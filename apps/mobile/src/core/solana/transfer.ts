/**
 * Prepares (but does not sign) SOL / SPL token / NFT transfers: validates the
 * recipient, builds the transaction, sizes compute units and the priority
 * fee, and simulates the final transaction so the user reviews exactly what
 * will happen. Nothing can be signed unless the simulation succeeds.
 *
 * The returned `PreparedTransfer` carries the recipient and amount that are
 * actually encoded in `message`: the review screen must show those values,
 * never live input state.
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
      /** The token account to debit (defaults to the sender's ATA). */
      sourceAccount?: string;
    }
  | {
      kind: 'nft';
      mint: string;
      tokenProgram: string;
      programmable: boolean;
      ruleSet: string | null;
      /** The token account holding the NFT (defaults to the sender's ATA). */
      sourceAccount?: string;
    };

export type TransferIssue =
  | 'invalid_address'
  | 'same_address'
  | 'program_address'
  | 'token_account_address'
  | 'off_curve_recipient'
  | 'program_owned_recipient'
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

export type TransferWarning =
  | 'recipient_new_account'
  | 'recipient_off_curve'
  | 'recipient_program_owned'
  | 'token_transfer_fee';

export type PreparedTransfer = {
  message: CompiledMessage;
  lastValidBlockHeight: number;
  /** Exactly what `message` sends: show these on the review screen. */
  from: string;
  to: string;
  asset: TransferAsset;
  /** Base units encoded in the transfer instruction (1 for NFTs). */
  amount: bigint;
  /** Base fee + priority fee, in lamports. */
  feeLamports: bigint;
  /** Rent paid to create the recipient's token account (0 if it exists). */
  rentLamports: bigint;
  createsRecipientTokenAccount: boolean;
  senderLamportsBefore: bigint;
  senderLamportsAfter: bigint | null;
  /** Token-2022 transfer fee in basis points, when the mint charges one. */
  transferFeeBasisPoints: number | null;
  /** Non-blocking notes to show on the review screen. */
  warnings: TransferWarning[];
};

const BASE_FEE_PER_SIGNATURE = 5_000n;
const MEASURE_UNIT_LIMIT = 400_000;
const MAX_PRIORITY_MICRO_LAMPORTS = 1_000_000n;
/** Rent-exempt minimum for a 0-byte system account (890,880 lamports). */
const SYSTEM_ACCOUNT_SIZE = 0;
/** SPL Token account; Token-2022 ATAs also carry the ImmutableOwner extension. */
const TOKEN_ACCOUNT_SIZE = 165;
const TOKEN_2022_ACCOUNT_SIZE = 170;

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
          source:
            asset.sourceAccount ||
            associatedTokenAddress(from, asset.mint, asset.tokenProgram),
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
            sourceAccount: asset.sourceAccount,
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
          source:
            asset.sourceAccount ||
            associatedTokenAddress(from, asset.mint, asset.tokenProgram),
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

/** Token-2022 `transferFeeConfig` (newer epoch) in basis points, if any. */
const readTransferFeeBasisPoints = async (rpc: SolanaRpc, mint: string) => {
  const result = await rpc.call<{
    value: {
      data?: {
        parsed?: {
          info?: {
            extensions?: Array<{
              extension: string;
              state?: {
                newerTransferFee?: { transferFeeBasisPoints?: number };
              };
            }>;
          };
        };
      };
    } | null;
  }>('getAccountInfo', [
    mint,
    { encoding: 'jsonParsed', commitment: 'confirmed' },
  ]);
  const config = result.value?.data?.parsed?.info?.extensions?.find(
    extension => extension.extension === 'transferFeeConfig',
  );
  const bps = config?.state?.newerTransferFee?.transferFeeBasisPoints;
  return typeof bps === 'number' && bps > 0 ? bps : null;
};

