/**
 * USD prices without price APIs:
 * - SOL: Chainlink SOL/USD on Ethereum, read through Helios (verified).
 * - SPL tokens with a known Raydium CPMM pool against USDC: the pool's
 *   on-chain reserves.
 */
import { ethers } from 'ethers';

import { heliosRpc, isHeliosSupported } from '@/core/helios/node';
import { customRPCServiceApi } from '@/core/serviceApi/customRPC';

import { encodeAddress } from './keys';
import type { SolanaRpc } from './rpc';

const CHAINLINK_SOL_USD = '0x4ffC43a60e009B551865A93d232E33Fce9f01507';
const MAX_FEED_AGE_S = 6 * 60 * 60;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';

/** Mint → Raydium CPMM pool used for its price (checked on read). */
export const KNOWN_POOLS: Record<string, string> = {
  // ARIO / USDC
  DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF:
    'Af2z5zkNXe9LDxQMrkDtBpehsLbMWTQrwhpjyW8439Lu',
};

const feed = new ethers.utils.Interface([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

const ethCall = async (to: string, data: string): Promise<string> =>
  isHeliosSupported()
    ? heliosRpc<string>('eth_call', [{ to, data }, 'latest'])
    : ((await customRPCServiceApi.defaultEthRPC({
        chainServerId: 'eth',
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      })) as string);

export const getSolUsdPrice = async (): Promise<number | null> => {
  const [round, decimals] = await Promise.all([
    ethCall(CHAINLINK_SOL_USD, feed.encodeFunctionData('latestRoundData')),
    ethCall(CHAINLINK_SOL_USD, feed.encodeFunctionData('decimals')),
  ]);
  const { answer, updatedAt } = feed.decodeFunctionResult(
    'latestRoundData',
    round,
  );
  const dec = Number(feed.decodeFunctionResult('decimals', decimals)[0]);
  if (Date.now() / 1000 - Number(updatedAt) > MAX_FEED_AGE_S) {
    return null; // stale feed: show no price rather than a wrong one
  }
  return Number(ethers.utils.formatUnits(answer, dec));
};

const tokenAmount = (data: Uint8Array) => {
  // SPL token account: amount u64 LE at offset 64.
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(data[64 + i]!);
  }
  return value;
};

/** USD price of `mint` from its known Raydium CPMM USDC pool, or `null`. */
export const getPoolUsdPrice = async (
  rpc: SolanaRpc,
  mint: string,
  mintDecimals: number,
): Promise<number | null> => {
  const pool = KNOWN_POOLS[mint];
  if (!pool) {
    return null;
  }
  const state = await rpc.getAccountData(pool);
  if (!state || state.owner !== RAYDIUM_CPMM || state.data.length < 232) {
    return null;
  }
  const key = (offset: number) =>
    encodeAddress(state.data.subarray(offset, offset + 32));
  const [vault0, vault1, mint0, mint1] = [
    key(72),
    key(104),
    key(168),
    key(200),
  ];
  const pair =
    mint0 === mint && mint1 === USDC_MINT
      ? { base: vault0, quote: vault1 }
      : mint1 === mint && mint0 === USDC_MINT
      ? { base: vault1, quote: vault0 }
      : null;
  if (!pair) {
    return null;
  }
  const [base, quote] = await Promise.all([
    rpc.getAccountData(pair.base),
    rpc.getAccountData(pair.quote),
  ]);
  if (!base || !quote) {
    return null;
  }
  const baseAmount = Number(tokenAmount(base.data)) / 10 ** mintDecimals;
  const quoteAmount = Number(tokenAmount(quote.data)) / 1e6;
  return baseAmount > 0 ? quoteAmount / baseAmount : null;
};

const PRICE_TTL_MS = 60_000;
const priceCache = new Map<
  string,
  { at: number; value: Promise<number | null> }
>();

/** Prices cached for a minute (one Chainlink / pool read per minute). */
export const getCachedUsdPrice = (
  rpc: SolanaRpc,
  mint: string | null,
  decimals = 9,
): Promise<number | null> => {
  const key = mint || 'SOL';
  const hit = priceCache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) {
    return hit.value;
  }
  const value = (
    mint ? getPoolUsdPrice(rpc, mint, decimals) : getSolUsdPrice()
  ).catch(() => null);
  const entry = { at: Date.now(), value };
  priceCache.set(key, entry);
  // A miss (often a rate-limited public RPC) is not cached.
  value.then(price => {
    if (price === null && priceCache.get(key) === entry) {
      priceCache.delete(key);
    }
  });
  return value;
};
