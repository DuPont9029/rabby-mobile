/**
 * Minimal Solana legacy-transaction builder for the transfers Helios Wallet
 * creates itself (SOL, SPL tokens, NFTs). No arbitrary/dApp transactions.
 *
 * Pure module (no app imports); serialization is checked against
 * @solana/web3.js decoding in tests.
 */
import {
  decodeAddress,
  encodeAddress,
  findProgramAddress,
  signMessage,
  utf8,
} from './keys';

export const PROGRAM_IDS = {
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  associatedToken: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  tokenMetadata: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  tokenAuthRules: 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg',
  sysvarInstructions: 'Sysvar1nstructions1111111111111111111111111',
} as const;

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export type AccountMeta = {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
};

export type Instruction = {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
};

const u64Le = (value: bigint) => {
  if (value < 0n || value > 0xffffffffffffffffn) {
    throw new Error('u64 out of range');
  }
  // Plain BigInt arithmetic (no DataView#setBigUint64, for older engines).
  const out = new Uint8Array(8);
  let rest = value;
  for (let index = 0; index < 8; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};

const u32Le = (value: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
};

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

/** Solana "compact-u16" (ShortVec) length prefix. */
const shortVec = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error('compact-u16 out of range');
  }
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>= 7;
    if (rest) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (rest);
  return Uint8Array.from(out);
};

const meta = (
  pubkey: string,
  isSigner: boolean,
  isWritable: boolean,
): AccountMeta => ({ pubkey, isSigner, isWritable });

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const associatedTokenAddress = (
  owner: string,
  mint: string,
  tokenProgram: string = PROGRAM_IDS.token,
) =>
  encodeAddress(
    findProgramAddress(
      [decodeAddress(owner), decodeAddress(tokenProgram), decodeAddress(mint)],
      decodeAddress(PROGRAM_IDS.associatedToken),
    )[0],
  );

const metadataSeeds = (mint: string) => [
  utf8('metadata'),
  decodeAddress(PROGRAM_IDS.tokenMetadata),
  decodeAddress(mint),
];

const tokenMetadataPda = (seeds: Uint8Array[]) =>
  encodeAddress(
    findProgramAddress(seeds, decodeAddress(PROGRAM_IDS.tokenMetadata))[0],
  );

export const metadataAddress = (mint: string) =>
  tokenMetadataPda(metadataSeeds(mint));

export const masterEditionAddress = (mint: string) =>
  tokenMetadataPda([...metadataSeeds(mint), utf8('edition')]);

export const tokenRecordAddress = (mint: string, tokenAccount: string) =>
  tokenMetadataPda([
    ...metadataSeeds(mint),
    utf8('token_record'),
    decodeAddress(tokenAccount),
  ]);

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

export const systemTransfer = (
  from: string,
  to: string,
  lamports: bigint,
): Instruction => ({
  programId: PROGRAM_IDS.system,
  keys: [meta(from, true, true), meta(to, false, true)],
  data: concat(u32Le(2), u64Le(lamports)),
});

export const setComputeUnitLimit = (units: number): Instruction => ({
  programId: PROGRAM_IDS.computeBudget,
  keys: [],
  data: concat(Uint8Array.of(2), u32Le(units)),
});

export const setComputeUnitPrice = (microLamports: bigint): Instruction => ({
  programId: PROGRAM_IDS.computeBudget,
  keys: [],
  data: concat(Uint8Array.of(3), u64Le(microLamports)),
});

/** Creates `owner`'s associated token account for `mint` if it is missing. */
export const createAssociatedTokenAccountIdempotent = (
  payer: string,
  owner: string,
  mint: string,
  tokenProgram: string = PROGRAM_IDS.token,
): Instruction => ({
  programId: PROGRAM_IDS.associatedToken,
  keys: [
    meta(payer, true, true),
    meta(associatedTokenAddress(owner, mint, tokenProgram), false, true),
    meta(owner, false, false),
    meta(mint, false, false),
    meta(PROGRAM_IDS.system, false, false),
    meta(tokenProgram, false, false),
  ],
  data: Uint8Array.of(1),
});

/** SPL Token / Token-2022 `TransferChecked`. */
export const tokenTransferChecked = ({
  source,
  mint,
  destination,
  owner,
  amount,
  decimals,
  tokenProgram = PROGRAM_IDS.token,
}: {
  source: string;
  mint: string;
  destination: string;
  owner: string;
  amount: bigint;
  decimals: number;
  tokenProgram?: string;
}): Instruction => {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('invalid token decimals');
  }
  return {
    programId: tokenProgram,
    keys: [
      meta(source, false, true),
      meta(mint, false, false),
      meta(destination, false, true),
      meta(owner, true, false),
    ],
    data: concat(Uint8Array.of(12), u64Le(amount), Uint8Array.of(decimals)),
  };
};

/**
 * Token Metadata `Transfer` (V1) for programmable NFTs, which cannot be moved
 * with a plain token transfer. Optional accounts that do not apply are set to
 * the Token Metadata program id, as the program expects.
 */