export const prepareTransfer = async ({
  rpc,
  from,
  to: rawTo,
  asset,
  amount,
  sendAll = false,
}: {
  rpc: SolanaRpc;
  from: string;
  to: string;
  asset: TransferAsset;
  /** Base units (lamports / token base units); ignored for NFTs. */
  amount: bigint;
  /** SOL only: send the whole balance minus the network fee. */
  sendAll?: boolean;
}): Promise<PreparedTransfer> => {
  const to = rawTo.trim();
  if (!isValidAddress(to)) {
    throw new TransferError('invalid_address');
  }
  if (to === from) {
    throw new TransferError('same_address');
  }
  const solSendAll = sendAll && asset.kind === 'sol';
  let transferAmount = asset.kind === 'nft' ? 1n : amount;
  if (transferAmount <= 0n && !solSendAll) {
    throw new TransferError('amount_zero');
  }

  const warnings: TransferWarning[] = [];
  const recipientOnCurve = isOnCurve(decodeAddress(to));
  if (!recipientOnCurve) {
    // Tokens sent to an address no wallet controls are usually lost.
    if (asset.kind !== 'sol') {
      throw new TransferError('off_curve_recipient');
    }
    warnings.push('recipient_off_curve');
  }

  const isToken2022 =
    asset.kind !== 'sol' && asset.tokenProgram === PROGRAM_IDS.token2022;
  const [recipient, senderLamports, systemRent, tokenRent] = await Promise.all([
    rpc.getAccountInfo(to),
    rpc.getBalance(from),
    rpc.getMinimumBalanceForRentExemption(SYSTEM_ACCOUNT_SIZE),
    asset.kind === 'sol'
      ? Promise.resolve(0n)
      : rpc.getMinimumBalanceForRentExemption(
          isToken2022 ? TOKEN_2022_ACCOUNT_SIZE : TOKEN_ACCOUNT_SIZE,
        ),
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
  if (recipient && recipient.owner !== PROGRAM_IDS.system) {
    // Owned by some program (stake, nonce, …): tokens there may be lost.
    if (asset.kind !== 'sol') {
      throw new TransferError('program_owned_recipient');
    }
    warnings.push('recipient_program_owned');
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

  const transferFeeBasisPoints =
    asset.kind === 'token' && isToken2022
      ? await readTransferFeeBasisPoints(rpc, asset.mint).catch(() => null)
      : null;
  if (transferFeeBasisPoints) {
    warnings.push('token_transfer_fee');
  }

  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();

  // 1) Measure compute units with a generous limit and no priority fee
  //    (a placeholder amount of 1 lamport when sending the whole balance).
  const measureAmount = solSendAll ? 1n : transferAmount;
  const measure = compileMessage({
    feePayer: from,
    recentBlockhash: blockhash,
    instructions: [
      setComputeUnitLimit(MEASURE_UNIT_LIMIT),
      ...transferInstructions(from, to, asset, measureAmount),
    ],
  });
  const measured = await rpc.simulate(unsignedTransaction(measure), [from]);
  if (measured.err) {
    throw new TransferError('simulation_failed', measured.logs);
  }
  const units = Math.min(
    MEASURE_UNIT_LIMIT,
    Math.ceil((measured.unitsConsumed || 50_000) * 1.2) + 1_000,
  );

  // 2) Fee with a capped median priority fee.
  const priorityPrice = await rpc
    .getPriorityFee([from, ...(asset.kind === 'sol' ? [to] : [asset.mint])])
    .catch(() => 0n);
  const microLamports =
    priorityPrice < 0n
      ? 0n
      : priorityPrice > MAX_PRIORITY_MICRO_LAMPORTS
      ? MAX_PRIORITY_MICRO_LAMPORTS
      : priorityPrice;
  const priorityLamports =
    (BigInt(units) * microLamports + 999_999n) / 1_000_000n;
  const feeLamports = BASE_FEE_PER_SIGNATURE + priorityLamports;

  if (solSendAll) {
    transferAmount = senderLamports - feeLamports;
    if (transferAmount <= 0n) {
      throw new TransferError('insufficient_balance');
    }
  }
  if (asset.kind === 'sol' && !recipient && transferAmount < systemRent) {
    throw new TransferError('below_rent_minimum');
  }

  const message = compileMessage({
    feePayer: from,
    recentBlockhash: blockhash,
    instructions: [
      setComputeUnitLimit(units),
      setComputeUnitPrice(microLamports),
      ...transferInstructions(from, to, asset, transferAmount),
    ],
  });
  if (message.numRequiredSignatures !== 1) {
    throw new TransferError('simulation_failed');
  }

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
    from,
    to,
    asset,
    amount: transferAmount,
    feeLamports,
    rentLamports,
    createsRecipientTokenAccount,
    senderLamportsBefore: senderLamports,
    senderLamportsAfter: final.postLamports[0] ?? null,
    transferFeeBasisPoints,
    warnings,
  };
};

export type ConfirmationStatus = 'confirmed' | 'failed' | 'expired' | 'unknown';

/** Polls until the transaction is confirmed, failed or its blockhash expired. */
export const waitForConfirmation = async (
  rpc: SolanaRpc,
  signature: string,
  lastValidBlockHeight: number,
  { intervalMs = 2_000, maxPolls = 90 } = {},
): Promise<ConfirmationStatus> => {
  const readStatus = async (): Promise<ConfirmationStatus | 'pending'> => {
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
    // `processed` (or unknown yet) is still pending.
    return 'pending';
  };
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const status = await readStatus();
    if (status !== 'pending') {
      return status;
    }
    const height = await rpc.getBlockHeight().catch(() => null);
    if (height !== null && height > lastValidBlockHeight) {
      // The transaction may have landed between the two reads: check again
      // before calling it expired.
      const last = await readStatus();
      return last === 'pending' ? 'expired' : last;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  return 'unknown';
};

/**
 * Human amount → base units. Accepts one decimal separator ("." or ","),
 * and rejects digit grouping ("1,000.5", "1.000,5") and more decimals than
 * the asset has, so what is signed always matches what was typed.
 */
export const parseAmount = (text: string, decimals: number): bigint | null => {
  const value = text.trim();
  if (!/^\d+([.,]\d+)?$/.test(value)) {
    return null;
  }
  const [whole, fraction = ''] = value.split(/[.,]/);
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
