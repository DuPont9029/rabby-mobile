import React, { useCallback, useState } from 'react';
import { TextInput, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/Typography';
import { Button } from '@/components2024/Button';
import { ChainSelector } from '@/components2024/ChainSelector';
import { CHAINS_ENUM } from '@/constant/chains';
import { useTheme2024 } from '@/hooks/theme';
import { findChainByEnum } from '@/utils/chain';
import { importOnchainNft } from '@/utils/customOnchainNfts';
import { createGetStyles2024 } from '@/utils/styles';

type Status =
  | { kind: 'idle' }
  | { kind: 'error'; message: string }
  | { kind: 'success'; message: string };

/**
 * Lets the user add an NFT the indexer does not list, by chain, contract
 * and token id. Ownership is verified on-chain before anything is stored.
 */
export const ImportOnchainNftPanel = ({
  address,
  onImported,
}: {
  address?: string;
  onImported: () => void;
}) => {
  const { t } = useTranslation();
  const { styles, colors2024 } = useTheme2024({ getStyle });
  const [expanded, setExpanded] = useState(false);
  const [chainEnum, setChainEnum] = useState<CHAINS_ENUM>(CHAINS_ENUM.ETH);
  const [contractId, setContractId] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const handleImport = useCallback(async () => {
    const chain = findChainByEnum(chainEnum)?.serverId;
    if (!address || !chain) {
      return;
    }
    setLoading(true);
    setStatus({ kind: 'idle' });
    try {
      const result = await importOnchainNft(address, {
        chain,
        contractId,
        tokenId,
      });
      if (result.status === 'imported') {
        setStatus({
          kind: 'success',
          message: t('page.nftImport.success', {
            defaultValue: 'NFT imported. Ownership verified on-chain.',
          }),
        });
        setContractId('');
        setTokenId('');
        onImported();
        return;
      }
      const messages: Record<typeof result.status, string> = {
        invalid: t('page.nftImport.invalid', {
          defaultValue: 'Enter a valid contract address and numeric token ID.',
        }),
        not_owned: t('page.nftImport.notOwned', {
          defaultValue:
            'This address does not own that token on the selected chain.',
        }),
        duplicate: t('page.nftImport.duplicate', {
          defaultValue: 'This NFT is already imported.',
        }),
        limit: t('page.nftImport.limit', {
          defaultValue: 'Too many imported NFTs for this address.',
        }),
      };
      setStatus({ kind: 'error', message: messages[result.status] });
    } catch {
      setStatus({
        kind: 'error',
        message: t('page.nftImport.failed', {
          defaultValue: 'Could not reach the chain. Try again.',
        }),
      });
    } finally {
      setLoading(false);
    }
  }, [address, chainEnum, contractId, onImported, t, tokenId]);

  if (!address) {
    return null;
  }

  if (!expanded) {
    return (
      <TouchableOpacity
        style={styles.toggle}
        onPress={() => setExpanded(true)}
        testID="import-onchain-nft-toggle">
        <Text style={styles.toggleText}>
          {t('page.nftImport.toggle', {
            defaultValue: '+ Import on-chain NFT',
          })}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>
        {t('page.nftImport.title', { defaultValue: 'Import on-chain NFT' })}
      </Text>
      <ChainSelector value={chainEnum} onChange={setChainEnum} />
      <TextInput
        style={styles.input}
        value={contractId}
        onChangeText={setContractId}
        placeholder={t('page.nftImport.contractPlaceholder', {
          defaultValue: 'Contract address (0x...)',
        })}
        placeholderTextColor={colors2024['neutral-foot']}
        autoCapitalize="none"
        autoCorrect={false}
        testID="import-onchain-nft-contract"
      />
      <TextInput
        style={styles.input}
        value={tokenId}
        onChangeText={setTokenId}
        placeholder={t('page.nftImport.tokenIdPlaceholder', {
          defaultValue: 'Token ID',
        })}
        placeholderTextColor={colors2024['neutral-foot']}
        keyboardType="number-pad"
        testID="import-onchain-nft-token-id"
      />
      {status.kind !== 'idle' ? (
        <Text
          style={
            status.kind === 'error' ? styles.errorText : styles.successText
          }>
          {status.message}
        </Text>
      ) : null}
      <Button
        title={t('page.nftImport.submit', {
          defaultValue: 'Verify and import',
        })}
        onPress={handleImport}
        loading={loading}
        disabled={loading || !contractId.trim() || !tokenId.trim()}
        height={44}
      />
      <TouchableOpacity
        onPress={() => setExpanded(false)}
        style={styles.cancel}>
        <Text style={styles.toggleText}>
          {t('global.Cancel', { defaultValue: 'Cancel' })}
        </Text>
      </TouchableOpacity>
    </View>
  );
};

const getStyle = createGetStyles2024(({ colors2024 }) => ({
  toggle: {
    alignSelf: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  toggleText: {
    fontSize: 14,
    color: colors2024['brand-default'],
    textAlign: 'center',
  },
  panel: {
    marginHorizontal: 16,
    marginVertical: 12,
    padding: 16,
    gap: 12,
    borderRadius: 16,
    backgroundColor: colors2024['neutral-bg-1'],
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
    color: colors2024['neutral-title-1'],
  },
  input: {
    height: 44,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
    color: colors2024['neutral-title-1'],
    fontSize: 14,
  },
  errorText: {
    fontSize: 13,
    color: colors2024['red-default'],
  },
  successText: {
    fontSize: 13,
    color: colors2024['brand-default'],
  },
  cancel: {
    alignSelf: 'center',
    paddingVertical: 4,
  },
}));
