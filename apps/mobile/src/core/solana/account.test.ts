import HdKeyring from '@rabby-wallet/eth-hd-keyring';

import vectors from './__fixtures__/reference-vectors.json';
import {
  __resetSolanaAccountCacheForTests,
  getSolanaAccount,
  SolanaAccountError,
  withSolanaSigner,
} from './account';
import {
  getKeyringInstancesSnapshot,
  keyringServiceApi,
} from '@/core/serviceApi/keyring';

jest.mock('@/core/serviceApi/keyring', () => ({
  keyringServiceApi: { getKeyringForAccount: jest.fn() },
  getKeyringInstancesSnapshot: jest.fn(() => []),
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
    jest.clearAllMocks();
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

  it('rejects addresses that are not seed-phrase accounts', async () => {
    jest
      .mocked(keyringServiceApi.getKeyringForAccount)
      .mockRejectedValue(new Error('no keyring'));
    expect(
      await reasonOf(
        getSolanaAccount('0x0000000000000000000000000000000000000001'),
      ),
    ).toBe('not_hd_account');
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
