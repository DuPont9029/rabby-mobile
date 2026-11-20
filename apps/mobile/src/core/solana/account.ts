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

import {
  getKeyringInstancesSnapshot,
  keyringServiceApi,
} from '@/core/serviceApi/keyring';
import { mnemonicToSeedSync } from '@scure/bip39';
import {
  deriveEd25519PrivateKey,
  encodeAddress,
  publicKeyFromPrivateKey,
  solanaPathForIndex,
} from './keys';

type HdKeyringLike = {
  type?: string;
  accounts?: string[];
  mnemonic?: string | null;
  passphrase?: string | null;
  hdPath?: string;
  getSeed?: (mnemonic: string, passphrase?: string) => Uint8Array;
  getInfoByAddress?: (
    address: string,
  ) => { index?: number; hdPath?: string } | null;
};

const HD_PATH_BASES = {
  bip44: "m/44'/60'/0'/0",
  legacy: "m/44'/60'/0'",
  ledgerLive: "m/44'/60'/0'/0/0",
};
/** How far the index search goes when the keyring has no account details. */
const MAX_SCANNED_INDEX = 100;

/**
 * EVM path of account `index` under the HD path that account was created
 * with (a keyring can mix BIP44, Legacy and Ledger Live accounts).
 */
const evmPathFor = (hdPath: string, index: number) =>
  hdPath === HD_PATH_BASES.ledgerLive
    ? `m/44'/60'/${index}'/0/0`
    : `${hdPath}/${index}`;

export type SolanaAccount = {
  evmAddress: string;
  index: number;
  address: string;
};

export type SolanaAccountErrorReason =
  | 'not_hd_account'
  | 'seed_mismatch'
  | 'locked'
  | 'key_mismatch';

export class SolanaAccountError extends Error {
  constructor(readonly reason: SolanaAccountErrorReason) {
    super(reason);
    this.name = 'SolanaAccountError';
  }
}

const evmAddressFromKey = (key: HDKey) => {
  if (!key.publicKey) {
    throw new SolanaAccountError('seed_mismatch');
  }
  const uncompressed = secp256k1.ProjectivePoint.fromHex(
    key.publicKey,
  ).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(-20))}`;
};

/**
 * The index of `evmAddress` under the seed, with the path it was found on.
 * Tries the index the keyring recorded first, then searches the standard
 * paths (keyrings imported long ago may not record account details). The
 * search itself is the cross-check: only an index whose derived EVM address
 * equals `evmAddress` is ever returned.
 */
const findAccountIndex = (
  seed: Uint8Array,
  evmAddress: string,
  hint: { index?: number; hdPath?: string },
): number | null => {
  const target = evmAddress.toLowerCase();
  const master = HDKey.fromMasterSeed(seed);
  try {
    const matches = (path: string) => {
      const child = master.derive(path);
      try {
        return evmAddressFromKey(child).toLowerCase() === target;
      } finally {
        child.wipePrivateData();
      }
    };
    const paths = [
      hint.hdPath,
      HD_PATH_BASES.bip44,
      HD_PATH_BASES.legacy,
      HD_PATH_BASES.ledgerLive,
    ].filter(
      (path, i, all): path is string => !!path && all.indexOf(path) === i,
    );
    if (
      typeof hint.index === 'number' &&
      Number.isInteger(hint.index) &&
      hint.index >= 0
    ) {
      for (const base of paths) {
        if (matches(evmPathFor(base, hint.index))) {
          return hint.index;
        }
      }
    }
    for (const base of paths) {
      if (base === HD_PATH_BASES.ledgerLive) {
        // Ledger Live hardens the account level: derive each path in full.
        for (let index = 0; index < MAX_SCANNED_INDEX; index += 1) {
          if (matches(evmPathFor(base, index))) {
            return index;
          }
        }
        continue;
      }
      // Derive the parent once; children are one cheap step each.
      const parent = master.derive(base);
      try {
        for (let index = 0; index < MAX_SCANNED_INDEX; index += 1) {
          const child = parent.deriveChild(index);
          try {
            if (evmAddressFromKey(child).toLowerCase() === target) {
              return index;
            }
          } finally {
            child.wipePrivateData();
          }
        }
      } finally {
        parent.wipePrivateData();
      }
    }
    return null;
  } finally {
    master.wipePrivateData();
  }
};

/** The live HD keyring instance that holds `evmAddress`. */
const loadKeyring = async (
  evmAddress: string,
): Promise<HdKeyringLike | null> => {
  const target = evmAddress.toLowerCase();
  const holds = (keyring?: HdKeyringLike | null) =>
    !!keyring &&
    keyring.type === KEYRING_CLASS.MNEMONIC &&
    Array.isArray(keyring.accounts) &&
    keyring.accounts.some(account => account?.toLowerCase() === target);
  let fromSnapshot: HdKeyringLike | null = null;
  try {
    fromSnapshot =
      (getKeyringInstancesSnapshot() as unknown as HdKeyringLike[]).find(
        holds,
      ) || null;
  } catch {
    // Snapshot not available yet: ask the service below.
  }
  if (fromSnapshot?.mnemonic) {
    return fromSnapshot;
  }
  try {
    const keyring = (await keyringServiceApi.getKeyringForAccount(
      evmAddress,
      KEYRING_CLASS.MNEMONIC,
    )) as unknown as HdKeyringLike;
    return keyring || fromSnapshot;
  } catch {
    return fromSnapshot;
  }
};

const seedOf = (keyring: HdKeyringLike, mnemonic: string) => {
  const passphrase = keyring.passphrase || '';
  const raw =
    typeof keyring.getSeed === 'function'
      ? keyring.getSeed(mnemonic, passphrase)
      : mnemonicToSeedSync(mnemonic, passphrase);
  const seed = Uint8Array.from(raw);
  raw.fill(0);
  return seed;
};

/**
 * Runs `use` with the seed of the HD keyring that owns `evmAddress`, after
 * checking the seed reproduces that EVM address. The seed is wiped after.
 */
const withVerifiedSeed = async <T>(
  evmAddress: string,
  // Synchronous on purpose: key material is wiped as soon as it returns.
  use: (
    seed: Uint8Array,
    index: number,
  ) => T extends Promise<unknown> ? never : T,
): Promise<T> => {
  const keyring = await loadKeyring(evmAddress);
  if (!keyring) {
    throw new SolanaAccountError('not_hd_account');
  }
  if (!keyring.mnemonic) {
    throw new SolanaAccountError('locked');
  }
  let hint: { index?: number; hdPath?: string } = {};
  try {
    hint =
      keyring.getInfoByAddress?.(evmAddress.toLowerCase()) ||
      keyring.getInfoByAddress?.(evmAddress) ||
      {};
  } catch {
    hint = {};
  }
  if (!hint.hdPath && keyring.hdPath) {
    hint = { ...hint, hdPath: keyring.hdPath };
  }
  const seed = seedOf(keyring, keyring.mnemonic);
  try {
    const index = findAccountIndex(seed, evmAddress, hint);
    if (index === null) {
      // The seed does not produce this address (e.g. passphrase not loaded).
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
  // Synchronous on purpose: the key is wiped as soon as `use` returns.
  use: (privateKey: Uint8Array) => T extends Promise<unknown> ? never : T,
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
