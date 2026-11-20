import { Buffer } from 'buffer';

import vectors from './__fixtures__/reference-vectors.json';
import {
  decodeAddress,
  deriveEd25519PrivateKey,
  publicKeyFromPrivateKey,
  verifySignature,
} from './keys';
import {
  associatedTokenAddress,
  compileMessage,
  createAssociatedTokenAccountIdempotent,
  masterEditionAddress,
  metadataAddress,
  PROGRAM_IDS,
  programmableNftTransfer,
  setComputeUnitLimit,
  setComputeUnitPrice,
  signTransaction,
  systemTransfer,
  tokenRecordAddress,
  tokenTransferChecked,
  unsignedTransaction,
} from './tx';

const ME = vectors.derivation[0].address;
const OTHER = vectors.derivation[1].address;
const BLOCKHASH = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
const privateKey = deriveEd25519PrivateKey(
  Uint8Array.from(Buffer.from(vectors.derivation[0].seedHex, 'hex')),
  vectors.derivation[0].path,
);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('Solana addresses (PDAs)', () => {
  it.each(vectors.ata)('derives the associated token account for $mint', a => {
    expect(associatedTokenAddress(a.owner, a.mint, a.tokenProgram)).toBe(a.ata);
  });

  it('derives Token Metadata PDAs', () => {
    expect(metadataAddress(vectors.pda.mint)).toBe(vectors.pda.metadata);
    expect(masterEditionAddress(vectors.pda.mint)).toBe(vectors.pda.edition);
    expect(tokenRecordAddress(vectors.pda.mint, vectors.pda.tokenAccount)).toBe(
      vectors.pda.tokenRecord,
    );
  });
});

describe('Solana instructions', () => {
  it('encodes a system transfer', () => {
    const ix = systemTransfer(ME, OTHER, 1_234_567_890n);
    expect(ix.programId).toBe(PROGRAM_IDS.system);
    expect(hex(ix.data)).toBe('02000000d202964900000000');
    expect(ix.keys).toEqual([
      { pubkey: ME, isSigner: true, isWritable: true },
      { pubkey: OTHER, isSigner: false, isWritable: true },
    ]);
  });

  it('encodes compute budget instructions', () => {
    expect(hex(setComputeUnitLimit(450).data)).toBe('02c2010000');
    expect(hex(setComputeUnitPrice(12345n).data)).toBe('033930000000000000');
  });

  it('encodes TransferChecked and rejects bad decimals', () => {
    const ix = tokenTransferChecked({
      source: ME,
      mint: OTHER,
      destination: OTHER,
      owner: ME,
      amount: 2_500_000n,
      decimals: 6,
    });
    // 12 = TransferChecked, amount 2_500_000 (u64 LE), decimals 6
    expect(hex(ix.data)).toBe('0c' + 'a025260000000000' + '06');
    expect(() =>
      tokenTransferChecked({
        source: ME,
        mint: OTHER,
        destination: OTHER,
        owner: ME,
        amount: 1n,
        decimals: 300,
      }),
    ).toThrow();
  });

  it('rejects amounts outside u64', () => {
    expect(() => systemTransfer(ME, OTHER, -1n)).toThrow();
    expect(() => systemTransfer(ME, OTHER, 2n ** 64n)).toThrow();
  });

  it('builds the pNFT transfer with Token Metadata placeholders', () => {
    const ix = programmableNftTransfer({
      owner: ME,
      destinationOwner: OTHER,
      mint: vectors.pda.mint,
      ruleSet: null,
    });
    expect(ix.programId).toBe(PROGRAM_IDS.tokenMetadata);
    expect(ix.keys).toHaveLength(17);
    expect(hex(ix.data)).toBe('3100' + '0100000000000000' + '00');
    // No rule set: both optional rule accounts point at the program itself.
    expect(ix.keys[15].pubkey).toBe(PROGRAM_IDS.tokenMetadata);
    expect(ix.keys[16].pubkey).toBe(PROGRAM_IDS.tokenMetadata);
  });
});

describe('Solana messages', () => {
  const instructions = [
    setComputeUnitLimit(450),
    createAssociatedTokenAccountIdempotent(ME, OTHER, vectors.ata[0].mint),
    tokenTransferChecked({
      source: associatedTokenAddress(ME, vectors.ata[0].mint),
      mint: vectors.ata[0].mint,
      destination: associatedTokenAddress(OTHER, vectors.ata[0].mint),
      owner: ME,
      amount: 1n,
      decimals: 6,
    }),
  ];

  it('puts the fee payer first and merges duplicate accounts', () => {
    const message = compileMessage({
      feePayer: ME,
      recentBlockhash: BLOCKHASH,
      instructions,
    });
    expect(message.accountKeys[0]).toBe(ME);
    expect(new Set(message.accountKeys).size).toBe(message.accountKeys.length);
    expect(message.numRequiredSignatures).toBe(1);
    // header: 1 signer, 0 read-only signers, read-only = programs + mint + owner
    expect(message.bytes[0]).toBe(1);
    expect(message.bytes[1]).toBe(0);
  });

  it('signs a verifiable transaction and refuses foreign signers', () => {
    const message = compileMessage({
      feePayer: ME,
      recentBlockhash: BLOCKHASH,
      instructions: [systemTransfer(ME, OTHER, 1n)],
    });
    const wire = signTransaction(message, ME, privateKey);
    expect(wire[0]).toBe(1);
    expect(
      verifySignature(
        wire.slice(1, 65),
        message.bytes,
        publicKeyFromPrivateKey(privateKey),
      ),
    ).toBe(true);
    expect(() => signTransaction(message, OTHER, privateKey)).toThrow();
    const twoSigners = compileMessage({
      feePayer: ME,
      recentBlockhash: BLOCKHASH,
      instructions: [systemTransfer(OTHER, ME, 1n)],
    });
    expect(() => signTransaction(twoSigners, ME, privateKey)).toThrow();
  });

  it('builds the zero-signature form for simulation', () => {
    const message = compileMessage({
      feePayer: ME,
      recentBlockhash: BLOCKHASH,
      instructions: [systemTransfer(ME, OTHER, 1n)],
    });
    const unsigned = unsignedTransaction(message);
    expect(unsigned[0]).toBe(1);
    expect(unsigned.slice(1, 65).every(byte => byte === 0)).toBe(true);
    expect(hex(unsigned.slice(65))).toBe(hex(message.bytes));
  });

  it('rejects malformed input', () => {
    expect(() =>
      compileMessage({
        feePayer: ME,
        recentBlockhash: BLOCKHASH,
        instructions: [],
      }),
    ).toThrow();
    expect(() =>
      compileMessage({
        feePayer: ME,
        recentBlockhash: BLOCKHASH,
        instructions: [systemTransfer(ME, 'not-an-address', 1n)],
      }),
    ).toThrow();
    expect(decodeAddress(BLOCKHASH)).toHaveLength(32);
  });
});
