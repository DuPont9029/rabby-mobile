import React, { useEffect, useMemo, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import Clipboard from '@react-native-clipboard/clipboard';
import QRCode from 'react-native-qrcode-svg';

import { Text } from '@/components/Typography';
import { Button } from '@/components2024/Button';
import { toast } from '@/components2024/Toast';
import { RootNames } from '@/constant/layout';
import type { GetRootScreenRouteProp } from '@/navigation-type';
import { useTheme2024 } from '@/hooks/theme';
import { naviPush } from '@/utils/navigation';
import { createGetStyles2024 } from '@/utils/styles';
import { formatAmount } from '@/core/solana/transfer';
import { DEFAULT_SOLANA_RPC } from '@/core/solana/rpc';
import {
  getCustomSolanaRpcUrl,
  setCustomSolanaRpcUrl,
} from '@/core/solana/settings';
import { SolanaNftImage } from './SolanaNftImage';
import {
  useSolanaAccount,
  useSolanaHdAccounts,
  useSolanaUnlockPrompt,
  useSolanaPortfolio,
} from './useSolana';

const shortAddress = (address: string) =>
  `${address.slice(0, 6)}…${address.slice(-6)}`;

export const SolanaHomeScreen = () => {
  const { t } = useTranslation();
  const { styles, colors2024 } = useTheme2024({ getStyle });
  const route = useRoute<GetRootScreenRouteProp<'SolanaHome'>>();
  const hdAccounts = useSolanaHdAccounts();
  const [evmAddress, setEvmAddress] = useState<string | undefined>(
    route.params?.evmAddress,
  );
  const [showQr, setShowQr] = useState(false);
  const { width } = useWindowDimensions();
  const nftSize = (width - 16 * 2 - 12) / 2;

  useEffect(() => {
    if (!evmAddress && hdAccounts.length) {
      setEvmAddress(hdAccounts[0]!.address);
    }
  }, [evmAddress, hdAccounts]);

  const accountState = useSolanaAccount(evmAddress);
  // The Solana key comes from the seed: unlock the wallet if needed.
  const unlockPrompt = useSolanaUnlockPrompt(accountState, { auto: true });
  const solanaAddress =
    accountState.status === 'ready' ? accountState.value.address : undefined;
  const { state: portfolio, refresh } = useSolanaPortfolio(solanaAddress);

  const [rpcInput, setRpcInput] = useState(getCustomSolanaRpcUrl() || '');
  const [showRpc, setShowRpc] = useState(false);

  const portfolioValue =
    portfolio.status === 'ready' ? portfolio.value : undefined;
  const solBalance = portfolioValue
    ? formatAmount(portfolioValue.lamports, 9, 6)
    : '…';

  const tokens = useMemo(() => portfolioValue?.tokens || [], [portfolioValue]);
  const nfts = useMemo(() => portfolioValue?.nfts || [], [portfolioValue]);

  if (!hdAccounts.length) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>
          {t('page.solana.noHdAccount', {
            defaultValue:
              'Solana is available for wallets created or imported with a seed phrase.',
          })}
        </Text>
      </View>
    );
  }

  const copyAddress = () => {
    if (solanaAddress) {
      Clipboard.setString(solanaAddress);
      toast.success(
        t('page.solana.copied', { defaultValue: 'Address copied' }),
      );
    }
  };

  const saveRpc = (value: string | null) => {
    try {
      setCustomSolanaRpcUrl(value);
      setRpcInput(value || '');
      toast.success(t('page.solana.rpcSaved', { defaultValue: 'RPC saved' }));
      refresh();
    } catch {
      toast.error(
        t('page.solana.rpcInvalid', {
          defaultValue: 'Enter a valid https:// RPC URL',
        }),
      );
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl refreshing={false} onRefresh={refresh} />
      }>
      {hdAccounts.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.accounts}>
          {hdAccounts.map(account => {
            const selected =
              account.address.toLowerCase() === evmAddress?.toLowerCase();
            return (
              <TouchableOpacity
                key={account.address}
                onPress={() => {
                  setShowQr(false);
                  setEvmAddress(account.address);
                }}
                style={[styles.chip, selected && styles.chipSelected]}>
                <Text
                  style={[styles.chipText, selected && styles.chipTextSelected]}
                  numberOfLines={1}>
                  {account.aliasName || shortAddress(account.address)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.label}>
          {t('page.solana.address', { defaultValue: 'Solana address' })}
        </Text>
        {accountState.status === 'error' ? (
          <Text style={styles.error} selectable>
            {`${
              accountState.reason === 'seed_mismatch'
                ? t('page.solana.seedMismatch', {
                    defaultValue:
                      'This wallet uses a passphrase that is not loaded. Unlock it with its passphrase first.',
                  })
                : accountState.reason === 'locked'
                ? t('page.solana.locked', {
                    defaultValue:
                      'The wallet is locked: unlock it and open Solana again.',
                  })
                : accountState.reason === 'not_hd_account'
                ? t('page.solana.notHdAccount', {
                    defaultValue:
                      'This address was not created from a seed phrase in this app (e.g. an imported private key or a hardware wallet), so there is no Solana key to derive.',
                  })
                : t('page.solana.accountUnavailable', {
                    defaultValue:
                      'A Solana account cannot be derived for this wallet.',
                  })
            } (${accountState.reason})`}
          </Text>
        ) : accountState.status === 'loading' && accountState.reason ? (
          <Text style={styles.muted}>
            {accountState.reason === 'locked'
              ? t('page.solana.waitingUnlock', {
                  defaultValue:
                    'The wallet is locked: unlock it to use your Solana account.',
                })
              : t('page.solana.waitingKeys', {
                  defaultValue: 'Loading the wallet keys… (retrying)',
                })}
            {` (${accountState.reason})`}
          </Text>
        ) : null}
        {unlockPrompt.locked ? (
          <Button
            height={40}
            type="ghost"
            title={t('page.solana.unlock', { defaultValue: 'Unlock wallet' })}
            loading={unlockPrompt.unlocking}
            onPress={unlockPrompt.unlock}
          />
        ) : accountState.status === 'error' ? null : (
          <Text style={styles.address} selectable>
            {solanaAddress || '…'}
          </Text>
        )}
        <Text style={styles.balance}>{`${solBalance} SOL`}</Text>
        <View style={styles.row}>
          <Button
            containerStyle={styles.flex}
            height={44}
            title={t('page.solana.send', { defaultValue: 'Send' })}
            disabled={!portfolioValue || !evmAddress}
            onPress={() =>
              evmAddress &&
              portfolioValue &&
              naviPush(RootNames.SolanaSend, {
                evmAddress,
                asset: {
                  kind: 'sol',
                  balance: portfolioValue.lamports.toString(),
                },
              })
            }
          />
          <Button
            containerStyle={styles.flex}
            height={44}
            type="ghost"
            title={t('page.solana.receive', { defaultValue: 'Receive' })}
            disabled={!solanaAddress}
            onPress={() => setShowQr(value => !value)}
          />
        </View>
        <Button
          height={44}
          type="ghost"
          title={t('page.solana.bridgeFromEth', {
            defaultValue: 'Bridge ETH from Ethereum →',
          })}
          disabled={!evmAddress}
          onPress={() =>
            evmAddress && naviPush(RootNames.WormholeBridge, { evmAddress })
          }
        />
        {showQr && solanaAddress ? (
          <View style={styles.qr}>
            <View style={styles.qrBox}>
              <QRCode value={solanaAddress} size={180} />
            </View>
            <TouchableOpacity onPress={copyAddress}>
              <Text style={styles.link}>
                {t('page.solana.copy', { defaultValue: 'Copy address' })}
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>

      {portfolio.status === 'error' ? (
        <TouchableOpacity onPress={refresh} style={styles.card}>
          <Text style={styles.error}>
            {t('page.solana.loadFailed', {
              defaultValue: 'Could not load Solana data. Tap to retry.',
            })}
          </Text>
        </TouchableOpacity>
      ) : null}

      <Text style={styles.section}>
        {t('page.solana.tokens', { defaultValue: 'Tokens' })}
      </Text>
      {portfolio.status === 'loading' ? (
        <Text style={styles.muted}>
          {t('page.solana.loading', { defaultValue: 'Loading…' })}
        </Text>
      ) : tokens.length ? (
        tokens.map(token => (
          <TouchableOpacity
            key={token.account}
            style={styles.tokenRow}
            disabled={!evmAddress}
            onPress={() =>
              evmAddress &&
              naviPush(RootNames.SolanaTokenDetail, {
                evmAddress,
                mint: token.mint,
                symbol: token.symbol,
              })
            }>
            <View style={styles.flex}>
              <Text style={styles.tokenName} numberOfLines={1}>
                {token.symbol || token.name || shortAddress(token.mint)}
              </Text>
              <Text style={styles.muted} numberOfLines={1}>
                {/* Names are self-declared on-chain: always show the mint. */}
                {`${token.name ? `${token.name} · ` : ''}${shortAddress(
                  token.mint,
                )}`}
              </Text>
            </View>
            <Text style={styles.tokenAmount}>
              {formatAmount(token.amount, token.decimals, 6)}
            </Text>
          </TouchableOpacity>
        ))
      ) : (
        <Text style={styles.muted}>
          {t('page.solana.noTokens', { defaultValue: 'No tokens' })}
        </Text>
      )}

      <Text style={styles.section}>
        {t('page.solana.nfts', { defaultValue: 'NFTs' })}
      </Text>
      {nfts.length ? (
        <View style={styles.grid}>
          {nfts.map(nft => (
            <TouchableOpacity
              key={nft.account}
              style={{ width: nftSize }}
              onPress={() =>
                evmAddress &&
                naviPush(RootNames.SolanaNftDetail, { evmAddress, nft })
              }>
              <SolanaNftImage
                metadataUri={nft.uri}
                style={[styles.nftImage, { width: nftSize, height: nftSize }]}
                imageStyle={{ width: nftSize, height: nftSize }}
                placeholder={
                  <View
                    style={[
                      styles.nftPlaceholder,
                      { width: nftSize, height: nftSize },
                    ]}
                  />
                }
              />
              <Text style={styles.nftName} numberOfLines={1}>
                {nft.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : portfolio.status === 'ready' ? (
        <Text style={styles.muted}>
          {t('page.solana.noNfts', { defaultValue: 'No NFTs' })}
        </Text>
      ) : null}

      <TouchableOpacity onPress={() => setShowRpc(value => !value)}>
        <Text style={styles.section}>
          {t('page.solana.rpc', { defaultValue: 'RPC' })}
        </Text>
      </TouchableOpacity>
      <Text style={styles.muted} numberOfLines={1}>
        {getCustomSolanaRpcUrl() || DEFAULT_SOLANA_RPC}
      </Text>
      {showRpc ? (
        <View style={styles.rpcBox}>
          <TextInput
            style={styles.input}
            value={rpcInput}
            onChangeText={setRpcInput}
            placeholder="https://…"
            placeholderTextColor={colors2024['neutral-foot']}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.row}>
            <Button
              containerStyle={styles.flex}
              height={40}
              title={t('page.solana.save', { defaultValue: 'Save' })}
              onPress={() => saveRpc(rpcInput)}
            />
            <Button
              containerStyle={styles.flex}
              height={40}
              type="ghost"
              title={t('page.solana.useDefault', {
                defaultValue: 'Use public RPC',
              })}
              onPress={() => saveRpc(null)}
            />
          </View>
        </View>
      ) : null}
    </ScrollView>
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
  center: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: colors2024['neutral-bg-1'],
  },
  accounts: {
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: colors2024['neutral-bg-2'],
    maxWidth: 180,
  },
  chipSelected: {
    backgroundColor: colors2024['brand-default'],
  },
  chipText: {
    fontSize: 14,
    color: colors2024['neutral-title-1'],
  },
  chipTextSelected: {
    color: '#FFFFFF',
  },
  card: {
    padding: 16,
    borderRadius: 16,
    gap: 10,
    backgroundColor: colors2024['neutral-bg-2'],
  },
  label: {
    fontSize: 13,
    color: colors2024['neutral-secondary'],
  },
  address: {
    fontSize: 14,
    color: colors2024['neutral-title-1'],
  },
  balance: {
    fontSize: 28,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  flex: {
    flex: 1,
  },
  qr: {
    alignItems: 'center',
    gap: 10,
    paddingTop: 6,
  },
  qrBox: {
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
  },
  link: {
    fontSize: 15,
    color: colors2024['brand-default'],
  },
  section: {
    marginTop: 8,
    fontSize: 18,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  muted: {
    fontSize: 13,
    color: colors2024['neutral-secondary'],
  },
  error: {
    fontSize: 14,
    color: colors2024['red-default'],
  },
  tokenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors2024['neutral-bg-2'],
  },
  tokenName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
  },
  tokenAmount: {
    fontSize: 16,
    color: colors2024['neutral-title-1'],
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  nftImage: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  nftPlaceholder: {
    borderRadius: 12,
    backgroundColor: colors2024['neutral-bg-2'],
  },
  nftName: {
    marginTop: 6,
    fontSize: 14,
    color: colors2024['neutral-title-1'],
  },
  rpcBox: {
    gap: 10,
  },
  input: {
    height: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
    color: colors2024['neutral-title-1'],
  },
}));
