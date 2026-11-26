/**
 * ETH → Solana bridge transfers (Wormhole Token Bridge), persisted locally
 * and advanced automatically:
 *
 *   pending_eth → waiting_guardians → redeeming → [swapping →] completed
 *                                   ↘ needs_sol (top up SOL, then retried)
 *
 * With `swapTo: 'ARIO'` the redeemed WETH is swapped on Raydium
 * (WETH → SOL → USDC → ARIO) right after the redeem, one resumable hop at a
 * time (see core/solana/raydiumSwap).
 *
 * Every step re-checks the chain, so the flow survives app restarts and
 * never redeems twice.
 */
import { useEffect, useState } from 'react';
import { bytesToHex } from '@noble/hashes/utils';
import { Buffer } from 'buffer';

import { appJsonStore } from '@/core/storage/mmkv';
import { getSolanaAccount } from '@/core/solana/account';
import { encodeAddress } from '@/core/solana/keys';
import { WETH_TO_ARIO } from '@/core/solana/raydium';
import {
  advanceSwap,
  isSwapDone,
  startSwap,
  SwapError,
  SwapProgress,
} from '@/core/solana/raydiumSwap';
import { getSolanaRpc } from '@/core/solana/settings';

import { WORMHOLE } from './constants';
import {
  getReceipt,
  guardianKeyBytes,
  readGuardianSet,
  sequenceFromReceipt,
  tokenBridgeEmitterHex,
  WEI_PER_WRAPPED_UNIT,
} from './evm';
import { redeemOnSolana, RedeemError } from './redeem';
import {
  evmAddressToBytes32,
  ParsedVaa,
  parseTokenTransfer,
  parseVaa,
  verifyVaaSignatures,
} from './vaa';

export type BridgeStatus =
  | 'pending_eth'
  | 'waiting_guardians'
  | 'redeeming'
  | 'needs_sol'
  | 'swapping'
  | 'completed'
  | 'failed';

export type BridgeTransfer = {
  ethTxHash: string;
  evmAddress: string;
  solanaOwner: string;
  recipientTokenAccount: string;
  amountWei: string;
  createdAt: number;
  status: BridgeStatus;
  sequence?: string;
  error?: string;
  solanaSignatures?: string[];
  updatedAt?: number;
  /** Swap the redeemed WETH into this token after the redeem. */
  swapTo?: 'ARIO';
  swapSlippageBps?: number;
  swap?: SwapProgress;
  /** Final amount received in `swapTo` (raw units), once done. */
  swapReceived?: string;
  /** The swap was stopped: the funds were kept as this token. */
  swapStoppedAs?: string;
};

/** Token held at each step of the ARIO route (what a stop keeps). */
export const SWAP_STEP_TOKENS = ['WETH', 'SOL', 'USDC', 'ARIO'] as const;
export const ARIO_DECIMALS = 6;

const STORAGE_KEY = 'helios:wormholeTransfers:v1';
const MAX_KEPT = 50;
const listeners = new Set<() => void>();

const readAll = (): BridgeTransfer[] => {
  try {
    const value = appJsonStore.getItem(STORAGE_KEY, null);
    return Array.isArray(value) ? (value as BridgeTransfer[]) : [];
  } catch {
    return [];
  }
};

const writeAll = (transfers: BridgeTransfer[]) => {
  appJsonStore.setItem(STORAGE_KEY, transfers.slice(-MAX_KEPT));
  listeners.forEach(listener => listener());
};

export const getBridgeTransfers = () => readAll();

export const addBridgeTransfer = (transfer: BridgeTransfer) => {
  writeAll([
    ...readAll().filter(t => t.ethTxHash !== transfer.ethTxHash),
    transfer,
  ]);
};

const update = (ethTxHash: string, patch: Partial<BridgeTransfer>) => {
  writeAll(
    readAll().map(t =>
      t.ethTxHash === ethTxHash ? { ...t, ...patch, updatedAt: Date.now() } : t,
    ),
  );
};

