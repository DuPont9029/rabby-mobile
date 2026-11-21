/**
 * Solana side of a Wormhole Token Bridge transfer: verify the guardian
 * signatures, post the VAA, and complete the wrapped-token transfer into the
 * recipient's associated token account.
 *
 * Instruction layouts and account lists follow the official Wormhole Solana
 * programs (IDL in @wormhole-foundation/sdk-solana-core / -tokenbridge) and
 * are checked byte for byte against that SDK in the tests.
 */
import {
  decodeAddress,
  encodeAddress,
  findProgramAddress,
  utf8,
} from '@/core/solana/keys';
import {
  AccountMeta,
  associatedTokenAddress,
  createAssociatedTokenAccountIdempotent,
  Instruction,
  PROGRAM_IDS,
} from '@/core/solana/tx';

import { WORMHOLE } from './constants';
import { ParsedVaa, parseTokenTransfer } from './vaa';

export const SOLANA_PROGRAMS = {
  secp256k1: 'KeccakSecp256k11111111111111111111111111111',
  sysvarRent: 'SysvarRent111111111111111111111111111111111',
  sysvarClock: 'SysvarC1ock11111111111111111111111111111111',
} as const;

/** Signatures checked per secp256k1 + verify_signatures instruction pair. */
export const SIGNATURES_PER_BATCH = 7;
const MAX_GUARDIANS = 19;

const meta = (
  pubkey: string,
  isSigner: boolean,
  isWritable: boolean,
): AccountMeta => ({ pubkey, isSigner, isWritable });

const be = (value: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  let rest = value;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};

const le = (value: bigint, bytes: number) => be(value, bytes).reverse();

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const pda = (seeds: Uint8Array[], program: string) =>
  encodeAddress(findProgramAddress(seeds, decodeAddress(program))[0]);

// ---- PDAs --------------------------------------------------------------

export const guardianSetAddress = (index: number) =>
  pda([utf8('GuardianSet'), be(BigInt(index), 4)], WORMHOLE.solCore);

export const bridgeDataAddress = () => pda([utf8('Bridge')], WORMHOLE.solCore);

export const postedVaaAddress = (hash: Uint8Array) =>
  pda([utf8('PostedVAA'), hash], WORMHOLE.solCore);

export const claimAddress = (vaa: ParsedVaa) =>
  pda(
    [vaa.emitterAddress, be(BigInt(vaa.emitterChain), 2), be(vaa.sequence, 8)],
    WORMHOLE.solTokenBridge,
  );

export const endpointAddress = (chain: number, emitter: Uint8Array) =>
  pda([be(BigInt(chain), 2), emitter], WORMHOLE.solTokenBridge);

export const wrappedMintAddress = (tokenChain: number, token: Uint8Array) =>
  pda(
    [utf8('wrapped'), be(BigInt(tokenChain), 2), token],
    WORMHOLE.solTokenBridge,
  );

export const wrappedMetaAddress = (mint: string) =>
  pda([utf8('meta'), decodeAddress(mint)], WORMHOLE.solTokenBridge);

export const tokenBridgeConfigAddress = () =>
  pda([utf8('config')], WORMHOLE.solTokenBridge);

export const mintAuthorityAddress = () =>
  pda([utf8('mint_signer')], WORMHOLE.solTokenBridge);

/** The Solana mint of ETH bridged from Ethereum (Wormhole-wrapped WETH). */
export const wrappedEthMint = () =>
  wrappedMintAddress(
    WORMHOLE.ethChainId,
    (() => {
      const out = new Uint8Array(32);
      const raw = WORMHOLE.ethWeth
        .slice(2)
        .match(/../g)!
        .map(h => parseInt(h, 16));
      out.set(raw, 12);
      return out;
    })(),
  );

/** Where wrapped ETH for `owner` lands: their associated token account. */
export const wrappedEthRecipient = (owner: string) =>
  associatedTokenAddress(owner, wrappedEthMint());

// ---- instructions --------------------------------------------------------

/** Secp256k1 program instruction checking `signatures` over `digest`. */
export const secp256k1Instruction = (
  signatures: Uint8Array[],
  ethKeys: Uint8Array[],
  message: Uint8Array,
): Instruction => {
  if (!signatures.length || signatures.length !== ethKeys.length) {
    throw new Error('signature/key count mismatch');
  }
  if (message.length !== 32) {
    throw new Error('message must be 32 bytes');
  }
  const count = signatures.length;
  const offsetSpan = 11;
  const dataStart = 1 + count * offsetSpan;
  const entry = 65 + 20;
  const messageOffset = dataStart + count * entry;
  const data = new Uint8Array(messageOffset + 32);
  const view = new DataView(data.buffer);
  data[0] = count;
  for (let i = 0; i < count; i += 1) {
    const signature = signatures[i]!;
    const ethKey = ethKeys[i]!;
    if (signature.length !== 65 || ethKey.length !== 20) {
      throw new Error('bad signature or key length');
    }
    const signatureOffset = dataStart + entry * i;
    const keyOffset = signatureOffset + 65;
    const base = 1 + i * offsetSpan;
    view.setUint16(base, signatureOffset, true);
    data[base + 2] = 0;
    view.setUint16(base + 3, keyOffset, true);
    data[base + 5] = 0;
    view.setUint16(base + 6, messageOffset, true);
    view.setUint16(base + 8, 32, true);
    data[base + 10] = 0;
    data.set(signature, signatureOffset);
    data.set(ethKey, keyOffset);
  }
  data.set(message, messageOffset);
  return { programId: SOLANA_PROGRAMS.secp256k1, keys: [], data };
};

