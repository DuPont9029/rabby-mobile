/**
 * Reads NFT artwork stored in the token contract itself, for NFTs whose
 * indexed media is missing or unusable.
 *
 * Privacy/safety boundary:
 * - the only network access is `eth_call` through the app's existing RPC
 *   path (`customRPCServiceApi.defaultEthRPC`), never a URL chosen by the
 *   NFT's creator: `http(s)`, `ipfs`, `ar` token URIs are not fetched;
 * - the artwork is returned as SVG markup for `RNFS.resolveSvgData`, which
 *   runs the native safe-SVG profile check and rasterizer.
 */
import { ethers } from 'ethers';

import { customRPCServiceApi } from '@/core/serviceApi/customRPC';
import {
  inlineSvgFromMetadata,
  parseInlineTokenUri,
  type OnchainNftMetadata,
} from './onchainNftMediaCore';

export type OnchainNftRef = {
  /** Chain server id, as in `NFTItem.chain` (e.g. `eth`). */
  chain: string;
  contractId: string;
  /** Decimal token id, as in `NFTItem.inner_id`. */
  tokenId: string;
};

const ERC721_TOKEN_URI = '0xc87b56dd'; // tokenURI(uint256)
const ERC1155_URI = '0x0e89341c'; // uri(uint256)
const ERC721_OWNER_OF = '0x6352211e'; // ownerOf(uint256)
const ERC1155_BALANCE_OF = '0x00fdd58e'; // balanceOf(address,uint256)

const MAX_CONCURRENT_CALLS = 3;
const MAX_CACHE_ENTRIES = 300;

let activeCalls = 0;
const waitingCalls: Array<() => void> = [];

const withCallSlot = async <T>(task: () => Promise<T>): Promise<T> => {
  if (activeCalls >= MAX_CONCURRENT_CALLS) {
    await new Promise<void>(resolve => waitingCalls.push(resolve));
  }
  activeCalls += 1;
  try {
    return await task();
  } finally {
    activeCalls -= 1;
    waitingCalls.shift()?.();
  }
};

const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value);

const encodeTokenId = (tokenId: string) =>
  ethers.utils.defaultAbiCoder
    .encode(['uint256'], [ethers.BigNumber.from(tokenId)])
    .slice(2);

const ethCall = (chain: string, to: string, data: string) =>
  withCallSlot(async () => {
    const result: unknown = await customRPCServiceApi.defaultEthRPC({
      chainServerId: chain,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    });
    return typeof result === 'string' && /^0x[0-9a-fA-F]*$/.test(result)
      ? result
      : null;
  });

const decodeString = (result: string | null) => {
  if (!result || result.length <= 2) {
    return null;
  }
  try {
    return ethers.utils.defaultAbiCoder.decode(['string'], result)[0] as string;
  } catch {
    return null;
  }
};

const isValidRef = ({ chain, contractId, tokenId }: OnchainNftRef) => {
  if (!chain || !isAddress(contractId) || !/^\d{1,78}$/.test(tokenId)) {
    return false;
  }
  try {
    return ethers.BigNumber.from(tokenId).lt(
      ethers.constants.MaxUint256.add(1),
    );
  } catch {
    return false;
  }
};

/** Reads `tokenURI` (ERC-721), falling back to `uri` (ERC-1155). */
export const fetchTokenUri = async (ref: OnchainNftRef) => {
  if (!isValidRef(ref)) {
    return null;
  }
  const argument = encodeTokenId(ref.tokenId);
  for (const selector of [ERC721_TOKEN_URI, ERC1155_URI]) {
    try {
      const uri = decodeString(
        await ethCall(ref.chain, ref.contractId, selector + argument),
      );
      if (uri) {
        return uri;
      }
    } catch {
      // Try the next interface.
    }
  }
  return null;
};

export type OnchainNftDetails = {
  /** The raw token URI (shown as text only; remote URIs are never fetched). */
  tokenUri: string | null;
  /** Parsed metadata when the token URI is an inline `data:` document. */
  metadata: OnchainNftMetadata | null;
};

const detailsCache = new Map<string, Promise<OnchainNftDetails>>();

const cacheKey = ({ chain, contractId, tokenId }: OnchainNftRef) =>
  `${chain}:${contractId.toLowerCase()}:${tokenId}`;

/**
 * The token URI and, when it is an inline `data:application/json` document,
 * its parsed metadata. Remote URIs are returned as text but never fetched.
 * Results, including misses, are cached for the app session.
 */
export const loadOnchainNftDetails = (
  ref: OnchainNftRef,
): Promise<OnchainNftDetails> => {
  const key = cacheKey(ref);
  const cached = detailsCache.get(key);
  if (cached) {
    return cached;
  }
  const pending = fetchTokenUri(ref)
    .then(tokenUri => ({
      tokenUri,
      metadata: parseInlineTokenUri(tokenUri),
    }))
    .catch(() => ({ tokenUri: null, metadata: null }));
  detailsCache.set(key, pending);
  if (detailsCache.size > MAX_CACHE_ENTRIES) {
    const oldest = detailsCache.keys().next().value;
    if (oldest !== undefined) {
      detailsCache.delete(oldest);
    }
  }
  return pending;
};

/** On-chain inline metadata, or `null` (remote URIs are not fetched). */
export const loadOnchainNftMetadata = async (
  ref: OnchainNftRef,
): Promise<OnchainNftMetadata | null> =>
  (await loadOnchainNftDetails(ref)).metadata;

/** SVG markup of the NFT's on-chain artwork, or `null`. */
export const loadOnchainNftSvg = async (ref: OnchainNftRef) =>
  inlineSvgFromMetadata(await loadOnchainNftMetadata(ref));

/**
 * Whether `owner` holds the token, checked on-chain: `ownerOf` for ERC-721,
 * then `balanceOf` for ERC-1155. Returns the detected standard.
 */
export const checkOnchainNftOwnership = async (
  ref: OnchainNftRef,
  owner: string,
): Promise<{
  owned: boolean;
  standard?: 'erc721' | 'erc1155';
  amount?: number;
}> => {
  if (!isValidRef(ref) || !isAddress(owner)) {
    return { owned: false };
  }
  const argument = encodeTokenId(ref.tokenId);
  try {
    const result = await ethCall(
      ref.chain,
      ref.contractId,
      ERC721_OWNER_OF + argument,
    );
    if (result && result.length >= 66) {
      const [holder] = ethers.utils.defaultAbiCoder.decode(['address'], result);
      return {
        owned: (holder as string).toLowerCase() === owner.toLowerCase(),
        standard: 'erc721',
        amount: 1,
      };
    }
  } catch {
    // Not ERC-721 (or the token does not exist); try ERC-1155.
  }
  try {
    const encodedOwner = ethers.utils.defaultAbiCoder
      .encode(['address'], [owner])
      .slice(2);
    const result = await ethCall(
      ref.chain,
      ref.contractId,
      ERC1155_BALANCE_OF + encodedOwner + argument,
    );
    if (result && result.length >= 66) {
      const [balance] = ethers.utils.defaultAbiCoder.decode(
        ['uint256'],
        result,
      );
      const amount = ethers.BigNumber.from(balance);
      return {
        owned: amount.gt(0),
        standard: 'erc1155',
        amount: amount.gt(Number.MAX_SAFE_INTEGER)
          ? Number.MAX_SAFE_INTEGER
          : amount.toNumber(),
      };
    }
  } catch {
    // Neither interface answered.
  }
  return { owned: false };
};

export const __resetOnchainNftMediaCacheForTests = () => {
  detailsCache.clear();
};
