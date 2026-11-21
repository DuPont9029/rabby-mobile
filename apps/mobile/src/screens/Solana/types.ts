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
      /** Token account shown in the list (the one debited). */
      sourceAccount: string;
    }
  | {
      kind: 'nft';
      mint: string;
      tokenProgram: string;
      programmable: boolean;
      ruleSet: string | null;
      name: string;
      /** Token account holding the NFT. */
      sourceAccount: string;
    };

export type SolanaScreenParams = {
  SolanaHome: { evmAddress?: string } | undefined;
  SolanaSend: { evmAddress: string; asset: SolanaSendAsset };
  WormholeBridge: { evmAddress: string };
  SolanaNftDetail: { evmAddress: string; nft: SolanaNft };
};
