import { ethers } from 'ethers';
import { bytesToHex } from '@noble/hashes/utils';

import { decodeAddress } from '@/core/solana/keys';

import fixture from './__fixtures__/mainnet-vaa.json';
import receipt from './__fixtures__/mainnet-receipt.json';
import { WORMHOLE } from './constants';
import {
  buildWrapAndTransferEth,
  normalizeBridgeAmount,
  sequenceFromReceipt,
  tokenBridgeEmitterHex,
} from './evm';

jest.mock('@/core/helios/node', () => ({
  heliosRpc: jest.fn(),
  isHeliosSupported: () => false,
}));
jest.mock('@/core/serviceApi/customRPC', () => ({
  customRPCServiceApi: { defaultEthRPC: jest.fn() },
}));

describe('Wormhole Ethereum side', () => {
  it('reads the sequence from a real token-bridge receipt', () => {
    expect(sequenceFromReceipt(receipt)).toBe(BigInt(fixture.sequence));
  });

  it('ignores failed receipts and receipts without a bridge message', () => {
    expect(sequenceFromReceipt({ ...receipt, status: '0x0' })).toBeNull();
    expect(sequenceFromReceipt({ status: '0x1', logs: [] })).toBeNull();
    expect(sequenceFromReceipt(null)).toBeNull();
  });

  it('encodes wrapAndTransferETH to the Solana token account', () => {
    const tx = buildWrapAndTransferEth({
      from: '0x0000000000000000000000000000000000000001',
      amountWei: 2_000_000_000_000_000n,
      messageFeeWei: 5n,
      recipientTokenAccount: '9h1cLBiraaUqM1CdJTaVaew1oQtgQUW24FZ8YdnLLgJY',
      nonce: 42,
    });
    expect(tx.to).toBe(WORMHOLE.ethTokenBridge);
    expect(BigInt(tx.value)).toBe(2_000_000_000_000_005n);
    const decoded = new ethers.utils.Interface([
      'function wrapAndTransferETH(uint16,bytes32,uint256,uint32)',
    ]).decodeFunctionData('wrapAndTransferETH', tx.data);
    expect(decoded[0]).toBe(WORMHOLE.solanaChainId);
    expect(decoded[2].toString()).toBe('0');
    expect(decoded[3]).toBe(42);
    // The recipient is the raw 32-byte Solana address.
    expect(decoded[1]).toBe(
      `0x${bytesToHex(
        decodeAddress('9h1cLBiraaUqM1CdJTaVaew1oQtgQUW24FZ8YdnLLgJY'),
      )}`,
    );
  });

  it('only bridges whole 1e-8 ETH units', () => {
    expect(normalizeBridgeAmount(1_234_567_891_234_567n)).toBe(
      1_234_560_000_000_000n,
    );
    expect(() =>
      buildWrapAndTransferEth({
        from: '0x0000000000000000000000000000000000000001',
        amountWei: 1n,
        messageFeeWei: 0n,
        recipientTokenAccount: '9h1cLBiraaUqM1CdJTaVaew1oQtgQUW24FZ8YdnLLgJY',
        nonce: 1,
      }),
    ).toThrow();
  });

  it('uses the token bridge as emitter', () => {
    expect(tokenBridgeEmitterHex()).toBe(
      '0000000000000000000000003ee18b2214aff97000d974cf647e7c347e8fa585',
    );
  });
});
