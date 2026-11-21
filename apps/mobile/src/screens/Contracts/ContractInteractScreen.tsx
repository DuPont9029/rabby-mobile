/**
 * Remix-like contract interaction for EVM chains: load a verified ABI from
 * Sourcify (or paste one), run read functions (verified through Helios on
 * Ethereum) and send write functions through the normal approval screen.
 */
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { ethers } from 'ethers';
import { KEYRING_TYPE } from '@rabby-wallet/keyring-utils';

import { Text } from '@/components/Typography';
import { Button } from '@/components2024/Button';
import { ChainSelector } from '@/components2024/ChainSelector';
import { toast } from '@/components2024/Toast';
import { INTERNAL_REQUEST_SESSION } from '@/constant';
import { CHAINS_ENUM } from '@/constant/chains';
import { sendRequest } from '@/core/apis/provider';
import {
  buildWriteTx,
  callReadFunction,
  LoadedAbi,
  loadSourcifyAbi,
  parseAbi,
  parseArg,
  splitFunctions,
} from '@/core/contracts/contract';
import { useMyAccounts } from '@/hooks/account';
import { useTheme2024 } from '@/hooks/theme';
import { ellipsisAddress } from '@/utils/address';
import { findChainByEnum } from '@/utils/chain';
import { createGetStyles2024 } from '@/utils/styles';

type FnResult =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; lines: string[] }
  | { status: 'error'; message: string };

const errorText = (error: unknown) => {
  const e = error as { reason?: string; message?: string; error?: unknown };
  return (
    e?.reason ||
    (typeof e?.error === 'object' && (e.error as any)?.message) ||
    e?.message ||
    String(error)
  );
};

