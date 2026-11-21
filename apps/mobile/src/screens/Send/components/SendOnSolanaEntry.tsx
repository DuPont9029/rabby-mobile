import React from 'react';
import { TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { KEYRING_TYPE } from '@rabby-wallet/keyring-utils';
import { StackActions } from '@react-navigation/native';

import { Text } from '@/components/Typography';
import { RootNames } from '@/constant/layout';
import { useTheme2024 } from '@/hooks/theme';
import { navigationRef } from '@/utils/navigation';
import { createGetStyles2024 } from '@/utils/styles';

/**
 * Seed-phrase accounts also have a Solana account (same seed): offer sending
 * SOL / SPL tokens from it. Opens the Solana screen of this account.
 */
export const SendOnSolanaEntry = ({
  account,
}: {
  account?: { address: string; type: string } | null;
}) => {
  const { t } = useTranslation();
  const { styles } = useTheme2024({ getStyle });
  if (!account || account.type !== KEYRING_TYPE.HdKeyring) {
    return null;
  }
  return (
    <TouchableOpacity
      style={styles.row}
      testID="send-on-solana"
      onPress={() =>
        navigationRef.current?.dispatch(
          StackActions.push(RootNames.SolanaHome, {
            evmAddress: account.address,
          }),
        )
      }>
      <Text style={styles.text}>
        {t('page.solana.sendOnSolana', {
          defaultValue: 'Send SOL or Solana tokens →',
        })}
      </Text>
    </TouchableOpacity>
  );
};

const getStyle = createGetStyles2024(({ colors2024 }) => ({
  row: {
    alignSelf: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  text: {
    fontSize: 14,
    color: colors2024['brand-default'],
  },
}));
