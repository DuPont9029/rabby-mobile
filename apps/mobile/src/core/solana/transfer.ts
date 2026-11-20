/**
 * Prepares (but does not sign) SOL / SPL token / NFT transfers: validates the
 * recipient, builds the transaction, sizes compute units and the priority
 * fee, and simulates the final transaction so the user reviews exactly what
 * will happen. Nothing can be signed unless the simulation succeeds.
 *
 * Pure module: the RPC client is injected.
 */
import { decodeAddress, isOnCurve, isValidAddress } from './keys';
import type { SolanaRpc } from './rpc';
import {
  associatedTokenAddress,
  compileMessage,
  CompiledMessage,
  createAssociatedTokenAccountIdempotent,
  Instruction,
  PROGRAM_IDS,
  programmableNftTransfer,
  setComputeUnitLimit,
  setComputeUnitPrice,
  systemTransfer,
  tokenTransferChecked,
  unsignedTransaction,
} from './tx';

export type TransferAsset =
  | { kind: 'sol' }
  | {
      kind: 'token';
      mint: string;
      decimals: number;
      tokenProgram: string;
    }
  | {
      kind: 'nft';
      mint: string;
      tokenProgram: string;
      programmable: boolean;
      ruleSet: string | null;
    };

export type TransferIssue =
  | 'invalid_address'
  | 'same_address'
  | 'program_address'
  | 'token_account_address'
  | 'off_curve_recipient'
  | 'amount_zero'
  | 'insufficient_balance'
  | 'insufficient_sol_for_fees'
  | 'below_rent_minimum'
  | 'leaves_dust'
  | 'simulation_failed';

export class TransferError extends Error {
  constructor(readonly issue: TransferIssue, readonly logs: string[] = []) {
    super(issue);
    this.name = 'TransferError';
  }
}

export type PreparedTransfer = {
  message: CompiledMessage;
  lastValidBlockHeight: number;
  /** Base fee + priority fee, in lamports. */
  feeLamports: bigint;
  /** Rent paid to create the recipient's token account (0 if it exists). */
  rentLamports: bigint;
  createsRecipientTokenAccount: boolean;
  senderLamportsBefore: bigint;
  senderLamportsAfter: bigint | null;
  /** Non-blocking notes to show on the review screen. */
  warnings: Array<'recipient_new_account' | 'recipient_off_curve'>;
};

const BASE_FEE_PER_SIGNATURE = 5_000n;
const MEASURE_UNIT_LIMIT = 400_000;
const MAX_PRIORITY_MICRO_LAMPORTS = 1_000_000n;
/** Rent-exempt minimum for a 0-byte system account (890,880 lamports). */
const SYSTEM_ACCOUNT_SIZE = 0;
const TOKEN_ACCOUNT_SIZE = 165;

const transferInstructions = (
  from: string,
  to: string,
  asset: TransferAsset,
  amount: bigint,
): Instruction[] => {
  switch (asset.kind) {
    case 'sol':
      return [systemTransfer(from, to, amount)];
    case 'token':
      return [
        createAssociatedTokenAccountIdempotent(
          from,
          to,
          asset.mint,
          asset.tokenProgram,
        ),
        tokenTransferChecked({
          source: associatedTokenAddress(from, asset.mint, asset.tokenProgram),
          mint: asset.mint,
          destination: associatedTokenAddress(
            to,
            asset.mint,
            asset.tokenProgram,
          ),
          owner: from,
          amount,
          decimals: asset.decimals,
          tokenProgram: asset.tokenProgram,
        }),
      ];
    case 'nft':
      if (asset.programmable) {
        // The Token Metadata program creates the destination account itself.
        return [
          programmableNftTransfer({
            owner: from,
            destinationOwner: to,
            mint: asset.mint,
            ruleSet: asset.ruleSet,
            tokenProgram: asset.tokenProgram,
          }),
        ];
      }
      return [
        createAssociatedTokenAccountIdempotent(
          from,
          to,
          asset.mint,
          asset.tokenProgram,
        ),
        tokenTransferChecked({
          source: associatedTokenAddress(from, asset.mint, asset.tokenProgram),
          mint: asset.mint,
          destination: associatedTokenAddress(
            to,
            asset.mint,
            asset.tokenProgram,
          ),
          owner: from,
          amount: 1n,
          decimals: 0,
          tokenProgram: asset.tokenProgram,
        }),
      ];
  }
};

