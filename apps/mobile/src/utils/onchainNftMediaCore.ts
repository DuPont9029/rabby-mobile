/**
 * Pure helpers for NFT artwork that lives inside the token itself
 * (`data:` URLs and raw SVG markup), with no network access.
 *
 * Everything returned here is SVG markup meant for
 * `RNFS.resolveSvgData`, which runs the native safe-SVG profile check and
 * rasterizer. Nothing here renders or trusts the markup on its own.
 */
import { Buffer } from 'buffer';

/** Must not exceed the native `resolveSvgData` input limit. */
export const MAX_INLINE_SVG_BYTES = 5 * 1024 * 1024;
/** Upper bound for an on-chain `tokenURI` string we are willing to parse. */
export const MAX_TOKEN_URI_CHARS = 8 * 1024 * 1024;

const RASTER_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);
const SVG_MIME_TYPE = 'image/svg+xml';

type DecodedDataUrl = { mime: string; isBase64: boolean; payload: string };

const splitDataUrl = (value: string): DecodedDataUrl | null => {
  const trimmed = value.trim();
  if (trimmed.slice(0, 5).toLowerCase() !== 'data:') {
    return null;
  }
  const comma = trimmed.indexOf(',');
  if (comma === -1) {
    return null;
  }
  const [mime = '', ...parameters] = trimmed
    .slice(5, comma)
    .split(';')
    .map(part => part.trim());
  return {
    mime: mime.toLowerCase(),
    isBase64: parameters.some(part => part.toLowerCase() === 'base64'),
    payload: trimmed.slice(comma + 1),
  };
};

const decodePayloadToUtf8 = (
  { isBase64, payload }: DecodedDataUrl,
  maxBytes: number,
): string | null => {
  try {
    if (isBase64) {
      const compact = payload.replace(/\s+/g, '');
      if (compact.length > (maxBytes * 4) / 3 + 64) {
        return null;
      }
      const bytes = Buffer.from(compact, 'base64');
      return bytes.length <= maxBytes ? bytes.toString('utf8') : null;
    }
    if (payload.length > maxBytes * 3) {
      return null;
    }
    // Some contracts emit raw (unencoded) JSON/SVG after the comma, which
    // can contain a literal `%`; fall back to the payload as-is then.
    let text: string;
    try {
      text = decodeURIComponent(payload);
    } catch {
      text = payload;
    }
    return Buffer.byteLength(text, 'utf8') <= maxBytes ? text : null;
  } catch {
    return null;
  }
};

const escapeXmlAttribute = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const looksLikeSvgMarkup = (value: string) => {
  const head = value.trimStart().slice(0, 256).toLowerCase();
  return (
    head.startsWith('<svg') ||
    (head.startsWith('<?xml') && head.includes('<svg'))
  );
};

/** Cheap pre-check (no decoding) for values `inlineImageToSvg` may accept. */
export const mayBeInlineImage = (value?: unknown): boolean => {
  if (typeof value !== 'string') {
    return false;
  }
  const head = value.trimStart().slice(0, 16).toLowerCase();
  return (
    head.startsWith('data:image/') ||
    head.startsWith('<svg') ||
    head.startsWith('<?xml')
  );
};

/**
 * Turns an NFT image value into SVG markup for the native renderer, or
 * `null` when it is not inline artwork:
 * - `data:image/svg+xml` (base64 or percent-encoded) and raw `<svg>` markup
 *   are returned as markup;
 * - `data:image/{png,jpeg,gif,webp}` is wrapped in a minimal SVG so it goes
 *   through the same native checks (format, dimensions, pixel budget).
 *
 * Remote URLs (`https:`, `ipfs:`, `ar:` ...) always return `null`: fetching
 * them would contact a server chosen by the NFT's creator.
 */
export const inlineImageToSvg = (value?: unknown): string | null => {
  if (typeof value !== 'string' || !value) {
    return null;
  }
  if (looksLikeSvgMarkup(value)) {
    return Buffer.byteLength(value, 'utf8') <= MAX_INLINE_SVG_BYTES
      ? value
      : null;
  }
  const dataUrl = splitDataUrl(value);
  if (!dataUrl) {
    return null;
  }
  if (dataUrl.mime === SVG_MIME_TYPE) {
    const svg = decodePayloadToUtf8(dataUrl, MAX_INLINE_SVG_BYTES);
    return svg && looksLikeSvgMarkup(svg) ? svg : null;
  }
  if (RASTER_MIME_TYPES.has(dataUrl.mime)) {
    const href = value.trim();
    // Leave room for the wrapper markup.
    if (href.length > MAX_INLINE_SVG_BYTES - 512) {
      return null;
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">' +
      `<image width="1" height="1" image-rendering="optimizeSpeed" href="${escapeXmlAttribute(
        href,
      )}"/></svg>`
    );
  }
  return null;
};

