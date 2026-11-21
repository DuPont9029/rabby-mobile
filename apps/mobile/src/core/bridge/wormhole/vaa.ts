/**
 * Wormhole VAA (signed message) parsing and local signature verification.
 *
 * A VAA is accepted only if more than 2/3 of the current guardian set signed
 * its body hash; the guardian set itself is read from the Ethereum core
 * contract (through Helios, so it is verified against the chain). Where the
 * VAA bytes were downloaded from therefore does not matter.
 *
 * Layout: version u8 | guardian_set_index u32 | n u8 |
 *   n × (guardian_index u8, r 32, s 32, v u8) | body
 * body:  timestamp u32 | nonce u32 | emitter_chain u16 | emitter 32 |
 *   sequence u64 | consistency u8 | payload
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

export type GuardianSignature = {
  guardianIndex: number;
  /** r ‖ s ‖ recovery id (65 bytes). */
  signature: Uint8Array;
};

export type ParsedVaa = {
  version: number;
  guardianSetIndex: number;
  signatures: GuardianSignature[];
  timestamp: number;
  nonce: number;
  emitterChain: number;
  emitterAddress: Uint8Array;
  sequence: bigint;
  consistencyLevel: number;
  payload: Uint8Array;
  body: Uint8Array;
  /** keccak256(keccak256(body)): what guardians sign. */
  digest: Uint8Array;
  /** keccak256(body): the hash Solana uses for the PostedVAA address. */
  hash: Uint8Array;
};

export type TokenTransfer = {
  amount: bigint;
  tokenAddress: Uint8Array;
  tokenChain: number;
  to: Uint8Array;
  toChain: number;
  fee: bigint;
};

const SIGNATURE_LENGTH = 65;

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(length: number) {
    if (this.offset + length > this.bytes.length) {
      throw new Error('VAA too short');
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
  u8() {
    return this.take(1)[0]!;
  }
  u16() {
    const b = this.take(2);
    return (b[0]! << 8) | b[1]!;
  }
  u32() {
    const b = this.take(4);
    return ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  }
  u64() {
    return BigInt(`0x${bytesToHex(this.take(8))}`);
  }
  u256() {
    return BigInt(`0x${bytesToHex(this.take(32))}`);
  }
}

export const parseVaa = (bytes: Uint8Array): ParsedVaa => {
  const reader = new Reader(bytes);
  const version = reader.u8();
  if (version !== 1) {
    throw new Error(`unsupported VAA version ${version}`);
  }
  const guardianSetIndex = reader.u32();
  const count = reader.u8();
  const signatures: GuardianSignature[] = [];
  for (let i = 0; i < count; i += 1) {
    const guardianIndex = reader.u8();
    signatures.push({
      guardianIndex,
      signature: Uint8Array.from(reader.take(SIGNATURE_LENGTH)),
    });
  }
  const bodyStart = reader.offset;
  const body = Uint8Array.from(bytes.subarray(bodyStart));
  const timestamp = reader.u32();
  const nonce = reader.u32();
  const emitterChain = reader.u16();
  const emitterAddress = Uint8Array.from(reader.take(32));
  const sequence = reader.u64();
  const consistencyLevel = reader.u8();
  const payload = Uint8Array.from(bytes.subarray(reader.offset));
  const hash = keccak_256(body);
  return {
    version,
    guardianSetIndex,
    signatures,
    timestamp,
    nonce,
    emitterChain,
    emitterAddress,
    sequence,
    consistencyLevel,
    payload,
    body,
    hash,
    digest: keccak_256(hash),
  };
};

/** Token Bridge transfer payload (type 1). */
export const parseTokenTransfer = (payload: Uint8Array): TokenTransfer => {
  const reader = new Reader(payload);
  if (reader.u8() !== 1) {
    throw new Error('not a token transfer');
  }
  const amount = reader.u256();
  const tokenAddress = Uint8Array.from(reader.take(32));
  const tokenChain = reader.u16();
  const to = Uint8Array.from(reader.take(32));
  const toChain = reader.u16();
  const fee = reader.u256();
  if (reader.offset !== payload.length) {
    throw new Error('unexpected bytes after transfer payload');
  }
  return { amount, tokenAddress, tokenChain, to, toChain, fee };
};

const ethAddressOf = (publicKey: Uint8Array) =>
  `0x${bytesToHex(keccak_256(publicKey.subarray(1)).subarray(12))}`;

/** Guardian quorum: more than 2/3 of the set. */
export const quorum = (guardianCount: number) =>
  Math.floor((guardianCount * 2) / 3) + 1;

/**
 * Checks that a quorum of distinct guardians of `guardians` (lower-case
 * 0x addresses, in set order) signed the VAA. Signatures must be in strictly
 * increasing guardian order, as the core contracts require.
 */
export const verifyVaaSignatures = (
  vaa: ParsedVaa,
  guardians: string[],
): boolean => {
  if (!guardians.length || vaa.signatures.length < quorum(guardians.length)) {
    return false;
  }
  let previous = -1;
  for (const { guardianIndex, signature } of vaa.signatures) {
    if (guardianIndex <= previous || guardianIndex >= guardians.length) {
      return false;
    }
    previous = guardianIndex;
    const recovery = signature[64] ?? 255;
    if (recovery > 3) {
      return false;
    }
    try {
      const sig = secp256k1.Signature.fromCompact(
        signature.subarray(0, 64),
      ).addRecoveryBit(recovery);
      const publicKey = sig.recoverPublicKey(vaa.digest).toRawBytes(false);
      if (
        ethAddressOf(publicKey) !==
        (guardians[guardianIndex] || '').toLowerCase()
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
};

/** Keeps only the first `count` signatures (fewer bytes to post on Solana). */
export const withFirstSignatures = (
  vaa: ParsedVaa,
  count: number,
): ParsedVaa => ({ ...vaa, signatures: vaa.signatures.slice(0, count) });

export const evmAddressToBytes32 = (address: string) => {
  const raw = hexToBytes(address.replace(/^0x/, '').toLowerCase());
  if (raw.length !== 20) {
    throw new Error('invalid EVM address');
  }
  const out = new Uint8Array(32);
  out.set(raw, 12);
  return out;
};
