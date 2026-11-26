/**
 * Small Solana JSON-RPC client. Every request has a timeout so a hung
 * endpoint can never block the UI forever. Pure module: the endpoint is
 * passed in by the caller.
 */
import { Buffer } from 'buffer';

import { PROGRAM_IDS } from './tx';

export const DEFAULT_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
export const RPC_TIMEOUT_MS = 20_000;
const RATE_LIMIT_RETRY_DELAYS_MS = [1_000, 3_000];

export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'SolanaRpcError';
  }
}

/** Only https endpoints (http only for local development hosts). */
export const isValidRpcUrl = (value: string) => {
  try {
    const url = new URL(value.trim());
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '10.0.2.2'].includes(url.hostname))
    );
  } catch {
    return false;
  }
};

let requestId = 0;

export const createSolanaRpc = (
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
) => {
  if (!isValidRpcUrl(endpoint)) {
    throw new Error('invalid Solana RPC URL');
  }

  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    // Public endpoints rate-limit aggressively (HTTP 429): back off and retry.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await callOnce<T>(method, params);
      } catch (error) {
        const delay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
        if (
          !(error instanceof SolanaRpcError) ||
          error.code !== 429 ||
          delay === undefined
        ) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  };

  const callOnce = async <T>(method: string, params: unknown[]): Promise<T> => {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new SolanaRpcError(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++requestId,
            method,
            params,
          }),
          signal: controller?.signal,
        }),
        timeout,
      ]);
      if (!response.ok) {
        throw new SolanaRpcError(
          `${method} failed: HTTP ${response.status}`,
          response.status,
        );
      }
      const body = (await Promise.race([response.json(), timeout])) as {
        result?: T;
        error?: { message?: string; code?: number; data?: unknown };
      };
      if (body.error) {
        throw new SolanaRpcError(
          body.error.message || `${method} failed`,
          body.error.code,
          body.error.data,
        );
      }
      return body.result as T;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  const getBalance = async (address: string) => {
    const result = await call<{ value: number }>('getBalance', [
      address,
      { commitment: 'confirmed' },
    ]);
    return BigInt(result.value);
  };

  type ParsedTokenAccount = {
    pubkey: string;
    account: {
      data: {
        parsed: {
          info: {
            mint: string;
            tokenAmount: { amount: string; decimals: number };
            state?: string;
          };
        };
      };
    };
  };

  /** Token accounts of `owner` for both SPL Token and Token-2022. */
  const getTokenAccounts = async (owner: string) => {
    const programs = [PROGRAM_IDS.token, PROGRAM_IDS.token2022];
    // Some endpoints refuse one of the two programs (e.g. Token-2022): show
    // what the other returns instead of failing the whole list.
    const settled = await Promise.allSettled(
      programs.map(programId =>
        call<{ value: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [
          owner,
          { programId },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        ]).then(result => ({ programId, accounts: result.value })),
      ),
    );
    const results = settled.flatMap(outcome =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    );
    if (!results.length) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return results.flatMap(({ programId, accounts }) =>
      accounts.map(({ pubkey, account }) => {
        const info = account.data.parsed.info;
        return {
          address: pubkey,
          mint: info.mint,
          amount: BigInt(info.tokenAmount.amount),
          decimals: info.tokenAmount.decimals,
          frozen: info.state === 'frozen',
          tokenProgram: programId,
        };
      }),
    );
  };

  /** Raw account data (base64-decoded), `null` for missing accounts. */
  const getMultipleAccounts = async (addresses: string[]) => {
    const out: Array<{ owner: string; data: Uint8Array } | null> = [];
    for (let index = 0; index < addresses.length; index += 100) {
      const chunk = addresses.slice(index, index + 100);
      const result = await call<{
        value: Array<{ owner: string; data: [string, string] } | null>;
      }>('getMultipleAccounts', [
        chunk,
        { encoding: 'base64', commitment: 'confirmed' },
      ]);
      for (const account of result.value) {
        out.push(
          account
            ? {
                owner: account.owner,
                data: Uint8Array.from(Buffer.from(account.data[0], 'base64')),
              }
            : null,
        );
      }
    }
    return out;
  };

  const getAccountInfo = async (address: string) => {
    const result = await call<{
      value: { owner: string; executable: boolean; lamports: number } | null;
    }>('getAccountInfo', [
      address,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        dataSlice: { offset: 0, length: 0 },
      },
    ]);
    return result.value;
  };

  const getLatestBlockhash = async () => {
    const result = await call<{
      value: { blockhash: string; lastValidBlockHeight: number };
    }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return result.value;
  };

  const getMinimumBalanceForRentExemption = async (size: number) =>
    BigInt(
      await call<number>('getMinimumBalanceForRentExemption', [
        size,
        { commitment: 'confirmed' },
      ]),
    );

  /** Median recent priority fee (micro-lamports per CU) for `accounts`. */
  const getPriorityFee = async (accounts: string[]) => {
    const fees = await call<Array<{ prioritizationFee: number }>>(
      'getRecentPrioritizationFees',
      [accounts.slice(0, 128)],
    );
    const values = fees
      .map(fee => fee.prioritizationFee)
      .filter(fee => Number.isFinite(fee))
      .sort((a, b) => a - b);
    return BigInt(values[Math.floor(values.length / 2)] ?? 0);
  };

  /**
   * Simulates without signatures (the wallet has not signed yet) and returns
   * the post-transaction lamports of `watch` accounts.
   */
  const simulate = async (transaction: Uint8Array, watch: string[]) => {
    const result = await call<{
      value: {
        err: unknown;
        logs: string[] | null;
        unitsConsumed?: number;
        accounts?: Array<{ lamports: number } | null> | null;
      };
    }>('simulateTransaction', [
      Buffer.from(transaction).toString('base64'),
      {
        encoding: 'base64',
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: watch },
      },
    ]);
    return {
      err: result.value.err,
      logs: result.value.logs || [],
      unitsConsumed: result.value.unitsConsumed,
      postLamports: (result.value.accounts || []).map(account =>
        account ? BigInt(account.lamports) : null,
      ),
    };
  };

  const sendTransaction = (transaction: Uint8Array) =>
    call<string>('sendTransaction', [
      Buffer.from(transaction).toString('base64'),
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 5,
      },
    ]);

  const getSignatureStatus = async (signature: string) => {
    const result = await call<{
      value: Array<{
        err: unknown;
        confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
      } | null>;
    }>('getSignatureStatuses', [
      [signature],
      { searchTransactionHistory: false },
    ]);
    return result.value[0];
  };

  const getBlockHeight = () =>
    call<number>('getBlockHeight', [{ commitment: 'confirmed' }]);

  /** Raw account data (base64-decoded), or `null` if the account is missing. */
  const getAccountData = async (address: string) => {
    const result = await call<{
      value: { data: [string, string]; owner: string } | null;
    }>('getAccountInfo', [
      address,
      { encoding: 'base64', commitment: 'confirmed' },
    ]);
    return result.value
      ? {
          owner: result.value.owner,
          data: Uint8Array.from(Buffer.from(result.value.data[0], 'base64')),
        }
      : null;
  };

  /** Most recent transaction signatures that touched `address`. */
  const getSignaturesForAddress = (address: string, limit = 20) =>
    call<
      Array<{
        signature: string;
        blockTime: number | null;
        err: unknown;
      }>
    >('getSignaturesForAddress', [
      address,
      { limit: Math.min(Math.max(limit, 1), 100), commitment: 'confirmed' },
    ]);

  /**
   * Highest transaction version this endpoint accepts: 1 (same jsonParsed
   * shape as v0); lowered to 0 once if an older endpoint rejects it.
   */
  let maxTransactionVersion = 1;

  /** A transaction with parsed balances (null while unknown). */
  const getParsedTransaction = async (
    signature: string,
  ): Promise<ParsedTransaction | null> => {
    const fetchWith = (version: number) =>
      call<ParsedTransaction | null>('getTransaction', [
        signature,
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          maxSupportedTransactionVersion: version,
        },
      ]);
    try {
      return await fetchWith(maxTransactionVersion);
    } catch (error) {
      if (
        maxTransactionVersion > 0 &&
        error instanceof SolanaRpcError &&
        /maxSupportedTransactionVersion|transaction version/i.test(
          error.message,
        ) &&
        !/not supported by the requesting client/i.test(error.message)
      ) {
        maxTransactionVersion = 0;
        return fetchWith(0);
      }
      throw error;
    }
  };

  return {
    endpoint,
    call,
    getAccountData,
    getSignaturesForAddress,
    getParsedTransaction,
    getBalance,
    getTokenAccounts,
    getMultipleAccounts,
    getAccountInfo,
    getLatestBlockhash,
    getMinimumBalanceForRentExemption,
    getPriorityFee,
    simulate,
    sendTransaction,
    getSignatureStatus,
    getBlockHeight,
  };
};

export type ParsedTokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
};

export type ParsedTransaction = {
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: ParsedTokenBalance[];
    postTokenBalances?: ParsedTokenBalance[];
  } | null;
  transaction: {
    message: {
      accountKeys: Array<{
        pubkey: string;
        signer: boolean;
        writable: boolean;
      }>;
    };
  };
};

export type SolanaRpc = ReturnType<typeof createSolanaRpc>;
