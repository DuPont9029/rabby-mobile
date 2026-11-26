import { Buffer } from 'buffer';

import snapshot from './__fixtures__/raydium-snapshot.json';
import { MINTS, RAYDIUM, WETH_TO_ARIO, loadRoute } from './raydium';
import { hopInstructions } from './raydium';
import {
  advanceSwap,
  startSwap,
  SwapError,
  SwapProgress,
  tokenDelta,
} from './raydiumSwap';
import type { ParsedTransaction, SolanaRpc } from './rpc';
import { associatedTokenAddress, PROGRAM_IDS } from './tx';

jest.mock('./account', () => ({
  withSolanaSigner: async (
    _account: unknown,
    use: (key: Uint8Array) => unknown,
  ) => use(new Uint8Array(32).fill(7)),
}));

const OWNER = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const ACCOUNT = { evmAddress: '0x0', index: 0, address: OWNER };
const CPMM_HOP = WETH_TO_ARIO[2]!; // USDC → ARIO
const USER_IN = associatedTokenAddress(OWNER, MINTS.usdc);
const USER_OUT = associatedTokenAddress(OWNER, MINTS.ario);

const raw = snapshot.raw as Record<string, string>;
const tokenAccount = (amount: bigint) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return data;
};

const parsedTx = (
  outPre: string | null,
  outPost: string,
  err: unknown = null,
): ParsedTransaction => ({
  blockTime: 1,
  meta: {
    err,
    fee: 5000,
    preBalances: [],
    postBalances: [],
    preTokenBalances: outPre
      ? [
          {
            accountIndex: 1,
            mint: MINTS.ario,
            uiTokenAmount: { amount: outPre, decimals: 6 },
          },
        ]
      : [],
    postTokenBalances: [
      {
        accountIndex: 1,
        mint: MINTS.ario,
        uiTokenAmount: { amount: outPost, decimals: 6 },
      },
    ],
  },
  transaction: {
    message: {
      accountKeys: [
        { pubkey: OWNER, signer: true, writable: true },
        { pubkey: USER_OUT, signer: false, writable: true },
      ],
    },
  },
});

const makeRpc = ({
  inputBalance = 1_000_000n,
  lamports = 10_000_000n,
  status = { confirmationStatus: 'confirmed' as const, err: null },
  tx = parsedTx('5', '1075773672') as ParsedTransaction | null,
  blockHeight = 100,
}: {
  inputBalance?: bigint | null;
  lamports?: bigint;
  status?: { confirmationStatus: 'confirmed'; err: unknown } | null;
  tx?: ParsedTransaction | null;
  blockHeight?: number;
} = {}) => {
  const calls: string[] = [];
  const rpc = {
    getMultipleAccounts: jest.fn(async (addresses: string[]) =>
      addresses.map(address => {
        if (address === USER_IN) {
          return inputBalance === null
            ? null
            : { owner: PROGRAM_IDS.token, data: tokenAccount(inputBalance) };
        }
        return raw[address]
          ? {
              owner:
                address === CPMM_HOP.pool ? RAYDIUM.cpmm : PROGRAM_IDS.token,
              data: Uint8Array.from(Buffer.from(raw[address]!, 'base64')),
            }
          : null;
      }),
    ),
    getBalance: jest.fn(async () => lamports),
    getPriorityFee: jest.fn(async () => 1_000n),
    getLatestBlockhash: jest.fn(async () => ({
      blockhash: 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k',
      lastValidBlockHeight: 150,
    })),
    simulate: jest.fn(async () => ({ err: null, logs: [], postLamports: [] })),
    sendTransaction: jest.fn(async () => {
      calls.push('send');
      return 'sig';
    }),
    getSignatureStatus: jest.fn(async () => status),
    getParsedTransaction: jest.fn(async () => tx),
    getBlockHeight: jest.fn(async () => blockHeight),
  };
  return { rpc: rpc as unknown as SolanaRpc, mock: rpc, calls };
};

