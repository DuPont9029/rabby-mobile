import type { SolanaNft } from '@/core/solana/portfolio';

/** Navigation-safe description of what to send (no BigInt in params). */
export type SolanaSendAsset =
  | { kind: 'sol'; balance: string }
  | {
      kind: 'token';
      mint: string;
      decimals: number;
      tokenProgram: string;
      symbol?: string;
      name?: string;
      balance: string;
    }
  | {
      kind: 'nft';
      mint: string;
      tokenProgram: string;
      programmable: boolean;
      ruleSet: string | null;
      name: string;
    };

export type SolanaScreenParams = {
  SolanaHome: { evmAddress?: string } | undefined;
  SolanaSend: { evmAddress: string; asset: SolanaSendAsset };
  SolanaNftDetail: { evmAddress: string; nft: SolanaNft };
};
