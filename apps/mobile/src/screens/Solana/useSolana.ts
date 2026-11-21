import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ensureWalletUnlockedForAction } from '@/utils/walletUnlock';
import { KEYRING_TYPE } from '@rabby-wallet/keyring-utils';

import { useMyAccounts } from '@/hooks/account';
import {
  getCachedSolanaAccount,
  getSolanaAccount,
  isTransientSolanaAccountError,
  SolanaAccount,
  SolanaAccountError,
} from '@/core/solana/account';
import { loadSolanaPortfolio, SolanaPortfolio } from '@/core/solana/portfolio';
import { getSolanaRpc } from '@/core/solana/settings';

/** Seed-phrase (HD) accounts: the only ones a Solana key can be derived from. */
export const useSolanaHdAccounts = () => {
  const { accounts } = useMyAccounts();
  return useMemo(
    () => accounts.filter(account => account.type === KEYRING_TYPE.HdKeyring),
    [accounts],
  );
};

export type LoadState<T> =
  /** `reason`: why it is still waiting (retrying), e.g. `locked`. */
  | { status: 'loading'; reason?: string }
  | { status: 'ready'; value: T }
  | { status: 'error'; reason: string };

/** Retries for keyring-loading states, then every 5 s while the screen lives. */
const ACCOUNT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 3_000, 5_000];
/** One derivation attempt never blocks the screen longer than this. */
const ACCOUNT_ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * Asks for the wallet password / biometrics when the keys are locked, then
 * lets the account hook pick the keys up on its next retry.
 */
export const useSolanaUnlockPrompt = (
  state: LoadState<unknown>,
  { auto }: { auto: boolean },
) => {
  const prompted = useRef(false);
  const [unlocking, setUnlocking] = useState(false);
  const locked = state.status === 'loading' && state.reason === 'locked';
  const unlock = useCallback(async () => {
    if (unlocking) {
      return;
    }
    setUnlocking(true);
    try {
      await ensureWalletUnlockedForAction();
    } catch {
      // Cancelled or failed: the button stays available.
    } finally {
      setUnlocking(false);
    }
  }, [unlocking]);
  useEffect(() => {
    if (auto && locked && !prompted.current) {
      prompted.current = true;
      unlock();
    }
  }, [auto, locked, unlock]);
  return { locked, unlocking, unlock };
};

export const useSolanaAccount = (evmAddress?: string) => {
  const [state, setState] = useState<LoadState<SolanaAccount>>({
    status: 'loading',
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setAttempt(0);
    // Show the address derived before right away (public data only).
    const cached = evmAddress ? getCachedSolanaAccount(evmAddress) : null;
    setState(
      cached ? { status: 'ready', value: cached } : { status: 'loading' },
    );
  }, [evmAddress]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!evmAddress) {
      // Accounts still loading: not an error.
      return;
    }
    Promise.race([
      getSolanaAccount(evmAddress),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new SolanaAccountError('not_ready')),
          ACCOUNT_ATTEMPT_TIMEOUT_MS,
        ),
      ),
    ])
      .then(account => active && setState({ status: 'ready', value: account }))
      .catch(error => {
        if (!active) {
          return;
        }
        const reason =
          error instanceof SolanaAccountError
            ? error.reason
            : `unknown: ${
                error instanceof Error ? error.message : String(error)
              }`;
        console.warn('[solana] account derivation failed', reason);
        if (isTransientSolanaAccountError(reason)) {
          const delay =
            ACCOUNT_RETRY_DELAYS_MS[
              Math.min(attempt, ACCOUNT_RETRY_DELAYS_MS.length - 1)
            ];
          timer = setTimeout(() => setAttempt(value => value + 1), delay);
          // Keep showing the cached address while retrying.
          setState(previous =>
            previous.status === 'ready'
              ? previous
              : { status: 'loading', reason },
          );
          return;
        }
        setState({ status: 'error', reason });
      });
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [evmAddress, attempt]);
  return state;
};

const RETRY_DELAYS_MS = [2_000, 6_000];

export const useSolanaPortfolio = (address?: string) => {
  const [state, setState] = useState<LoadState<SolanaPortfolio>>({
    status: 'loading',
  });
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(() => {
    setAttempt(0);
    setVersion(value => value + 1);
  }, []);

  // Another account: never show the previous account's balances/NFTs.
  useEffect(() => {
    setState({ status: 'loading' });
    setAttempt(0);
  }, [address]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!address) {
      return;
    }
    setState(previous =>
      previous.status === 'ready' ? previous : { status: 'loading' },
    );
    loadSolanaPortfolio(getSolanaRpc(), address)
      .then(value => {
        if (active) {
          setState({ status: 'ready', value });
        }
      })
      .catch(error => {
        if (!active) {
          return;
        }
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          timer = setTimeout(() => setAttempt(value => value + 1), delay);
          return;
        }
        setState({
          status: 'error',
          reason: error instanceof Error ? error.message : 'unknown',
        });
      });
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [address, attempt, version]);

  return { state, refresh };
};
