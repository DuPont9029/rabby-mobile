import { useCallback, useEffect, useMemo, useState } from 'react';
import { StackActions } from '@react-navigation/native';

import { RootNames } from '@/constant/layout';
import { getCachedUsdPrice } from '@/core/solana/prices';
import { getSolanaRpc } from '@/core/solana/settings';
import { formatAmount } from '@/core/solana/transfer';
import { navigationRef } from '@/utils/navigation';
import { ellipsisAddress } from '@/utils/address';
import { formatPrice } from '@/utils/number';
import type { SolanaAssetRowData } from '@/screens/Home/components/SolanaAssetRow';

import {
  useSolanaAccount,
  useSolanaPortfolio,
  useSolanaUnlockPrompt,
} from './useSolana';

const usd = (value: number) =>
  `$${value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 0.01 && value > 0 ? 4 : 2,
  })}`;

/**
 * Rows for the Solana account of a seed-phrase address, for the home token
 * lists: SOL and SPL tokens with logo, address, USD value and price; a
 * "tap to unlock" row when the keys are locked and the address was never
 * derived; a loading row meanwhile. Never prompts by itself.
 */
export const useSolanaTokenRows = (evmAddress?: string) => {
  const solanaAccount = useSolanaAccount(evmAddress);
  const owner =
    evmAddress && solanaAccount.status === 'ready'
      ? solanaAccount.value.address
      : undefined;
  const { state: portfolio } = useSolanaPortfolio(owner);
  const unlockPrompt = useSolanaUnlockPrompt(solanaAccount, { auto: false });

  // USD prices: SOL (Chainlink via Helios) and tokens with a known pool.
  const [prices, setPrices] = useState<Record<string, number>>({});
  const tokens = portfolio.status === 'ready' ? portfolio.value.tokens : null;
  useEffect(() => {
    if (!tokens) {
      return;
    }
    let active = true;
    const rpc = getSolanaRpc();
    const wanted: Array<[string, string | null, number]> = [
      ['sol', null, 9],
      ...tokens
        .filter(t => t.amount > 0n)
        .map(t => [t.mint, t.mint, t.decimals] as [string, string, number]),
    ];
    Promise.all(
      wanted.map(([key, mint, decimals]) =>
        getCachedUsdPrice(rpc, mint, decimals).then(
          price => [key, price] as const,
        ),
      ),
    ).then(entries => {
      if (active) {
        const next: Record<string, number> = {};
        for (const [key, price] of entries) {
          if (price !== null) {
            next[key] = price;
          }
        }
        setPrices(next);
      }
    });
    return () => {
      active = false;
    };
  }, [tokens]);

  const rows = useMemo<SolanaAssetRowData[]>(() => {
    if (!evmAddress) {
      return [];
    }
    if (unlockPrompt.locked) {
      return [
        {
          key: 'sol-locked',
          symbol: 'SOL',
          subtitle: 'Solana · tap to unlock',
          topRight: '🔒',
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
              subtitle: owner ? ellipsisAddress(owner) : 'Solana',
              topRight: '…',
            },
          ];
    }
    const subtitle = owner ? ellipsisAddress(owner) : 'Solana';
    const row = (
      key: string,
      symbol: string,
      raw: bigint,
      decimals: number,
      extra: Partial<SolanaAssetRowData>,
    ): SolanaAssetRowData => {
      const amount = formatAmount(raw, decimals, 6);
      const price = prices[key];
      return {
        key,
        symbol,
        subtitle,
        topRight: price !== undefined ? usd(price * Number(amount)) : amount,
        bottomRight:
          price !== undefined
            ? `${amount} · $${formatPrice(price)}`
            : undefined,
        ...extra,
      };
    };
    const { lamports } = portfolio.value;
    const out: SolanaAssetRowData[] = [row('sol', 'SOL', lamports, 9, {})];
    for (const token of portfolio.value.tokens) {
      if (token.amount > 0n) {
        out.push(
          row(
            token.mint,
            token.symbol || `${token.mint.slice(0, 4)}…`,
            token.amount,
            token.decimals,
            { mint: token.mint, metadataUri: token.uri },
          ),
        );
      }
    }
    return out;
  }, [
    evmAddress,
    owner,
    portfolio,
    prices,
    solanaAccount.status,
    unlockPrompt.locked,
  ]);

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
      // Always the token detail (SOL while still loading), never the old
      // account screen.
      const isToken = !!row?.mint;
      navigationRef.current?.dispatch(
        StackActions.push(RootNames.SolanaTokenDetail, {
          evmAddress,
          ...(isToken ? { mint: row!.mint, symbol: row!.symbol } : {}),
        }),
      );
    },
    [evmAddress, unlockPrompt],
  );

  return { rows, onPress };
};
