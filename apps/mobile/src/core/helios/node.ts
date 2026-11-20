/**
 * a16z Helios light client for Ethereum mainnet, running in process.
 *
 * Helios follows the beacon chain (sync committees) and checks every answer
 * of the execution RPC against the verified state root with Merkle proofs:
 * the RPC supplies data but cannot lie about balances, contract code or
 * `eth_call` results. The execution RPCs below are only data sources.
 *
 * Android only for now; elsewhere `isHeliosSupported()` is false.
 */
import RNFS from '@rabby-wallet/react-native-fs';

import { appJsonStore } from '@/core/storage/mmkv';
import { isValidRpcUrl } from '@/core/solana/rpc';

/** Public execution RPCs that serve `eth_getProof` for recent blocks. */
export const DEFAULT_HELIOS_EXECUTION_RPCS = [
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
  'https://eth-mainnet.public.blastapi.io',
  'https://rpc.mevblocker.io',
];

/** Beacon light-client APIs (one is used at a time, in order). */
export const DEFAULT_HELIOS_CONSENSUS_RPCS = [
  'https://ethereum-beacon-api.publicnode.com',
  'https://lodestar-mainnet.chainsafe.io',
];

const EXECUTION_RPC_KEY = 'helios:heliosExecutionRpc:v1';
const STATUS_POLL_MS = 300;
export const HELIOS_SYNC_WAIT_MS = 45_000;

export type HeliosState =
  | 'stopped'
  | 'syncing'
  | 'synced'
  | 'failed'
  | 'unavailable';

export class HeliosRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    /** True when retrying later may succeed (sync, network, upstream). */
    readonly transient: boolean,
  ) {
    super(message);
    this.name = 'HeliosRpcError';
  }
}

export const getCustomHeliosExecutionRpc = (): string | null => {
  try {
    const value = appJsonStore.getItem(EXECUTION_RPC_KEY, null);
    return typeof value === 'string' && isValidRpcUrl(value) ? value : null;
  } catch {
    return null;
  }
};

/**
 * A custom execution RPC (must support `eth_getProof`) is tried first; the
 * public ones stay as fallbacks. `null` restores the defaults.
 */
export const setCustomHeliosExecutionRpc = (url: string | null) => {
  if (url === null || !url.trim()) {
    appJsonStore.setItem(EXECUTION_RPC_KEY, null);
  } else if (!isValidRpcUrl(url)) {
    throw new Error('invalid execution RPC URL');
  } else {
    appJsonStore.setItem(EXECUTION_RPC_KEY, url.trim());
  }
  restartHelios();
};

export const getHeliosExecutionRpcs = () => {
  const custom = getCustomHeliosExecutionRpc();
  return custom
    ? [custom, ...DEFAULT_HELIOS_EXECUTION_RPCS.filter(url => url !== custom)]
    : DEFAULT_HELIOS_EXECUTION_RPCS;
};

export const isHeliosSupported = () => {
  try {
    return RNFS.isHeliosAvailable() && !!RNFS.heliosDataDirectory();
  } catch {
    return false;
  }
};

export const getHeliosStatus = (): {
  state: HeliosState;
  error: string | null;
} => {
  if (!isHeliosSupported()) {
    return { state: 'unavailable', error: null };
  }
  const status = RNFS.heliosStatus();
  return { state: status.state, error: status.error ?? null };
};

/** Starts the node if it is not running (or failed). Cheap to call. */
export const startHelios = () => {
  if (!isHeliosSupported()) {
    return false;
  }
  const dataDir = RNFS.heliosDataDirectory();
  if (!dataDir) {
    return false;
  }
  return (
    RNFS.heliosStart({
      executionRpcs: getHeliosExecutionRpcs(),
      consensusRpcs: DEFAULT_HELIOS_CONSENSUS_RPCS,
      dataDir,
    }) === 0
  );
};

export const restartHelios = () => {
  if (!isHeliosSupported()) {
    return;
  }
  RNFS.heliosStop();
  startHelios();
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Starts Helios if needed and waits until it is synced. */
export const waitForHelios = async (timeoutMs = HELIOS_SYNC_WAIT_MS) => {
  if (!isHeliosSupported()) {
    throw new HeliosRpcError('helios unavailable', null, false);
  }
  let status = getHeliosStatus();
  if (status.state === 'stopped' || status.state === 'failed') {
    startHelios();
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    status = getHeliosStatus();
    if (status.state === 'synced') {
      return;
    }
    if (status.state === 'failed') {
      throw new HeliosRpcError(
        `helios failed: ${status.error || 'unknown'}`,
        null,
        true,
      );
    }
    if (Date.now() >= deadline) {
      throw new HeliosRpcError('helios sync timed out', null, true);
    }
    await sleep(STATUS_POLL_MS);
  }
};

/** JSON-RPC error codes from Helios that mean "try again later". */
const TRANSIENT_CODES = new Set([-32001, -32002, -32603, 1]);

let nextId = 1;

/** A verified JSON-RPC call (Ethereum mainnet). */
export const heliosRpc = async <T = unknown>(
  method: string,
  params: unknown[],
): Promise<T> => {
  await waitForHelios();
  const raw = await RNFS.heliosRequest(
    JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  );
  let response: {
    result?: T;
    error?: { code?: number; message?: string };
  };
  try {
    response = JSON.parse(raw);
  } catch {
    throw new HeliosRpcError('invalid helios response', null, true);
  }
  if (response.error) {
    const code =
      typeof response.error.code === 'number' ? response.error.code : null;
    throw new HeliosRpcError(
      response.error.message || 'helios error',
      code,
      code === null || TRANSIENT_CODES.has(code),
    );
  }
  return response.result as T;
};
