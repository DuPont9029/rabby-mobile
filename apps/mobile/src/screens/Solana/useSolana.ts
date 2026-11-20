import { useCallback, useEffect, useMemo, useState } from 'react';
import { KEYRING_TYPE } from '@rabby-wallet/keyring-utils';

import { useMyAccounts } from '@/hooks/account';
import {
  getSolanaAccount,
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
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; reason: string };

export const useSolanaAccount = (evmAddress?: string) => {
  const [state, setState] = useState<LoadState<SolanaAccount>>({
    status: 'loading',
  });
  useEffect(() => {
    let active = true;
    if (!evmAddress) {
      setState({ status: 'error', reason: 'not_hd_account' });
      return;
    }
    setState({ status: 'loading' });
    getSolanaAccount(evmAddress)
      .then(account => active && setState({ status: 'ready', value: account }))
      .catch(error => {
        if (active) {
          const reason =
            error instanceof SolanaAccountError
              ? error.reason
              : `unknown: ${
                  error instanceof Error ? error.message : String(error)
                }`;
          console.warn('[solana] account derivation failed', reason);
          setState({ status: 'error', reason });
        }
      });
    return () => {
      active = false;
    };
  }, [evmAddress]);
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
