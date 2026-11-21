import React from 'react';
import { TouchableOpacity, View, ViewStyle } from 'react-native';
import { colord } from 'colord';

import { Text } from '@/components/Typography';
import { ASSETS_ITEM_HEIGHT_NEW } from '@/constant/layout';
import { useTheme2024 } from '@/hooks/theme';
import { createGetStyles2024 } from '@/utils/styles';
import { SolanaTokenAvatar } from '@/screens/Solana/SolanaTokenAvatar';

export type SolanaAssetRowData = {
  /** 'sol', a token mint, or a state key ('sol-locked' / 'sol-loading'). */
  key: string;
  symbol: string;
  /** Second line (wallet address, or a hint). */
  subtitle: string;
  /** Top right: USD value when priced, else the amount. */
  topRight: string;
  /** Bottom right: price or amount. */
  bottomRight?: string;
  mint?: string;
  metadataUri?: string;
};

/** A SOL / SPL token row styled like the EVM token rows. */
export const SolanaAssetRow = ({
  data,
  style,
  onPress,
}: {
  data: SolanaAssetRowData;
  style?: ViewStyle;
  onPress: () => void;
}) => {
  const { styles } = useTheme2024({ getStyle });
  return (
    <TouchableOpacity
      style={[styles.row, style]}
      onPress={onPress}
      testID={`solana-asset-${data.key}`}>
      <SolanaTokenAvatar
        mint={data.mint}
        metadataUri={data.metadataUri}
        symbol={data.symbol}
        size={46}
        badgeSize={18}
      />
      <View style={styles.left}>
        <Text style={styles.symbol} numberOfLines={1}>
          {data.symbol}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {data.subtitle}
        </Text>
      </View>
      <View style={styles.right}>
        <Text style={styles.top} numberOfLines={1}>
          {data.topRight}
        </Text>
        {data.bottomRight ? (
          <Text style={styles.sub} numberOfLines={1}>
            {data.bottomRight}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
};

const getStyle = createGetStyles2024(({ colors2024, isLight }) => ({
  row: {
    height: ASSETS_ITEM_HEIGHT_NEW,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 12,
    paddingRight: 16,
    borderRadius: 14,
    backgroundColor: isLight
      ? colord(colors2024['neutral-bg-1']).alpha(0.9).toRgbString()
      : colors2024['neutral-bg-2'],
  },
  left: { flex: 1, gap: 4 },
  right: { alignItems: 'flex-end', gap: 4, maxWidth: '50%' },
  symbol: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  top: {
    fontSize: 16,
    lineHeight: 20,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  sub: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
    color: colors2024['neutral-secondary'],
  },
}));
