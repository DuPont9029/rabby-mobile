/**
 * Raydium swaps built in the app (no API): AMM v4 (`swap_base_in_v2`, no
 * OpenBook accounts) and CPMM (`swap_base_input`). Quotes use the pools'
 * on-chain reserves with the programs' own integer math; instruction layouts
 * and quotes are checked against @raydium-io/raydium-sdk-v2 in the tests.
 *
 * Programs (open source, Apache-2.0):
 *  - AMM v4  675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
 *  - CPMM    CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 */
import { encodeAddress } from './keys';
import type { SolanaRpc } from './rpc';
import {
  AccountMeta,
  associatedTokenAddress,
  closeTokenAccount,
  createAssociatedTokenAccountIdempotent,
  Instruction,
  PROGRAM_IDS,
  setComputeUnitLimit,
  setComputeUnitPrice,
} from './tx';

export const RAYDIUM = {
  ammV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  ammV4Authority: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  cpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  cpmmAuthority: 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL',
} as const;

export const MINTS = {
  wrappedEth: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  wrappedSol: 'So11111111111111111111111111111111111111112',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  ario: 'DcNnMuFxwhgV4WY1HVSaSEgr92bv2b1vUvEKiNxWqHdF',
} as const;

export type Hop = {
  kind: 'ammV4' | 'cpmm';
  pool: string;
  inputMint: string;
  outputMint: string;
};

/** ETH (Wormhole WETH) → SOL → USDC → ARIO: ARIO trades only against USDC. */
export const WETH_TO_ARIO: Hop[] = [
  {
    kind: 'ammV4',
    pool: '4yrHms7ekgTBgJg77zJ33TsWrraqHsCXDtuSZqUsuGHb',
    inputMint: MINTS.wrappedEth,
    outputMint: MINTS.wrappedSol,
  },
  {
    kind: 'ammV4',
    pool: '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2',
    inputMint: MINTS.wrappedSol,
    outputMint: MINTS.usdc,
  },
  {
    kind: 'cpmm',
    pool: 'Af2z5zkNXe9LDxQMrkDtBpehsLbMWTQrwhpjyW8439Lu',
    inputMint: MINTS.usdc,
    outputMint: MINTS.ario,
  },
];

const u64 = (data: Uint8Array, offset: number) => {
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(data[offset + i]!);
  }
  return value;
};

const key = (data: Uint8Array, offset: number) =>
  encodeAddress(data.subarray(offset, offset + 32));

const u64Le = (value: bigint) => {
  const out = new Uint8Array(8);
  let rest = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

const meta = (
  pubkey: string,
  isSigner: boolean,
  isWritable: boolean,
): AccountMeta => ({
  pubkey,
  isSigner,
  isWritable,
});

/** Amount of an SPL token account (u64 at offset 64). */
export const tokenAccountAmount = (data: Uint8Array) => u64(data, 64);

// ---- AMM v4 ---------------------------------------------------------------

export type AmmV4Pool = {
  id: string;
  baseVault: string;
  quoteVault: string;
  baseMint: string;
  quoteMint: string;
  swapFeeNumerator: bigint;
  swapFeeDenominator: bigint;
  baseNeedTakePnl: bigint;
  quoteNeedTakePnl: bigint;
  status: bigint;
};

/** Raydium AMM v4 `AmmInfo` (752 bytes). */
export const parseAmmV4Pool = (id: string, data: Uint8Array): AmmV4Pool => {
  if (data.length !== 752) {
    throw new Error('not an AMM v4 pool');
  }
  return {
    id,
    status: u64(data, 0),
    swapFeeNumerator: u64(data, 22 * 8),
    swapFeeDenominator: u64(data, 23 * 8),
    baseNeedTakePnl: u64(data, 24 * 8),
    quoteNeedTakePnl: u64(data, 25 * 8),
    baseVault: key(data, 336),
    quoteVault: key(data, 368),
    baseMint: key(data, 400),
    quoteMint: key(data, 432),
  };
};

/** `swap_base_in` math: fee = ceil(in·num/den), constant product on the rest. */
export const ammV4AmountOut = (
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeNumerator: bigint,
  feeDenominator: bigint,
) => {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    return 0n;
  }
  const fee = (amountIn * feeNumerator + feeDenominator - 1n) / feeDenominator;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
};

