import vectors from './__fixtures__/reference-vectors.json';
import type { SolanaRpc } from './rpc';
import {
  formatAmount,
  parseAmount,
  prepareTransfer,
  TransferAsset,
  TransferError,
} from './transfer';
import { associatedTokenAddress, PROGRAM_IDS } from './tx';

const ME = vectors.derivation[0].address;
const OTHER = vectors.derivation[1].address;
const USDC = vectors.ata[0].mint;
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const SOL: TransferAsset = { kind: 'sol' };
const TOKEN: TransferAsset = {
  kind: 'token',
  mint: USDC,
  decimals: 6,
  tokenProgram: PROGRAM_IDS.token,
};

const fakeRpc = (overrides: Partial<Record<string, unknown>> = {}) => {
  const accounts: Record<
    string,
    { owner: string; executable: boolean; lamports: number } | null
  > = {
    [OTHER]: { owner: PROGRAM_IDS.system, executable: false, lamports: 1 },
    ...(overrides.accounts as object),
  };
  const rpc = {
    getAccountInfo: jest.fn(
      async (address: string) => accounts[address] ?? null,
    ),
    getBalance: jest.fn(
      async () => (overrides.balance as bigint) ?? 10_000_000_000n,
    ),
    getMinimumBalanceForRentExemption: jest.fn(async (size: number) =>
      size === 0 ? 890_880n : 2_039_280n,
    ),
    getLatestBlockhash: jest.fn(async () => ({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 100,
    })),
    simulate: jest.fn(async () => ({
      err: overrides.simulationError ?? null,
      logs: ['Program log: test'],
      unitsConsumed: 1_000,
      postLamports: [9_000_000_000n],
    })),
    getPriorityFee: jest.fn(async () => (overrides.priority as bigint) ?? 0n),
  };
  return rpc as unknown as SolanaRpc & typeof rpc;
};

const issueOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof TransferError ? error.issue : 'other';
  }
  return 'none';
};

describe('prepareTransfer', () => {
  it('prepares and simulates a SOL transfer', async () => {
    const rpc = fakeRpc({ priority: 50_000n });
    const prepared = await prepareTransfer({
      rpc,
      from: ME,
      to: ` ${OTHER} `,
      asset: SOL,
      amount: 1_000_000n,
    });
    expect(prepared.message.accountKeys[0]).toBe(ME);
    expect(prepared.feeLamports).toBeGreaterThanOrEqual(5_000n);
    expect(prepared.rentLamports).toBe(0n);
    expect(prepared.senderLamportsAfter).toBe(9_000_000_000n);
    // measured once, then the final transaction is simulated again
    expect(rpc.simulate).toHaveBeenCalledTimes(2);
  });

  it('caps the priority fee', async () => {
    const prepared = await prepareTransfer({
      rpc: fakeRpc({ priority: 10n ** 15n }),
      from: ME,
      to: OTHER,
      asset: SOL,
      amount: 1_000_000n,
    });
    // ~2.2k CU at the 1 lamport/CU cap
    expect(prepared.feeLamports).toBeLessThan(5_000n + 10_000n);
  });

  it('adds the recipient token account rent when it is missing', async () => {
    const prepared = await prepareTransfer({
      rpc: fakeRpc(),
      from: ME,
      to: OTHER,
      asset: TOKEN,
      amount: 1n,
    });
    expect(prepared.createsRecipientTokenAccount).toBe(true);
    expect(prepared.rentLamports).toBe(2_039_280n);
  });

  it('blocks dangerous or invalid recipients before simulating', async () => {
    const tokenAccount = associatedTokenAddress(OTHER, USDC);
    const program = PROGRAM_IDS.token;
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc(),
          from: ME,
          to: 'nope',
          asset: SOL,
          amount: 1n,
        }),
      ),
    ).toBe('invalid_address');
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc(),
          from: ME,
          to: ME,
          asset: SOL,
          amount: 1n,
        }),
      ),
    ).toBe('same_address');
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc({
            accounts: {
              [program]: {
                owner: 'BPFLoader2111111111111111111111111111111111',
                executable: true,
                lamports: 1,
              },
            },
          }),
          from: ME,
          to: program,
          asset: SOL,
          amount: 1_000_000n,
        }),
      ),
    ).toBe('program_address');
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc({
            accounts: {
              [vectors.derivation[2].address]: {
                owner: PROGRAM_IDS.token,
                executable: false,
                lamports: 1,
              },
            },
          }),
          from: ME,
          to: vectors.derivation[2].address,
          asset: SOL,
          amount: 1_000_000n,
        }),
      ),
    ).toBe('token_account_address');
    // Off-curve (PDA) recipients: tokens are refused outright.
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc(),
          from: ME,
          to: tokenAccount,
          asset: TOKEN,
          amount: 1n,
        }),
      ),
    ).toBe('off_curve_recipient');
  });

  it('checks balances and the rent minimum', async () => {
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc(),
          from: ME,
          to: vectors.derivation[2].address,
          asset: SOL,
          amount: 1_000n,
        }),
      ),
    ).toBe('below_rent_minimum');
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc({ balance: 1_000_000n }),
          from: ME,
          to: OTHER,
          asset: SOL,
          amount: 1_000_000n,
        }),
      ),
    ).toBe('insufficient_balance');
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc({ balance: 1_000_000n }),
          from: ME,
          to: OTHER,
          asset: SOL,
          amount: 500_000n,
        }),
      ),
    ).toBe('leaves_dust');
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc(),
          from: ME,
          to: OTHER,
          asset: SOL,
          amount: 0n,
        }),
      ),
    ).toBe('amount_zero');
  });

  it('refuses to proceed when the network rejects the simulation', async () => {
    expect(
      await issueOf(
        prepareTransfer({
          rpc: fakeRpc({
            simulationError: { InstructionError: [0, 'Custom'] },
          }),
          from: ME,
          to: OTHER,
          asset: SOL,
          amount: 1_000_000n,
        }),
      ),
    ).toBe('simulation_failed');
  });
});

describe('amount helpers', () => {
  it('parses decimal amounts exactly', () => {
    expect(parseAmount('1.5', 9)).toBe(1_500_000_000n);
    expect(parseAmount('0,25', 6)).toBe(250_000n);
    expect(parseAmount('1.1234567', 6)).toBeNull();
    expect(parseAmount('-1', 6)).toBeNull();
    expect(parseAmount('1e3', 6)).toBeNull();
  });

  it('formats base units', () => {
    expect(formatAmount(1_500_000_000n, 9)).toBe('1.5');
    expect(formatAmount(5_000n, 9)).toBe('0.000005');
    expect(formatAmount(123_456_789n, 6, 2)).toBe('123.45');
    expect(formatAmount(0n, 9)).toBe('0');
  });
});
