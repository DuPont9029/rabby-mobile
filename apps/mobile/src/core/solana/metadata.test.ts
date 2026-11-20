import { Buffer } from 'buffer';

import accounts from './__fixtures__/metadata-accounts.json';
import { decodeTokenMetadata, isProgrammable, TokenStandard } from './metadata';

const data = (base64: string) => Uint8Array.from(Buffer.from(base64, 'base64'));

// Real mainnet Token Metadata accounts (decoded identically by
// @metaplex-foundation/mpl-token-metadata).
describe('decodeTokenMetadata', () => {
  it('reads a programmable NFT with a rule set (Mad Lads collection)', () => {
    const metadata = decodeTokenMetadata(data(accounts.madLads));
    expect(metadata.mint).toBe('J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w');
    expect(metadata.name).toBe('Mad Lads');
    expect(metadata.symbol).toBe('MAD');
    expect(metadata.tokenStandard).toBe(TokenStandard.ProgrammableNonFungible);
    expect(isProgrammable(metadata)).toBe(true);
    expect(metadata.ruleSet).toBe(
      'eBJLFYPxJmMGKuFwpDWkzxZeUrad92kZRC5BJLpzyT9',
    );
    expect(metadata.uri).toMatch(/^https?:\/\//);
  });

  it('reads an older account without the newer optional fields (USDC)', () => {
    const metadata = decodeTokenMetadata(data(accounts.usdc));
    expect(metadata.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(metadata.name).toBe('USD Coin');
    expect(metadata.symbol).toBe('USDC');
    expect(metadata.tokenStandard).toBeNull();
    expect(isProgrammable(metadata)).toBe(false);
  });

  it('rejects other account types and truncated data', () => {
    expect(() => decodeTokenMetadata(Uint8Array.of(1, 2, 3))).toThrow();
    expect(() =>
      decodeTokenMetadata(data(accounts.madLads).slice(0, 40)),
    ).toThrow();
  });
});
