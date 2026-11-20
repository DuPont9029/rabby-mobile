/**
 * Solana RPC endpoint: the public mainnet RPC by default, or a custom URL
 * the user sets (e.g. a Helius/QuickNode endpoint with an API key).
 */
import { appJsonStore } from '@/core/storage/mmkv';
import {
  createSolanaRpc,
  DEFAULT_SOLANA_RPC,
  isValidRpcUrl,
  SolanaRpc,
} from './rpc';

const STORAGE_KEY = 'helios:solanaRpcUrl:v1';

export const getCustomSolanaRpcUrl = (): string | null => {
  try {
    const value = appJsonStore.getItem(STORAGE_KEY, null);
    return typeof value === 'string' && isValidRpcUrl(value) ? value : null;
  } catch {
    return null;
  }
};

export const getSolanaRpcUrl = () =>
  getCustomSolanaRpcUrl() || DEFAULT_SOLANA_RPC;

/** `null` restores the public default. Throws for an invalid URL. */
export const setCustomSolanaRpcUrl = (url: string | null) => {
  if (url === null || !url.trim()) {
    appJsonStore.setItem(STORAGE_KEY, null);
    return;
  }
  if (!isValidRpcUrl(url)) {
    throw new Error('invalid Solana RPC URL');
  }
  appJsonStore.setItem(STORAGE_KEY, url.trim());
};

let cached: SolanaRpc | null = null;

export const getSolanaRpc = (): SolanaRpc => {
  const url = getSolanaRpcUrl();
  if (!cached || cached.endpoint !== url) {
    cached = createSolanaRpc(url);
  }
  return cached;
};
