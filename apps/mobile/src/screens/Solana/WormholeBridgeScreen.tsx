import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
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
  BridgeTransfer,
  isFinal,
  useBridgeTransfers,
} from '@/core/bridge/wormhole/transfers';
import {
  buildWrapAndTransferEth,
  getEthBalance,
  normalizeBridgeAmount,
  readMessageFee,
} from '@/core/bridge/wormhole/evm';
import { estimateRedeemLamports } from '@/core/bridge/wormhole/redeem';
import { wrappedEthRecipient } from '@/core/bridge/wormhole/solana';
import { getSolanaRpc } from '@/core/solana/settings';
import { formatAmount, parseAmount } from '@/core/solana/transfer';
import { useMyAccounts } from '@/hooks/account';
import { useTheme2024 } from '@/hooks/theme';
import type { GetRootScreenRouteProp } from '@/navigation-type';
import { createGetStyles2024 } from '@/utils/styles';
import { useSolanaAccount } from './useSolana';

/** Kept for Ethereum gas when using "Max". */
const GAS_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

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
    case 'completed':
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
  const lowSol =
    solBalance !== null && redeemCost !== null && solBalance < redeemCost;

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
  }, [account, amountWei, sending, solanaAddress, t]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>
        {t('page.wormhole.title', { defaultValue: 'ETH → Solana' })}
      </Text>
      <Text style={styles.muted}>
        {t('page.wormhole.intro', {
          defaultValue:
            'Bridges ETH with the Wormhole Token Bridge (open source). You receive WETH (Wormhole) on your Solana address; swap it on Raydium.',
        })}
      </Text>

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
        <Text style={styles.muted}>
          {t('page.wormhole.receive', { defaultValue: 'You receive' })}:{' '}
          {amountWei ? formatAmount(amountWei, 18, 8) : '0'} WETH (Wormhole)
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {t('page.wormhole.to', { defaultValue: 'To' })}:{' '}
          {solanaAddress || '…'}
        </Text>
        <Text style={[styles.muted, lowSol && styles.warning]}>
          {t('page.wormhole.solCost', {
            defaultValue: 'Solana fees to receive',
          })}
          :{' '}
          {redeemCost !== null ? `~${formatAmount(redeemCost, 9, 5)} SOL` : '…'}{' '}
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
          title={t('page.wormhole.submit', {
            defaultValue: 'Bridge to Solana',
          })}
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
