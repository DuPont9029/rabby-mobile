/**
 * Solana balances, tokens and NFTs of one address, read over RPC:
 * token accounts (SPL Token + Token-2022), Metaplex metadata accounts, and
 * the off-chain JSON the metadata points to (name/image/attributes).
 *
 * Off-chain JSON and images are loaded from the URI the NFT creator chose
 * (Arweave/IPFS/https), as the user opted in to; the JSON is size-limited,
 * time-limited and parsed as data only.
 */
import {
  decodeTokenMetadata,
  isProgrammable,
  TokenMetadata,
  TokenStandard,
} from './metadata';
import type { SolanaRpc } from './rpc';
import { metadataAddress, PROGRAM_IDS } from './tx';

export type SolanaToken = {
  mint: string;
  account: string;
  amount: bigint;
  decimals: number;
  tokenProgram: string;
  frozen: boolean;
  name?: string;
  symbol?: string;
  /** Off-chain JSON URI (logo lookup), if any. */
  uri?: string;
};

export type SolanaNft = {
  mint: string;
  account: string;
  tokenProgram: string;
  frozen: boolean;
  name: string;
  symbol: string;
  uri: string;
  programmable: boolean;
  ruleSet: string | null;
  collection: string | null;
  tokenStandard: TokenStandard | null;
};

export type SolanaPortfolio = {
  lamports: bigint;
  tokens: SolanaToken[];
  nfts: SolanaNft[];
};

const isFungible = (metadata?: TokenMetadata | null) =>
  metadata?.tokenStandard === TokenStandard.Fungible ||
  metadata?.tokenStandard === TokenStandard.FungibleAsset;

export const loadSolanaPortfolio = async (
  rpc: SolanaRpc,
  owner: string,
): Promise<SolanaPortfolio> => {
  const [lamports, accounts] = await Promise.all([
    rpc.getBalance(owner),
    rpc.getTokenAccounts(owner),
  ]);
  const held = accounts.filter(account => account.amount > 0n);
  const metadataAccounts = await rpc
    .getMultipleAccounts(held.map(account => metadataAddress(account.mint)))
    .catch(() => held.map(() => null));
  const metadata = metadataAccounts.map(account => {
    if (!account || account.owner !== PROGRAM_IDS.tokenMetadata) {
      return null;
    }
    try {
      return decodeTokenMetadata(account.data);
    } catch {
      return null;
    }
  });

  const tokens: SolanaToken[] = [];
  const nfts: SolanaNft[] = [];
  held.forEach((account, index) => {
    const meta = metadata[index];
    const looksLikeNft =
      account.decimals === 0 &&
      account.amount === 1n &&
      !!meta &&
      !isFungible(meta);
    if (looksLikeNft && meta) {
      nfts.push({
        mint: account.mint,
        account: account.address,
        tokenProgram: account.tokenProgram,
        frozen: account.frozen,
        name:
          meta.name || `${account.mint.slice(0, 4)}…${account.mint.slice(-4)}`,
        symbol: meta.symbol,
        uri: meta.uri,
        programmable: isProgrammable(meta),
        ruleSet: meta.ruleSet,
        collection: meta.collection?.verified ? meta.collection.key : null,
        tokenStandard: meta.tokenStandard,
      });
      return;
    }
    tokens.push({
      mint: account.mint,
      account: account.address,
      amount: account.amount,
      decimals: account.decimals,
      tokenProgram: account.tokenProgram,
      frozen: account.frozen,
      name: meta?.name || undefined,
      symbol: meta?.symbol || undefined,
      uri: meta?.uri || undefined,
    });
  });
  return { lamports, tokens, nfts };
};

// ---------------------------------------------------------------------------
// Off-chain JSON metadata
// ---------------------------------------------------------------------------

const MAX_JSON_BYTES = 1024 * 1024;
const JSON_TIMEOUT_MS = 15_000;

