import React from 'react';
import { TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/Typography';
import { useTheme2024 } from '@/hooks/theme';
import {
  NFT_REFRESH_CHOICES,
  setNftRefreshSeconds,
  useNftRefreshSeconds,
} from '@/utils/nftRefresh';
import { createGetStyles2024 } from '@/utils/styles';

/** How often on-chain NFTs (artwork, metadata) are re-read. */
export const NftRefreshSetting = () => {
  const { t } = useTranslation();
  const { styles } = useTheme2024({ getStyle });
  const seconds = useNftRefreshSeconds();
  return (
    <View style={styles.row} testID="nft-refresh-setting">
      <Text style={styles.label}>
        {t('page.nftPrefs.refreshLabel', {
          defaultValue: 'Refresh on-chain NFTs every',
        })}
      </Text>
      <View style={styles.choices}>
        {NFT_REFRESH_CHOICES.map(choice => {
          const selected = choice === seconds;
          return (
            <TouchableOpacity
              key={choice}
              onPress={() => setNftRefreshSeconds(choice)}
              style={[styles.chip, selected && styles.chipSelected]}
              accessibilityState={{ selected }}>
              <Text style={[styles.chipText, selected && styles.chipTextOn]}>
                {`${choice}s`}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
};

const getStyle = createGetStyles2024(({ colors2024 }) => ({
  row: {
    marginHorizontal: 16,
    marginTop: 8,
    gap: 8,
    alignItems: 'center',
  },
  label: {
    fontSize: 13,
    color: colors2024['neutral-foot'],
  },
  choices: {
    flexDirection: 'row',
    gap: 8,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
  },
  chipSelected: {
    borderColor: colors2024['brand-default'],
    backgroundColor: colors2024['brand-light-1'],
  },
  chipText: {
    fontSize: 13,
    color: colors2024['neutral-body'],
  },
  chipTextOn: {
    color: colors2024['brand-default'],
    fontWeight: '600',
  },
}));