export const ammV4SwapInstruction = ({
  pool,
  userIn,
  userOut,
  owner,
  amountIn,
  minAmountOut,
}: {
  pool: AmmV4Pool;
  userIn: string;
  userOut: string;
  owner: string;
  amountIn: bigint;
  minAmountOut: bigint;
}): Instruction => ({
  programId: RAYDIUM.ammV4,
  keys: [
    meta(PROGRAM_IDS.token, false, false),
    meta(pool.id, false, true),
    meta(RAYDIUM.ammV4Authority, false, false),
    meta(pool.baseVault, false, true),
    meta(pool.quoteVault, false, true),
    meta(userIn, false, true),
    meta(userOut, false, true),
    meta(owner, true, false),
  ],
  data: concat(Uint8Array.of(16), u64Le(amountIn), u64Le(minAmountOut)),
});

// ---- CPMM -----------------------------------------------------------------

export type CpmmPool = {
  id: string;
  config: string;
  vault0: string;
  vault1: string;
  mint0: string;
  mint1: string;
  mintProgram0: string;
  mintProgram1: string;
  observation: string;
  status: number;
  /** Fees accrued in the vaults that are not part of the reserves. */
  feesHeld0: bigint;
  feesHeld1: bigint;
  enableCreatorFee: boolean;
};

/** Raydium CPMM `PoolState` (637 bytes). */
export const parseCpmmPool = (id: string, data: Uint8Array): CpmmPool => {
  if (data.length !== 637) {
    throw new Error('not a CPMM pool');
  }
  return {
    id,
    config: key(data, 8),
    vault0: key(data, 72),
    vault1: key(data, 104),
    mint0: key(data, 168),
    mint1: key(data, 200),
    mintProgram0: key(data, 232),
    mintProgram1: key(data, 264),
    observation: key(data, 296),
    status: data[329]!,
    // protocol + fund + creator fees per side
    feesHeld0: u64(data, 341) + u64(data, 357) + u64(data, 397),
    feesHeld1: u64(data, 349) + u64(data, 365) + u64(data, 405),
    enableCreatorFee: data[390] === 1,
  };
};

/** `AmmConfig.trade_fee_rate` (u64 at offset 12), in 1e-6 units. */
export const parseCpmmTradeFeeRate = (data: Uint8Array) => u64(data, 12);

export const cpmmAmountOut = (
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  tradeFeeRate: bigint,
) => {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    return 0n;
  }
  const fee = (amountIn * tradeFeeRate + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
};

const CPMM_SWAP_BASE_INPUT = Uint8Array.from([
  0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde,
]);

export const cpmmSwapInstruction = ({
  pool,
  payer,
  userIn,
  userOut,
  inputMint,
  amountIn,
  minAmountOut,
}: {
  pool: CpmmPool;
  payer: string;
  userIn: string;
  userOut: string;
  inputMint: string;
  amountIn: bigint;
  minAmountOut: bigint;
}): Instruction => {
  const zeroIn = inputMint === pool.mint0;
  if (!zeroIn && inputMint !== pool.mint1) {
    throw new Error('mint not in pool');
  }
  return {
    programId: RAYDIUM.cpmm,
    keys: [
      meta(payer, true, false),
      meta(RAYDIUM.cpmmAuthority, false, false),
      meta(pool.config, false, false),
      meta(pool.id, false, true),
      meta(userIn, false, true),
      meta(userOut, false, true),
      meta(zeroIn ? pool.vault0 : pool.vault1, false, true),
      meta(zeroIn ? pool.vault1 : pool.vault0, false, true),
      meta(zeroIn ? pool.mintProgram0 : pool.mintProgram1, false, false),
      meta(zeroIn ? pool.mintProgram1 : pool.mintProgram0, false, false),
      meta(zeroIn ? pool.mint0 : pool.mint1, false, false),
      meta(zeroIn ? pool.mint1 : pool.mint0, false, false),
      meta(pool.observation, false, true),
    ],
    data: concat(CPMM_SWAP_BASE_INPUT, u64Le(amountIn), u64Le(minAmountOut)),
  };
};

/** Compute units for one hop transaction (measured ≈70k for the CPMM). */
const HOP_UNIT_LIMIT = 150_000;

// ---- route state & quotes --------------------------------------------------

export type HopState =
  | {
      hop: Hop;
      kind: 'ammV4';
      pool: AmmV4Pool;
      reserveIn: bigint;
      reserveOut: bigint;
    }
  | {
      hop: Hop;
      kind: 'cpmm';
      pool: CpmmPool;
      reserveIn: bigint;
      reserveOut: bigint;
      tradeFeeRate: bigint;
    };