const FunctionCard = ({
  fragment,
  mode,
  onRun,
  nativeSymbol,
}: {
  fragment: ethers.utils.FunctionFragment;
  mode: 'read' | 'write';
  nativeSymbol: string;
  onRun: (args: unknown[], valueWei: ethers.BigNumber) => Promise<string[]>;
}) => {
  const { styles, colors2024 } = useTheme2024({ getStyle });
  const [open, setOpen] = useState(false);
  const [inputs, setInputs] = useState<string[]>(() =>
    fragment.inputs.map(() => ''),
  );
  const [value, setValue] = useState('');
  const [result, setResult] = useState<FnResult>({ status: 'idle' });

  const run = async () => {
    let args: unknown[];
    let valueWei = ethers.BigNumber.from(0);
    try {
      args = fragment.inputs.map((param, i) =>
        parseArg(param, inputs[i] || ''),
      );
      if (fragment.payable && value.trim()) {
        valueWei = ethers.utils.parseEther(value.trim());
      }
    } catch (error) {
      setResult({ status: 'error', message: errorText(error) });
      return;
    }
    setResult({ status: 'running' });
    try {
      setResult({ status: 'ok', lines: await onRun(args, valueWei) });
    } catch (error) {
      setResult({ status: 'error', message: errorText(error) });
    }
  };

  return (
    <View style={styles.fnCard}>
      <Pressable onPress={() => setOpen(v => !v)} style={styles.fnHeader}>
        <Text style={[styles.fnName, mode === 'write' && styles.fnWrite]}>
          {fragment.name}
        </Text>
        <Text style={styles.fnSig} numberOfLines={1}>
          {`(${fragment.inputs.map(i => i.type).join(', ')})${
            fragment.payable ? ' payable' : ''
          }`}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.fnBody}>
          {fragment.inputs.map((param, i) => (
            <TextInput
              key={`${param.name}-${i}`}
              style={styles.input}
              value={inputs[i]}
              onChangeText={text =>
                setInputs(prev => prev.map((v, j) => (j === i ? text : v)))
              }
              placeholder={`${param.name || `arg${i}`} (${param.type})`}
              placeholderTextColor={colors2024['neutral-foot']}
              autoCapitalize="none"
              autoCorrect={false}
            />
          ))}
          {fragment.payable ? (
            <TextInput
              style={styles.input}
              value={value}
              onChangeText={setValue}
              placeholder={`value (${nativeSymbol})`}
              placeholderTextColor={colors2024['neutral-foot']}
              keyboardType="decimal-pad"
            />
          ) : null}
          <Button
            height={40}
            type={mode === 'read' ? 'ghost' : 'primary'}
            title={mode === 'read' ? 'Query' : 'Write'}
            loading={result.status === 'running'}
            onPress={run}
          />
          {result.status === 'ok' ? (
            <View style={styles.output}>
              {result.lines.map((line, i) => (
                <Text key={i} style={styles.outputText} selectable>
                  {line}
                </Text>
              ))}
            </View>
          ) : result.status === 'error' ? (
            <Text style={styles.error} selectable>
              {result.message}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};

export const ContractInteractScreen = () => {
  const { t } = useTranslation();
  const { styles, colors2024 } = useTheme2024({ getStyle });
  const { accounts } = useMyAccounts();
  const signers = useMemo(
    () =>
      accounts.filter(
        a =>
          a.type !== KEYRING_TYPE.WatchAddressKeyring &&
          a.type !== KEYRING_TYPE.GnosisKeyring,
      ),
    [accounts],
  );
  const [fromIndex, setFromIndex] = useState(0);
  const from = signers[fromIndex] || signers[0];

  const [chainEnum, setChainEnum] = useState<CHAINS_ENUM>(CHAINS_ENUM.ETH);
  const chain = findChainByEnum(chainEnum);
  const [address, setAddress] = useState('');
  const [abiText, setAbiText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [loaded, setLoaded] = useState<
    (LoadedAbi & { address: string; chainId: number }) | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'read' | 'write'>('read');

  const functions = useMemo(
    () => (loaded ? splitFunctions(loaded.abi) : { read: [], write: [] }),
    [loaded],
  );

  const load = async () => {
    if (!chain || !ethers.utils.isAddress(address.trim())) {
      toast.info('Enter a valid contract address');
      return;
    }
    const target = ethers.utils.getAddress(address.trim());
    setLoading(true);
    try {
      if (showPaste && abiText.trim()) {
        setLoaded({
          abi: parseAbi(abiText),
          source: 'pasted',
          address: target,
          chainId: chain.id,
        });
        return;
      }
      const result = await loadSourcifyAbi(chain.id, target);
      if (!result) {
        toast.info('Not verified on Sourcify: paste the ABI');
        setShowPaste(true);
        return;
      }
      setLoaded({ ...result, address: target, chainId: chain.id });
    } catch (error) {
      toast.info(errorText(error));
    } finally {
      setLoading(false);
    }
  };

  const runRead =
    (fragment: ethers.utils.FunctionFragment) => async (args: unknown[]) => {
      const outputs = await callReadFunction(
        { serverId: chain!.serverId, id: chain!.id },
        loaded!.address,
        fragment,
        args,
      );
      return outputs.map(o => `${o.name} (${o.type}): ${o.value}`);
    };

  const runWrite =
    (fragment: ethers.utils.FunctionFragment) =>
    async (args: unknown[], valueWei: ethers.BigNumber) => {
      if (!from) {
        throw new Error('No account that can sign');
      }
      const tx = buildWriteTx({
        from: from.address,
        chainId: chain!.id,
        address: loaded!.address,
        fragment,
        args,
        valueWei,
      });
      const hash = await sendRequest<string>({
        data: { method: 'eth_sendTransaction', params: [tx] },
        session: INTERNAL_REQUEST_SESSION,
        account: from,
      });
      return [`tx: ${hash}`];
    };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <ChainSelector
          value={chainEnum}
          onChange={value => {
            setChainEnum(value);
            setLoaded(null);
          }}
        />
        <TextInput
          style={styles.input}
          value={address}
          onChangeText={text => {
            setAddress(text);
            setLoaded(null);
          }}
          placeholder="Contract address (0x…)"
          placeholderTextColor={colors2024['neutral-foot']}
          autoCapitalize="none"
          autoCorrect={false}
          testID="contract-address"
        />
        <TouchableOpacity onPress={() => setShowPaste(v => !v)}>
          <Text style={styles.link}>
            {showPaste
              ? 'Use the verified ABI (Sourcify)'
              : 'Paste an ABI instead'}
          </Text>
        </TouchableOpacity>
        {showPaste ? (
          <TextInput
            style={[styles.input, styles.abiInput]}
            value={abiText}
            onChangeText={setAbiText}
            placeholder='[{"type":"function", ...}]'
            placeholderTextColor={colors2024['neutral-foot']}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
        ) : null}
        <Button
          height={44}
          title={t('page.contracts.load', { defaultValue: 'Load contract' })}
          loading={loading}
          onPress={load}
        />
      </View>

      {loaded ? (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>{ellipsisAddress(loaded.address)}</Text>
            <Text style={styles.muted}>
              {loaded.source === 'pasted'
                ? 'ABI pasted by you'
                : `Verified on Sourcify (${loaded.source.replace('_', ' ')})`}
              {loaded.implementation
                ? ` · proxy of ${
                    loaded.implementationName || ''
                  } ${ellipsisAddress(loaded.implementation)}`
                : ''}
            </Text>
            {chain?.id === 1 ? (
              <Text style={styles.muted}>Reads verified by Helios</Text>
            ) : null}
            {signers.length ? (
              <View style={styles.fromRow}>
                <Text style={styles.muted}>Write as</Text>
                {signers.map((account, i) => (
                  <Pressable
                    key={account.address + account.type}
                    onPress={() => setFromIndex(i)}
                    style={[
                      styles.chip,
                      from === account && styles.chipSelected,
                    ]}>
                    <Text style={styles.chipText}>
                      {ellipsisAddress(account.address)}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
          <View style={styles.tabs}>
            {(['read', 'write'] as const).map(name => (
              <Pressable
                key={name}
                onPress={() => setTab(name)}
                style={[styles.tab, tab === name && styles.tabOn]}>
                <Text
                  style={[styles.tabText, tab === name && styles.tabTextOn]}>
                  {`${name === 'read' ? 'Read' : 'Write'} (${
                    functions[name].length
                  })`}
                </Text>
              </Pressable>
            ))}
          </View>
          {functions[tab].map(fragment => (
            <FunctionCard
              key={fragment.format(ethers.utils.FormatTypes.sighash)}
              fragment={fragment}
              mode={tab}
              nativeSymbol={chain?.nativeTokenSymbol || 'ETH'}
              onRun={tab === 'read' ? runRead(fragment) : runWrite(fragment)}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
};

const getStyle = createGetStyles2024(({ colors2024, isLight }) => ({
  screen: { flex: 1, backgroundColor: colors2024['neutral-bg-1'] },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  card: {
    padding: 16,
    gap: 10,
    borderRadius: 16,
    backgroundColor: isLight
      ? colors2024['neutral-bg-2']
      : colors2024['neutral-bg-2'],
  },
  input: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
    color: colors2024['neutral-title-1'],
    fontSize: 14,
  },
  abiInput: { minHeight: 120, textAlignVertical: 'top' },
  link: { fontSize: 13, color: colors2024['brand-default'] },
  label: {
    fontSize: 16,
    fontWeight: '700',
    color: colors2024['neutral-title-1'],
  },
  muted: { fontSize: 13, color: colors2024['neutral-secondary'] },
  error: { fontSize: 13, color: colors2024['red-default'] },
  fromRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
  },
  chipSelected: {
    borderColor: colors2024['brand-default'],
    backgroundColor: colors2024['brand-light-1'],
  },
  chipText: { fontSize: 12, color: colors2024['neutral-body'] },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors2024['neutral-line'],
  },
  tabOn: {
    borderColor: colors2024['brand-default'],
    backgroundColor: colors2024['brand-light-1'],
  },
  tabText: { fontSize: 14, color: colors2024['neutral-body'] },
  tabTextOn: { color: colors2024['brand-default'], fontWeight: '700' },
  fnCard: {
    borderRadius: 12,
    backgroundColor: colors2024['neutral-bg-2'],
    overflow: 'hidden',
  },
  fnHeader: { padding: 12, gap: 2 },
  fnName: {
    fontSize: 15,
    fontWeight: '700',
    color: colors2024['brand-default'],
  },
  fnWrite: { color: colors2024['orange-default'] },
  fnSig: { fontSize: 12, color: colors2024['neutral-secondary'] },
  fnBody: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  output: {
    padding: 10,
    borderRadius: 8,
    backgroundColor: colors2024['neutral-bg-1'],
    gap: 4,
  },
  outputText: {
    fontSize: 13,
    color: colors2024['neutral-title-1'],
    fontFamily: 'monospace',
  },
}));
