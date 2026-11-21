/**
 * Transfer history of a Solana account (SOL or one SPL token), read from the
 * RPC: recent signatures, then each transaction's balance changes. Pure
 * parsing is separate so it can be tested on recorded transactions.
 */
import type { ParsedTokenBalance, ParsedTransaction, SolanaRpc } from './rpc';

export type SolanaHistoryItem = {
  signature: string;
  blockTime: number | null;
  /** Signed change for the wallet, in base units (fee excluded for SOL). */
  delta: bigint;
  /** The other side when it can be told (largest opposite change). */
  counterparty: string | null;
  failed: boolean;
};

export type HistoryAsset = { kind: 'sol' } | { kind: 'token'; mint: string };

/** The wallet's change in `asset` within one transaction. */
export const transferFromTransaction = (
  tx: ParsedTransaction,
  owner: string,
  asset: HistoryAsset,
  signature: string,
): SolanaHistoryItem | null => {
  const meta = tx.meta;
  if (!meta) {
    return null;
  }
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey);
  if (asset.kind === 'sol') {
    const index = keys.indexOf(owner);
    if (index < 0) {
      return null;
    }
    const change = (i: number) =>
      BigInt(meta.postBalances[i] ?? 0) - BigInt(meta.preBalances[i] ?? 0);
    // The fee is not a transfer: add it back when this wallet paid it.
    const delta = change(index) + (index === 0 ? BigInt(meta.fee) : 0n);
    if (delta === 0n) {
      return null;
    }
    let counterparty: string | null = null;
    let best = 0n;
    keys.forEach((key, i) => {
      if (i === index) {
        return;
      }
      const other = change(i);
      if ((delta > 0n ? -other : other) > best) {
        best = delta > 0n ? -other : other;
        counterparty = key;
      }
    });
    return {
      signature,
      blockTime: tx.blockTime,
      delta,
      counterparty,
      failed: !!meta.err,
    };
  }
  const amountOf = (
    list: ParsedTokenBalance[] | undefined,
    filter: (b: ParsedTokenBalance) => boolean,
  ) =>
    (list || [])
      .filter(b => b.mint === asset.mint && filter(b))
      .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
  const mine = (b: { owner?: string }) => b.owner === owner;
  const delta =
    amountOf(meta.postTokenBalances, mine) -
    amountOf(meta.preTokenBalances, mine);
  if (delta === 0n) {
    return null;
  }
  // Counterparty: the other owner whose balance moved the opposite way.
  const owners = new Set(
    [...(meta.preTokenBalances || []), ...(meta.postTokenBalances || [])]
      .filter(b => b.mint === asset.mint && b.owner && b.owner !== owner)
      .map(b => b.owner as string),
  );
  let counterparty: string | null = null;
  let best = 0n;
  for (const other of owners) {
    const otherDelta =
      amountOf(meta.postTokenBalances, b => b.owner === other) -
      amountOf(meta.preTokenBalances, b => b.owner === other);
    const opposite = delta > 0n ? -otherDelta : otherDelta;
    if (opposite > best) {
      best = opposite;
      counterparty = other;
    }
  }
  return {
    signature,
    blockTime: tx.blockTime,
    delta,
    counterparty,
    failed: !!meta.err,
  };
};

/**
 * Recent transfers of `asset` for `owner`. `lookup` is the address whose
 * signatures are listed: the wallet for SOL, its token account for a token.
 */
export const loadSolanaHistory = async (
  rpc: SolanaRpc,
  owner: string,
  asset: HistoryAsset,
  lookup: string,
  limit = 15,
): Promise<SolanaHistoryItem[]> => {
  const signatures = await rpc.getSignaturesForAddress(lookup, limit);
  const items: Array<SolanaHistoryItem | null> = new Array(
    signatures.length,
  ).fill(null);
  // A few at a time: fast, but gentle with public RPC rate limits.
  const CONCURRENCY = 3;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < signatures.length) {
        const index = next++;
        const { signature } = signatures[index]!;
        const tx = await rpc.getParsedTransaction(signature).catch(() => null);
        items[index] = tx
          ? transferFromTransaction(tx, owner, asset, signature)
          : null;
      }
    }),
  );
  return items.filter((item): item is SolanaHistoryItem => !!item);
};
