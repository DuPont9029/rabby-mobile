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

import {
  HELIOS_SYNC_WAIT_MS,
  heliosRpc,
  isHeliosSupported,
} from '@/core/helios/node';
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
/** Delays before re-reading the chain after a temporary failure. */
export const ONCHAIN_RETRY_DELAYS_MS = [2_000, 6_000, 15_000];
/** A hung RPC request must not hold a call slot (and every later NFT) forever. */
export const ETH_CALL_TIMEOUT_MS = 15_000;

class EthCallTimeoutError extends Error {
  constructor() {
    super('eth_call timed out');
    this.name = 'EthCallTimeoutError';
  }
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EthCallTimeoutError()), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

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

/**
 * Ethereum mainnet reads go through the in-process Helios light client, so
 * the token URI is verified against the chain's state root instead of
 * trusting an RPC. Other chains (and platforms without Helios) use the
 * default RPC.
 */
const usesHelios = (chain: string) => chain === 'eth' && isHeliosSupported();

const ethCall = (chain: string, to: string, data: string) =>
  withCallSlot(async () => {
    const result: unknown = await withTimeout(
      usesHelios(chain)
        ? heliosRpc<string>('eth_call', [{ to, data }, 'latest'])
        : customRPCServiceApi.defaultEthRPC({
            chainServerId: chain,
            method: 'eth_call',
            params: [{ to, data }, 'latest'],
          }),
      usesHelios(chain)
        ? HELIOS_SYNC_WAIT_MS + ETH_CALL_TIMEOUT_MS
        : ETH_CALL_TIMEOUT_MS,
    );
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

/**
 * Reads `tokenURI` (ERC-721), falling back to `uri` (ERC-1155).
 * `transient` is true when no URI was found and at least one call failed
 * (network error, timeout, revert), so the miss may not be definitive.
 */
const readTokenUri = async (
  ref: OnchainNftRef,
): Promise<{ uri: string | null; transient: boolean }> => {
  if (!isValidRef(ref)) {
    return { uri: null, transient: false };
  }
  const argument = encodeTokenId(ref.tokenId);
  let transient = false;
  for (const selector of [ERC721_TOKEN_URI, ERC1155_URI]) {
    try {
      const uri = decodeString(
        await ethCall(ref.chain, ref.contractId, selector + argument),
      );
      if (uri) {
        return { uri, transient: false };
      }
    } catch {
      // A revert is the usual answer of the wrong interface, but it cannot
      // be told apart from an RPC failure here; try the next interface.
      transient = true;
    }
  }
  return { uri: null, transient };
};

/** Reads `tokenURI` (ERC-721), falling back to `uri` (ERC-1155). */
export const fetchTokenUri = async (ref: OnchainNftRef) =>
  (await readTokenUri(ref)).uri;

export type OnchainNftDetails = {
  /** The raw token URI (shown as text only; remote URIs are never fetched). */
  tokenUri: string | null;
  /** Parsed metadata when the token URI is an inline `data:` document. */
  metadata: OnchainNftMetadata | null;
  /**
   * True when the read failed in a way that may succeed later (RPC error or
   * timeout). Such results are not cached, so the next request retries.
   */
  transient?: boolean;
};

type CachedDetails = {
  promise: Promise<OnchainNftDetails>;
  /** When the read started. */
  at: number;
  /** Last definitive answer, kept while a refresh is pending or fails. */
  settled?: OnchainNftDetails;
};

const detailsCache = new Map<string, CachedDetails>();

const cacheKey = ({ chain, contractId, tokenId }: OnchainNftRef) =>
  `${chain}:${contractId.toLowerCase()}:${tokenId}`;

export type LoadDetailsOptions = {
  /**
   * Re-read the chain when the cached answer is older than this. Without it
   * the cached answer is reused for the app session.
   */
  maxAgeMs?: number;
};

/**
 * The token URI and, when it is an inline `data:application/json` document,
 * its parsed metadata. Remote URIs are returned as text but never fetched.
 * A failed refresh keeps the last definitive answer.
 */
export const loadOnchainNftDetails = (
  ref: OnchainNftRef,
  options: LoadDetailsOptions = {},
): Promise<OnchainNftDetails> => {
  const key = cacheKey(ref);
  const cached = detailsCache.get(key);
  const fresh =
    cached &&
    (options.maxAgeMs === undefined ||
      Date.now() - cached.at < options.maxAgeMs);
  if (cached && fresh) {
    return cached.promise;
  }
  const previous = cached?.settled;
  const entry = { at: Date.now(), settled: previous } as CachedDetails;
  entry.promise = readTokenUri(ref)
    .then(({ uri, transient }) => ({
      tokenUri: uri,
      metadata: parseInlineTokenUri(uri),
      transient,
    }))
    .catch(() => ({ tokenUri: null, metadata: null, transient: true }))
    .then(details => {
      if (!details.transient) {
        entry.settled = details;
        return details;
      }
      // Temporary failure: serve the last good answer if there is one, and
      // do not keep the miss cached so the next request retries.
      if (detailsCache.get(key) === entry) {
        if (previous) {
          entry.promise = Promise.resolve(previous);
          entry.at = 0; // stale: refresh on next request with maxAgeMs
        } else {
          detailsCache.delete(key);
        }
      }
      return previous ?? details;
    });
  detailsCache.delete(key);
  detailsCache.set(key, entry);
  if (detailsCache.size > MAX_CACHE_ENTRIES) {
    const oldest = detailsCache.keys().next().value;
    if (oldest !== undefined) {
      detailsCache.delete(oldest);
    }
  }
  return entry.promise;
};

/** On-chain inline metadata, or `null` (remote URIs are not fetched). */
export const loadOnchainNftMetadata = async (
  ref: OnchainNftRef,
  options?: LoadDetailsOptions,
): Promise<OnchainNftMetadata | null> =>
  (await loadOnchainNftDetails(ref, options)).metadata;

/**
 * The NFT's on-chain artwork as SVG markup (or `null`), and whether a miss
 * may be temporary (worth retrying).
 */
export const loadOnchainNftArtwork = async (
  ref: OnchainNftRef,
  options?: LoadDetailsOptions,
): Promise<{ svg: string | null; transient: boolean }> => {
  const details = await loadOnchainNftDetails(ref, options);
  return {
    svg: inlineSvgFromMetadata(details.metadata),
    transient: !!details.transient,
  };
};

/** SVG markup of the NFT's on-chain artwork, or `null`. */
export const loadOnchainNftSvg = async (ref: OnchainNftRef) =>
  (await loadOnchainNftArtwork(ref)).svg;

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
