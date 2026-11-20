/**
 * Solana keys for Helios Wallet: SLIP-0010 ed25519 derivation from the same
 * BIP39/SLIP39 seed as the EVM accounts, base58 addresses and PDAs.
 *
 * Pure module (no app imports) so it can be checked against @solana/web3.js
 * outside the app. Built only on audited libraries (@noble/*, @scure/base).
 */
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { base58 } from '@scure/base';
import { Buffer } from 'buffer';

export const PUBLIC_KEY_LENGTH = 32;

/**
 * Phantom/Solflare-compatible path for account `index`:
 * m/44'/501'/index'/0' (every level hardened, as ed25519 requires).
 */
export const solanaPathForIndex = (index: number) => {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error('invalid Solana account index');
  }
  return `m/44'/501'/${index}'/0'`;
};

const HARDENED = 0x80000000;
export const utf8 = (text: string) =>
  Uint8Array.from(Buffer.from(text, 'utf8'));

const ED25519_SEED = utf8('ed25519 seed');

const parsePath = (path: string) => {
  const parts = path.split('/');
  if (parts[0] !== 'm') {
    throw new Error('invalid derivation path');
  }
  return parts.slice(1).map(part => {
    if (!/^\d+'$/.test(part)) {
      // SLIP-0010 ed25519 only supports hardened derivation.
      throw new Error('ed25519 derivation requires hardened indexes');
    }
    const index = Number(part.slice(0, -1));
    if (index >= HARDENED) {
      throw new Error('derivation index out of range');
    }
    return index + HARDENED;
  });
};

/**
 * SLIP-0010 ed25519 private key (32-byte seed) for `path` from a BIP32
 * master seed. Intermediate key material is wiped before returning.
 */
export const deriveEd25519PrivateKey = (
  seed: Uint8Array,
  path: string,
): Uint8Array => {
  if (seed.length < 16 || seed.length > 64) {
    throw new Error('invalid seed length');
  }
  let digest = hmac(sha512, ED25519_SEED, seed);
  let key = digest.slice(0, 32);
  let chainCode = digest.slice(32);
  digest.fill(0);
  for (const index of parsePath(path)) {
    const data = new Uint8Array(1 + 32 + 4);
    data.set(key, 1);
    new DataView(data.buffer).setUint32(33, index, false);
    digest = hmac(sha512, chainCode, data);
    data.fill(0);
    key.fill(0);
    chainCode.fill(0);
    key = digest.slice(0, 32);
    chainCode = digest.slice(32);
    digest.fill(0);
  }
  chainCode.fill(0);
  return key;
};

export const publicKeyFromPrivateKey = (privateKey: Uint8Array) =>
  ed25519.getPublicKey(privateKey);

export const signMessage = (message: Uint8Array, privateKey: Uint8Array) =>
  ed25519.sign(message, privateKey);

export const verifySignature = (
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
) => {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
};

export const encodeAddress = (publicKey: Uint8Array) => {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) {
    throw new Error('invalid public key length');
  }
  return base58.encode(publicKey);
};

/** Decodes a base58 address; throws unless it is exactly 32 bytes. */
export const decodeAddress = (address: string): Uint8Array => {
  const bytes = base58.decode(address.trim());
  if (bytes.length !== PUBLIC_KEY_LENGTH) {
    throw new Error('invalid Solana address');
  }
  return bytes;
};

export const isValidAddress = (address: string) => {
  try {
    decodeAddress(address);
    return true;
  } catch {
    return false;
  }
};

/** Whether 32 bytes are a valid ed25519 point (a key a wallet could own). */
export const isOnCurve = (publicKey: Uint8Array) => {
  try {
    ed25519.ExtendedPoint.fromHex(publicKey);
    return true;
  } catch {
    return false;
  }
};

const PDA_MARKER = utf8('ProgramDerivedAddress');

const concatBytes = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** `findProgramAddressSync`: the first off-curve address from bump 255 down. */
export const findProgramAddress = (
  seeds: Uint8Array[],
  programId: Uint8Array,
): [Uint8Array, number] => {
  if (seeds.length > 15 || seeds.some(seed => seed.length > 32)) {
    throw new Error('invalid PDA seeds');
  }
  for (let bump = 255; bump >= 0; bump -= 1) {
    const candidate = sha256(
      concatBytes(...seeds, Uint8Array.of(bump), programId, PDA_MARKER),
    );
    if (!isOnCurve(candidate)) {
      return [candidate, bump];
    }
  }
  throw new Error('no viable PDA bump');
};

export const bytesEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((value, index) => value === b[index]);
