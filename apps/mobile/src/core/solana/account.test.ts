import HdKeyring from '@rabby-wallet/eth-hd-keyring';

import vectors from './__fixtures__/reference-vectors.json';
import {
  __resetSolanaAccountCacheForTests,
  getCachedSolanaAccount,
  getSolanaAccount,
  SolanaAccountError,
  withSolanaSigner,
} from './account';
import {
  ensureKeyringRuntimeReadyForApi,
  getKeyringInstancesSnapshot,
  isKeyringUnlockedSnapshot,
  keyringServiceApi,
} from '@/core/serviceApi/keyring';

jest.mock('@/core/serviceApi/keyring', () => ({
  keyringServiceApi: { getKeyringForAccount: jest.fn() },
  getKeyringInstancesSnapshot: jest.fn(() => []),
  isKeyringUnlockedSnapshot: jest.fn(() => true),
  ensureKeyringRuntimeReadyForApi: jest.fn(async () => undefined),
}));

const mockStore = new Map<string, unknown>();
jest.mock('@/core/storage/mmkv', () => ({
  appJsonStore: {
    getItem: (key: string, fallback: unknown) =>
      mockStore.has(key) ? mockStore.get(key) : fallback,
    setItem: (key: string, value: unknown) => mockStore.set(key, value),
  },
}));

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const makeKeyring = async (passphrase = '') => {
  const keyring = new HdKeyring({ mnemonic: MNEMONIC, passphrase });
  await keyring.activeAccounts([0, 1]);
  return keyring;
};

const reasonOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof SolanaAccountError ? error.reason : String(error);
  }
  return 'none';
};

