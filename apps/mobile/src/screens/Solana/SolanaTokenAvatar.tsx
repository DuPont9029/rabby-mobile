import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import FastImage from 'react-native-fast-image';

import RcSolanaLogo from '@/assets2024/icons/solana/solana-logo.svg';
import { Text } from '@/components/Typography';
import { loadSolanaTokenLogo } from '@/core/solana/tokenLogo';
import { useTheme2024 } from '@/hooks/theme';
import { createGetStyles2024 } from '@/utils/styles';

/**
 * Token logo with the Solana chain badge, sized like the EVM AssetAvatar
 * (logo `size`, badge `badgeSize` at the bottom right).
 */
export const SolanaTokenAvatar = ({
  mint,
  metadataUri,
  symbol,
  size = 46,
  badgeSize = 18,
}: {
  /** Undefined: SOL. */
  mint?: string;
  metadataUri?: string;
  symbol?: string;
  size?: number;
  badgeSize?: number;
}) => {
  const { styles, colors2024, isLight } = useTheme2024({ getStyle });
  const [logo, setLogo] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLogo(null);
    if (mint) {
      loadSolanaTokenLogo(mint, metadataUri).then(
        uri => active && setLogo(uri),
      );
    }
    return () => {
      active = false;
    };
  }, [mint, metadataUri]);

  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View style={round}>
      {!mint ? (
        <RcSolanaLogo width={size} height={size} />
      ) : logo ? (
        <FastImage source={{ uri: logo }} style={round} />
      ) : (
        <View style={[round, styles.placeholder]}>
          <Text style={[styles.letter, { fontSize: size * 0.4 }]}>
            {(symbol || '?').slice(0, 1).toUpperCase()}
          </Text>
        </View>
      )}
      <View
        style={[
          styles.badge,
          {
            width: badgeSize + 3,
            height: badgeSize + 3,
            borderRadius: (badgeSize + 3) / 2,
            borderColor: isLight
              ? colors2024['neutral-bg-1']
              : colors2024['neutral-bg-2'],
          },
        ]}>
        <RcSolanaLogo width={badgeSize} height={badgeSize} />
      </View>
    </View>
  );
};

const getStyle = createGetStyles2024(({ colors2024 }) => ({
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors2024['neutral-bg-5'],
  },
  letter: { fontWeight: '700', color: colors2024['neutral-title-1'] },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
