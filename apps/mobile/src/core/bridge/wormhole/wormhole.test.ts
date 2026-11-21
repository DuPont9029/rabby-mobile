import { Buffer } from 'buffer';
import { hexToBytes } from '@noble/hashes/utils';

import fixture from './__fixtures__/mainnet-vaa.json';
import reference from './__fixtures__/sdk-reference.json';
import { WORMHOLE } from './constants';
import {
  completeWrappedInstruction,
  postVaaInstruction,
  verifySignaturesInstructions,
  wrappedEthMint,
} from './solana';
import {
  parseTokenTransfer,
  parseVaa,
  quorum,
  verifyVaaSignatures,
} from './vaa';
import type { Instruction } from '@/core/solana/tx';

const vaaBytes = Uint8Array.from(Buffer.from(fixture.vaa, 'base64'));
const dump = (ix: Instruction) => ({
  programId: ix.programId,
  keys: ix.keys.map(k => [k.pubkey, k.isSigner, k.isWritable]),
  data: Buffer.from(ix.data).toString('hex'),
});

describe('Wormhole VAA', () => {
  it('parses a real mainnet token-bridge transfer', () => {
    const vaa = parseVaa(vaaBytes);
    expect(vaa.guardianSetIndex).toBe(fixture.guardianSetIndex);
    expect(vaa.emitterChain).toBe(WORMHOLE.ethChainId);
    expect(vaa.sequence).toBe(BigInt(fixture.sequence));
    const transfer = parseTokenTransfer(vaa.payload);
    expect(transfer.toChain).toBe(WORMHOLE.solanaChainId);
  });

  it('accepts the real guardian signatures', () => {
    const vaa = parseVaa(vaaBytes);
    expect(vaa.signatures.length).toBeGreaterThanOrEqual(quorum(19));
    expect(verifyVaaSignatures(vaa, fixture.guardians)).toBe(true);
  });

  it('rejects a tampered body, a wrong guardian set and too few signatures', () => {
    const tampered = Uint8Array.from(vaaBytes);
    tampered[tampered.length - 1] ^= 1;
    expect(verifyVaaSignatures(parseVaa(tampered), fixture.guardians)).toBe(
      false,
    );
    const shuffled = [...fixture.guardians].reverse();
    expect(verifyVaaSignatures(parseVaa(vaaBytes), shuffled)).toBe(false);
    const vaa = parseVaa(vaaBytes);
    expect(
      verifyVaaSignatures(
        { ...vaa, signatures: vaa.signatures.slice(0, quorum(19) - 1) },
        fixture.guardians,
      ),
    ).toBe(false);
  });

  it('rejects duplicated guardian signatures', () => {
    const vaa = parseVaa(vaaBytes);
    const first = vaa.signatures[0];
    const duplicated = {
      ...vaa,
      signatures: [first, ...vaa.signatures.slice(0, -1)],
    };
    expect(verifyVaaSignatures(duplicated, fixture.guardians)).toBe(false);
  });

  it('the Solana guardian set matches the Ethereum one', () => {
    expect(reference.solanaGuardianKeys.map(k => k.toLowerCase())).toEqual(
      fixture.guardians.map(k => k.toLowerCase()),
    );
  });
});

describe('Wormhole Solana instructions (vs the official SDK)', () => {
  const vaa = parseVaa(vaaBytes);
  const keys = fixture.guardians.map(k => hexToBytes(k.slice(2)));

  it('derives the wrapped ETH mint', () => {
    expect(wrappedEthMint()).toBe(reference.wethMint);
    expect(wrappedEthMint()).toBe(WORMHOLE.solWrappedEthMint);
  });

  it('builds identical verify_signatures batches', () => {
    const mine = verifySignaturesInstructions(
      reference.payer,
      vaa,
      keys,
      reference.signatureSet,
    )
      .flat()
      .map(dump);
    expect(mine).toEqual(reference.verify);
  });

  it('builds an identical post_vaa', () => {
    expect(
      dump(postVaaInstruction(reference.payer, vaa, reference.signatureSet)),
    ).toEqual(reference.post);
  });

  it('builds an identical complete_wrapped', () => {
    expect(dump(completeWrappedInstruction(reference.payer, vaa))).toEqual(
      reference.complete,
    );
  });
});

describe('checkTransferVaa', () => {
  // Imported lazily: the module pulls in storage and Solana services.
  jest.mock('@/core/storage/mmkv', () => ({
    appJsonStore: { getItem: () => null, setItem: () => undefined },
  }));
  jest.mock('@/core/helios/node', () => ({
    heliosRpc: jest.fn(),
    isHeliosSupported: () => false,
  }));
  jest.mock('@/core/serviceApi/customRPC', () => ({
    customRPCServiceApi: { defaultEthRPC: jest.fn() },
  }));
  jest.mock('@/core/solana/account', () => ({
    getSolanaAccount: jest.fn(),
    withSolanaSigner: jest.fn(),
  }));
  jest.mock('@/core/solana/settings', () => ({ getSolanaRpc: jest.fn() }));

  const { checkTransferVaa } =
    require('./transfers') as typeof import('./transfers');
  const { encodeAddress } =
    require('@/core/solana/keys') as typeof import('@/core/solana/keys');
  const vaa = parseVaa(vaaBytes);
  const payload = parseTokenTransfer(vaa.payload);
  const transfer = {
    sequence: String(fixture.sequence),
    recipientTokenAccount: encodeAddress(payload.to),
    amountWei: (payload.amount * 10n ** 10n).toString(),
  };
  const guardians = async () => ({
    guardians: fixture.guardians.map(g => g.toLowerCase()),
    expirationTime: 0,
  });

  it('rejects a transfer of another token (not WETH)', async () => {
    // The main fixture bridges another ERC-20, never WETH.
    await expect(
      checkTransferVaa(vaaBytes, transfer, guardians),
    ).rejects.toThrow('do not match');
  });

  it('accepts a real WETH transfer to its recipient', async () => {
    const weth = require('./__fixtures__/mainnet-weth-vaa.json');
    const bytes = Uint8Array.from(Buffer.from(weth.vaa, 'base64'));
    const parsed = parseTokenTransfer(parseVaa(bytes).payload);
    await expect(
      checkTransferVaa(
        bytes,
        {
          sequence: String(weth.sequence),
          recipientTokenAccount: encodeAddress(parsed.to),
          amountWei: (parsed.amount * 10n ** 10n).toString(),
        },
        guardians,
      ),
    ).resolves.toBeTruthy();
  });

  it('rejects another recipient, amount or sequence', async () => {
    await expect(
      checkTransferVaa(
        vaaBytes,
        {
          ...transfer,
          recipientTokenAccount: '9h1cLBiraaUqM1CdJTaVaew1oQtgQUW24FZ8YdnLLgJY',
        },
        guardians,
      ),
    ).rejects.toThrow();
    await expect(
      checkTransferVaa(vaaBytes, { ...transfer, amountWei: '1' }, guardians),
    ).rejects.toThrow();
    await expect(
      checkTransferVaa(vaaBytes, { ...transfer, sequence: '1' }, guardians),
    ).rejects.toThrow('not this transfer');
  });

  it('rejects a VAA signed by another guardian set', async () => {
    await expect(
      checkTransferVaa(vaaBytes, transfer, async () => ({
        guardians: [...fixture.guardians].reverse(),
        expirationTime: 0,
      })),
    ).rejects.toThrow('signatures');
  });
});