describe('Solana accounts derived from HD keyrings', () => {
  beforeEach(() => {
    __resetSolanaAccountCacheForTests();
    mockStore.clear();
    jest.clearAllMocks();
    jest.mocked(isKeyringUnlockedSnapshot).mockReturnValue(true);
    jest.mocked(getKeyringInstancesSnapshot).mockReturnValue([]);
  });

  it('pairs EVM account #i with the Phantom Solana account #i', async () => {
    const keyring = await makeKeyring();
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockResolvedValue(keyring as never);
    const [first, second] = await keyring.getAccounts();

    await expect(getSolanaAccount(first)).resolves.toMatchObject({
      index: 0,
      address: vectors.derivation[0].address,
    });
    await expect(getSolanaAccount(second)).resolves.toMatchObject({
      index: 1,
      address: vectors.derivation[1].address,
    });
  });

  it('uses the BIP39 passphrase like the EVM accounts', async () => {
    const keyring = await makeKeyring('TREZOR');
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockResolvedValue(keyring as never);
    const [first] = await keyring.getAccounts();

    await expect(getSolanaAccount(first)).resolves.toMatchObject({
      address: vectors.derivation[3].address,
    });
  });

  it('refuses to derive when the seed does not reproduce the EVM address', async () => {
    const keyring = await makeKeyring('TREZOR');
    const [first] = await keyring.getAccounts();
    // e.g. the passphrase is not loaded: the seed differs from the one that
    // produced the EVM account.
    (keyring as unknown as { passphrase: string }).passphrase = '';
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockResolvedValue(keyring as never);

    expect(await reasonOf(getSolanaAccount(first))).toBe('seed_mismatch');
  });

  it('rejects addresses held by a non seed-phrase keyring', async () => {
    const address = '0x0000000000000000000000000000000000000001';
    jest
      .mocked(getKeyringInstancesSnapshot)
      .mockReturnValue([
        { type: 'Simple Key Pair', accounts: [address] },
      ] as never);
    expect(await reasonOf(getSolanaAccount(address))).toBe('not_hd_account');
  });

  it('reports a keyring that is still loading as not ready, not as "not a seed wallet"', async () => {
    jest.useFakeTimers();
    try {
      jest
        .mocked(keyringServiceApi.getKeyringForAccount)
        .mockRejectedValue(new Error('no keyring'));
      const pending = reasonOf(
        getSolanaAccount('0x0000000000000000000000000000000000000001'),
      );
      await jest.runAllTimersAsync();
      expect(await pending).toBe('not_ready');
      expect(ensureKeyringRuntimeReadyForApi).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for the keyring runtime instead of failing during unlock', async () => {
    const keyring = await makeKeyring();
    const [first] = await keyring.getAccounts();
    // The keyring appears only after the runtime finished loading.
    jest
      .mocked(ensureKeyringRuntimeReadyForApi)
      .mockImplementationOnce(async () => {
        jest
          .mocked(getKeyringInstancesSnapshot)
          .mockReturnValue([keyring] as never);
      });
    await expect(getSolanaAccount(first)).resolves.toMatchObject({
      address: vectors.derivation[0].address,
    });
  });

  it('reports a locked wallet as locked', async () => {
    jest.useFakeTimers();
    try {
      jest.mocked(isKeyringUnlockedSnapshot).mockReturnValue(false);
      const pending = reasonOf(
        getSolanaAccount('0x0000000000000000000000000000000000000001'),
      );
      await jest.runAllTimersAsync();
      expect(await pending).toBe('locked');
    } finally {
      jest.useRealTimers();
    }
  });

  it('remembers the public Solana address for the next start', async () => {
    const keyring = await makeKeyring();
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockResolvedValue(keyring as never);
    const [first] = await keyring.getAccounts();
    await getSolanaAccount(first);
    __resetSolanaAccountCacheForTests();
    expect(getCachedSolanaAccount(first)).toMatchObject({
      index: 0,
      address: vectors.derivation[0].address,
    });
  });

  it('hands out the private key only inside the signer, then wipes it', async () => {
    const keyring = await makeKeyring();
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockResolvedValue(keyring as never);
    const [first] = await keyring.getAccounts();
    const account = await getSolanaAccount(first);

    let seen: Uint8Array | null = null;
    const length = await withSolanaSigner(account, privateKey => {
      seen = privateKey;
      return privateKey.length;
    });
    expect(length).toBe(32);
    expect(seen!.every(byte => byte === 0)).toBe(true);

    expect(
      await reasonOf(
        withSolanaSigner(
          { ...account, address: vectors.derivation[1].address },
          () => 0,
        ),
      ),
    ).toBe('key_mismatch');
  });

  it('finds the index itself when the keyring recorded no account details', async () => {
    const keyring = await makeKeyring();
    const [, second] = await keyring.getAccounts();
    // Older imports: no accountDetails, and no getInfoByAddress at all.
    const bare = {
      type: 'HD Key Tree',
      accounts: [second],
      mnemonic: MNEMONIC,
      passphrase: '',
    };
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockResolvedValue(bare as never);

    await expect(getSolanaAccount(second)).resolves.toMatchObject({
      index: 1,
      address: vectors.derivation[1].address,
    });
  });

  it('uses the live keyring instance when the service lookup fails', async () => {
    const keyring = await makeKeyring();
    const [first] = await keyring.getAccounts();
    jest
      .mocked(getKeyringInstancesSnapshot)
      .mockReturnValue([keyring] as never);
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockRejectedValue(new Error('runtime not ready'));

    await expect(
      getSolanaAccount(first.toUpperCase().replace('0X', '0x')),
    ).resolves.toMatchObject({
      address: vectors.derivation[0].address,
    });
    jest.mocked(getKeyringInstancesSnapshot).mockReturnValue([] as never);
  });

  it('finds accounts created on the Legacy and Ledger Live paths', async () => {
    for (const hdPath of ["m/44'/60'/0'", "m/44'/60'/0'/0/0"]) {
      __resetSolanaAccountCacheForTests();
      const keyring = new HdKeyring({ mnemonic: MNEMONIC, hdPath });
      await keyring.activeAccounts([2]);
      const [address] = await keyring.getAccounts();
      jest
        .mocked(keyringServiceApi.getKeyringForAccount)
        .mockResolvedValue(keyring as never);

      await expect(getSolanaAccount(address)).resolves.toMatchObject({
        index: 2,
        address:
          vectors.derivation.find(d => d.index === 2)?.address ??
          expect.any(String),
      });
    }
  });

  it('still refuses when no index of the seed produces the address', async () => {
    const bare = {
      type: 'HD Key Tree',
      accounts: ['0x000000000000000000000000000000000000dead'],
      mnemonic: MNEMONIC,
    };
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockResolvedValue(bare as never);

    expect(
      await reasonOf(
        getSolanaAccount('0x000000000000000000000000000000000000dEaD'),
      ),
    ).toBe('seed_mismatch');
  });
});
