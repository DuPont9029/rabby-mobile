import React, { useMemo, useRef, useState } from 'react';
import {
  Linking,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';

import { Text } from '@/components/Typography';
import { Button } from '@/components2024/Button';
import type { GetRootScreenRouteProp } from '@/navigation-type';
import { useTheme2024 } from '@/hooks/theme';
import { createGetStyles2024 } from '@/utils/styles';
import { withSolanaSigner } from '@/core/solana/account';
import { getSolanaRpc } from '@/core/solana/settings';
import {
  formatAmount,
  parseAmount,
  PreparedTransfer,
  prepareTransfer,
  TransferAsset,
  TransferError,
  TransferIssue,
  waitForConfirmation,
} from '@/core/solana/transfer';
import { signTransaction, PROGRAM_IDS } from '@/core/solana/tx';
import { SolanaRpcError } from '@/core/solana/rpc';
import { base58 } from '@scure/base';
import { useSolanaAccount } from './useSolana';

/** A review older than this is rebuilt before signing (blockhash expiry). */
const REVIEW_MAX_AGE_MS = 40_000;

type Phase =
  | { step: 'edit' }
  | { step: 'preparing' }
  | { step: 'review'; prepared: PreparedTransfer; preparedAt: number }
  | { step: 'sending' }
  | {
      step: 'sent';
      signature: string;
      status: 'pending' | 'confirmed' | 'failed' | 'expired' | 'unknown';
    };

export const SolanaSendScreen = () => {
  const { t } = useTranslation();
  const { styles, colors2024 } = useTheme2024({ getStyle });
  const { params } = useRoute<GetRootScreenRouteProp<'SolanaSend'>>();
  const { evmAddress, asset } = params;
  const accountState = useSolanaAccount(evmAddress);
  const account = accountState.status === 'ready' ? accountState.value : null;

  const [recipient, setRecipient] = useState('');
  const [amountText, setAmountText] = useState('');
  // SOL "Max": send the whole balance minus the exact network fee.
  const [sendAll, setSendAll] = useState(false);
  const [phase, setPhase] = useState<Phase>({ step: 'edit' });
  const [problem, setProblem] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const busy = useRef(false);

  const decimals =
    asset.kind === 'sol' ? 9 : asset.kind === 'token' ? asset.decimals : 0;
  const symbol =
    asset.kind === 'sol'
      ? 'SOL'
      : asset.kind === 'token'
      ? asset.symbol || asset.name || 'token'
      : asset.name;
  const balance = asset.kind === 'nft' ? 1n : BigInt(asset.balance);

  const transferAsset: TransferAsset = useMemo(() => {
    switch (asset.kind) {
      case 'sol':
        return { kind: 'sol' };
      case 'token':
        return {
          kind: 'token',
          mint: asset.mint,
          decimals: asset.decimals,
          tokenProgram: asset.tokenProgram,
          sourceAccount: asset.sourceAccount,
        };
      default:
        return {
          kind: 'nft',
          mint: asset.mint,
          tokenProgram: asset.tokenProgram || PROGRAM_IDS.token,
          programmable: asset.programmable,
          ruleSet: asset.ruleSet,
          sourceAccount: asset.sourceAccount,
        };
    }
  }, [asset]);

  const issueText = (issue: TransferIssue) => {
    const messages: Record<TransferIssue, string> = {
      invalid_address: t('page.solana.issue.invalidAddress', {
        defaultValue: 'This is not a valid Solana address.',
      }),
      same_address: t('page.solana.issue.sameAddress', {
        defaultValue: 'You cannot send to the same address.',
      }),
      program_address: t('page.solana.issue.programAddress', {
        defaultValue: 'This address is a program, not a wallet.',
      }),
      token_account_address: t('page.solana.issue.tokenAccount', {
        defaultValue:
          'This is a token account address. Enter the wallet address instead.',
      }),
      off_curve_recipient: t('page.solana.issue.offCurve', {
        defaultValue:
          'No wallet can own this address; tokens sent there would be lost.',
      }),
      program_owned_recipient: t('page.solana.issue.programOwned', {
        defaultValue:
          'This address belongs to a program, not a wallet; tokens sent there may be lost.',
      }),
      amount_zero: t('page.solana.issue.amountZero', {
        defaultValue: 'Enter an amount.',
      }),
      insufficient_balance: t('page.solana.issue.insufficient', {
        defaultValue: 'Not enough SOL for this amount plus the network fee.',
      }),
      insufficient_sol_for_fees: t('page.solana.issue.noFeeSol', {
        defaultValue: 'Not enough SOL to pay the network fee.',
      }),
      below_rent_minimum: t('page.solana.issue.belowRent', {
        defaultValue:
          'The recipient is a new account: send at least 0.00089088 SOL.',
      }),
      leaves_dust: t('page.solana.issue.leavesDust', {
        defaultValue:
          'This would leave less than the minimum balance. Send everything or leave at least 0.00089088 SOL.',
      }),
      simulation_failed: t('page.solana.issue.simulationFailed', {
        defaultValue:
          'The network rejected this transfer in simulation, so it was not sent.',
      }),
    };
    return messages[issue];
  };

  /** Builds and simulates the transfer; `true` when a review is shown. */
  const prepare = async (): Promise<boolean> => {
    // Any previous review is dropped first: nothing stale can be confirmed.
    setPhase({ step: 'edit' });
    if (!account) {
      return false;
    }
    setProblem(null);
    setLogs([]);
    let amount = 1n;
    const solSendAll = asset.kind === 'sol' && sendAll;
    if (asset.kind !== 'nft' && !solSendAll) {
      const parsed = parseAmount(amountText, decimals);
      if (parsed === null || parsed <= 0n) {
        setProblem(issueText('amount_zero'));
        return false;
      }
      if (parsed > balance) {
        setProblem(issueText('insufficient_balance'));
        return false;
      }
      amount = parsed;
    }
    setPhase({ step: 'preparing' });
    try {
      const prepared = await prepareTransfer({
        rpc: getSolanaRpc(),
        from: account.address,
        to: recipient,
        asset: transferAsset,
        amount,
        sendAll: solSendAll,
      });
      setPhase({ step: 'review', prepared, preparedAt: Date.now() });
      return true;
    } catch (error) {
      setPhase({ step: 'edit' });
      if (error instanceof TransferError) {
        setProblem(issueText(error.issue));
        setLogs(error.logs.slice(-6));
      } else {
        setProblem(
          t('page.solana.networkError', {
            defaultValue: 'Could not reach the Solana network. Try again.',
          }),
        );
      }
      return false;
    }
  };

  /** A JSON-RPC error (or 4xx) means the node refused it: nothing was sent. */
  const isDefiniteRejection = (error: unknown) =>
    error instanceof SolanaRpcError &&
    typeof error.code === 'number' &&
    (error.code < 0 || (error.code >= 400 && error.code < 500));

  const confirmAndSend = async () => {
    if (!account || phase.step !== 'review' || busy.current) {
      return;
    }
    if (Date.now() - phase.preparedAt > REVIEW_MAX_AGE_MS) {
      // The blockhash is about to expire: rebuild, and let the user review
      // the refreshed numbers before signing.
      if (await prepare()) {
        setProblem(
          t('page.solana.reviewRefreshed', {
            defaultValue:
              'The review was refreshed. Check it and confirm again.',
          }),
        );
      }
      return;
    }
    busy.current = true;
    const { prepared } = phase;
    setPhase({ step: 'sending' });
    let wire: Uint8Array;
    try {
      wire = await withSolanaSigner(account, privateKey =>
        signTransaction(prepared.message, prepared.from, privateKey),
      );
    } catch {
      busy.current = false;
      setPhase({ step: 'edit' });
      setProblem(
        t('page.solana.signFailed', {
          defaultValue: 'Could not sign with this wallet.',
        }),
      );
      return;
    }
    // The transaction id is the first signature: known before sending, so a
    // lost RPC response never leads to a second, different transaction.
    const signature = base58.encode(wire.slice(1, 65));
    const rpc = getSolanaRpc();
    try {
      const returned = await rpc.sendTransaction(wire);
      if (returned !== signature) {
        // A misbehaving RPC: keep watching the transaction we signed.
        console.warn('[solana] RPC returned a different signature');
      }
    } catch (error) {
      if (isDefiniteRejection(error)) {
        busy.current = false;
        setPhase({ step: 'edit' });
        setProblem(
          t('page.solana.sendFailed', {
            defaultValue: 'The transfer was not sent: {{reason}}',
            reason: error instanceof Error ? error.message : 'unknown error',
          }),
        );
        return;
      }
      // Network error/timeout: it may have been broadcast. Track it until
      // its blockhash expires instead of letting the user send it twice.
    }
    setPhase({ step: 'sent', signature, status: 'pending' });
    try {
      const status = await waitForConfirmation(
        rpc,
        signature,
        prepared.lastValidBlockHeight,
      );
      setPhase({ step: 'sent', signature, status });
    } finally {
      busy.current = false;
    }
  };

  const setMax = () => {
    if (asset.kind === 'sol') {
      // The exact fee is only known after measuring: prepareTransfer sends
      // the balance minus that fee, and the review shows the real amount.
      setSendAll(true);
      setAmountText(formatAmount(balance, 9));
    } else if (asset.kind === 'token') {
      setSendAll(false);
      setAmountText(formatAmount(balance, decimals));
    }
    setPhase({ step: 'edit' });
  };

  const pasteRecipient = async () => {
    const text = await Clipboard.getString();
    setRecipient(text.trim());
    setPhase({ step: 'edit' });
  };

  // Inputs are locked while a review is shown: editing means starting over.
  const editable = phase.step === 'edit';

  if (accountState.status === 'error') {
    return (
      <View style={styles.screen}>
        <Text style={styles.error}>
          {t('page.solana.accountUnavailable', {
            defaultValue: 'A Solana account cannot be derived for this wallet.',
          })}
        </Text>
      </View>
    );
  }

  if (phase.step === 'sent') {
    const explorer = `https://solscan.io/tx/${phase.signature}`;
    const statusText: Record<typeof phase.status, string> = {
      pending: t('page.solana.status.pending', {
        defaultValue: 'Sent, waiting for confirmation…',
      }),
      confirmed: t('page.solana.status.confirmed', {
        defaultValue: 'Confirmed',
      }),
      failed: t('page.solana.status.failed', {
        defaultValue: 'Failed on-chain',
      }),
      expired: t('page.solana.status.expired', {
        defaultValue:
          'Not confirmed in time (expired). Check the explorer before retrying.',
      }),
      unknown: t('page.solana.status.unknown', {
        defaultValue: 'Status unknown. Check the explorer before retrying.',
      }),
    };
    return (
      <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
        <Text style={styles.title}>{statusText[phase.status]}</Text>
        <Text style={styles.label}>
          {t('page.solana.signature', { defaultValue: 'Signature' })}
        </Text>
        <Text style={styles.mono} selectable>
          {phase.signature}
        </Text>
        <TouchableOpacity onPress={() => Linking.openURL(explorer)}>
          <Text style={styles.link}>
            {t('page.solana.viewExplorer', { defaultValue: 'View on Solscan' })}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>
        {t('page.solana.sendTitle', {
          defaultValue: 'Send {{symbol}}',
          symbol,
        })}
      </Text>
      {asset.kind !== 'nft' ? (
        <Text style={styles.label}>
          {t('page.solana.available', {
            defaultValue: 'Available: {{amount}} {{symbol}}',
            amount: formatAmount(balance, decimals),
            symbol,
          })}
        </Text>
      ) : null}

      <Text style={styles.label}>
        {t('page.solana.recipient', { defaultValue: 'Recipient address' })}
      </Text>
      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, styles.flex]}
          value={recipient}
          onChangeText={value => {
            setRecipient(value);
            setPhase({ step: 'edit' });
          }}
          editable={editable}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('page.solana.recipientPlaceholder', {
            defaultValue: 'Solana address',
          })}
          placeholderTextColor={colors2024['neutral-foot']}
          testID="solana-send-recipient"
        />
        <TouchableOpacity onPress={pasteRecipient} disabled={!editable}>
          <Text style={styles.link}>
            {t('page.solana.paste', { defaultValue: 'Paste' })}
          </Text>
        </TouchableOpacity>
      </View>

      {asset.kind !== 'nft' ? (
        <>
          <Text style={styles.label}>
            {t('page.solana.amount', { defaultValue: 'Amount' })}
          </Text>
          <View style={styles.inputRow}>
            <TextInput
              style={[styles.input, styles.flex]}
              value={amountText}
              onChangeText={value => {
                setAmountText(value);
                setSendAll(false);
                setPhase({ step: 'edit' });
              }}
              editable={editable}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={colors2024['neutral-foot']}
              testID="solana-send-amount"
            />
            <TouchableOpacity onPress={setMax} disabled={!editable}>
              <Text style={styles.link}>
                {t('page.solana.max', { defaultValue: 'Max' })}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}

      {problem ? <Text style={styles.error}>{problem}</Text> : null}
      {logs.length ? (
        <Text style={styles.logs} selectable>
          {logs.join('\n')}
        </Text>
      ) : null}

      {phase.step === 'review' ? (
        <View style={styles.review} testID="solana-send-review">
          <View style={styles.reviewHeader}>
            <Text style={styles.sectionTitle}>
              {t('page.solana.review', { defaultValue: 'Review' })}
            </Text>
            <TouchableOpacity
              onPress={() => setPhase({ step: 'edit' })}
              testID="solana-send-edit">
              <Text style={styles.link}>
                {t('page.solana.edit', { defaultValue: 'Edit' })}
              </Text>
            </TouchableOpacity>
          </View>
          {/* Every value below comes from the prepared (signed) transfer,
              never from the editable inputs. */}
          <ReviewRow
            label={t('page.solana.from', { defaultValue: 'From' })}
            value={phase.prepared.from}
          />
          <ReviewRow
            label={t('page.solana.to', { defaultValue: 'To' })}
            value={phase.prepared.to}
            strong
          />
          <ReviewRow
            label={t('page.solana.sending', { defaultValue: 'Sending' })}
            value={
              phase.prepared.asset.kind === 'nft'
                ? `1 × ${symbol}`
                : `${formatAmount(phase.prepared.amount, decimals)} ${symbol}`
            }
            strong
          />
          {phase.prepared.asset.kind !== 'sol' ? (
            <ReviewRow
              label={t('page.solana.mint', { defaultValue: 'Mint' })}
              value={phase.prepared.asset.mint}
            />
          ) : null}
          <ReviewRow
            label={t('page.solana.networkFee', { defaultValue: 'Network fee' })}
            value={`${formatAmount(phase.prepared.feeLamports, 9)} SOL`}
          />
          {phase.prepared.rentLamports > 0n ? (
            <ReviewRow
              label={t('page.solana.accountCreation', {
                defaultValue: "Recipient's token account (rent)",
              })}
              value={`${formatAmount(phase.prepared.rentLamports, 9)} SOL`}
            />
          ) : null}
          {phase.prepared.senderLamportsAfter !== null ? (
            <ReviewRow
              label={t('page.solana.solAfter', {
                defaultValue: 'Your SOL after (simulated)',
              })}
              value={`${formatAmount(
                phase.prepared.senderLamportsAfter,
                9,
              )} SOL`}
            />
          ) : null}
          {phase.prepared.warnings.includes('recipient_new_account') ? (
            <Text style={styles.warning}>
              {t('page.solana.warnNewAccount', {
                defaultValue:
                  'This address has never been used on Solana. Double-check it.',
              })}
            </Text>
          ) : null}
          {phase.prepared.transferFeeBasisPoints ? (
            <Text style={styles.warning}>
              {t('page.solana.warnTransferFee', {
                defaultValue:
                  'This token charges a {{percent}}% transfer fee: the recipient receives less than the amount sent.',
                percent: (
                  phase.prepared.transferFeeBasisPoints / 100
                ).toString(),
              })}
            </Text>
          ) : null}
          {phase.prepared.warnings.includes('recipient_program_owned') ? (
            <Text style={styles.warning}>
              {t('page.solana.warnProgramOwned', {
                defaultValue:
                  'This address is owned by a program, not a regular wallet. Only continue if you know it is correct.',
              })}
            </Text>
          ) : null}
          {phase.prepared.warnings.includes('recipient_off_curve') ? (
            <Text style={styles.warning}>
              {t('page.solana.warnOffCurve', {
                defaultValue:
                  'This address is not a regular wallet (no private key). Only continue if you know it is correct.',
              })}
            </Text>
          ) : null}
          <Text style={styles.label}>
            {t('page.solana.simulated', {
              defaultValue: 'Simulated successfully on the network.',
            })}
          </Text>
        </View>
      ) : null}

      {phase.step === 'review' ? (
        <Button
          height={48}
          title={t('page.solana.confirmSend', {
            defaultValue: 'Confirm and send',
          })}
          onPress={confirmAndSend}
        />
      ) : (
        <Button
          height={48}
          title={t('page.solana.reviewButton', { defaultValue: 'Review' })}
          loading={phase.step === 'preparing' || phase.step === 'sending'}
          disabled={
            !account ||
            !recipient.trim() ||
            phase.step === 'preparing' ||
            phase.step === 'sending'
          }
          onPress={prepare}
        />
      )}
    </ScrollView>
  );
};