/**
 * One secp256k1 + `verify_signatures` pair per batch of up to 7 signatures,
 * all writing into the `signatureSet` account (a fresh keypair that signs).
 */
export const verifySignaturesInstructions = (
  payer: string,
  vaa: ParsedVaa,
  guardianKeys: Uint8Array[],
  signatureSet: string,
): Instruction[][] => {
  const batches: Instruction[][] = [];
  for (
    let start = 0;
    start < vaa.signatures.length;
    start += SIGNATURES_PER_BATCH
  ) {
    const batch = vaa.signatures.slice(start, start + SIGNATURES_PER_BATCH);
    const status = new Int8Array(MAX_GUARDIANS).fill(-1);
    batch.forEach((item, position) => {
      status[item.guardianIndex] = position;
    });
    const keys = batch.map(item => {
      const key = guardianKeys[item.guardianIndex];
      if (!key || key.length !== 20) {
        throw new Error('unknown guardian');
      }
      return key;
    });
    batches.push([
      secp256k1Instruction(
        batch.map(item => item.signature),
        keys,
        vaa.hash,
      ),
      {
        programId: WORMHOLE.solCore,
        keys: [
          meta(payer, true, true),
          meta(guardianSetAddress(vaa.guardianSetIndex), false, false),
          meta(signatureSet, true, true),
          meta(PROGRAM_IDS.sysvarInstructions, false, false),
          meta(SOLANA_PROGRAMS.sysvarRent, false, false),
          meta(PROGRAM_IDS.system, false, false),
        ],
        data: concat(Uint8Array.of(7), new Uint8Array(status.buffer)),
      },
    ]);
  }
  return batches;
};

export const postVaaInstruction = (
  payer: string,
  vaa: ParsedVaa,
  signatureSet: string,
): Instruction => ({
  programId: WORMHOLE.solCore,
  keys: [
    meta(guardianSetAddress(vaa.guardianSetIndex), false, false),
    meta(bridgeDataAddress(), false, false),
    meta(signatureSet, false, false),
    meta(postedVaaAddress(vaa.hash), false, true),
    meta(payer, true, true),
    meta(SOLANA_PROGRAMS.sysvarClock, false, false),
    meta(SOLANA_PROGRAMS.sysvarRent, false, false),
    meta(PROGRAM_IDS.system, false, false),
  ],
  data: concat(
    Uint8Array.of(2, vaa.version),
    le(BigInt(vaa.guardianSetIndex), 4),
    le(BigInt(vaa.timestamp), 4),
    le(BigInt(vaa.nonce), 4),
    le(BigInt(vaa.emitterChain), 2),
    vaa.emitterAddress,
    le(vaa.sequence, 8),
    Uint8Array.of(vaa.consistencyLevel),
    le(BigInt(vaa.payload.length), 4),
    vaa.payload,
  ),
});

/** `complete_wrapped`: mints the wrapped tokens into `transfer.to`. */
export const completeWrappedInstruction = (
  payer: string,
  vaa: ParsedVaa,
): Instruction => {
  const transfer = parseTokenTransfer(vaa.payload);
  const mint = wrappedMintAddress(transfer.tokenChain, transfer.tokenAddress);
  const to = encodeAddress(transfer.to);
  return {
    programId: WORMHOLE.solTokenBridge,
    keys: [
      meta(payer, true, true),
      meta(tokenBridgeConfigAddress(), false, false),
      meta(postedVaaAddress(vaa.hash), false, false),
      meta(claimAddress(vaa), false, true),
      meta(endpointAddress(vaa.emitterChain, vaa.emitterAddress), false, false),
      meta(to, false, true),
      meta(to, false, true),
      meta(mint, false, true),
      meta(wrappedMetaAddress(mint), false, false),
      meta(mintAuthorityAddress(), false, false),
      meta(SOLANA_PROGRAMS.sysvarRent, false, false),
      meta(PROGRAM_IDS.system, false, false),
      meta(PROGRAM_IDS.token, false, false),
      meta(WORMHOLE.solCore, false, false),
    ],
    data: Uint8Array.of(3),
  };
};

/**
 * The redeem instructions for a transfer to `owner`'s wrapped-ETH account:
 * create the account if missing, then complete the transfer. The VAA's
 * recipient must be exactly that account.
 */
export const redeemInstructions = (
  payer: string,
  owner: string,
  vaa: ParsedVaa,
): Instruction[] => {
  const transfer = parseTokenTransfer(vaa.payload);
  const mint = wrappedMintAddress(transfer.tokenChain, transfer.tokenAddress);
  const expected = associatedTokenAddress(owner, mint);
  if (encodeAddress(transfer.to) !== expected) {
    throw new Error('the transfer is not addressed to this wallet');
  }
  if (transfer.toChain !== WORMHOLE.solanaChainId) {
    throw new Error('the transfer is not for Solana');
  }
  return [
    createAssociatedTokenAccountIdempotent(payer, owner, mint),
    completeWrappedInstruction(payer, vaa),
  ];
};
