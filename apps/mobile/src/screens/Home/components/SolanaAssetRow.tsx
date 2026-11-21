import React from 'react';
import { TouchableOpacity, View, ViewStyle } from 'react-native';

import RcIconSolanaCC from '@/assets2024/icons/home/IconSolanaCC.svg';
import { Text } from '@/components/Typography';
import { ASSETS_ITEM_HEIGHT_NEW } from '@/constant/layout';
import { useTheme2024 } from '@/hooks/theme';
import { createGetStyles2024 } from '@/utils/styles';

export type SolanaAssetRowData = {
  key: string;
  symbol: string;
  name: string;
  amountText: string;
};

/** A SOL / SPL token row in the home token list (balance only, no price). */
export const SolanaAssetRow = ({
  data,
  style,
  onPress,
}: {
  data: SolanaAssetRowData;
  style?: ViewStyle;
  onPress: () => void;
}) => {
  const { styles, colors2024 } = useTheme2024({ getStyle });
  return (
    <TouchableOpacity
      style={[styles.row, style]}
      onPress={onPress}
      testID={`solana-asset-${data.key}`}>
      <View style={styles.logo}>
        <RcIconSolanaCC
          width={22}
          height={22}
          color={colors2024['neutral-title-1']}
        />
      </View>
      <View style={styles.names}>
        <Text style={styles.symbol} numberOfLines={1}>
          {data.symbol}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {data.name}
        </Text>
      </View>
      <Text style={styles.amount} numberOfLines={1}>
        {data.amountText}
      </Text>
    </TouchableOpacity>
  );
};

const getStyle = createGetStyles2024(({ colors2024, isLight }) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: ASSETS_ITEM_HEIGHT_NEW,
    paddingLeft: 12,
    paddingRight: 16,
    borderRadius: 16,
    backgroundColor: isLight
      ? colors2024['neutral-bg-1']
      : colors2024['neutral-bg-2'],
  },
  logo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: isLight
      ? colors2024['neutral-bg-2']
      : colors2024['neutral-bg-3'],
  },
  names: {
    flex: 1,
    gap: 2,
  },
  symbol: {
    fontSize: 16,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  sub: {
    fontSize: 13,
    color: colors2024['neutral-foot'],
  },
  amount: {
    fontSize: 16,
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
    maxWidth: '45%',
  },
}));
