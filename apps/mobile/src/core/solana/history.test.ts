import tx from './__fixtures__/devnet-redeem-tx.json';
import { transferFromTransaction } from './history';
import type { ParsedTransaction } from './rpc';

const OWNER = '3V8fYJRbxJiKtXoPMd9M6eQC2MRTDv9RHC867LaEm1m7';
const WETH = '6F5YWWrUMNpee8C6BDUc6DmRvYRMDDTgJHwKhbXuifWs';
const parsed = tx as unknown as ParsedTransaction;

describe('Solana history parsing (recorded devnet transaction)', () => {
  it('sees the minted wrapped ETH as a receive', () => {
    const item = transferFromTransaction(
      parsed,
      OWNER,
      { kind: 'token', mint: WETH },
      'sig',
    )!;
    expect(item.delta).toBe(1_000_000n);
    expect(item.failed).toBe(false);
  });

  it('reports SOL spent on rent, excluding the fee', () => {
    const item = transferFromTransaction(parsed, OWNER, { kind: 'sol' }, 'sig');
    // The token account rent left the wallet; the fee is not counted.
    expect(item && item.delta < 0n).toBe(true);
    const keys = parsed.transaction.message.accountKeys.map(k => k.pubkey);
    const i = keys.indexOf(OWNER);
    const raw =
      BigInt(parsed.meta!.postBalances[i]!) -
      BigInt(parsed.meta!.preBalances[i]!);
    expect(item!.delta).toBe(raw + BigInt(parsed.meta!.fee));
  });

  it('ignores other tokens', () => {
    expect(
      transferFromTransaction(
        parsed,
        OWNER,
        { kind: 'token', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        'sig',
      ),
    ).toBeNull();
  });
});