/** Maps ipfs:// and ar:// to public gateways; keeps http(s); rejects others. */
export const resolveMediaUri = (uri?: string | null): string | null => {
  if (!uri) {
    return null;
  }
  const value = uri.trim();
  if (/^ipfs:\/\//i.test(value)) {
    return `https://ipfs.io/ipfs/${value.replace(/^ipfs:\/\/(ipfs\/)?/i, '')}`;
  }
  if (/^ar:\/\//i.test(value)) {
    return `https://arweave.net/${value.replace(/^ar:\/\//i, '')}`;
  }
  if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) {
    return value;
  }
  return null;
};

export type OffchainNftMetadata = {
  name?: string;
  description?: string;
  image?: string;
  animationUrl?: string;
  externalUrl?: string;
  attributes: Array<{ trait: string; value: string }>;
};

const text = (value: unknown, max = 2_000) =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

export const parseOffchainMetadata = (json: unknown): OffchainNftMetadata => {
  const record =
    json && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  const attributes = Array.isArray(record.attributes)
    ? record.attributes.slice(0, 100).flatMap(entry => {
        if (!entry || typeof entry !== 'object') {
          return [];
        }
        const item = entry as Record<string, unknown>;
        const value =
          typeof item.value === 'string' ||
          typeof item.value === 'number' ||
          typeof item.value === 'boolean'
            ? String(item.value).slice(0, 200)
            : null;
        return value === null
          ? []
          : [{ trait: text(item.trait_type, 200) || '', value }];
      })
    : [];
  return {
    name: text(record.name, 200),
    description: text(record.description),
    image: text(record.image, 8_192),
    animationUrl: text(record.animation_url, 8_192),
    externalUrl: text(record.external_url, 2_000),
    attributes,
  };
};

const jsonCache = new Map<string, Promise<OffchainNftMetadata | null>>();
let activeFetches = 0;
const queue: Array<() => void> = [];

const withFetchSlot = async <T>(task: () => Promise<T>) => {
  if (activeFetches >= 4) {
    await new Promise<void>(resolve => queue.push(resolve));
  }
  activeFetches += 1;
  try {
    return await task();
  } finally {
    activeFetches -= 1;
    queue.shift()?.();
  }
};

/**
 * GETs `url` as text with one overall deadline (headers and body) and a size
 * cap; the request is aborted on timeout. `null` on any failure.
 */
export const fetchTextLimited = async (
  url: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
  headers: Record<string, string> = {},
  timeoutMs = JSON_TIMEOUT_MS,
): Promise<string | null> => {
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      controller?.abort();
      resolve(null);
    }, timeoutMs);
  });
  const read = (async () => {
    const response = await fetchImpl(url, {
      headers,
      signal: controller?.signal,
    });
    if (!response.ok) {
      return null;
    }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxBytes) {
      controller?.abort();
      return null;
    }
    const body = await response.text();
    return body.length > maxBytes ? null : body;
  })().catch(() => null);
  try {
    return await Promise.race([read, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/** Off-chain JSON metadata, cached on success; failures are retried later. */
export const loadOffchainMetadata = (
  uri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OffchainNftMetadata | null> => {
  const url = resolveMediaUri(uri);
  if (!url || !/^https?:\/\//i.test(url)) {
    return Promise.resolve(null);
  }
  const cached = jsonCache.get(url);
  if (cached) {
    return cached;
  }
  const pending = withFetchSlot(async () => {
    const body = await fetchTextLimited(url, MAX_JSON_BYTES, fetchImpl, {
      accept: 'application/json',
    });
    if (body === null) {
      return null;
    }
    try {
      return parseOffchainMetadata(JSON.parse(body));
    } catch {
      return null;
    }
  });
  jsonCache.set(url, pending);
  pending.then(result => {
    if (!result && jsonCache.get(url) === pending) {
      jsonCache.delete(url);
    }
  });
  return pending;
};

export const __resetOffchainCacheForTests = () => jsonCache.clear();
