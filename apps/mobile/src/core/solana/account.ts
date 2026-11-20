/**
 * Solana accounts derived from the wallet's seed-phrase (HD) accounts.
 *
 * EVM account #i of an HD keyring maps to Solana account #i on the
 * Phantom-compatible path m/44'/501'/i'/0'. The seed comes from the keyring
 * itself (`getSeed`, so BIP39 passphrases and SLIP39 work as for EVM), and
 * before any Solana key is used the same seed must reproduce the EVM
 * address: if it does not (e.g. a passphrase that is not loaded), nothing is
 * derived.
 *
 * Private keys are derived only inside `withSolanaSigner`, used, and wiped.
 * Only public addresses are cached.
 */
import { HDKey } from '@scure/bip32';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { KEYRING_CLASS } from '@rabby-wallet/keyring-utils';

import { keyringServiceApi } from '@/core/serviceApi/keyring';
import {
  deriveEd25519PrivateKey,
  encodeAddress,
  publicKeyFromPrivateKey,
  solanaPathForIndex,
} from './keys';

type HdKeyringLike = {
  mnemonic?: string | null;
  passphrase?: string | null;
  getSeed: (mnemonic: string, passphrase?: string) => Uint8Array;
  getInfoByAddress: (address: string) => { index?: number } | null;
  getPathForIndex: (index: number) => string;
};

export type SolanaAccount = {
  evmAddress: string;
  index: number;
  address: string;
};

export class SolanaAccountError extends Error {
  constructor(
    readonly reason:
      | 'not_hd_account'
      | 'seed_mismatch'
      | 'locked'
      | 'key_mismatch',
  ) {
    super(reason);
    this.name = 'SolanaAccountError';
  }
}

const evmAddressFromSeed = (seed: Uint8Array, path: string) => {
  const child = HDKey.fromMasterSeed(seed).derive(path);
  if (!child.publicKey) {
    throw new SolanaAccountError('seed_mismatch');
  }
  const uncompressed = secp256k1.ProjectivePoint.fromHex(
    child.publicKey,
  ).toRawBytes(false);
  child.wipePrivateData();
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
};

const loadKeyring = async (evmAddress: string) => {
  try {
    return (await keyringServiceApi.getKeyringForAccount(
      evmAddress,
      KEYRING_CLASS.MNEMONIC,
    )) as unknown as HdKeyringLike;
  } catch {
    throw new SolanaAccountError('not_hd_account');
  }
};

/**
 * Runs `use` with the seed of the HD keyring that owns `evmAddress`, after
 * checking the seed reproduces that EVM address. The seed is wiped after.
 */
const withVerifiedSeed = async <T>(
  evmAddress: string,
  use: (seed: Uint8Array, index: number) => T,
): Promise<T> => {
  const keyring = await loadKeyring(evmAddress);
  if (!keyring?.mnemonic) {
    throw new SolanaAccountError('locked');
  }
  const info = keyring.getInfoByAddress(evmAddress.toLowerCase());
  const index = info?.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new SolanaAccountError('not_hd_account');
  }
  const seed = Uint8Array.from(
    keyring.getSeed(keyring.mnemonic, keyring.passphrase || ''),
  );
  try {
    const derived = evmAddressFromSeed(seed, keyring.getPathForIndex(index));
    if (derived.toLowerCase() !== evmAddress.toLowerCase()) {
      throw new SolanaAccountError('seed_mismatch');
    }
    return use(seed, index);
  } finally {
    seed.fill(0);
  }
};

const addressCache = new Map<string, SolanaAccount>();

/** The Solana account paired with a seed-phrase EVM account. */
export const getSolanaAccount = async (
  evmAddress: string,
): Promise<SolanaAccount> => {
  const key = evmAddress.toLowerCase();
  const cached = addressCache.get(key);
  if (cached) {
    return cached;
  }
  const account = await withVerifiedSeed(evmAddress, (seed, index) => {
    const privateKey = deriveEd25519PrivateKey(seed, solanaPathForIndex(index));
    try {
      return {
        evmAddress: key,
        index,
        address: encodeAddress(publicKeyFromPrivateKey(privateKey)),
      };
    } finally {
      privateKey.fill(0);
    }
  });
  addressCache.set(key, account);
  return account;
};

/**
 * Derives the Solana private key for `account` only for the duration of
 * `use`, after checking it still matches the expected address, then wipes
 * it.
 */
export const withSolanaSigner = async <T>(
  account: SolanaAccount,
  use: (privateKey: Uint8Array) => T,
): Promise<T> =>
  withVerifiedSeed(account.evmAddress, (seed, index) => {
    if (index !== account.index) {
      throw new SolanaAccountError('key_mismatch');
    }
    const privateKey = deriveEd25519PrivateKey(seed, solanaPathForIndex(index));
    try {
      if (
        encodeAddress(publicKeyFromPrivateKey(privateKey)) !== account.address
      ) {
        throw new SolanaAccountError('key_mismatch');
      }
      return use(privateKey);
    } finally {
      privateKey.fill(0);
    }
  });

export const __resetSolanaAccountCacheForTests = () => addressCache.clear();
