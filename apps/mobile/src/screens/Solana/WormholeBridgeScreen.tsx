import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { randomBytes } from '@noble/hashes/utils';

import { Text } from '@/components/Typography';
import { Button } from '@/components2024/Button';
import { toast } from '@/components2024/Toast';
import { INTERNAL_REQUEST_SESSION } from '@/constant';
import { sendRequest } from '@/core/apis/provider';
import {
  advanceBridgeTransfer,
  addBridgeTransfer,
  ARIO_DECIMALS,
  BridgeTransfer,
  isFinal,
  stopBridgeSwap,
  SWAP_STEP_TOKENS,
  useBridgeTransfers,
} from '@/core/bridge/wormhole/transfers';
import {
  buildWrapAndTransferEth,
  getEthBalance,
  normalizeBridgeAmount,
  readMessageFee,
  WEI_PER_WRAPPED_UNIT,
} from '@/core/bridge/wormhole/evm';
import { estimateRedeemLamports } from '@/core/bridge/wormhole/redeem';
import { wrappedEthRecipient } from '@/core/bridge/wormhole/solana';
import { loadRoute, quoteRoute, WETH_TO_ARIO } from '@/core/solana/raydium';
import {
  DEFAULT_SWAP_SLIPPAGE_BPS,
  SWAP_HOP_MIN_LAMPORTS,
} from '@/core/solana/raydiumSwap';
import { getSolanaRpc } from '@/core/solana/settings';
import { formatAmount, parseAmount } from '@/core/solana/transfer';
import { useMyAccounts } from '@/hooks/account';
import { useTheme2024 } from '@/hooks/theme';
import type { GetRootScreenRouteProp } from '@/navigation-type';
import { createGetStyles2024 } from '@/utils/styles';
import { useSolanaAccount } from './useSolana';

/** Kept for Ethereum gas when using "Max". */
const GAS_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH
/** Above this price impact the quote is shown as a warning. */
const HIGH_IMPACT = 0.03;

type Receive = 'WETH' | 'ARIO';

type ArioQuote = {
  amountWei: bigint;
  out: bigint;
  /** Worst case with the per-hop slippage limit. */
  min: bigint;
  impact: number;
};

