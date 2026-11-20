import { Buffer } from 'buffer';

import accounts from './__fixtures__/metadata-accounts.json';
import {
  __resetOffchainCacheForTests,
  loadOffchainMetadata,
  loadSolanaPortfolio,
  parseOffchainMetadata,
  resolveMediaUri,
} from './portfolio';
import type { SolanaRpc } from './rpc';
import { PROGRAM_IDS } from './tx';

const MAD_LADS = 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const metadataAccount = (base64: string) => ({
  owner: PROGRAM_IDS.tokenMetadata,
  data: Uint8Array.from(Buffer.from(base64, 'base64')),
});

describe('loadSolanaPortfolio', () => {
  it('splits NFTs (supply-1, 0 decimals, with NFT metadata) from tokens', async () => {
    const rpc = {
      getBalance: jest.fn(async () => 2_000_000_000n),
      getTokenAccounts: jest.fn(async () => [
        {
          address: 'acc-nft',
          mint: MAD_LADS,
          amount: 1n,
          decimals: 0,
          frozen: false,
          tokenProgram: PROGRAM_IDS.token,
        },
        {
          address: 'acc-usdc',
          mint: USDC,
          amount: 5_000_000n,
          decimals: 6,
          frozen: false,
          tokenProgram: PROGRAM_IDS.token,
        },
        {
          address: 'acc-empty',
          mint: USDC,
          amount: 0n,
          decimals: 6,
          frozen: false,
          tokenProgram: PROGRAM_IDS.token,
        },
      ]),
      getMultipleAccounts: jest.fn(async () => [
        metadataAccount(accounts.madLads),
        metadataAccount(accounts.usdc),
      ]),
    } as unknown as SolanaRpc;

    const portfolio = await loadSolanaPortfolio(rpc, 'owner');

    expect(portfolio.lamports).toBe(2_000_000_000n);
    expect(portfolio.nfts).toHaveLength(1);
    expect(portfolio.nfts[0]).toMatchObject({
      mint: MAD_LADS,
      name: 'Mad Lads',
      programmable: true,
      ruleSet: 'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9',
    });
    // Zero-balance accounts are hidden.
    expect(portfolio.tokens).toEqual([
      expect.objectContaining({
        mint: USDC,
        symbol: 'USDC',
        amount: 5_000_000n,
      }),
    ]);
  });

  it('ignores metadata accounts not owned by Token Metadata', async () => {
    const rpc = {
      getBalance: jest.fn(async () => 0n),
      getTokenAccounts: jest.fn(async () => [
        {
          address: 'a',
          mint: MAD_LADS,
          amount: 1n,
          decimals: 0,
          frozen: false,
          tokenProgram: PROGRAM_IDS.token,
        },
      ]),
      getMultipleAccounts: jest.fn(async () => [
        {
          owner: PROGRAM_IDS.system,
          data: Uint8Array.from(Buffer.from(accounts.madLads, 'base64')),
        },
      ]),
    } as unknown as SolanaRpc;

    const portfolio = await loadSolanaPortfolio(rpc, 'owner');
    expect(portfolio.nfts).toHaveLength(0);
    expect(portfolio.tokens).toHaveLength(1);
  });
});

describe('off-chain metadata', () => {
  beforeEach(__resetOffchainCacheForTests);

  it('maps storage URIs to gateways', () => {
    expect(resolveMediaUri('ipfs://bafy/1.png')).toBe(
      'https://ipfs.io/ipfs/bafy/1.png',
    );
    expect(resolveMediaUri('ipfs://ipfs/bafy')).toBe(
      'https://ipfs.io/ipfs/bafy',
    );
    expect(resolveMediaUri('ar://abc')).toBe('https://arweave.net/abc');
    expect(resolveMediaUri('https://x.y/a.png')).toBe('https://x.y/a.png');
    expect(resolveMediaUri('javascript:alert(1)')).toBeNull();
    expect(resolveMediaUri('file:///etc/passwd')).toBeNull();
  });

  it('parses JSON metadata as plain data', () => {
    expect(
      parseOffchainMetadata({
        name: 'Lad #1',
        image: 'https://img/1.png',
        attributes: [
          { trait_type: 'Hat', value: 'Cap' },
          { value: 7 },
          { value: { x: 1 } },
        ],
      }),
    ).toEqual({
      name: 'Lad #1',
      description: undefined,
      image: 'https://img/1.png',
      animationUrl: undefined,
      externalUrl: undefined,
      attributes: [
        { trait: 'Hat', value: 'Cap' },
        { trait: '', value: '7' },
      ],
    });
    expect(parseOffchainMetadata('nope').attributes).toEqual([]);
  });

  it('caches successes and retries failures', async () => {
    const ok = {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({ name: 'A' }),
    };
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(ok);

    expect(
      await loadOffchainMetadata('https://m/1.json', fetchImpl),
    ).toBeNull();
    // Let the failed entry leave the cache.
    await Promise.resolve();
    expect(
      (await loadOffchainMetadata('https://m/1.json', fetchImpl))?.name,
    ).toBe('A');
    expect(
      (await loadOffchainMetadata('https://m/1.json', fetchImpl))?.name,
    ).toBe('A');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses oversized JSON', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => String(5 * 1024 * 1024) },
      text: async () => '{}',
    });
    expect(
      await loadOffchainMetadata('https://m/big.json', fetchImpl),
    ).toBeNull();
  });
});
