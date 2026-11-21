/**
 * Redeems a verified Wormhole ETH transfer on Solana, signed automatically
 * with the wallet's derived Solana key (the user approved the whole bridge
 * when sending the Ethereum transaction). Every transaction is built here:
 * it can only create the bridge's bookkeeping accounts and mint the wrapped
 * ETH into the user's own token account.
 *
 * Steps are idempotent and resumable: an existing posted VAA or claim is
 * detected and skipped.
 */
import { randomBytes } from '@noble/hashes/utils';

import { SolanaAccount, withSolanaSigner } from '@/core/solana/account';
import { encodeAddress, publicKeyFromPrivateKey } from '@/core/solana/keys';
import { SolanaRpc } from '@/core/solana/rpc';
import { waitForConfirmation } from '@/core/solana/transfer';
import {
  associatedTokenAddress,
  compileMessage,
  Instruction,
  signTransactionWithSigners,
} from '@/core/solana/tx';

import { WORMHOLE } from './constants';
import {
  claimAddress,
  postedVaaAddress,
  postVaaInstruction,
  redeemInstructions,
  verifySignaturesInstructions,
} from './solana';
import { ParsedVaa, quorum, withFirstSignatures } from './vaa';

/** On-chain sizes of the accounts a redeem creates (bytes). */
const SIGNATURE_SET_SIZE = 4 + 19 + 32 + 4;
const POSTED_VAA_BASE_SIZE = 3 + 1 + 1 + 4 + 32 + 4 + 4 + 8 + 2 + 32 + 4;
const CLAIM_SIZE = 1;
const TOKEN_ACCOUNT_SIZE = 165;
/** Generous: up to 3 verify batches (2 signatures each) + post + complete. */
const FEE_LAMPORTS = 5_000n * 10n;
/** Token-transfer payload length (type 1). */
const TRANSFER_PAYLOAD_SIZE = 133;

export class RedeemError extends Error {
  constructor(
    message: string,
    /** Retrying later can help (network, expired blockhash, low SOL). */
    readonly transient: boolean,
    readonly code?: 'needs_sol',
  ) {
    super(message);
    this.name = 'RedeemError';
  }
}

/** Lamports a redeem costs (rent of the new accounts + fees). */
export const estimateRedeemLamports = async (
  rpc: SolanaRpc,
  owner: string,
): Promise<bigint> => {
  const tokenAccount = associatedTokenAddress(
    owner,
    WORMHOLE.solWrappedEthMint,
  );
  const [sigSet, posted, claim, ata, existing] = await Promise.all([
    rpc.getMinimumBalanceForRentExemption(SIGNATURE_SET_SIZE),
    rpc.getMinimumBalanceForRentExemption(
      POSTED_VAA_BASE_SIZE + TRANSFER_PAYLOAD_SIZE,
    ),
    rpc.getMinimumBalanceForRentExemption(CLAIM_SIZE),
    rpc.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE),
    rpc.getAccountInfo(tokenAccount),
  ]);
  return sigSet + posted + claim + (existing ? 0n : ata) + FEE_LAMPORTS;
};

const sendAndConfirm = async (
  rpc: SolanaRpc,
  account: SolanaAccount,
  instructions: Instruction[],
  extraSigner?: { address: string; privateKey: Uint8Array },
) => {
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash();
  const message = compileMessage({
    feePayer: account.address,
    recentBlockhash: blockhash,
    instructions,
  });
  const wire = await withSolanaSigner(account, privateKey =>
    signTransactionWithSigners(message, [
      { address: account.address, privateKey },
      ...(extraSigner ? [extraSigner] : []),
    ]),
  );
  let signature: string;
  try {
    signature = await rpc.sendTransaction(wire);
  } catch (error) {
    throw new RedeemError(
      error instanceof Error ? error.message : 'send failed',
      true,
    );
  }
  const status = await waitForConfirmation(
    rpc,
    signature,
    lastValidBlockHeight,
  );
  if (status === 'failed') {
    throw new RedeemError(`Solana transaction failed: ${signature}`, true);
  }
  if (status !== 'confirmed') {
    throw new RedeemError('Solana transaction not confirmed yet', true);
  }
  return signature;
};

/**
 * Posts the VAA (if needed) and completes the transfer (if not yet claimed).
 * `vaa` must already be verified by the caller. Returns the signatures sent.
 */
export const redeemOnSolana = async ({
  rpc,
  account,
  vaa,
  guardianKeys,
}: {
  rpc: SolanaRpc;
  account: SolanaAccount;
  vaa: ParsedVaa;
  guardianKeys: Uint8Array[];
}): Promise<{ signatures: string[]; alreadyClaimed: boolean }> => {
  const owner = account.address;
  // Throws if the VAA is not addressed to this wallet's token account.
  const finalInstructions = redeemInstructions(owner, owner, vaa);

  if (await rpc.getAccountInfo(claimAddress(vaa))) {
    return { signatures: [], alreadyClaimed: true };
  }

  const needed = await estimateRedeemLamports(rpc, owner);
  const balance = await rpc.getBalance(owner);
  const posted = await rpc.getAccountInfo(postedVaaAddress(vaa.hash));
  if (!posted && balance < needed) {
    throw new RedeemError(
      `needs ${needed} lamports of SOL, has ${balance}`,
      true,
      'needs_sol',
    );
  }

  const signatures: string[] = [];
  if (!posted) {
    // One-time account holding the verified signatures.
    const seed = randomBytes(32);
    const signatureSet = {
      address: encodeAddress(publicKeyFromPrivateKey(seed)),
      privateKey: seed,
    };
    try {
      const trimmed = withFirstSignatures(vaa, quorum(guardianKeys.length));
      for (const batch of verifySignaturesInstructions(
        owner,
        trimmed,
        guardianKeys,
        signatureSet.address,
      )) {
        signatures.push(
          await sendAndConfirm(rpc, account, batch, signatureSet),
        );
      }
      signatures.push(
        await sendAndConfirm(rpc, account, [
          postVaaInstruction(owner, trimmed, signatureSet.address),
        ]),
      );
    } finally {
      seed.fill(0);
    }
  }
  signatures.push(await sendAndConfirm(rpc, account, finalInstructions));
  return { signatures, alreadyClaimed: false };
};