/** Stops a pending swap and keeps the funds as the token held right now. */
export const stopBridgeSwap = (ethTxHash: string) => {
  const transfer = readAll().find(t => t.ethTxHash === ethTxHash);
  if (!transfer || !transfer.swapTo || isFinal(transfer.status)) {
    return;
  }
  if (transfer.swap?.pending) {
    return; // a hop is in flight: it settles first
  }
  update(ethTxHash, {
    status: transfer.status === 'swapping' ? 'completed' : transfer.status,
    swapTo: undefined,
    swapStoppedAs: SWAP_STEP_TOKENS[transfer.swap?.hop ?? 0],
    error: undefined,
  });
};

export const isFinal = (status: BridgeStatus) =>
  status === 'completed' || status === 'failed';

export const useBridgeTransfers = (evmAddress?: string) => {
  const [transfers, setTransfers] = useState(readAll);
  useEffect(() => {
    const refresh = () => setTransfers(readAll());
    listeners.add(refresh);
    refresh();
    return () => {
      listeners.delete(refresh);
    };
  }, []);
  return evmAddress
    ? transfers.filter(
        t => t.evmAddress.toLowerCase() === evmAddress.toLowerCase(),
      )
    : transfers;
};

// ---- VAA download + checks ---------------------------------------------------

const VAA_TIMEOUT_MS = 10_000;