describe('hopInstructions', () => {
  it('closes the input account only when the hop empties it', async () => {
    const { rpc } = makeRpc();
    const [state] = await loadRoute(rpc, [CPMM_HOP]);
    const build = (inputBalance: bigint) =>
      hopInstructions({
        owner: OWNER,
        hop: CPMM_HOP,
        state: state!,
        amountIn: 1_000n,
        minAmountOut: 1n,
        inputBalance,
        microLamports: 0n,
      });
    const full = build(1_000n);
    const partial = build(5_000n);
    expect(full).toHaveLength(5);
    expect(full[4]!.data).toEqual(Uint8Array.of(9));
    expect(full[4]!.keys.map(k => k.pubkey)).toEqual([USER_IN, OWNER, OWNER]);
    expect(partial).toHaveLength(4);
    // The output account is created idempotently before the swap.
    expect(partial[2]!.programId).toBe(PROGRAM_IDS.associatedToken);
    expect(partial[3]!.programId).toBe(RAYDIUM.cpmm);
  });
});

describe('tokenDelta', () => {
  it('reads the output change, treating a new account as zero before', () => {
    expect(tokenDelta(parsedTx('100', '350'), USER_OUT)).toBe(250n);
    expect(tokenDelta(parsedTx(null, '350'), USER_OUT)).toBe(350n);
    expect(tokenDelta(parsedTx('1', '2'), OWNER)).toBe(0n);
  });
});

describe('advanceSwap', () => {
  const route = [CPMM_HOP];

  it('saves the signature before sending and settles from the transaction', async () => {
    const { rpc, mock, calls } = makeRpc();
    const saved: SwapProgress[] = [];
    const result = await advanceSwap({
      rpc,
      account: ACCOUNT,
      route,
      progress: startSwap(100_000n),
      save: progress => {
        saved.push(progress);
        calls.push(progress.pending ? 'save-pending' : 'save');
      },
    });
    expect(calls.slice(0, 2)).toEqual(['save-pending', 'send']);
    expect(saved[0]!.pending!.outAccount).toBe(USER_OUT);
    expect(result).toEqual({
      hop: 1,
      amount: '1075773667',
      signatures: [saved[0]!.pending!.signature],
    });
    expect(mock.simulate).toHaveBeenCalledTimes(1);
  });

  it('never swaps again after a restart: a pending hop is looked up first', async () => {
    const { rpc, mock } = makeRpc({ status: null, blockHeight: 500 });
    const result = await advanceSwap({
      rpc,
      account: ACCOUNT,
      route,
      progress: {
        hop: 0,
        amount: '100000',
        signatures: [],
        pending: {
          signature: 'old',
          lastValidBlockHeight: 150,
          outAccount: USER_OUT,
        },
      },
      save: () => {},
    });
    expect(mock.sendTransaction).not.toHaveBeenCalled();
    expect(result.hop).toBe(1);
    expect(result.signatures).toEqual(['old']);
  });

  it('waits while a pending hop may still land', async () => {
    const { rpc, mock } = makeRpc({ status: null, blockHeight: 120 });
    const pending = {
      hop: 0,
      amount: '100000',
      signatures: [],
      pending: {
        signature: 'old',
        lastValidBlockHeight: 150,
        outAccount: USER_OUT,
      },
    };
    const result = await advanceSwap({
      rpc,
      account: ACCOUNT,
      route,
      progress: pending,
      save: () => {},
    });
    expect(result).toBe(pending);
    expect(mock.sendTransaction).not.toHaveBeenCalled();
  });

  it('swaps only what the transfer produced, not the wallet balance', async () => {
    const { rpc, mock } = makeRpc({ inputBalance: 9_000_000n });
    await advanceSwap({
      rpc,
      account: ACCOUNT,
      route,
      progress: startSwap(100_000n),
      save: () => {},
    });
    const [wire] = mock.sendTransaction.mock.calls[0] as unknown as [
      Uint8Array,
    ];
    // amountIn (u64 LE) right after the CPMM discriminator.
    const hex = Buffer.from(wire).toString('hex');
    expect(hex).toContain('8fbe5adac41e33dea086010000000000');
  });

  it('stops when the step tokens are gone, and asks for SOL when low', async () => {
    await expect(
      advanceSwap({
        rpc: makeRpc({ inputBalance: null }).rpc,
        account: ACCOUNT,
        route,
        progress: startSwap(1n),
        save: () => {},
      }),
    ).rejects.toMatchObject({ code: 'input_missing' });
    await expect(
      advanceSwap({
        rpc: makeRpc({ lamports: 1_000n }).rpc,
        account: ACCOUNT,
        route,
        progress: startSwap(1n),
        save: () => {},
      }),
    ).rejects.toBeInstanceOf(SwapError);
  });
});
