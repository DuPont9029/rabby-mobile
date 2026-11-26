import { Buffer } from 'buffer';

import reference from './__fixtures__/raydium-reference.json';
import snapshot from './__fixtures__/raydium-snapshot.json';
import {
  ammV4AmountOut,
  ammV4SwapInstruction,
  cpmmAmountOut,
  cpmmSwapInstruction,
  loadRoute,
  MINTS,
  parseAmmV4Pool,
  parseCpmmPool,
  parseCpmmTradeFeeRate,
  quoteRoute,
  RAYDIUM,
  WETH_TO_ARIO,
  withSlippage,
} from './raydium';
import type { SolanaRpc } from './rpc';

const raw = snapshot.raw as Record<string, string>;
const bytes = (address: string) =>
  Uint8Array.from(Buffer.from(raw[address]!, 'base64'));

const keysOf = (ix: {
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
}) => ix.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]);
const hex = (data: Uint8Array) => Buffer.from(data).toString('hex');

const ammIds = Object.keys(reference.amm) as Array<keyof typeof reference.amm>;
const CPMM_ID = 'Af2z5zkNXe9LDxQMrkDtBpehsLbMWTQrwhpjyW8439Lu';

/** Minimal RPC over the snapshot (owners from the pool kind). */
const snapshotRpc = {
  getMultipleAccounts: async (addresses: string[]) =>
    addresses.map(address =>
      raw[address]
        ? {
            owner:
              address === CPMM_ID
                ? RAYDIUM.cpmm
                : ammIds.includes(address as never)
                ? RAYDIUM.ammV4
                : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            data: bytes(address),
          }
        : null,
    ),
} as unknown as SolanaRpc;

describe('Raydium AMM v4', () => {
  it.each(ammIds)('parses pool %s like the SDK', id => {
    const ref = reference.amm[id];
    const pool = parseAmmV4Pool(id, bytes(id));
    expect(pool.baseMint).toBe(ref.mintA);
    expect(pool.quoteMint).toBe(ref.mintB);
    expect(pool.baseVault).toBe(ref.vaultA);
    expect(pool.quoteVault).toBe(ref.vaultB);
    expect(pool.swapFeeNumerator).toBe(BigInt(ref.feeNum));
    expect(pool.swapFeeDenominator).toBe(BigInt(ref.feeDen));
  });

  it.each(ammIds)('quotes %s like the SDK', id => {
    const e = snapshot.expected[id];
    expect(
      ammV4AmountOut(
        BigInt(e.amountIn),
        BigInt(e.baseRes),
        BigInt(e.quoteRes),
        25n,
        10000n,
      ),
    ).toBe(BigInt(e.out));
  });

  it.each(ammIds)('builds the same swap instruction as the SDK for %s', id => {
    const ref = reference.amm[id];
    const pool = parseAmmV4Pool(id, bytes(id));
    const [, , , , , userIn, userOut, owner] = ref.ix.keys;
    const ix = ammV4SwapInstruction({
      pool,
      userIn: userIn![0] as string,
      userOut: userOut![0] as string,
      owner: owner![0] as string,
      amountIn: BigInt(ref.amountIn),
      minAmountOut: 1n,
    });
    expect(ix.programId).toBe(ref.ix.programId);
    expect(keysOf(ix)).toEqual(ref.ix.keys);
    expect(hex(ix.data)).toBe(ref.ix.data);
  });
});

describe('Raydium CPMM', () => {
  const ref = reference.cpmm;

  it('parses the ARIO/USDC pool and its config', () => {
    const pool = parseCpmmPool(CPMM_ID, bytes(CPMM_ID));
    expect(pool.config).toBe(ref.config);
    expect(pool.mint0).toBe(ref.mintA);
    expect(pool.mint1).toBe(ref.mintB);
    expect(pool.vault0).toBe(ref.vaultA);
    expect(pool.vault1).toBe(ref.vaultB);
    expect(pool.observation).toBe(ref.observation);
    expect(pool.enableCreatorFee).toBe(false);
    expect(parseCpmmTradeFeeRate(bytes(ref.config))).toBe(2500n);
  });

  it('builds the same swap instruction as the SDK', () => {
    const pool = parseCpmmPool(CPMM_ID, bytes(CPMM_ID));
    const [payer, , , , userIn, userOut] = ref.ix.keys;
    const ix = cpmmSwapInstruction({
      pool,
      payer: payer![0] as string,
      userIn: userIn![0] as string,
      userOut: userOut![0] as string,
      inputMint: MINTS.usdc,
      amountIn: BigInt(ref.usdcIn),
      minAmountOut: 1n,
    });
    expect(ix.programId).toBe(ref.ix.programId);
    expect(keysOf(ix)).toEqual(ref.ix.keys);
    expect(hex(ix.data)).toBe(ref.ix.data);
  });

  it('quotes with the trade fee only (creator fee disabled)', () => {
    const e = snapshot.expected.cpmm;
    // USDC (mint1) in, ARIO (mint0) out.
    expect(
      cpmmAmountOut(BigInt(e.usdcIn), BigInt(e.r1), BigInt(e.r0), 2500n),
    ).toBe(107577367n);
  });
});

describe('WETH → ARIO route', () => {
  it('loads reserves from the snapshot and quotes every hop', async () => {
    const states = await loadRoute(snapshotRpc, WETH_TO_ARIO);
    expect(states.map(s => s.kind)).toEqual(['ammV4', 'ammV4', 'cpmm']);
    const weth =
      snapshot.expected['4yrHms7ekgTBgJg77zJ33TsWrraqHsCXDtuSZqUsuGHb'];
    expect(states[0]!.reserveIn).toBe(BigInt(weth.baseRes));
    expect(states[0]!.reserveOut).toBe(BigInt(weth.quoteRes));
    const sol =
      snapshot.expected['58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'];
    expect(states[1]!.reserveIn).toBe(BigInt(sol.baseRes));
    expect(states[2]!.reserveIn).toBe(BigInt(snapshot.expected.cpmm.r1));
    expect(states[2]!.reserveOut).toBe(BigInt(snapshot.expected.cpmm.r0));

    const outputs = quoteRoute(states, 100000n);
    expect(outputs[0]).toBe(BigInt(weth.out));
    expect(outputs).toHaveLength(3);
    expect(outputs[2]! > 0n).toBe(true);
  });

  it('applies slippage', () => {
    expect(withSlippage(10_000n, 100)).toBe(9_900n);
    expect(withSlippage(999n, 50)).toBe(994n);
  });
});