const fetchVaaBytes = async (sequence: string): Promise<Uint8Array | null> => {
  const path = `/v1/signed_vaa/${
    WORMHOLE.ethChainId
  }/${tokenBridgeEmitterHex()}/${sequence}`;
  for (const base of WORMHOLE.vaaApis) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VAA_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${path}`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const body = (await response.json()) as { vaaBytes?: string };
        if (typeof body.vaaBytes === 'string' && body.vaaBytes.length < 8_000) {
          return Uint8Array.from(Buffer.from(body.vaaBytes, 'base64'));
        }
      }
    } catch {
      // Try the next source.
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
};

/**
 * Parses and fully checks a VAA for `transfer`: guardian signatures (against
 * the guardian set read from Ethereum), emitter, sequence, token, recipient
 * and amount. Throws with a reason on any mismatch.
 */
export const checkTransferVaa = async (
  bytes: Uint8Array,
  transfer: Pick<
    BridgeTransfer,
    'sequence' | 'recipientTokenAccount' | 'amountWei'
  >,
  loadGuardians: typeof readGuardianSet = readGuardianSet,
): Promise<{ vaa: ParsedVaa; guardianKeys: Uint8Array[] }> => {
  const vaa = parseVaa(bytes);
  if (
    vaa.emitterChain !== WORMHOLE.ethChainId ||
    bytesToHex(vaa.emitterAddress) !== tokenBridgeEmitterHex() ||
    vaa.sequence.toString() !== transfer.sequence
  ) {
    throw new Error('VAA is not this transfer');
  }
  const { guardians } = await loadGuardians(vaa.guardianSetIndex);
  if (!verifyVaaSignatures(vaa, guardians)) {
    throw new Error('VAA guardian signatures are invalid');
  }
  const payload = parseTokenTransfer(vaa.payload);
  const weth = bytesToHex(evmAddressToBytes32(WORMHOLE.ethWeth));
  if (
    payload.toChain !== WORMHOLE.solanaChainId ||
    payload.tokenChain !== WORMHOLE.ethChainId ||
    bytesToHex(payload.tokenAddress) !== weth ||
    encodeAddress(payload.to) !== transfer.recipientTokenAccount ||
    payload.amount !== BigInt(transfer.amountWei) / WEI_PER_WRAPPED_UNIT ||
    payload.fee !== 0n
  ) {
    throw new Error('VAA transfer details do not match');
  }
  return { vaa, guardianKeys: guardianKeyBytes(guardians) };
};

// ---- engine -----------------------------------------------------------------

/** Runs the post-redeem swap as far as possible; errors are retried later. */
const runSwap = async (transfer: BridgeTransfer) => {
  const route = WETH_TO_ARIO;
  let progress = transfer.swap!;
  try {
    const account = await getSolanaAccount(transfer.evmAddress);
    if (account.address !== transfer.solanaOwner) {
      throw new Error('The Solana account no longer matches this transfer.');
    }
    progress = await advanceSwap({
      rpc: getSolanaRpc(),
      account,
      route,
      progress,
      slippageBps: transfer.swapSlippageBps,
      save: next => update(transfer.ethTxHash, { swap: next }),
    });
    if (isSwapDone(route, progress)) {
      update(transfer.ethTxHash, {
        status: 'completed',
        error: undefined,
        swap: progress,
        swapReceived: progress.amount,
      });
    }
  } catch (error) {
    if (error instanceof SwapError && error.code === 'input_missing') {
      // The tokens of this step were moved elsewhere: nothing more to do.
      update(transfer.ethTxHash, {
        status: 'completed',
        swapTo: undefined,
        swapStoppedAs: SWAP_STEP_TOKENS[progress.hop],
        error: error.message,
      });
      return;
    }
    update(transfer.ethTxHash, {
      error:
        error instanceof SwapError && error.code === 'needs_sol'
          ? 'Needs about 0.003 SOL for the swap fees (refunded rent included).'
          : error instanceof Error
          ? error.message
          : 'swap failed',
    });
  }
};

const running = new Set<string>();

/** Advances one transfer as far as possible right now. */
export const advanceBridgeTransfer = async (transfer: BridgeTransfer) => {
  if (isFinal(transfer.status) || running.has(transfer.ethTxHash)) {
    return;
  }
  running.add(transfer.ethTxHash);
  try {
    let current = transfer;
    if (current.status === 'swapping') {
      await runSwap(current);
      return;
    }
    if (current.status === 'pending_eth') {
      const receipt = await getReceipt(current.ethTxHash);
      if (!receipt) {
        return;
      }
      if (receipt.status !== '0x1') {
        update(current.ethTxHash, {
          status: 'failed',
          error: 'The Ethereum transaction failed (no funds were bridged).',
        });
        return;
      }
      const sequence = sequenceFromReceipt(receipt);
      if (sequence === null) {
        update(current.ethTxHash, {
          status: 'failed',
          error: 'No Wormhole message in the Ethereum transaction.',
        });
        return;
      }
      current = {
        ...current,
        status: 'waiting_guardians',
        sequence: sequence.toString(),
      };
      update(current.ethTxHash, {
        status: current.status,
        sequence: current.sequence,
      });
    }

    const bytes = await fetchVaaBytes(current.sequence!);
    if (!bytes) {
      return; // Guardians have not signed yet (finality takes ~15 min).
    }
    let checked;
    try {
      checked = await checkTransferVaa(bytes, current);
    } catch (error) {
      // A source served a bad VAA: keep waiting, never redeem it.
      update(current.ethTxHash, {
        error: error instanceof Error ? error.message : 'invalid VAA',
      });
      return;
    }

    const account = await getSolanaAccount(current.evmAddress);
    if (account.address !== current.solanaOwner) {
      update(current.ethTxHash, {
        status: 'failed',
        error: 'The Solana account no longer matches this transfer.',
      });
      return;
    }
    update(current.ethTxHash, { status: 'redeeming', error: undefined });
    try {
      const result = await redeemOnSolana({
        rpc: getSolanaRpc(),
        account,
        vaa: checked.vaa,
        guardianKeys: checked.guardianKeys,
      });
      const signatures = [
        ...(current.solanaSignatures || []),
        ...result.signatures,
      ];
      if (current.swapTo) {
        const swapping: BridgeTransfer = {
          ...current,
          status: 'swapping',
          error: undefined,
          solanaSignatures: signatures,
          swap:
            current.swap ||
            startSwap(BigInt(current.amountWei) / WEI_PER_WRAPPED_UNIT),
        };
        update(current.ethTxHash, swapping);
        await runSwap(swapping);
        return;
      }
      update(current.ethTxHash, {
        status: 'completed',
        error: undefined,
        solanaSignatures: signatures,
      });
    } catch (error) {
      const needsSol =
        error instanceof RedeemError && error.code === 'needs_sol';
      update(current.ethTxHash, {
        status: needsSol ? 'needs_sol' : 'redeeming',
        error: error instanceof Error ? error.message : 'redeem failed',
      });
    }
  } catch (error) {
    // Network or keyring not ready: retried on the next tick.
    update(transfer.ethTxHash, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running.delete(transfer.ethTxHash);
  }
};

export const advanceAllBridgeTransfers = async () => {
  for (const transfer of readAll()) {
    if (!isFinal(transfer.status)) {
      await advanceBridgeTransfer(transfer);
    }
  }
};
