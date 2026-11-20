/**
 * NFTs the user imports by contract and token id, for tokens the indexer
 * does not list. They are kept per address on the device only.
 *
 * Every entry is re-checked on-chain (`ownerOf` / `balanceOf`) before it is
 * shown, so an import can never make the wallet display a token the address
 * does not hold. Artwork is resolved later by `Media` through the on-chain
 * inline-metadata path; nothing here fetches creator-controlled URLs.
 */
import type { NFTItem } from '@rabby-wallet/rabby-api/dist/types';

import { appJsonStore } from '@/core/storage/mmkv';
import {
  checkOnchainNftOwnership,
  loadOnchainNftMetadata,
  type OnchainNftRef,
} from './onchainNftMedia';
import { toOnchainNftRef } from './onchainNftMediaCore';

const STORAGE_KEY = 'customOnchainNfts:v1';
const MAX_ENTRIES_PER_ADDRESS = 100;

export type CustomOnchainNft = OnchainNftRef & {
  name?: string;
  standard: 'erc721' | 'erc1155';
  addedAt: number;
};

type StoredCustomNfts = Record<string, CustomOnchainNft[]>;

const sameRef = (a: OnchainNftRef, b: OnchainNftRef) =>
  a.chain === b.chain &&
  a.contractId.toLowerCase() === b.contractId.toLowerCase() &&
  a.tokenId === b.tokenId;

const readAll = (): StoredCustomNfts => {
  try {
    const stored = appJsonStore.getItem(STORAGE_KEY, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as StoredCustomNfts)
      : {};
  } catch {
    return {};
  }
};

export const getCustomOnchainNfts = (address: string): CustomOnchainNft[] => {
  const entries = readAll()[address.toLowerCase()];
  return Array.isArray(entries)
    ? entries.filter(entry =>
        toOnchainNftRef({
          chain: entry?.chain,
          contract_id: entry?.contractId,
          inner_id: entry?.tokenId,
        }),
      )
    : [];
};

const writeEntries = (address: string, entries: CustomOnchainNft[]) => {
  const all = readAll();
  all[address.toLowerCase()] = entries;
  appJsonStore.setItem(STORAGE_KEY, all);
};

export const removeCustomOnchainNft = (address: string, ref: OnchainNftRef) => {
  writeEntries(
    address,
    getCustomOnchainNfts(address).filter(entry => !sameRef(entry, ref)),
  );
};

export type ImportOnchainNftResult =
  | { status: 'imported'; nft: CustomOnchainNft }
  | { status: 'invalid' | 'not_owned' | 'duplicate' | 'limit' };

/** Verifies on-chain ownership, then stores the NFT for this address. */
export const importOnchainNft = async (
  address: string,
  input: { chain: string; contractId: string; tokenId: string },
): Promise<ImportOnchainNftResult> => {
  const ref = toOnchainNftRef({
    chain: input.chain,
    contract_id: input.contractId.trim(),
    inner_id: input.tokenId.trim(),
  });
  if (!ref) {
    return { status: 'invalid' };
  }
  const existing = getCustomOnchainNfts(address);
  if (existing.some(entry => sameRef(entry, ref))) {
    return { status: 'duplicate' };
  }
  if (existing.length >= MAX_ENTRIES_PER_ADDRESS) {
    return { status: 'limit' };
  }
  const ownership = await checkOnchainNftOwnership(ref, address);
  if (!ownership.owned || !ownership.standard) {
    return { status: 'not_owned' };
  }
  const metadata = await loadOnchainNftMetadata(ref);
  const nft: CustomOnchainNft = {
    ...ref,
    name: metadata?.name,
    standard: ownership.standard,
    addedAt: Date.now(),
  };
  writeEntries(address, [...getCustomOnchainNfts(address), nft]);
  return { status: 'imported', nft };
};

/** Shape the imported NFT like an indexed one so every NFT view can use it. */
export const toCustomNftItem = (
  nft: CustomOnchainNft,
  amount: number,
): NFTItem => {
  const contract = nft.contractId.toLowerCase();
  const collectionId = `onchain:${contract}`;
  const name = nft.name || `#${nft.tokenId}`;
  return {
    chain: nft.chain,
    id: `${collectionId}:${nft.tokenId}`,
    contract_id: contract,
    inner_id: nft.tokenId,
    token_id: nft.tokenId,
    name,
    contract_name: name,
    collection_name: name,
    description: '',
    usd_price: 0,
    amount,
    // Empty indexed media: `Media` resolves the on-chain artwork instead.
    content_type: 'image',
    content: '',
    thumbnail_url: '',
    detail_url: '',
    is_erc721: nft.standard === 'erc721',
    is_erc1155: nft.standard === 'erc1155',
    collection_id: `${nft.chain}:${collectionId}`,
    collection: {
      id: collectionId,
      name,
      description: null,
      logo_url: '',
      // The user imported it explicitly: list it with visible collections.
      is_core: true,
      contract_uuids: [`${nft.chain}:${contract}`],
      create_at: Math.floor(nft.addedAt / 1000),
      floor_price: 0,
      is_scam: false,
      nft_list: [],
    } as unknown as NFTItem['collection'],
  };
};

/**
 * Appends the imported NFTs that `address` still holds on-chain and that the
 * indexer did not already return. Never throws: on any failure the indexed
 * list is returned unchanged.
 */
export const appendCustomOnchainNfts = async (
  address: string,
  nfts: NFTItem[],
): Promise<NFTItem[]> => {
  try {
    const custom = getCustomOnchainNfts(address).filter(
      entry =>
        !nfts.some(nft =>
          sameRef(entry, {
            chain: nft.chain,
            contractId: nft.contract_id || '',
            tokenId: String(nft.inner_id ?? ''),
          }),
        ),
    );
    if (!custom.length) {
      return nfts;
    }
    const verified = await Promise.all(
      custom.map(async entry => {
        const ownership = await checkOnchainNftOwnership(entry, address);
        return ownership.owned
          ? toCustomNftItem(entry, ownership.amount || 1)
          : null;
      }),
    );
    const owned = verified.filter((item): item is NFTItem => !!item);
    return owned.length ? [...nfts, ...owned] : nfts;
  } catch {
    return nfts;
  }
};
