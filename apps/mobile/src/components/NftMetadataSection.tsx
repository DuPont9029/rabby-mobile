import React, { useEffect, useState } from 'react';
import { Platform, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { NFTItem } from '@rabby-wallet/rabby-api/dist/types';

import { Text } from '@/components/Typography';
import { useTheme2024 } from '@/hooks/theme';
import {
  loadOnchainNftDetails,
  type OnchainNftDetails,
} from '@/utils/onchainNftMedia';
import { toOnchainNftRef } from '@/utils/onchainNftMediaCore';
import { createGetStyles2024 } from '@/utils/styles';

type LoadState =
  | { status: 'loading' }
  | { status: 'done'; details: OnchainNftDetails | null };

/** Where the token URI points, for display only (never fetched). */
const describeStorage = (
  tokenUri: string | null,
  t: (key: string, options: { defaultValue: string }) => string,
) => {
  if (!tokenUri) {
    return t('page.nftDetail.metadata.unavailable', {
      defaultValue: 'Not readable on-chain',
    });
  }
  if (tokenUri.trim().slice(0, 5).toLowerCase() === 'data:') {
    return t('page.nftDetail.metadata.onchain', { defaultValue: 'On-chain' });
  }
  return tokenUri.length > 120 ? `${tokenUri.slice(0, 120)}…` : tokenUri;
};

/**
 * Token facts and metadata for the NFT detail screen. Metadata is read from
 * the contract (`tokenURI`/`uri`) through the app's RPC path; only inline
 * `data:` metadata is parsed, and remote metadata URLs are shown as text but
 * never fetched or opened.
 */
export const NftMetadataSection = ({ nft }: { nft: NFTItem }) => {
  const { t } = useTranslation();
  const { styles } = useTheme2024({ getStyle });
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [showRaw, setShowRaw] = useState(false);
  const ref = toOnchainNftRef(nft);
  const chain = ref?.chain;
  const contractId = ref?.contractId;
  const tokenId = ref?.tokenId;

  useEffect(() => {
    let active = true;
    if (!chain || !contractId || !tokenId) {
      setState({ status: 'done', details: null });
      return;
    }
    setState({ status: 'loading' });
    loadOnchainNftDetails({ chain, contractId, tokenId })
      .then(details => active && setState({ status: 'done', details }))
      .catch(() => active && setState({ status: 'done', details: null }));
    return () => {
      active = false;
    };
  }, [chain, contractId, tokenId]);

  const details = state.status === 'done' ? state.details : null;
  const metadata = details?.metadata;
  const description = metadata?.description || nft.description;
  const standard = nft.is_erc1155
    ? 'ERC-1155'
    : nft.is_erc721
    ? 'ERC-721'
    : '-';
  const storage =
    state.status === 'loading'
      ? t('page.nftDetail.metadata.loading', { defaultValue: 'Loading…' })
      : describeStorage(details?.tokenUri ?? null, t);

  const rows: Array<[string, string]> = [
    [
      t('page.nftDetail.metadata.contract', { defaultValue: 'Contract' }),
      nft.contract_id || '-',
    ],
    [
      t('page.nftDetail.metadata.tokenId', { defaultValue: 'Token ID' }),
      String(nft.inner_id ?? '-'),
    ],
    [
      t('page.nftDetail.metadata.standard', { defaultValue: 'Standard' }),
      standard,
    ],
    [
      t('page.nftDetail.metadata.storage', { defaultValue: 'Metadata' }),
      storage,
    ],
  ];
  if (metadata?.externalUrl) {
    rows.push([
      t('page.nftDetail.metadata.externalUrl', {
        defaultValue: 'External URL',
      }),
      metadata.externalUrl,
    ]);
  }

  return (
    <View style={styles.container} testID="nft-metadata-section">
      <Text style={styles.sectionTitle}>
        {t('page.nftDetail.metadata.title', { defaultValue: 'Metadata' })}
      </Text>
      {rows.map(([label, value]) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value} selectable numberOfLines={3}>
            {value}
          </Text>
        </View>
      ))}
      {description ? (
        <View style={styles.block}>
          <Text style={styles.label}>
            {t('page.nftDetail.metadata.description', {
              defaultValue: 'Description',
            })}
          </Text>
          <Text style={styles.description} selectable>
            {description}
          </Text>
        </View>
      ) : null}
      {metadata?.attributes?.length ? (
        <View style={styles.block}>
          <Text style={styles.label}>
            {t('page.nftDetail.metadata.attributes', {
              defaultValue: 'Attributes',
            })}
          </Text>
          <View style={styles.attributes}>
            {metadata.attributes.map((attribute, index) => (
              <View
                key={`${attribute.trait}:${index}`}
                style={styles.attribute}>
                {attribute.trait ? (
                  <Text style={styles.attributeTrait} numberOfLines={1}>
                    {attribute.trait}
                  </Text>
                ) : null}
                <Text style={styles.attributeValue} numberOfLines={2}>
                  {attribute.value}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {metadata?.raw ? (
        <View style={styles.block}>
          <TouchableOpacity
            onPress={() => setShowRaw(value => !value)}
            testID="nft-metadata-raw-toggle">
            <Text style={styles.toggle}>
              {showRaw
                ? t('page.nftDetail.metadata.hideRaw', {
                    defaultValue: 'Hide raw metadata',
                  })
                : t('page.nftDetail.metadata.showRaw', {
                    defaultValue: 'Show raw metadata',
                  })}
            </Text>
          </TouchableOpacity>
          {showRaw ? (
            <Text style={styles.raw} selectable>
              {metadata.raw}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};

const getStyle = createGetStyles2024(({ colors2024 }) => ({
  container: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
    width: '100%',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 10,
    gap: 16,
  },
  label: {
    fontSize: 15,
    fontWeight: '500',
    color: colors2024['neutral-secondary'],
  },
  value: {
    flex: 1,
    fontSize: 15,
    color: colors2024['neutral-title-1'],
    textAlign: 'right',
  },
  block: {
    paddingVertical: 10,
    gap: 8,
  },
  description: {
    fontSize: 15,
    lineHeight: 21,
    color: colors2024['neutral-title-1'],
  },
  attributes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  attribute: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: colors2024['neutral-bg-2'],
    maxWidth: '100%',
  },
  attributeTrait: {
    fontSize: 12,
    color: colors2024['neutral-secondary'],
  },
  attributeValue: {
    fontSize: 14,
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
  },
  toggle: {
    fontSize: 15,
    color: colors2024['brand-default'],
  },
  raw: {
    fontSize: 12,
    lineHeight: 17,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    color: colors2024['neutral-title-1'],
    backgroundColor: colors2024['neutral-bg-2'],
    borderRadius: 10,
    padding: 12,
  },
}));
