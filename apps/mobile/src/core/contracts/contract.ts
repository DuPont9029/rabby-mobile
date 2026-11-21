/**
 * Generic smart-contract interaction (Remix-like): load the ABI (Sourcify,
 * or pasted), call read functions, and build write transactions.
 *
 * Reads on Ethereum mainnet go through Helios (verified); other chains use
 * the default RPC. Writes are sent by the caller through the normal approval
 * flow.
 */
import { ethers } from 'ethers';

import { heliosRpc, isHeliosSupported } from '@/core/helios/node';
import { customRPCServiceApi } from '@/core/serviceApi/customRPC';

const SOURCIFY = 'https://sourcify.dev/server/v2/contract';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ABI_ITEMS = 1_000;

export type LoadedAbi = {
  abi: ethers.utils.Fragment[];
  /** 'exact_match' | 'match' from Sourcify, or 'pasted'. */
  source: string;
  /** Implementation address when `address` is a proxy. */
  implementation?: string;
  implementationName?: string;
};

type SourcifyResponse = {
  match?: string | null;
  abi?: unknown[];
  proxyResolution?: {
    isProxy?: boolean;
    implementations?: Array<{ address: string; name?: string }>;
  } | null;
};

const fetchJson = async (url: string) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Sourcify: HTTP ${response.status}`);
    }
    return (await response.json()) as SourcifyResponse;
  } finally {
    clearTimeout(timer);
  }
};

/** Parses a JSON ABI (array of fragments) defensively. */
export const parseAbi = (abi: unknown): ethers.utils.Fragment[] => {
  const list = typeof abi === 'string' ? JSON.parse(abi) : abi;
  if (!Array.isArray(list) || list.length > MAX_ABI_ITEMS) {
    throw new Error('ABI must be a JSON array');
  }
  return new ethers.utils.Interface(list as any).fragments.slice();
};

/**
 * The verified ABI of `address` on `chainId` from Sourcify. For proxies the
 * implementation's functions are added (they are called on the proxy).
 */
export const loadSourcifyAbi = async (
  chainId: number,
  address: string,
): Promise<LoadedAbi | null> => {
  const checksummed = ethers.utils.getAddress(address);
  const main = await fetchJson(
    `${SOURCIFY}/${chainId}/${checksummed}?fields=abi,proxyResolution`,
  );
  if (!main?.abi) {
    return null;
  }
  const fragments = parseAbi(main.abi);
  const implementation = main.proxyResolution?.isProxy
    ? main.proxyResolution.implementations?.[0]
    : undefined;
  if (implementation && ethers.utils.isAddress(implementation.address)) {
    const impl = await fetchJson(
      `${SOURCIFY}/${chainId}/${ethers.utils.getAddress(
        implementation.address,
      )}?fields=abi`,
    ).catch(() => null);
    if (impl?.abi) {
      const seen = new Set(
        fragments.map(f => f.format(ethers.utils.FormatTypes.sighash)),
      );
      for (const fragment of parseAbi(impl.abi)) {
        const key = fragment.format(ethers.utils.FormatTypes.sighash);
        if (!seen.has(key)) {
          seen.add(key);
          fragments.push(fragment);
        }
      }
    }
  }
  return {
    abi: fragments,
    source: main.match || 'match',
    implementation: implementation?.address,
    implementationName: implementation?.name,
  };
};

export const splitFunctions = (abi: ethers.utils.Fragment[]) => {
  const functions = abi.filter(
    (f): f is ethers.utils.FunctionFragment => f.type === 'function',
  );
  const isRead = (f: ethers.utils.FunctionFragment) =>
    f.stateMutability === 'view' || f.stateMutability === 'pure' || f.constant;
  return {
    read: functions.filter(isRead),
    write: functions.filter(f => !isRead(f)),
  };
};

/**
 * Converts the text typed for a parameter into an ABI value. Arrays and
 * tuples are written as JSON (e.g. `["0x…", 5]`), numbers as decimal or hex.
 */
export const parseArg = (param: ethers.utils.ParamType, text: string): any => {
  const value = text.trim();
  if (param.baseType === 'array' || param.baseType === 'tuple') {
    const parsed = JSON.parse(value || '[]');
    if (param.baseType === 'array') {
      if (!Array.isArray(parsed)) {
        throw new Error(`${param.name || param.type}: expected a JSON array`);
      }
      return parsed.map(item =>
        parseArg(
          param.arrayChildren,
          typeof item === 'string' ? item : JSON.stringify(item),
        ),
      );
    }
    const items = Array.isArray(parsed)
      ? parsed
      : param.components.map(c => parsed[c.name]);
    return param.components.map((component, i) =>
      parseArg(
        component,
        typeof items[i] === 'string' ? items[i] : JSON.stringify(items[i]),
      ),
    );
  }
  if (param.type === 'bool') {
    if (!/^(true|false)$/i.test(value)) {
      throw new Error(`${param.name || 'bool'}: true or false`);
    }
    return /^true$/i.test(value);
  }
  if (param.type === 'address') {
    if (!ethers.utils.isAddress(value)) {
      throw new Error(`${param.name || 'address'}: invalid address`);
    }
    return ethers.utils.getAddress(value);
  }
  if (/^u?int\d*$/.test(param.type)) {
    if (!/^(-?\d+|0x[0-9a-fA-F]+)$/.test(value)) {
      throw new Error(`${param.name || param.type}: invalid number`);
    }
    return ethers.BigNumber.from(value);
  }
  if (param.type.startsWith('bytes')) {
    if (!ethers.utils.isHexString(value)) {
      throw new Error(`${param.name || param.type}: hex (0x…) expected`);
    }
    return value;
  }
  return value; // string
};

const toPlain = (value: unknown): unknown =>
  ethers.BigNumber.isBigNumber(value)
    ? value.toString()
    : Array.isArray(value)
    ? Array.from(value, toPlain)
    : value;

/** Human-readable rendering of a decoded value (JSON for arrays/tuples). */
export const formatResult = (value: unknown): string => {
  const plain = toPlain(value);
  return typeof plain === 'string' ? plain : JSON.stringify(plain);
};

export const ethCallOnChain = async (
  chain: { serverId: string; id: number },
  to: string,
  data: string,
): Promise<string> =>
  chain.id === 1 && isHeliosSupported()
    ? heliosRpc<string>('eth_call', [{ to, data }, 'latest'])
    : ((await customRPCServiceApi.defaultEthRPC({
        chainServerId: chain.serverId,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      })) as string);

/** Calls a read function; returns each output as `name: value` lines. */
export const callReadFunction = async (
  chain: { serverId: string; id: number },
  address: string,
  fragment: ethers.utils.FunctionFragment,
  args: unknown[],
): Promise<Array<{ name: string; type: string; value: string }>> => {
  const iface = new ethers.utils.Interface([fragment]);
  const raw = await ethCallOnChain(
    chain,
    address,
    iface.encodeFunctionData(fragment, args),
  );
  const decoded = iface.decodeFunctionResult(fragment, raw);
  return fragment.outputs!.map((output, i) => ({
    name: output.name || `[${i}]`,
    type: output.type,
    value: formatResult(decoded[i]),
  }));
};

/** The `eth_sendTransaction` params for a write function. */
export const buildWriteTx = ({
  from,
  chainId,
  address,
  fragment,
  args,
  valueWei,
}: {
  from: string;
  chainId: number;
  address: string;
  fragment: ethers.utils.FunctionFragment;
  args: unknown[];
  valueWei: ethers.BigNumber;
}) => {
  if (!valueWei.isZero() && !fragment.payable) {
    throw new Error('This function is not payable');
  }
  return {
    from,
    to: ethers.utils.getAddress(address),
    data: new ethers.utils.Interface([fragment]).encodeFunctionData(
      fragment,
      args,
    ),
    value: valueWei.toHexString(),
    chainId,
  };
};
