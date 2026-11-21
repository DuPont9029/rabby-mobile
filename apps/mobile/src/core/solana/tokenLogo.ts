/**
 * Token logos from Metaplex metadata: off-chain JSON `image`. Raster images
 * are shown by URL; SVG logos are fetched as text (size-capped) and
 * rasterized by the app's safe SVG pipeline, never rendered as SVG directly.
 */
import RNFS from '@rabby-wallet/react-native-fs';

import { appJsonStore } from '@/core/storage/mmkv';

const CACHE_KEY = 'helios:solanaTokenLogos:v1';
const JSON_MAX_BYTES = 64 * 1024;
const SVG_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;

const isHttps = (url: unknown): url is string =>
  typeof url === 'string' &&
  /^https:\/\/[^\s]+$/i.test(url) &&
  url.length < 2048;

const fetchText = async (url: string, maxBytes: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error('too large');
    }
    return { text, type: response.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
};

type CachedLogo = { image: string; svg: boolean };

const readCache = (): Record<string, CachedLogo> => {
  try {
    const value = appJsonStore.getItem(CACHE_KEY, null);
    return value && typeof value === 'object' ? (value as any) : {};
  } catch {
    return {};
  }
};

const memo = new Map<string, Promise<string | null>>();

/** A displayable logo URI for `mint` (https URL or local PNG), or `null`. */
export const loadSolanaTokenLogo = (
  mint: string,
  metadataUri?: string,
): Promise<string | null> => {
  const existing = memo.get(mint);
  if (existing) {
    return existing;
  }
  const pending = (async () => {
    let entry: CachedLogo | undefined = readCache()[mint];
    if (!entry) {
      if (!isHttps(metadataUri)) {
        return null;
      }
      const { text } = await fetchText(metadataUri, JSON_MAX_BYTES);
      const json = JSON.parse(text) as {
        image?: unknown;
        properties?: { files?: Array<{ uri?: unknown; type?: unknown }> };
      };
      if (!isHttps(json.image)) {
        return null;
      }
      const declared = json.properties?.files?.find(f => f.uri === json.image);
      entry = {
        image: json.image,
        svg:
          declared?.type === 'image/svg+xml' || /\.svg(\?|$)/i.test(json.image),
      };
      appJsonStore.setItem(CACHE_KEY, { ...readCache(), [mint]: entry });
    }
    if (!entry.svg) {
      return entry.image;
    }
    if (!RNFS.isSafeSvgDataRasterizationAvailable()) {
      return null;
    }
    const { text } = await fetchText(entry.image, SVG_MAX_BYTES);
    const result = await RNFS.resolveSvgData({
      svg: text,
      variant: 'thumbnail',
    });
    return result.status === 'ready' ? result.uri : null;
  })().catch(() => {
    memo.delete(mint);
    return null;
  });
  memo.set(mint, pending);
  return pending;
};