export const programmableNftTransfer = ({
  owner,
  destinationOwner,
  mint,
  ruleSet,
  tokenProgram = PROGRAM_IDS.token,
}: {
  owner: string;
  destinationOwner: string;
  mint: string;
  ruleSet?: string | null;
  tokenProgram?: string;
}): Instruction => {
  const source = associatedTokenAddress(owner, mint, tokenProgram);
  const destination = associatedTokenAddress(
    destinationOwner,
    mint,
    tokenProgram,
  );
  const none = PROGRAM_IDS.tokenMetadata;
  return {
    programId: PROGRAM_IDS.tokenMetadata,
    keys: [
      meta(source, false, true),
      meta(owner, false, false),
      meta(destination, false, true),
      meta(destinationOwner, false, false),
      meta(mint, false, false),
      meta(metadataAddress(mint), false, true),
      meta(masterEditionAddress(mint), false, false),
      meta(tokenRecordAddress(mint, source), false, true),
      meta(tokenRecordAddress(mint, destination), false, true),
      meta(owner, true, false),
      meta(owner, true, true),
      meta(PROGRAM_IDS.system, false, false),
      meta(PROGRAM_IDS.sysvarInstructions, false, false),
      meta(tokenProgram, false, false),
      meta(PROGRAM_IDS.associatedToken, false, false),
      meta(ruleSet ? PROGRAM_IDS.tokenAuthRules : none, false, false),
      meta(ruleSet || none, false, false),
    ],
    // Transfer = 49, TransferArgs::V1 = 0, amount = 1, authorization_data = None
    data: concat(Uint8Array.of(49, 0), u64Le(1n), Uint8Array.of(0)),
  };
};

// ---------------------------------------------------------------------------
// Message / transaction
// ---------------------------------------------------------------------------

const compareKeys = (a: string, b: string) => {
  const left = decodeAddress(a);
  const right = decodeAddress(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
};

export type CompiledMessage = {
  bytes: Uint8Array;
  accountKeys: string[];
  numRequiredSignatures: number;
};

/**
 * Compiles a legacy message. Accounts are merged (signer/writable flags
 * OR-ed), ordered signer+writable, signer, writable, read-only, with the fee
 * payer first; ties are ordered by key bytes so the result never depends on
 * the device locale.
 */
export const compileMessage = ({
  feePayer,
  recentBlockhash,
  instructions,
}: {
  feePayer: string;
  recentBlockhash: string;
  instructions: Instruction[];
}): CompiledMessage => {
  if (!instructions.length) {
    throw new Error('a transaction needs at least one instruction');
  }
  const metas = new Map<string, AccountMeta>();
  const add = (account: AccountMeta) => {
    decodeAddress(account.pubkey);
    const existing = metas.get(account.pubkey);
    metas.set(
      account.pubkey,
      existing
        ? {
            pubkey: account.pubkey,
            isSigner: existing.isSigner || account.isSigner,
            isWritable: existing.isWritable || account.isWritable,
          }
        : { ...account },
    );
  };
  for (const instruction of instructions) {
    instruction.keys.forEach(add);
    add(meta(instruction.programId, false, false));
  }
  metas.delete(feePayer);
  const rank = (account: AccountMeta) =>
    account.isSigner
      ? account.isWritable
        ? 0
        : 1
      : account.isWritable
      ? 2
      : 3;
  const ordered = [
    meta(feePayer, true, true),
    ...[...metas.values()].sort(
      (a, b) => rank(a) - rank(b) || compareKeys(a.pubkey, b.pubkey),
    ),
  ];
  if (ordered.length > 256) {
    throw new Error('too many accounts');
  }
  const numRequiredSignatures = ordered.filter(a => a.isSigner).length;
  const numReadonlySigned = ordered.filter(
    a => a.isSigner && !a.isWritable,
  ).length;
  const numReadonlyUnsigned = ordered.filter(
    a => !a.isSigner && !a.isWritable,
  ).length;
  const indexOf = new Map(
    ordered.map((account, index) => [account.pubkey, index]),
  );

  const compiledInstructions = instructions.map(instruction =>
    concat(
      Uint8Array.of(indexOf.get(instruction.programId)!),
      shortVec(instruction.keys.length),
      Uint8Array.from(instruction.keys.map(key => indexOf.get(key.pubkey)!)),
      shortVec(instruction.data.length),
      instruction.data,
    ),
  );
  const accountKeys = ordered.map(account => account.pubkey);
  const bytes = concat(
    Uint8Array.of(
      numRequiredSignatures,
      numReadonlySigned,
      numReadonlyUnsigned,
    ),
    shortVec(accountKeys.length),
    ...accountKeys.map(decodeAddress),
    decodeAddress(recentBlockhash),
    shortVec(compiledInstructions.length),
    ...compiledInstructions,
  );
  return { bytes, accountKeys, numRequiredSignatures };
};

/** Max legacy transaction size on the wire. */
export const PACKET_DATA_SIZE = 1232;

/**
 * Signs a compiled message with the single signer it requires (the fee
 * payer) and returns the wire-format transaction.
 */
export const signTransaction = (
  message: CompiledMessage,
  signerAddress: string,
  privateKey: Uint8Array,
): Uint8Array => {
  if (
    message.numRequiredSignatures !== 1 ||
    message.accountKeys[0] !== signerAddress
  ) {
    throw new Error(
      'only single-signer transactions from this wallet are supported',
    );
  }
  const signature = signMessage(message.bytes, privateKey);
  const wire = concat(shortVec(1), signature, message.bytes);
  if (wire.length > PACKET_DATA_SIZE) {
    throw new Error('transaction too large');
  }
  return wire;
};

/** Wire format with an empty signature, for `simulateTransaction`. */
export const unsignedTransaction = (message: CompiledMessage) =>
  concat(
    shortVec(message.numRequiredSignatures),
    new Uint8Array(64 * message.numRequiredSignatures),
    message.bytes,
  );
