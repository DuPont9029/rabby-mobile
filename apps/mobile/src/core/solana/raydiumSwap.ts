/**
 * Runs a Raydium route one hop per transaction, signed with the wallet's
 * derived Solana key. Resumable and crash-safe:
 *
 *  - each hop swaps only what the previous hop produced (read from the
 *    confirmed transaction), never tokens the wallet already held;
 *  - the signature is saved before sending, so a restart checks that
 *    transaction instead of swapping again;
 *  - every hop is simulated before signing and protected by a minimum
 *    output (fresh quote − slippage);
 *  - intermediate token accounts emptied by a hop are closed, so their rent
 *    (and wrapped SOL) returns to the wallet.
 */
import { base58 } from '@scure/base';

import { SolanaAccount, withSolanaSigner } from './account';
import {
  hopAmountOut,
  hopInstructions,
  Hop,
  loadRoute,
  tokenAccountAmount,
  withSlippage,
} from './raydium';
import type { ParsedTokenBalance, ParsedTransaction, SolanaRpc } from './rpc';
import { waitForConfirmation } from './transfer';
import {
  associatedTokenAddress,
  compileMessage,
  signTransactionWithSigners,
  unsignedTransaction,
} from './tx';

export const DEFAULT_SWAP_SLIPPAGE_BPS = 100;
/** Rent of a new token account (≈0.00204 SOL, refunded on close) + fees. */
export const SWAP_HOP_MIN_LAMPORTS = 2_500_000n;
const MAX_PRIORITY_MICRO_LAMPORTS = 200_000n;

export type SwapProgress = {
  /** Index of the next hop to run (= route length when done). */
  hop: number;
  /** Input of the next hop, or the final output once done (raw units). */
  amount: string;
  pending?: {
    signature: string;
    lastValidBlockHeight: number;
    outAccount: string;
  };
  signatures: string[];
};

export class SwapError extends Error {
  constructor(
    message: string,
    readonly code: 'needs_sol' | 'retry' | 'input_missing',
  ) {
    super(message);
    this.name = 'SwapError';
  }
}

export const startSwap = (amountIn: bigint): SwapProgress => ({
  hop: 0,
  amount: amountIn.toString(),
  signatures: [],
});

export const isSwapDone = (route: Hop[], progress: SwapProgress) =>
  progress.hop >= route.length;

/** Raw token balance change of `account` in a confirmed transaction. */
export const tokenDelta = (tx: ParsedTransaction, account: string) => {
  const index = tx.transaction.message.accountKeys.findIndex(
    key => key.pubkey === account,
  );
  if (index < 0) {
    return 0n;
  }
  const amount = (list?: ParsedTokenBalance[]) =>
    BigInt(
      list?.find(b => b.accountIndex === index)?.uiTokenAmount.amount ?? '0',
    );
  return amount(tx.meta?.postTokenBalances) - amount(tx.meta?.preTokenBalances);
};

/** First signature of a signed wire transaction (single-signer). */
const wireSignature = (wire: Uint8Array) => base58.encode(wire.slice(1, 65));

/** Quote for the whole route with fresh reserves. */
export const quoteSwapRoute = async (
  rpc: SolanaRpc,
  route: Hop[],
  amountIn: bigint,
) => {
  const states = await loadRoute(rpc, route);
  let amount = amountIn;
  for (const state of states) {
    amount = hopAmountOut(state, amount);
  }
  return amount;
};

/** Settles a sent hop. Returns the new progress, or null while still pending. */
const settlePending = async (
  rpc: SolanaRpc,
  progress: SwapProgress,
): Promise<SwapProgress | null> => {
  const pending = progress.pending!;
  const fromTransaction = (tx: ParsedTransaction): SwapProgress =>
    tx.meta!.err
      ? { ...progress, pending: undefined }
      : {
          hop: progress.hop + 1,
          amount: tokenDelta(tx, pending.outAccount).toString(),
          signatures: [...progress.signatures, pending.signature],
        };
  const status = await rpc.getSignatureStatus(pending.signature);
  if (status?.err) {
    return { ...progress, pending: undefined };
  }
  if (status && status.confirmationStatus !== 'processed') {
    const tx = await rpc.getParsedTransaction(pending.signature);
    return tx?.meta ? fromTransaction(tx) : null;
  }
  if (!status) {
    const height = await rpc.getBlockHeight();
    if (height > pending.lastValidBlockHeight) {
      // The recent-status cache forgets old signatures: look the transaction
      // up in history before concluding it never landed.
      const tx = await rpc.getParsedTransaction(pending.signature);
      return tx?.meta
        ? fromTransaction(tx)
        : { ...progress, pending: undefined };
    }
  }
  return null;
};

