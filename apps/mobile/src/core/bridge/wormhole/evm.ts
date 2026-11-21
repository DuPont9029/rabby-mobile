/**
 * Ethereum side of a Wormhole Token Bridge transfer of ETH.
 *
 * Reads (message fee, guardian set, receipt) go through Helios when it is
 * available, so they are verified against the chain.
 */
import { ethers } from 'ethers';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { heliosRpc, isHeliosSupported } from '@/core/helios/node';
import { customRPCServiceApi } from '@/core/serviceApi/customRPC';
import { decodeAddress } from '@/core/solana/keys';

import { WORMHOLE } from './constants';
import { evmAddressToBytes32 } from './vaa';

const tokenBridge = new ethers.utils.Interface([
  'function wrapAndTransferETH(uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce) payable returns (uint64 sequence)',
]);
const core = new ethers.utils.Interface([
  'function messageFee() view returns (uint256)',
  'function getGuardianSet(uint32 index) view returns (tuple(address[] keys, uint32 expirationTime))',
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
]);

/** Wrapped tokens use 8 decimals: ETH below 1e-8 cannot be bridged. */
export const WEI_PER_WRAPPED_UNIT = 10n ** 10n;

const ethRpc = async <T>(method: string, params: unknown[]): Promise<T> =>
  isHeliosSupported()
    ? heliosRpc<T>(method, params)
    : ((await customRPCServiceApi.defaultEthRPC({
        chainServerId: 'eth',
        method,
        params,
      })) as T);

const ethCall = (to: string, data: string) =>
  ethRpc<string>('eth_call', [{ to, data }, 'latest']);

export const getEthBalance = async (address: string): Promise<bigint> =>
  BigInt(await ethRpc<string>('eth_getBalance', [address, 'latest']));

export const readMessageFee = async (): Promise<bigint> => {
  const result = await ethCall(
    WORMHOLE.ethCore,
    core.encodeFunctionData('messageFee'),
  );
  return BigInt(core.decodeFunctionResult('messageFee', result)[0].toString());
};

/** Guardian addresses (lower-case, in set order) of guardian set `index`. */
export const readGuardianSet = async (
  index: number,
): Promise<{ guardians: string[]; expirationTime: number }> => {
  const result = await ethCall(
    WORMHOLE.ethCore,
    core.encodeFunctionData('getGuardianSet', [index]),
  );
  // Access by position: `keys` is also Array.prototype.keys on ethers Results.
  const set = core.decodeFunctionResult('getGuardianSet', result)[0];
  const guardians = (set[0] as string[]).map(key => key.toLowerCase());
  return { guardians, expirationTime: Number(set[1]) };
};

export const guardianKeyBytes = (guardians: string[]) =>
  guardians.map(key => hexToBytes(key.slice(2)));

/** Rounds down to what the bridge can carry (8 decimals). */
export const normalizeBridgeAmount = (wei: bigint) =>
  (wei / WEI_PER_WRAPPED_UNIT) * WEI_PER_WRAPPED_UNIT;

/**
 * The `eth_sendTransaction` request for bridging `amountWei` (already
 * normalized) to the Solana token account `recipientTokenAccount`.
 */
export const buildWrapAndTransferEth = ({
  from,
  amountWei,
  messageFeeWei,
  recipientTokenAccount,
  nonce,
}: {
  from: string;
  amountWei: bigint;
  messageFeeWei: bigint;
  recipientTokenAccount: string;
  nonce: number;
}) => {
  if (amountWei <= 0n || amountWei % WEI_PER_WRAPPED_UNIT !== 0n) {
    throw new Error('amount must be a positive multiple of 1e10 wei');
  }
  const recipient = `0x${bytesToHex(decodeAddress(recipientTokenAccount))}`;
  return {
    from,
    to: WORMHOLE.ethTokenBridge,
    value: `0x${(amountWei + messageFeeWei).toString(16)}`,
    data: tokenBridge.encodeFunctionData('wrapAndTransferETH', [
      WORMHOLE.solanaChainId,
      recipient,
      0,
      nonce >>> 0,
    ]),
    chainId: 1,
  };
};

type RawReceipt = {
  status?: string;
  logs?: Array<{ address: string; topics: string[]; data: string }>;
} | null;

export const getReceipt = (hash: string) =>
  ethRpc<RawReceipt>('eth_getTransactionReceipt', [hash]);

/**
 * The Wormhole sequence of the token-bridge message in `receipt`, or `null`
 * if the transaction failed or did not publish one.
 */
export const sequenceFromReceipt = (receipt: RawReceipt): bigint | null => {
  if (!receipt || receipt.status !== '0x1') {
    return null;
  }
  const topic = core.getEventTopic('LogMessagePublished');
  const sender = `0x${bytesToHex(
    evmAddressToBytes32(WORMHOLE.ethTokenBridge),
  )}`;
  for (const log of receipt.logs || []) {
    if (
      log.address.toLowerCase() === WORMHOLE.ethCore.toLowerCase() &&
      log.topics[0] === topic &&
      log.topics[1]?.toLowerCase() === sender
    ) {
      const parsed = core.parseLog(log);
      return BigInt(parsed.args.sequence.toString());
    }
  }
  return null;
};

/** The token bridge's emitter address as Wormhole uses it (hex, 32 bytes). */
export const tokenBridgeEmitterHex = () =>
  bytesToHex(evmAddressToBytes32(WORMHOLE.ethTokenBridge));