const ReviewRow = ({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) => {
  const { styles } = useTheme2024({ getStyle });
  return (
    <View style={styles.reviewRow}>
      <Text style={styles.label}>{label}</Text>
      <Text style={strong ? styles.valueStrong : styles.value} selectable>
        {value}
      </Text>
    </View>
  );
};

const getStyle = createGetStyles2024(({ colors2024 }) => ({
  screen: {
    flex: 1,
    backgroundColor: colors2024['neutral-bg-1'],
  },
  content: {
    padding: 16,
    paddingBottom: 48,
    gap: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  label: {
    fontSize: 13,
    color: colors2024['neutral-secondary'],
  },
  value: {
    fontSize: 14,
    color: colors2024['neutral-title-1'],
  },
  valueStrong: {
    fontSize: 15,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
  input: {
    height: 46,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
    color: colors2024['neutral-title-1'],
    fontSize: 15,
  },
  link: {
    fontSize: 15,
    color: colors2024['brand-default'],
  },
  error: {
    fontSize: 14,
    color: colors2024['red-default'],
  },
  warning: {
    fontSize: 13,
    color: colors2024['red-default'],
  },
  logs: {
    fontSize: 11,
    color: colors2024['neutral-secondary'],
  },
  mono: {
    fontSize: 13,
    color: colors2024['neutral-title-1'],
  },
  review: {
    padding: 14,
    borderRadius: 14,
    gap: 10,
    backgroundColor: colors2024['neutral-bg-2'],
  },
  reviewHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reviewRow: {
    gap: 2,
  },
}));