/** Reads every pool, its vaults and (CPMM) config in one batch. */
export const loadRoute = async (
  rpc: SolanaRpc,
  route: Hop[],
): Promise<HopState[]> => {
  const pools = await rpc.getMultipleAccounts(route.map(h => h.pool));
  const parsed = route.map((hop, i) => {
    const account = pools[i];
    if (!account) {
      throw new Error(`pool ${hop.pool} not found`);
    }
    if (hop.kind === 'ammV4') {
      if (account.owner !== RAYDIUM.ammV4) {
        throw new Error('unexpected pool owner');
      }
      return parseAmmV4Pool(hop.pool, account.data);
    }
    if (account.owner !== RAYDIUM.cpmm) {
      throw new Error('unexpected pool owner');
    }
    return parseCpmmPool(hop.pool, account.data);
  });
  const extra: string[] = [];
  parsed.forEach(p =>
    'baseVault' in p
      ? extra.push(p.baseVault, p.quoteVault)
      : extra.push(p.vault0, p.vault1, p.config),
  );
  const accounts = await rpc.getMultipleAccounts(extra);
  let cursor = 0;
  const next = () => {
    const account = accounts[cursor++];
    if (!account) {
      throw new Error('pool account missing');
    }
    return account.data;
  };
  return route.map((hop, i): HopState => {
    const p = parsed[i]!;
    if ('baseVault' in p) {
      const base = tokenAccountAmount(next()) - p.baseNeedTakePnl;
      const quote = tokenAccountAmount(next()) - p.quoteNeedTakePnl;
      const baseIn = hop.inputMint === p.baseMint;
      if (!baseIn && hop.inputMint !== p.quoteMint) {
        throw new Error('mint not in pool');
      }
      return {
        hop,
        kind: 'ammV4',
        pool: p,
        reserveIn: baseIn ? base : quote,
        reserveOut: baseIn ? quote : base,
      };
    }
    const r0 = tokenAccountAmount(next()) - p.feesHeld0;
    const r1 = tokenAccountAmount(next()) - p.feesHeld1;
    const tradeFeeRate = parseCpmmTradeFeeRate(next());
    const zeroIn = hop.inputMint === p.mint0;
    return {
      hop,
      kind: 'cpmm',
      pool: p,
      reserveIn: zeroIn ? r0 : r1,
      reserveOut: zeroIn ? r1 : r0,
      tradeFeeRate,
    };
  });
};

export const hopAmountOut = (state: HopState, amountIn: bigint) =>
  state.kind === 'ammV4'
    ? ammV4AmountOut(
        amountIn,
        state.reserveIn,
        state.reserveOut,
        state.pool.swapFeeNumerator,
        state.pool.swapFeeDenominator,
      )
    : cpmmAmountOut(
        amountIn,
        state.reserveIn,
        state.reserveOut,
        state.tradeFeeRate,
      );

/** Quote along the route: output of every hop for `amountIn`. */
export const quoteRoute = (states: HopState[], amountIn: bigint) => {
  const outputs: bigint[] = [];
  let amount = amountIn;
  for (const state of states) {
    amount = hopAmountOut(state, amount);
    outputs.push(amount);
  }
  return outputs;
};

/** `amount` reduced by `slippageBps` (rounded down). */
export const withSlippage = (amount: bigint, slippageBps: number) =>
  (amount * BigInt(10_000 - slippageBps)) / 10_000n;

// ---- hop transaction -------------------------------------------------------

/**
 * Builds the instructions of one hop. `inputBalance` is the wallet's current
 * balance of the hop's input token: the input account is closed only when
 * the hop spends all of it.
 */
export const hopInstructions = ({
  owner,
  hop,
  state,
  amountIn,
  minAmountOut,
  inputBalance,
  microLamports,
}: {
  owner: string;
  hop: Hop;
  state: HopState;
  amountIn: bigint;
  minAmountOut: bigint;
  inputBalance: bigint;
  microLamports: bigint;
}): Instruction[] => {
  const userIn = associatedTokenAddress(owner, hop.inputMint);
  const userOut = associatedTokenAddress(owner, hop.outputMint);
  const swap =
    state.kind === 'ammV4'
      ? ammV4SwapInstruction({
          pool: state.pool,
          userIn,
          userOut,
          owner,
          amountIn,
          minAmountOut,
        })
      : cpmmSwapInstruction({
          pool: state.pool,
          payer: owner,
          userIn,
          userOut,
          inputMint: hop.inputMint,
          amountIn,
          minAmountOut,
        });
  return [
    setComputeUnitLimit(HOP_UNIT_LIMIT),
    setComputeUnitPrice(microLamports),
    createAssociatedTokenAccountIdempotent(owner, owner, hop.outputMint),
    swap,
    ...(inputBalance === amountIn
      ? [closeTokenAccount(userIn, owner, owner)]
      : []),
  ];
};
