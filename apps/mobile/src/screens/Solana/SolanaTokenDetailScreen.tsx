/**
 * SOL / SPL token detail, laid out like the EVM token detail screen
 * (header, address chip, balance + price box, wallet card, token history,
 * bottom Send / Receive / more bar). Data comes from the Solana RPC; prices
 * from Chainlink via Helios (SOL) or the token's Raydium pool.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { StackActions, useRoute } from '@react-navigation/native';
import { useMyAccounts } from '@/hooks/account';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import type { BottomSheetModal } from '@gorhom/bottom-sheet';

import RcSolanaLogo from '@/assets2024/icons/solana/solana-logo.svg';
import { SolanaTokenAvatar } from './SolanaTokenAvatar';
import RcIconSendCC from '@/assets2024/singleHome/send.svg';
import RcIconMoreCC from '@/assets/icons/home/more-cc.svg';
import { ArrowCircleCC } from '@/assets2024/icons/address';
import { Text } from '@/components/Typography';
import { toast } from '@/components2024/Toast';
import NormalScreenContainer2024 from '@/components2024/ScreenContainer/NormalScreenContainer';
import { CaretArrowIconCC } from '@/components/Icons/CaretArrowIconCC';
import {
  BOTTOM_BUTTON_DOUBLE_HEIGHT,
  BOTTOM_BUTTON_TOP_OFFSET,
  getBottomButtonBottomOffset,
  RootNames,
} from '@/constant/layout';
import { associatedTokenAddress } from '@/core/solana/tx';
import { formatAmount } from '@/core/solana/transfer';
import { loadSolanaHistory, SolanaHistoryItem } from '@/core/solana/history';
import { getCachedUsdPrice } from '@/core/solana/prices';
import { getSolanaRpc } from '@/core/solana/settings';
import { HeaderBackButton } from '@/hooks/navigation';
import { useTheme2024 } from '@/hooks/theme';
import type { GetRootScreenRouteProp } from '@/navigation-type';
import { ellipsisAddress } from '@/utils/address';
import { naviPush, navigationRef } from '@/utils/navigation';
import { formatPrice } from '@/utils/number';
import { createGetStyles2024 } from '@/utils/styles';
import { formatTimestamp } from '@/utils/time';
import { TokenMoreSheet } from '@/screens/TokenDetail/components/TokenMoreSheet';
import BalanceOverview from '@/screens/TokenDetail/components/BalanceOverview';

import {
  useSolanaAccount,
  useSolanaPortfolio,
  useSolanaUnlockPrompt,
} from './useSolana';

const SOL_DECIMALS = 9;

const usd = (value: number) =>
  `$${value.toLocaleString('en-US', {
    maximumFractionDigits: value < 1 ? 4 : 2,
  })}`;

type Row =
  | { type: 'date'; key: string; label: string }
  | { type: 'tx'; key: string; item: SolanaHistoryItem };

export const SolanaTokenDetailScreen = () => {
  const { t } = useTranslation();
  const { styles, colors2024 } = useTheme2024({ getStyle });
  const route = useRoute<GetRootScreenRouteProp<'SolanaTokenDetail'>>();
  const { evmAddress, mint } = route.params;
  const isSol = !mint;

  const account = useSolanaAccount(evmAddress);
  useSolanaUnlockPrompt(account, { auto: true });
  const owner = account.status === 'ready' ? account.value.address : undefined;
  const { state: portfolio, refresh } = useSolanaPortfolio(owner);
  const token =
    portfolio.status === 'ready' && mint
      ? portfolio.value.tokens.find(item => item.mint === mint)
      : undefined;

  const decimals = isSol ? SOL_DECIMALS : token?.decimals ?? 0;
  const symbol = isSol
    ? 'SOL'
    : token?.symbol || route.params.symbol || `${mint!.slice(0, 4)}…`;
  const rawBalance: bigint | null =
    portfolio.status !== 'ready'
      ? null
      : isSol
      ? portfolio.value.lamports
      : token?.amount ?? 0n;
  const amount =
    rawBalance === null ? 0 : Number(formatAmount(rawBalance, decimals, 9));

  const [price, setPrice] = useState<number | null>(null);
  const tokenMint = token?.mint;
  const tokenDecimals = token?.decimals;
  useEffect(() => {
    if (!isSol && !tokenMint) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const delays = [3_000, 8_000, 20_000];
    const attempt = (n: number) => {
      getCachedUsdPrice(
        getSolanaRpc(),
        isSol ? null : tokenMint!,
        isSol ? 9 : tokenDecimals,
      ).then(value => {
        if (!active) {
          return;
        }
        if (value !== null) {
          setPrice(value);
        } else if (delays[n] !== undefined) {
          timer = setTimeout(() => attempt(n + 1), delays[n]);
        }
      });
    };
    attempt(0);
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isSol, tokenMint, tokenDecimals]);

  const [history, setHistory] = useState<SolanaHistoryItem[] | null>(null);
  useEffect(() => {
    if (!owner || (!isSol && !token)) {
      return;
    }
    let active = true;
    const lookup = isSol
      ? owner
      : token!.account || associatedTokenAddress(owner, token!.mint);
    loadSolanaHistory(
      getSolanaRpc(),
      owner,
      isSol ? { kind: 'sol' } : { kind: 'token', mint: token!.mint },
      lookup,
    )
      .then(items => active && setHistory(items))
      .catch(() => active && setHistory([]));
    return () => {
      active = false;
    };
  }, [isSol, owner, token]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let lastDay = '';
    for (const item of history || []) {
      const day = item.blockTime
        ? new Date(item.blockTime * 1000).toDateString()
        : 'pending';
      if (day !== lastDay) {
        lastDay = day;
        out.push({
          type: 'date',
          key: `d-${day}-${item.signature}`,
          label: item.blockTime
            ? formatTimestamp(item.blockTime * 1000, t)
            : t('page.solana.pending', { defaultValue: 'Pending' }),
        });
      }
      out.push({ type: 'tx', key: item.signature, item });
    }
    return out;
  }, [history, t]);

  const moreRef = useRef<BottomSheetModal>(null);
  const { accounts } = useMyAccounts();

  const sendAsset = () => {
    if (!owner || rawBalance === null) {
      return;
    }
    naviPush(RootNames.SolanaSend, {
      evmAddress,
      asset: isSol
        ? { kind: 'sol', balance: rawBalance.toString() }
        : {
            kind: 'token',
            mint: token!.mint,
            decimals: token!.decimals,
            tokenProgram: token!.tokenProgram,
            symbol: token!.symbol,
            name: token!.name,
            balance: rawBalance.toString(),
            sourceAccount: token!.account,
          },
    });
  };

  const header = (
    <View>
      <View style={styles.chip}>
        <RcSolanaLogo width={18} height={18} />
        <Text style={styles.chipText}>
          {owner ? ellipsisAddress(owner) : '…'}
        </Text>
        <CaretArrowIconCC
          dir="down"
          width={18}
          height={18}
          bgColor={colors2024['neutral-bg-5']}
          lineColor={colors2024['neutral-title-1']}
        />
      </View>
      <View style={styles.balanceRow}>
        <BalanceOverview
          amount={amount}
          usdValue={
            price !== null ? formatPrice(price * amount, 8, true) : '--'
          }
          status={rawBalance === null ? 'loading' : 'ready'}
        />
        <View style={styles.priceBox}>
          <Text style={styles.priceTitle}>
            {t('page.tokenDetail.price', { defaultValue: 'Price' })}:
            <Text style={styles.priceValue}>
              {price !== null ? formatPrice(price) : ' --'}
            </Text>
          </Text>
          <Text style={styles.priceSource}>
            {isSol ? 'Chainlink · Helios' : price !== null ? 'Raydium' : '—'}
          </Text>
        </View>
      </View>

      <View style={styles.walletBlock}>
        <Text style={styles.sectionTitle}>
          {t('page.tokenDetail.wallet', { defaultValue: 'Wallet' })}
        </Text>
        <Pressable
          style={styles.walletCard}
          onPress={() => naviPush(RootNames.SolanaHome, { evmAddress })}>
          <View style={styles.walletIcon}>
            <RcSolanaLogo width={30} height={30} />
          </View>
          <View style={styles.walletText}>
            <Text style={styles.walletName}>
              {owner ? ellipsisAddress(owner) : '…'}
            </Text>
            <Text style={styles.walletBalance}>
              {price !== null ? usd(price * amount) : `${amount} ${symbol}`}
            </Text>
          </View>
          <ArrowCircleCC
            style={styles.walletArrow}
            color={colors2024['neutral-body']}
            backgroundColor={colors2024['neutral-bg-5']}
          />
        </Pressable>
      </View>
      <Text style={styles.sectionTitle}>
        {t('page.tokenDetail.Transaction', { defaultValue: 'Token History' })}
      </Text>
      {history === null ? (
        <Text style={styles.muted}>
          {t('page.solana.loading', { defaultValue: 'Loading…' })}
        </Text>
      ) : !history.length ? (
        <Text style={styles.muted}>
          {t('page.solana.noHistory', { defaultValue: 'No transfers yet' })}
        </Text>
      ) : null}
    </View>
  );

  const renderRow = ({ item: row }: { item: Row }) => {
    if (row.type === 'date') {
      return <Text style={styles.date}>{row.label}</Text>;
    }
    const { item } = row;
    const received = item.delta > 0n;
    const value = Number(
      formatAmount(received ? item.delta : -item.delta, decimals, 9),
    );
    return (
      <View style={[styles.txCard, item.failed && styles.txFailed]}>
        <View style={styles.txIcon}>
          <SolanaTokenAvatar
            mint={mint}
            metadataUri={token?.uri}
            symbol={symbol}
            size={46}
            badgeSize={16}
          />
        </View>
        <View style={styles.txText}>
          <Text style={styles.txTitle}>
            {item.failed
              ? t('page.solana.failed', { defaultValue: 'Failed' })
              : received
              ? t('page.transactions.itemTitle.Recieve', {
                  defaultValue: 'Received',
                })
              : t('page.transactions.itemTitle.Send', { defaultValue: 'Sent' })}
          </Text>
          <Text style={styles.txDesc} numberOfLines={1}>
            {item.counterparty
              ? `${received ? 'From' : 'To'} ${item.counterparty.slice(
                  0,
                  8,
                )}...`
              : item.signature.slice(0, 8)}
          </Text>
        </View>
        <View style={styles.txChange}>
          <Text style={[styles.txAmount, !received && styles.txNegative]}>
            {`${received ? '+' : '-'}${formatAmount(
              received ? item.delta : -item.delta,
              decimals,
              6,
            )} ${symbol}`}
          </Text>
          {price !== null ? (
            <Text style={styles.txUsd}>{usd(price * value)}</Text>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <NormalScreenContainer2024 type="bg1" noHeader style={styles.root}>
      <View style={styles.headerRow}>
        <HeaderBackButton tintColor={colors2024['neutral-title-1']} />
        <View style={styles.headerToken}>
          <View style={styles.headerLogo}>
            <SolanaTokenAvatar
              mint={mint}
              metadataUri={token?.uri}
              symbol={symbol}
              size={33}
              badgeSize={14}
            />
          </View>
          <Text style={styles.headerSymbol}>{symbol}</Text>
        </View>
        <Pressable hitSlop={10} onPress={() => moreRef.current?.present()}>
          <RcIconMoreCC
            width={22}
            height={22}
            color={colors2024['neutral-body']}
          />
        </Pressable>
      </View>
      <FlatList
        data={rows}
        keyExtractor={row => row.key}
        renderItem={renderRow}
        ListHeaderComponent={header}
        contentContainerStyle={styles.list}
        onRefresh={() => {
          setHistory(null);
          refresh();
        }}
        refreshing={false}
      />
      <View style={styles.footer}>
        <View style={styles.footerRow}>
          <Pressable
            style={[styles.action, rawBalance === null && styles.disabled]}
            onPress={sendAsset}>
            <RcIconSendCC
              width={22}
              height={22}
              color={colors2024['neutral-InvertHighlight']}
            />
            <Text style={styles.actionText}>
              {t('page.home.services.send', { defaultValue: 'Send' })}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.action, styles.blueAction]}
            onPress={() => {
              const evmAccount = accounts.find(
                item => item.address.toLowerCase() === evmAddress.toLowerCase(),
              );
              if (evmAccount) {
                navigationRef.current?.dispatch(
                  StackActions.push(RootNames.StackTransaction, {
                    screen: RootNames.Receive,
                    params: { account: evmAccount, network: 'solana' },
                  }),
                );
              }
            }}>
            <Text style={styles.actionText}>
              {t('page.home.services.receive', { defaultValue: 'Receive' })}
            </Text>
          </Pressable>
          <Pressable
            style={styles.moreAction}
            onPress={() => moreRef.current?.present()}>
            <RcIconMoreCC
              width={22}
              height={22}
              color={colors2024['neutral-body']}
            />
          </Pressable>
        </View>
      </View>
      <TokenMoreSheet
        modalRef={moreRef}
        items={[
          {
            key: 'copy',
            title: t('page.solana.copy', { defaultValue: 'Copy address' }),
            disabled: !owner,
            onPress: () => {
              if (owner) {
                Clipboard.setString(owner);
                toast.success(
                  t('global.copiedSuccessfully', { defaultValue: 'Copied' }),
                );
              }
            },
          },
          ...(isSol
            ? [
                {
                  key: 'bridge',
                  title: t('page.solana.bridgeFromEth', {
                    defaultValue: 'Bridge ETH from Ethereum',
                  }),
                  onPress: () =>
                    naviPush(RootNames.WormholeBridge, { evmAddress }),
                },
              ]
            : []),
          {
            key: 'account',
            title: t('page.solana.openAccount', {
              defaultValue: 'Solana account',
            }),
            onPress: () => naviPush(RootNames.SolanaHome, { evmAddress }),
          },
        ]}
      />
    </NormalScreenContainer2024>
  );
};

const getStyle = createGetStyles2024(
  ({ colors2024, isLight, safeAreaInsets }) => ({
    root: {
      backgroundColor: isLight
        ? colors2024['neutral-bg-0']
        : colors2024['neutral-bg-1'],
    },
    headerRow: {
      height: 48,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 14,
      gap: 8,
    },
    headerToken: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    headerLogo: { width: 33, height: 33 },
    headerSymbol: {
      fontSize: 20,
      fontWeight: '900',
      color: colors2024['neutral-title-1'],
      fontFamily: 'SF Pro Rounded',
    },
    list: {
      paddingHorizontal: 16,
      paddingBottom:
        BOTTOM_BUTTON_TOP_OFFSET +
        BOTTOM_BUTTON_DOUBLE_HEIGHT +
        getBottomButtonBottomOffset(safeAreaInsets.bottom) +
        24,
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 8,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 6,
      backgroundColor: colors2024['neutral-bg-5'],
      borderWidth: 1,
      borderColor: colors2024['neutral-line'],
      marginBottom: 12,
    },
    chipText: {
      fontSize: 16,
      lineHeight: 20,
      fontWeight: '500',
      color: colors2024['neutral-body'],
    },
    balanceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingLeft: 5,
      paddingRight: 9,
    },
    priceBox: {
      gap: 4,
      borderWidth: 1,
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: 16,
      borderBottomRightRadius: 2,
      borderColor: colors2024['neutral-bg-5'],
      backgroundColor: colors2024['neutral-bg-1'],
    },
    priceTitle: {
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '500',
      color: colors2024['neutral-title-1'],
    },
    priceValue: { fontWeight: '900' },
    priceSource: {
      fontSize: 12,
      lineHeight: 16,
      fontWeight: '500',
      color: colors2024['neutral-secondary'],
    },
    walletBlock: { gap: 8, marginTop: 24, marginBottom: 18 },
    sectionTitle: {
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '900',
      color: colors2024['neutral-title-1'],
      marginBottom: 8,
    },
    walletCard: {
      height: 70,
      borderRadius: 16,
      padding: 12,
      paddingRight: 54,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: isLight
        ? colors2024['neutral-bg-1']
        : colors2024['neutral-bg-2'],
    },
    walletIcon: {
      width: 46,
      height: 46,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors2024['neutral-bg-5'],
    },
    walletText: { gap: 4 },
    walletName: {
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '500',
      color: colors2024['neutral-secondary'],
    },
    walletBalance: {
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '700',
      color: colors2024['neutral-body'],
    },
    walletArrow: { position: 'absolute', right: 12, top: 22 },
    muted: { fontSize: 14, color: colors2024['neutral-secondary'] },
    date: {
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '500',
      color: colors2024['neutral-secondary'],
      paddingLeft: 4,
      marginTop: 4,
      marginBottom: 8,
    },
    txCard: {
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingRight: 16,
      paddingVertical: 14,
      marginBottom: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: isLight
        ? colors2024['neutral-bg-1']
        : colors2024['neutral-bg-2'],
    },
    txFailed: { opacity: 0.5 },
    txIcon: { width: 46, height: 46 },
    txText: { flex: 1 },
    txTitle: {
      fontSize: 17,
      lineHeight: 20,
      fontWeight: '500',
      color: colors2024['neutral-body'],
      marginBottom: 3,
    },
    txDesc: {
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '500',
      color: colors2024['neutral-secondary'],
    },
    txChange: { maxWidth: '50%', gap: 3 },
    txAmount: {
      fontSize: 16,
      lineHeight: 20,
      fontWeight: '700',
      color: colors2024['green-default'],
      textAlign: 'right',
    },
    txNegative: { color: colors2024['red-default'] },
    txUsd: {
      fontSize: 14,
      lineHeight: 18,
      fontWeight: '500',
      color: colors2024['neutral-secondary'],
      textAlign: 'right',
    },
    footer: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      height:
        BOTTOM_BUTTON_TOP_OFFSET +
        BOTTOM_BUTTON_DOUBLE_HEIGHT +
        getBottomButtonBottomOffset(safeAreaInsets.bottom),
      backgroundColor: colors2024['neutral-bg-1'],
    },
    footerRow: {
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    action: {
      height: 48,
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      borderRadius: 10,
      backgroundColor: colors2024['green-default'],
    },
    blueAction: { backgroundColor: colors2024['brand-default'] },
    disabled: { opacity: 0.6 },
    actionText: {
      fontSize: 18,
      lineHeight: 22,
      fontWeight: '700',
      color: colors2024['neutral-InvertHighlight'],
    },
    moreAction: {
      width: 48,
      height: 48,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors2024['neutral-line'],
      alignItems: 'center',
      justifyContent: 'center',
    },
  }),
);
