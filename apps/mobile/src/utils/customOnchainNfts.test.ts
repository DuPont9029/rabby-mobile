import type { NFTItem } from '@rabby-wallet/rabby-api/dist/types';

import {
  appendCustomOnchainNfts,
  getCustomOnchainNfts,
  importOnchainNft,
  removeCustomOnchainNft,
} from './customOnchainNfts';
import {
  checkOnchainNftOwnership,
  loadOnchainNftMetadata,
} from './onchainNftMedia';

const mockStorage = new Map<string, unknown>();

jest.mock('@/core/storage/mmkv', () => ({
  appJsonStore: {
    getItem: (key: string, fallback: unknown) =>
      mockStorage.has(key) ? mockStorage.get(key) : fallback,
    setItem: (key: string, value: unknown) => {
      mockStorage.set(key, JSON.parse(JSON.stringify(value)));
    },
  },
}));

jest.mock('./onchainNftMedia', () => ({
  checkOnchainNftOwnership: jest.fn(),
  loadOnchainNftMetadata: jest.fn(),
}));

const OWNER = '0x1111111111111111111111111111111111111111';
const CONTRACT = '0xff9c1b15b16263c61d017ee9f65c50e4ae0113d7';
const INPUT = { chain: 'eth', contractId: CONTRACT, tokenId: '1' };

describe('custom on-chain NFTs', () => {
  beforeEach(() => {
    mockStorage.clear();
    jest.mocked(checkOnchainNftOwnership).mockResolvedValue({
      owned: true,
      standard: 'erc721',
      amount: 1,
    });
    jest.mocked(loadOnchainNftMetadata).mockResolvedValue({ name: 'Bag #1' });
  });

  it('imports only after on-chain ownership is verified', async () => {
    const result = await importOnchainNft(OWNER, INPUT);

    expect(result).toMatchObject({
      status: 'imported',
      nft: { ...INPUT, name: 'Bag #1', standard: 'erc721' },
    });
    expect(checkOnchainNftOwnership).toHaveBeenCalledWith(
      { chain: 'eth', contractId: CONTRACT, tokenId: '1' },
      OWNER,
    );
    expect(
      getCustomOnchainNfts(OWNER.toUpperCase().replace('0X', '0x')),
    ).toHaveLength(1);
  });

  it('refuses tokens the address does not own, duplicates and bad input', async () => {
    jest
      .mocked(checkOnchainNftOwnership)
      .mockResolvedValueOnce({ owned: false });
    expect(await importOnchainNft(OWNER, INPUT)).toEqual({
      status: 'not_owned',
    });
    expect(getCustomOnchainNfts(OWNER)).toHaveLength(0);

    await importOnchainNft(OWNER, INPUT);
    expect(await importOnchainNft(OWNER, INPUT)).toEqual({
      status: 'duplicate',
    });

    expect(
      await importOnchainNft(OWNER, { ...INPUT, contractId: 'not-an-address' }),
    ).toEqual({ status: 'invalid' });
    expect(await importOnchainNft(OWNER, { ...INPUT, tokenId: '-1' })).toEqual({
      status: 'invalid',
    });
  });

  it('appends still-owned imports that the indexer did not return', async () => {
    await importOnchainNft(OWNER, INPUT);

    const appended = await appendCustomOnchainNfts(OWNER, []);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      chain: 'eth',
      contract_id: CONTRACT,
      inner_id: '1',
      content: '',
      is_erc721: true,
      collection: { is_core: true },
    });

    jest
      .mocked(checkOnchainNftOwnership)
      .mockResolvedValueOnce({ owned: false });
    expect(await appendCustomOnchainNfts(OWNER, [])).toEqual([]);
  });

  it('does not duplicate an NFT the indexer already returned', async () => {
    await importOnchainNft(OWNER, INPUT);
    const indexed = [
      { chain: 'eth', contract_id: CONTRACT, inner_id: '1' } as NFTItem,
    ];

    expect(await appendCustomOnchainNfts(OWNER, indexed)).toBe(indexed);
  });

  it('returns the indexed list unchanged when the on-chain check fails', async () => {
    await importOnchainNft(OWNER, INPUT);
    jest
      .mocked(checkOnchainNftOwnership)
      .mockRejectedValueOnce(new Error('rpc'));
    const indexed: NFTItem[] = [];

    expect(await appendCustomOnchainNfts(OWNER, indexed)).toBe(indexed);
  });

  it('removes an import', async () => {
    await importOnchainNft(OWNER, INPUT);
    removeCustomOnchainNft(OWNER, INPUT);

    expect(getCustomOnchainNfts(OWNER)).toEqual([]);
  });
});