/** Live ETH → ARIO quote from the Raydium pools (debounced). */
const useArioQuote = (amountWei: bigint | null, enabled: boolean) => {
  const [quote, setQuote] = useState<ArioQuote | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    setError(false);
    if (!enabled || !amountWei) {
      setQuote(null);
      return;
    }
    let active = true;
    const timer = setTimeout(async () => {
      try {
        const states = await loadRoute(getSolanaRpc(), WETH_TO_ARIO);
        const weth = amountWei / WEI_PER_WRAPPED_UNIT;
        const out = quoteRoute(states, weth)[WETH_TO_ARIO.length - 1]!;
        // Spot price from a tiny trade, for the price impact.
        const probe = weth / 1000n > 0n ? weth / 1000n : 1n;
        const spot =
          Number(quoteRoute(states, probe)[WETH_TO_ARIO.length - 1]!) /
          Number(probe);
        const impact = spot > 0 ? 1 - Number(out) / Number(weth) / spot : 0;
        let min = out;
        for (let i = 0; i < WETH_TO_ARIO.length; i += 1) {
          min = (min * BigInt(10_000 - DEFAULT_SWAP_SLIPPAGE_BPS)) / 10_000n;
        }
        if (active) {
          setQuote({ amountWei, out, min, impact: Math.max(impact, 0) });
        }
      } catch {
        if (active) {
          setError(true);
        }
      }
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [amountWei, enabled]);
  return { quote: quote?.amountWei === amountWei ? quote : null, error };
};

const statusText = (
  transfer: BridgeTransfer,
  t: (key: string, options: { defaultValue: string }) => string,
) => {
  switch (transfer.status) {
    case 'pending_eth':
      return t('page.wormhole.status.pendingEth', {
        defaultValue: 'Waiting for the Ethereum transaction…',
      });
    case 'waiting_guardians':
      return t('page.wormhole.status.waitingGuardians', {
        defaultValue:
          'Waiting for Ethereum finality and the Wormhole guardians (~15–20 min)…',
      });
    case 'redeeming':
      return t('page.wormhole.status.redeeming', {
        defaultValue: 'Receiving on Solana…',
      });
    case 'needs_sol':
      return t('page.wormhole.status.needsSol', {
        defaultValue:
          'Add a little SOL to your Solana address to receive (it is retried automatically).',
      });
    case 'swapping':
      return `${t('page.wormhole.status.swapping', {
        defaultValue: 'Swapping to ARIO on Raydium',
      })} (${Math.min((transfer.swap?.hop ?? 0) + 1, 3)}/3)…`;
    case 'completed':
      if (transfer.swapReceived) {
        return `${t('page.wormhole.status.receivedAs', {
          defaultValue: 'Received',
        })} ${formatAmount(
          BigInt(transfer.swapReceived),
          ARIO_DECIMALS,
          4,
        )} ARIO`;
      }
      if (transfer.swapStoppedAs) {
        return `${t('page.wormhole.status.keptAs', {
          defaultValue: 'Swap stopped: kept as',
        })} ${transfer.swapStoppedAs}`;
      }
      return t('page.wormhole.status.completed', {
        defaultValue: 'Received on Solana',
      });
    case 'failed':
      return t('page.wormhole.status.failed', { defaultValue: 'Failed' });
  }
};

export const WormholeBridgeScreen = () => {
  const { t } = useTranslation();
  const { styles, colors2024 } = useTheme2024({ getStyle });
  const route = useRoute<GetRootScreenRouteProp<'WormholeBridge'>>();
  const evmAddress = route.params?.evmAddress;
  const [receive, setReceive] = useState<Receive>(
    route.params?.receive ?? 'WETH',
  );
  const toArio = receive === 'ARIO';
  const { accounts } = useMyAccounts();
  const account = useMemo(
    () =>
      accounts.find(
        item => item.address.toLowerCase() === evmAddress?.toLowerCase(),
      ) || null,
    [accounts, evmAddress],
  );
  const solanaAccount = useSolanaAccount(evmAddress);
  const solanaAddress =
    solanaAccount.status === 'ready' ? solanaAccount.value.address : undefined;
  const transfers = useBridgeTransfers(evmAddress);

  const [ethBalance, setEthBalance] = useState<bigint | null>(null);
  const [solBalance, setSolBalance] = useState<bigint | null>(null);
  const [redeemCost, setRedeemCost] = useState<bigint | null>(null);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!evmAddress) {
      return;
    }
    getEthBalance(evmAddress)
      .then(setEthBalance)
      .catch(() => setEthBalance(null));
  }, [evmAddress, transfers.length]);

  useEffect(() => {
    if (!solanaAddress) {
      return;
    }
    const rpc = getSolanaRpc();
    rpc
      .getBalance(solanaAddress)
      .then(setSolBalance)
      .catch(() => setSolBalance(null));
    estimateRedeemLamports(rpc, solanaAddress)
      .then(setRedeemCost)
      .catch(() => setRedeemCost(null));
  }, [solanaAddress]);

  const amountWei = useMemo(() => {
    try {
      const parsed = input.trim() ? parseAmount(input.trim(), 18) : null;
      return parsed ? normalizeBridgeAmount(parsed) : null;
    } catch {
      return null;
    }
  }, [input]);

  const problem = !account
    ? t('page.wormhole.noAccount', { defaultValue: 'Account not found.' })
    : !solanaAddress
    ? t('page.wormhole.noSolana', {
        defaultValue: 'Deriving your Solana address…',
      })
    : input.trim() && !amountWei
    ? t('page.wormhole.badAmount', { defaultValue: 'Enter a valid amount.' })
    : amountWei !== null && ethBalance !== null && amountWei > ethBalance
    ? t('page.wormhole.tooMuch', { defaultValue: 'Not enough ETH.' })
    : null;
  const { quote: arioQuote, error: quoteError } = useArioQuote(
    amountWei,
    toArio,
  );
  const solNeeded =
    redeemCost === null
      ? null
      : redeemCost + (toArio ? SWAP_HOP_MIN_LAMPORTS : 0n);
  const lowSol =
    solBalance !== null && solNeeded !== null && solBalance < solNeeded;

  const setMax = () => {
    if (ethBalance !== null && ethBalance > GAS_RESERVE_WEI) {
      setInput(
        formatAmount(
          normalizeBridgeAmount(ethBalance - GAS_RESERVE_WEI),
          18,
          8,
        ),
      );
    }
  };

  const bridge = useCallback(async () => {
    if (!account || !solanaAddress || !amountWei || sending) {
      return;
    }
    setSending(true);
    try {
      const recipientTokenAccount = wrappedEthRecipient(solanaAddress);
      const messageFeeWei = await readMessageFee();
      const nonce = new DataView(randomBytes(4).buffer).getUint32(0);
      const tx = buildWrapAndTransferEth({
        from: account.address,
        amountWei,
        messageFeeWei,
        recipientTokenAccount,
        nonce,
      });
      const hash = await sendRequest<string>({
        data: { method: 'eth_sendTransaction', params: [tx] },
        session: INTERNAL_REQUEST_SESSION,
        account,
      });
      const transfer: BridgeTransfer = {
        ethTxHash: hash,
        evmAddress: account.address,
        solanaOwner: solanaAddress,
        recipientTokenAccount,
        amountWei: amountWei.toString(),
        createdAt: Date.now(),
        status: 'pending_eth',
        ...(toArio
          ? { swapTo: 'ARIO', swapSlippageBps: DEFAULT_SWAP_SLIPPAGE_BPS }
          : {}),
      };
      addBridgeTransfer(transfer);
      setInput('');
      toast.success(
        t('page.wormhole.sent', {
          defaultValue: 'Sent. The rest happens automatically.',
        }),
      );
      advanceBridgeTransfer(transfer);
    } catch (error) {
      toast.info(
        error instanceof Error ? error.message : String(error ?? 'cancelled'),
      );
    } finally {
      setSending(false);
    }
  }, [account, amountWei, sending, solanaAddress, t, toArio]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>
        {toArio
          ? t('page.wormhole.titleArio', { defaultValue: 'ETH → ARIO' })
          : t('page.wormhole.title', { defaultValue: 'ETH → Solana' })}
      </Text>
      <Text style={styles.muted}>
        {toArio
          ? t('page.wormhole.introArio', {
              defaultValue:
                'One confirmation on Ethereum. The app bridges with Wormhole and swaps on Raydium (WETH → SOL → USDC → ARIO) by itself. Open source, no intermediaries.',
            })
          : t('page.wormhole.intro', {
              defaultValue:
                'Bridges ETH with the Wormhole Token Bridge (open source). You receive WETH (Wormhole) on your Solana address.',
            })}
      </Text>

      <View style={styles.segment}>
        {(['ARIO', 'WETH'] as const).map(option => (
          <Pressable
            key={option}
            style={[
              styles.segmentItem,
              receive === option && styles.segmentActive,
            ]}
            onPress={() => setReceive(option)}
            testID={`wormhole-receive-${option}`}>
            <Text
              style={[
                styles.segmentText,
                receive === option && styles.segmentTextActive,
              ]}>
              {option === 'ARIO'
                ? t('page.wormhole.receiveArio', {
                    defaultValue: 'Receive ARIO',
                  })
                : t('page.wormhole.receiveWeth', {
                    defaultValue: 'Receive WETH',
                  })}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.label}>
            {t('page.wormhole.amount', { defaultValue: 'Amount (ETH)' })}
          </Text>
          <Text style={styles.link} onPress={setMax}>
            {ethBalance !== null
              ? `${formatAmount(ethBalance, 18, 6)} ETH · Max`
              : '…'}
          </Text>
        </View>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="0.0"
          placeholderTextColor={colors2024['neutral-foot']}
          keyboardType="decimal-pad"
          editable={!sending}
          testID="wormhole-amount"
        />
        {toArio ? (
          <>
            <Text style={styles.quote}>
              {t('page.wormhole.receive', { defaultValue: 'You receive' })}: ≈{' '}
              {arioQuote
                ? formatAmount(arioQuote.out, ARIO_DECIMALS, 2)
                : amountWei
                ? '…'
                : '0'}{' '}
              ARIO
            </Text>
            {arioQuote ? (
              <Text
                style={[
                  styles.muted,
                  arioQuote.impact > HIGH_IMPACT && styles.warning,
                ]}>
                {t('page.wormhole.minimum', { defaultValue: 'Minimum' })}{' '}
                {formatAmount(arioQuote.min, ARIO_DECIMALS, 2)} ARIO ·{' '}
                {t('page.wormhole.impact', { defaultValue: 'price impact' })}{' '}
                {(arioQuote.impact * 100).toFixed(2)}%
              </Text>
            ) : null}
            {quoteError ? (
              <Text style={styles.warning}>
                {t('page.wormhole.quoteError', {
                  defaultValue: 'Could not read the Raydium pools. Retry.',
                })}
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.muted}>
            {t('page.wormhole.receive', { defaultValue: 'You receive' })}:{' '}
            {amountWei ? formatAmount(amountWei, 18, 8) : '0'} WETH (Wormhole)
          </Text>
        )}
        <Text style={styles.muted} numberOfLines={1}>
          {t('page.wormhole.to', { defaultValue: 'To' })}:{' '}
          {solanaAddress || '…'}
        </Text>
        <Text style={[styles.muted, lowSol && styles.warning]}>
          {t('page.wormhole.solCost', {
            defaultValue: 'Solana fees to receive',
          })}
          : {solNeeded !== null ? `~${formatAmount(solNeeded, 9, 5)} SOL` : '…'}{' '}
          ({t('page.wormhole.youHave', { defaultValue: 'you have' })}{' '}
          {solBalance !== null ? formatAmount(solBalance, 9, 5) : '…'})
        </Text>
        {lowSol ? (
          <Text style={styles.warning}>
            {t('page.wormhole.lowSol', {
              defaultValue:
                'Not enough SOL to receive yet. You can still bridge: it completes automatically once you add SOL.',
            })}
          </Text>
        ) : null}
        {problem ? <Text style={styles.warning}>{problem}</Text> : null}
        <Button
          title={
            toArio
              ? t('page.wormhole.submitArio', { defaultValue: 'Buy ARIO' })
              : t('page.wormhole.submit', { defaultValue: 'Bridge to Solana' })
          }
          onPress={bridge}
          loading={sending}
          disabled={!!problem || !amountWei || sending}
          height={48}
        />
        <Text style={styles.muted}>
          {t('page.wormhole.note', {
            defaultValue:
              'One confirmation: after it, the app waits for the guardians and receives on Solana by itself (~15–20 min). Ethereum gas is shown on the next screen.',
          })}
        </Text>
      </View>

      {transfers.length ? (
        <View style={styles.card}>
          <Text style={styles.label}>
            {t('page.wormhole.history', { defaultValue: 'Transfers' })}
          </Text>
          {[...transfers].reverse().map(transfer => (
            <View key={transfer.ethTxHash} style={styles.transfer}>
              <Text style={styles.transferAmount}>
                {formatAmount(BigInt(transfer.amountWei), 18, 8)} ETH
              </Text>
              <Text
                style={[
                  styles.muted,
                  transfer.status === 'failed' && styles.warning,
                ]}>
                {statusText(transfer, t)}
              </Text>
              {transfer.error && !isFinal(transfer.status) ? (
                <Text style={styles.small} numberOfLines={2}>
                  {transfer.error}
                </Text>
              ) : null}
              {transfer.status === 'failed' && transfer.error ? (
                <Text style={styles.small}>{transfer.error}</Text>
              ) : null}
              {transfer.swapTo &&
              !isFinal(transfer.status) &&
              !transfer.swap?.pending ? (
                <Text
                  style={styles.link}
                  onPress={() => stopBridgeSwap(transfer.ethTxHash)}>
                  {t('page.wormhole.stopSwap', {
                    defaultValue: 'Stop the swap and keep',
                  })}{' '}
                  {SWAP_STEP_TOKENS[transfer.swap?.hop ?? 0]}
                </Text>
              ) : null}
              <Text style={styles.small} selectable numberOfLines={1}>
                {transfer.ethTxHash}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
};

const getStyle = createGetStyles2024(({ colors2024 }) => ({
  screen: { flex: 1, backgroundColor: colors2024['neutral-bg-1'] },
  content: { padding: 16, gap: 16 },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  card: {
    padding: 16,
    gap: 10,
    borderRadius: 16,
    backgroundColor: colors2024['neutral-bg-2'],
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
  },
  link: { fontSize: 13, color: colors2024['brand-default'] },
  input: {
    height: 48,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
    color: colors2024['neutral-title-1'],
    fontSize: 18,
  },
  muted: { fontSize: 13, color: colors2024['neutral-foot'] },
  quote: {
    fontSize: 15,
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
  },
  segment: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 12,
    backgroundColor: colors2024['neutral-bg-2'],
  },
  segmentItem: {
    flex: 1,
    height: 36,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: { backgroundColor: colors2024['neutral-bg-1'] },
  segmentText: { fontSize: 14, color: colors2024['neutral-foot'] },
  segmentTextActive: {
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
  },
  small: { fontSize: 11, color: colors2024['neutral-foot'] },
  warning: { fontSize: 13, color: colors2024['red-default'] },
  transfer: {
    paddingVertical: 8,
    gap: 2,
    borderTopWidth: 1,
    borderTopColor: colors2024['neutral-line'],
  },
  transferAmount: {
    fontSize: 15,
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
  },
}));
