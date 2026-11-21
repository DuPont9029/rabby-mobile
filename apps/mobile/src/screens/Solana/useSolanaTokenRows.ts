import { useCallback, useMemo } from 'react';
import { StackActions } from '@react-navigation/native';

import { RootNames } from '@/constant/layout';
import { formatAmount } from '@/core/solana/transfer';
import { navigationRef } from '@/utils/navigation';
import type { SolanaAssetRowData } from '@/screens/Home/components/SolanaAssetRow';

import {
  useSolanaAccount,
  useSolanaPortfolio,
  useSolanaUnlockPrompt,
} from './useSolana';

/**
 * Rows for the Solana account of a seed-phrase address, for the home token
 * lists: SOL and SPL tokens; a "tap to unlock" row when the keys are locked
 * and the address was never derived; a loading row meanwhile. Never prompts
 * by itself.
 */
export const useSolanaTokenRows = (evmAddress?: string) => {
  const solanaAccount = useSolanaAccount(evmAddress);
  const { state: portfolio } = useSolanaPortfolio(
    evmAddress && solanaAccount.status === 'ready'
      ? solanaAccount.value.address
      : undefined,
  );
  const unlockPrompt = useSolanaUnlockPrompt(solanaAccount, { auto: false });

  const rows = useMemo<SolanaAssetRowData[]>(() => {
    if (!evmAddress) {
      return [];
    }
    if (unlockPrompt.locked) {
      return [
        {
          key: 'sol-locked',
          symbol: 'SOL',
          name: 'Solana · tap to unlock',
          amountText: '🔒',
        },
      ];
    }
    if (portfolio.status !== 'ready') {
      return solanaAccount.status === 'error'
        ? []
        : [
            {
              key: 'sol-loading',
              symbol: 'SOL',
              name: 'Solana',
              amountText: '…',
            },
          ];
    }
    const { lamports, tokens } = portfolio.value;
    const out: SolanaAssetRowData[] = [
      {
        key: 'sol',
        symbol: 'SOL',
        name: 'Solana',
        amountText: formatAmount(lamports, 9, 6),
      },
    ];
    for (const token of tokens) {
      if (token.amount > 0n) {
        out.push({
          key: token.mint,
          symbol: token.symbol || `${token.mint.slice(0, 4)}…`,
          name: `${token.name || 'Token'} · Solana`,
          amountText: formatAmount(token.amount, token.decimals, 6),
        });
      }
    }
    return out;
  }, [evmAddress, portfolio, solanaAccount.status, unlockPrompt.locked]);

  /** Opens the row's detail (SOL or the token); unlocks first if needed. */
  const onPress = useCallback(
    (row?: SolanaAssetRowData) => {
      if (unlockPrompt.locked) {
        unlockPrompt.unlock();
        return;
      }
      if (!evmAddress) {
        return;
      }
      const isToken = !!row && !row.key.startsWith('sol');
      navigationRef.current?.dispatch(
        row && (row.key === 'sol' || isToken)
          ? StackActions.push(RootNames.SolanaTokenDetail, {
              evmAddress,
              ...(isToken ? { mint: row.key, symbol: row.symbol } : {}),
            })
          : StackActions.push(RootNames.SolanaHome, { evmAddress }),
      );
    },
    [evmAddress, unlockPrompt],
  );

  return { rows, onPress };
};
