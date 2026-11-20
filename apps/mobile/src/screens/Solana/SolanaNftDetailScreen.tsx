import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/Typography';
import { ZoomableModal } from '@/components/ZoomableModal';
import { Button } from '@/components2024/Button';
import { RootNames } from '@/constant/layout';
import type { GetRootScreenRouteProp } from '@/navigation-type';
import { useTheme2024 } from '@/hooks/theme';
import { naviPush } from '@/utils/navigation';
import { createGetStyles2024 } from '@/utils/styles';
import { TokenStandard } from '@/core/solana/metadata';
import {
  loadOffchainMetadata,
  OffchainNftMetadata,
} from '@/core/solana/portfolio';
import { SolanaNftImage } from './SolanaNftImage';

const standardLabel = (standard: TokenStandard | null) => {
  switch (standard) {
    case TokenStandard.ProgrammableNonFungible:
      return 'Programmable NFT (pNFT)';
    case TokenStandard.ProgrammableNonFungibleEdition:
      return 'Programmable NFT edition';
    case TokenStandard.NonFungibleEdition:
      return 'NFT edition';
    default:
      return 'NFT';
  }
};

export const SolanaNftDetailScreen = () => {
  const { t } = useTranslation();
  const { styles } = useTheme2024({ getStyle });
  const { params } = useRoute<GetRootScreenRouteProp<'SolanaNftDetail'>>();
  const { evmAddress, nft } = params;
  const { width } = useWindowDimensions();
  const [metadata, setMetadata] = useState<OffchainNftMetadata | null>(null);
  const [viewer, setViewer] = useState(false);
  const imageSize = width - 32;

  useEffect(() => {
    let active = true;
    loadOffchainMetadata(nft.uri).then(value => active && setMetadata(value));
    return () => {
      active = false;
    };
  }, [nft.uri]);

  const rows: Array<[string, string]> = [
    [
      t('page.solana.standard', { defaultValue: 'Standard' }),
      standardLabel(nft.tokenStandard),
    ],
    [t('page.solana.mint', { defaultValue: 'Mint' }), nft.mint],
    ...(nft.collection
      ? ([
          [
            t('page.solana.collection', { defaultValue: 'Collection' }),
            nft.collection,
          ],
        ] as Array<[string, string]>)
      : []),
    [
      t('page.solana.metadataUri', { defaultValue: 'Metadata URI' }),
      nft.uri || '-',
    ],
  ];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <TouchableOpacity onPress={() => setViewer(true)} activeOpacity={0.9}>
        <SolanaNftImage
          metadataUri={nft.uri}
          variant="detail"
          resizeMode="contain"
          style={[styles.image, { width: imageSize, height: imageSize }]}
          imageStyle={{ width: imageSize, height: imageSize }}
          placeholder={
            <View
              style={[
                styles.placeholder,
                { width: imageSize, height: imageSize },
              ]}
            />
          }
        />
      </TouchableOpacity>

      <Text style={styles.title}>{metadata?.name || nft.name}</Text>
      {nft.symbol ? <Text style={styles.muted}>{nft.symbol}</Text> : null}

      {rows.map(([label, value]) => (
        <View key={label} style={styles.row}>
          <Text style={styles.label}>{label}</Text>
          <Text style={styles.value} selectable numberOfLines={3}>
            {value}
          </Text>
        </View>
      ))}

      {metadata?.description ? (
        <View style={styles.block}>
          <Text style={styles.label}>
            {t('page.solana.description', { defaultValue: 'Description' })}
          </Text>
          <Text style={styles.description} selectable>
            {metadata.description}
          </Text>
        </View>
      ) : null}

      {metadata?.attributes.length ? (
        <View style={styles.block}>
          <Text style={styles.label}>
            {t('page.solana.attributes', { defaultValue: 'Attributes' })}
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

      <Button
        height={48}
        disabled={nft.frozen}
        title={
          nft.frozen
            ? t('page.solana.frozen', {
                defaultValue: 'Frozen (cannot be sent)',
              })
            : t('page.solana.send', { defaultValue: 'Send' })
        }
        onPress={() =>
          naviPush(RootNames.SolanaSend, {
            evmAddress,
            asset: {
              kind: 'nft',
              mint: nft.mint,
              tokenProgram: nft.tokenProgram,
              programmable: nft.programmable,
              ruleSet: nft.ruleSet,
              name: metadata?.name || nft.name,
              sourceAccount: nft.account,
            },
          })
        }
      />

      <ZoomableModal visible={viewer} onClose={() => setViewer(false)}>
        {frame => (
          <SolanaNftImage
            metadataUri={nft.uri}
            variant="detail"
            resizeMode="contain"
            style={StyleSheet.flatten([frame])}
            imageStyle={frame}
          />
        )}
      </ZoomableModal>
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
  image: {
    borderRadius: 16,
    overflow: 'hidden',
  },
  placeholder: {
    borderRadius: 16,
    backgroundColor: colors2024['neutral-bg-2'],
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  muted: {
    fontSize: 13,
    color: colors2024['neutral-secondary'],
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 6,
  },
  label: {
    fontSize: 14,
    color: colors2024['neutral-secondary'],
  },
  value: {
    flex: 1,
    fontSize: 14,
    textAlign: 'right',
    color: colors2024['neutral-title-1'],
  },
  block: {
    gap: 8,
    paddingVertical: 6,
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
}));
