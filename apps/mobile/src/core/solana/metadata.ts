/**
 * Decoder for Metaplex Token Metadata accounts (the on-chain part of a
 * Solana NFT/token: name, symbol, off-chain JSON URI, token standard,
 * collection and programmable rule set).
 *
 * Pure module; checked against @metaplex-foundation/mpl-token-metadata on
 * real accounts. Older accounts may end before the newer optional fields, so
 * every optional tail field is read defensively.
 */
import { encodeAddress } from './keys';

export enum TokenStandard {
  NonFungible = 0,
  FungibleAsset = 1,
  Fungible = 2,
  NonFungibleEdition = 3,
  ProgrammableNonFungible = 4,
  ProgrammableNonFungibleEdition = 5,
}

export type TokenMetadata = {
  updateAuthority: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  sellerFeeBasisPoints: number;
  creators: Array<{ address: string; verified: boolean; share: number }>;
  primarySaleHappened: boolean;
  isMutable: boolean;
  tokenStandard: TokenStandard | null;
  collection: { verified: boolean; key: string } | null;
  /** Rule set of a programmable NFT, when one is configured. */
  ruleSet: string | null;
};

const METADATA_KEY_V1 = 4;
const MAX_STRING_BYTES = 1024;

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get remaining() {
    return this.bytes.length - this.offset;
  }

  u8() {
    if (this.remaining < 1) {
      throw new Error('unexpected end of metadata');
    }
    return this.bytes[this.offset++];
  }

  u16() {
    return this.u8() | (this.u8() << 8);
  }

  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  u64() {
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value |= BigInt(this.u8()) << BigInt(8 * index);
    }
    return value;
  }

  bool() {
    return this.u8() !== 0;
  }

  bytesN(length: number) {
    if (this.remaining < length) {
      throw new Error('unexpected end of metadata');
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  pubkey() {
    return encodeAddress(this.bytesN(32));
  }

  /** Borsh string; Metaplex pads names/symbols/URIs with NUL bytes. */
  string() {
    const length = this.u32();
    if (length > MAX_STRING_BYTES) {
      throw new Error('metadata string too long');
    }
    const raw = this.bytesN(length);
    let text = '';
    try {
      text = decodeURIComponent(
        Array.from(raw, byte => `%${byte.toString(16).padStart(2, '0')}`).join(
          '',
        ),
      );
    } catch {
      text = String.fromCharCode(...raw);
    }
    return text.replace(/\u0000+$/g, '').trim();
  }

  /** Reads an optional field, or `fallback` if the account ends here. */
  optional<T>(read: () => T, fallback: T): T {
    if (this.remaining < 1) {
      return fallback;
    }
    return this.bool() ? read() : fallback;
  }
}

export const decodeTokenMetadata = (data: Uint8Array): TokenMetadata => {
  const reader = new Reader(data);
  if (reader.u8() !== METADATA_KEY_V1) {
    throw new Error('not a metadata account');
  }
  const updateAuthority = reader.pubkey();
  const mint = reader.pubkey();
  const name = reader.string();
  const symbol = reader.string();
  const uri = reader.string();
  const sellerFeeBasisPoints = reader.u16();
  const creators = reader.optional(() => {
    const count = reader.u32();
    if (count > 5) {
      throw new Error('too many creators');
    }
    return Array.from({ length: count }, () => ({
      address: reader.pubkey(),
      verified: reader.bool(),
      share: reader.u8(),
    }));
  }, [] as TokenMetadata['creators']);
  const primarySaleHappened = reader.bool();
  const isMutable = reader.bool();

  let tokenStandard: TokenStandard | null = null;
  let collection: TokenMetadata['collection'] = null;
  let ruleSet: string | null = null;
  try {
    reader.optional(() => reader.u8(), null); // edition_nonce
    tokenStandard = reader.optional(() => {
      const value = reader.u8();
      return value <= TokenStandard.ProgrammableNonFungibleEdition
        ? (value as TokenStandard)
        : null;
    }, null);
    collection = reader.optional(
      () => ({ verified: reader.bool(), key: reader.pubkey() }),
      null,
    );
    reader.optional(() => {
      reader.u8(); // use_method
      reader.u64(); // remaining
      reader.u64(); // total
      return null;
    }, null); // uses
    reader.optional(() => {
      reader.u8(); // CollectionDetails variant (V1 { size } / V2 { padding })
      reader.bytesN(8);
      return null;
    }, null);
    ruleSet = reader.optional(() => {
      reader.u8(); // ProgrammableConfig::V1
      return reader.optional(() => reader.pubkey(), null);
    }, null);
  } catch {
    // Older/truncated accounts: keep the fields read so far.
  }

  return {
    updateAuthority,
    mint,
    name,
    symbol,
    uri,
    sellerFeeBasisPoints,
    creators,
    primarySaleHappened,
    isMutable,
    tokenStandard,
    collection,
    ruleSet,
  };
};

export const isProgrammable = (metadata?: TokenMetadata | null) =>
  metadata?.tokenStandard === TokenStandard.ProgrammableNonFungible ||
  metadata?.tokenStandard === TokenStandard.ProgrammableNonFungibleEdition;