export const prepareTransfer = async ({
  rpc,
  from,
  to: rawTo,
  asset,
  amount,
}: {
  rpc: SolanaRpc;
  from: string;
  to: string;
  asset: TransferAsset;
  /** Base units (lamports / token base units); ignored for NFTs. */
  amount: bigint;
}): Promise<PreparedTransfer> => {
  const to = rawTo.trim();
  if (!isValidAddress(to)) {
    throw new TransferError('invalid_address');
  }
  if (to === from) {
    throw new TransferError('same_address');
  }
  const transferAmount = asset.kind === 'nft' ? 1n : amount;
  if (transferAmount <= 0n) {
    throw new TransferError('amount_zero');
  }

  const warnings: PreparedTransfer['warnings'] = [];
  const recipientOnCurve = isOnCurve(decodeAddress(to));
  if (!recipientOnCurve) {
    // Tokens sent to an address no wallet controls are usually lost.
    if (asset.kind !== 'sol') {
      throw new TransferError('off_curve_recipient');
    }
    warnings.push('recipient_off_curve');
  }

  const [recipient, senderLamports, systemRent, tokenRent] = await Promise.all([
    rpc.getAccountInfo(to),
    rpc.getBalance(from),
    rpc.getMinimumBalanceForRentExemption(SYSTEM_ACCOUNT_SIZE),
    asset.kind === 'sol'
      ? Promise.resolve(0n)
      : rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
  ]);
  if (recipient?.executable) {
    throw new TransferError('program_address');
  }
  if (
    recipient &&
    (recipient.owner === PROGRAM_IDS.token ||
      recipient.owner === PROGRAM_IDS.token2022)
  ) {
    // A token account address instead of the wallet address: a common
    // mistake that would send funds to the wrong place.
    throw new TransferError('token_account_address');
  }
  if (!recipient) {
    warnings.push('recipient_new_account');
  }

  let createsRecipientTokenAccount = false;
  if (asset.kind !== 'sol') {
    const recipientTokenAccount = associatedTokenAddress(
      to,
      asset.mint,
      asset.tokenProgram,
    );
    createsRecipientTokenAccount = !(await rpc.getAccountInfo(
      recipientTokenAccount,
    ));
  }
  const rentLamports = createsRecipientTokenAccount ? tokenRent : 0n;

  if (asset.kind === 'sol' && !recipient && transferAmount < systemRent) {
    throw new TransferError('below_rent_minimum');
  }

  const instructions = transferInstructions(from, to, asset, transferAmount);
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();

  // 1) Measure compute units with a generous limit and no priority fee.
  const measure = compileMessage({
    feePayer: from,
    recentBlockhash: blockhash,
    instructions: [setComputeUnitLimit(MEASURE_UNIT_LIMIT), ...instructions],
  });
  const measured = await rpc.simulate(unsignedTransaction(measure), [from]);
  if (measured.err) {
    throw new TransferError('simulation_failed', measured.logs);
  }
  const units = Math.min(
    MEASURE_UNIT_LIMIT,
    Math.ceil((measured.unitsConsumed || 50_000) * 1.2) + 1_000,
  );

  // 2) Final transaction with a capped median priority fee.
  const priorityPrice = await rpc
    .getPriorityFee([from, ...(asset.kind === 'sol' ? [to] : [asset.mint])])
    .catch(() => 0n);
  const microLamports =
    priorityPrice > MAX_PRIORITY_MICRO_LAMPORTS
      ? MAX_PRIORITY_MICRO_LAMPORTS
      : priorityPrice;
  const message = compileMessage({
    feePayer: from,
    recentBlockhash: blockhash,
    instructions: [
      setComputeUnitLimit(units),
      setComputeUnitPrice(microLamports),
      ...instructions,
    ],
  });
  const priorityLamports =
    (BigInt(units) * microLamports + 999_999n) / 1_000_000n;
  const feeLamports =
    BASE_FEE_PER_SIGNATURE * BigInt(message.numRequiredSignatures) +
    priorityLamports;

  const solSpent =
    feeLamports + rentLamports + (asset.kind === 'sol' ? transferAmount : 0n);
  if (solSpent > senderLamports) {
    throw new TransferError(
      asset.kind === 'sol'
        ? 'insufficient_balance'
        : 'insufficient_sol_for_fees',
    );
  }
  const left = senderLamports - solSpent;
  if (left > 0n && left < systemRent) {
    // The runtime rejects leaving a non-zero balance below rent exemption.
    throw new TransferError('leaves_dust');
  }

  const final = await rpc.simulate(unsignedTransaction(message), [from]);
  if (final.err) {
    throw new TransferError('simulation_failed', final.logs);
  }

  return {
    message,
    lastValidBlockHeight,
    feeLamports,
    rentLamports,
    createsRecipientTokenAccount,
    senderLamportsBefore: senderLamports,
    senderLamportsAfter: final.postLamports[0] ?? null,
    warnings,
  };
};

/** Polls until the transaction is confirmed, failed or its blockhash expired. */
export const waitForConfirmation = async (
  rpc: SolanaRpc,
  signature: string,
  lastValidBlockHeight: number,
  { intervalMs = 2_000, maxPolls = 90 } = {},
): Promise<'confirmed' | 'failed' | 'expired' | 'unknown'> => {
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const status = await rpc.getSignatureStatus(signature).catch(() => null);
    if (status?.err) {
      return 'failed';
    }
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      return 'confirmed';
    }
    const height = await rpc.getBlockHeight().catch(() => null);
    if (height !== null && height > lastValidBlockHeight) {
      return 'expired';
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return 'unknown';
};

/** Human amount → base units, rejecting more decimals than the asset has. */
export const parseAmount = (text: string, decimals: number): bigint | null => {
  const value = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    return null;
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
};

export const formatAmount = (
  value: bigint,
  decimals: number,
  maxFraction = decimals,
) => {
  const negative = value < 0n;
  const digits = (negative ? -value : value)
    .toString()
    .padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = digits
    .slice(digits.length - decimals)
    .slice(0, maxFraction)
    .replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
};