export type NftAttribute = { trait: string; value: string };

export type OnchainNftMetadata = {
  name?: string;
  description?: string;
  image?: unknown;
  image_data?: unknown;
  animation_url?: unknown;
  /** Display-only, as text. `external_url` is never opened automatically. */
  externalUrl?: string;
  attributes?: NftAttribute[];
  /** Pretty-printed JSON for display, long strings (e.g. images) shortened. */
  raw?: string;
};

const MAX_ATTRIBUTES = 100;
const MAX_ATTRIBUTE_CHARS = 200;
const MAX_RAW_STRING_CHARS = 160;
const MAX_RAW_CHARS = 20_000;

const attributeText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value.slice(0, MAX_ATTRIBUTE_CHARS);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
};

/** Reads OpenSea-style `attributes` (or `traits`) as plain text pairs. */
const parseAttributes = (value: unknown): NftAttribute[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const attributes: NftAttribute[] = [];
  for (const entry of value.slice(0, MAX_ATTRIBUTES)) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const trait =
      attributeText(record.trait_type) ?? attributeText(record.trait) ?? '';
    const text = attributeText(record.value);
    if (text !== null) {
      attributes.push({ trait, value: text });
    }
  }
  return attributes;
};

/** JSON for display: long strings (embedded images, scripts) are shortened. */
export const toDisplayJson = (value: unknown): string => {
  try {
    const text = JSON.stringify(
      value,
      (_key, item) =>
        typeof item === 'string' && item.length > MAX_RAW_STRING_CHARS
          ? `${item.slice(0, MAX_RAW_STRING_CHARS)}… (${item.length} chars)`
          : item,
      2,
    );
    return text.length > MAX_RAW_CHARS
      ? `${text.slice(0, MAX_RAW_CHARS)}\n…`
      : text;
  } catch {
    return '';
  }
};

/**
 * Parses token metadata that is stored on-chain as a
 * `data:application/json` URL. Remote token URIs return `null` and are never
 * fetched.
 */
export const parseInlineTokenUri = (
  tokenUri?: string | null,
): OnchainNftMetadata | null => {
  if (!tokenUri || tokenUri.length > MAX_TOKEN_URI_CHARS) {
    return null;
  }
  const dataUrl = splitDataUrl(tokenUri);
  if (!dataUrl || dataUrl.mime !== 'application/json') {
    return null;
  }
  const json = decodePayloadToUtf8(dataUrl, MAX_TOKEN_URI_CHARS);
  if (!json) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const metadata = parsed as Record<string, unknown>;
    const text = (key: string) =>
      typeof metadata[key] === 'string'
        ? (metadata[key] as string).slice(0, 2_000)
        : undefined;
    return {
      name: text('name'),
      description: text('description'),
      image: metadata.image,
      image_data: metadata.image_data,
      animation_url: metadata.animation_url,
      externalUrl: text('external_url'),
      attributes: parseAttributes(metadata.attributes ?? metadata.traits),
      raw: toDisplayJson(metadata),
    };
  } catch {
    return null;
  }
};

/**
 * Picks the first inline artwork from on-chain metadata. `animation_url` is
 * only used when it is itself an inline image: HTML/JS animations are never
 * executed.
 */
export const inlineSvgFromMetadata = (
  metadata?: OnchainNftMetadata | null,
): string | null => {
  if (!metadata) {
    return null;
  }
  return (
    inlineImageToSvg(metadata.image) ??
    inlineImageToSvg(metadata.image_data) ??
    inlineImageToSvg(metadata.animation_url)
  );
};

/**
 * Builds the on-chain reference `Media` needs from an indexed NFT
 * (`chain`, `contract_id`, `inner_id`), or `undefined` when incomplete.
 */
export const toOnchainNftRef = (
  nft?: {
    chain?: string | null;
    contract_id?: string | null;
    inner_id?: string | number | null;
  } | null,
) => {
  const chain = nft?.chain;
  const contractId = nft?.contract_id;
  const tokenId =
    nft?.inner_id === undefined || nft?.inner_id === null
      ? ''
      : String(nft.inner_id);
  if (
    !chain ||
    !contractId ||
    !/^0x[0-9a-fA-F]{40}$/.test(contractId) ||
    !/^\d{1,78}$/.test(tokenId)
  ) {
    return undefined;
  }
  return { chain, contractId, tokenId };
};