/**
 * Advances `progress` along `route` as far as possible, calling `save` after
 * every change (before sending, too). Returns the latest progress.
 */
export const advanceSwap = async ({
  rpc,
  account,
  route,
  progress: initial,
  slippageBps = DEFAULT_SWAP_SLIPPAGE_BPS,
  save,
}: {
  rpc: SolanaRpc;
  account: SolanaAccount;
  route: Hop[];
  progress: SwapProgress;
  slippageBps?: number;
  save: (progress: SwapProgress) => void;
}): Promise<SwapProgress> => {
  const owner = account.address;
  let progress = initial;
  while (!isSwapDone(route, progress)) {
    if (progress.pending) {
      const settled = await settlePending(rpc, progress);
      if (!settled) {
        return progress; // still in flight
      }
      progress = settled;
      save(progress);
      continue;
    }

    const hop = route[progress.hop]!;
    const wanted = BigInt(progress.amount);
    const userIn = associatedTokenAddress(owner, hop.inputMint);
    const [inputAccount] = await rpc.getMultipleAccounts([userIn]);
    const inputBalance = inputAccount
      ? tokenAccountAmount(inputAccount.data)
      : 0n;
    // Never more than this transfer produced, even if the wallet holds more.
    const amountIn = inputBalance < wanted ? inputBalance : wanted;
    if (amountIn <= 0n) {
      throw new SwapError('Nothing left to swap at this step', 'input_missing');
    }
    if ((await rpc.getBalance(owner)) < SWAP_HOP_MIN_LAMPORTS) {
      throw new SwapError('needs SOL for the swap fees', 'needs_sol');
    }

    const [state] = await loadRoute(rpc, [hop]);
    const quote = hopAmountOut(state!, amountIn);
    if (quote <= 0n) {
      throw new SwapError('The pool returned no quote', 'retry');
    }
    const priority = await rpc
      .getPriorityFee([hop.pool, userIn])
      .catch(() => 0n);
    const microLamports =
      priority > MAX_PRIORITY_MICRO_LAMPORTS
        ? MAX_PRIORITY_MICRO_LAMPORTS
        : priority;
    const instructions = hopInstructions({
      owner,
      hop,
      state: state!,
      amountIn,
      minAmountOut: withSlippage(quote, slippageBps),
      inputBalance,
      microLamports,
    });
    const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
    const message = compileMessage({
      feePayer: owner,
      recentBlockhash: blockhash,
      instructions,
    });
    if (message.numRequiredSignatures !== 1) {
      throw new SwapError('unexpected signers', 'retry');
    }
    const simulation = await rpc.simulate(unsignedTransaction(message), []);
    if (simulation.err) {
      throw new SwapError(
        `swap simulation failed: ${JSON.stringify(simulation.err)}`,
        'retry',
      );
    }

    const wire = await withSolanaSigner(account, privateKey =>
      signTransactionWithSigners(message, [{ address: owner, privateKey }]),
    );
    const signature = wireSignature(wire);
    progress = {
      ...progress,
      pending: {
        signature,
        lastValidBlockHeight,
        outAccount: associatedTokenAddress(owner, hop.outputMint),
      },
    };
    save(progress);
    try {
      await rpc.sendTransaction(wire);
    } catch {
      // Possibly sent anyway: the pending signature settles it either way.
    }
    await waitForConfirmation(rpc, signature, lastValidBlockHeight);
  }
  return progress;
};
