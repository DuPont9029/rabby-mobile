import { Buffer } from 'buffer';

import vectors from './__fixtures__/reference-vectors.json';
import {
  decodeAddress,
  deriveEd25519PrivateKey,
  encodeAddress,
  findProgramAddress,
  isOnCurve,
  isValidAddress,
  publicKeyFromPrivateKey,
  signMessage,
  solanaPathForIndex,
  utf8,
  verifySignature,
} from './keys';

// Vectors generated with @solana/web3.js + ed25519-hd-key from the public
// BIP39 test mnemonic "abandon … about" (Phantom shows the same addresses).
describe('Solana key derivation', () => {
  it.each(vectors.derivation)(
    'derives $path (passphrase "$passphrase") like Phantom',
    ({ seedHex, path, privateKeyHex, address }) => {
      const privateKey = deriveEd25519PrivateKey(
        Uint8Array.from(Buffer.from(seedHex, 'hex')),
        path,
      );
      expect(Buffer.from(privateKey).toString('hex')).toBe(privateKeyHex);
      expect(encodeAddress(publicKeyFromPrivateKey(privateKey))).toBe(address);
    },
  );

  it('uses the Phantom-compatible path', () => {
    expect(solanaPathForIndex(0)).toBe("m/44'/501'/0'/0'");
    expect(solanaPathForIndex(7)).toBe("m/44'/501'/7'/0'");
    expect(() => solanaPathForIndex(-1)).toThrow();
    expect(() => solanaPathForIndex(1.5)).toThrow();
  });

  it('refuses non-hardened paths and bad seeds', () => {
    const seed = new Uint8Array(64);
    expect(() => deriveEd25519PrivateKey(seed, "m/44'/501'/0/0'")).toThrow();
    expect(() => deriveEd25519PrivateKey(seed, "44'/501'")).toThrow();
    expect(() => deriveEd25519PrivateKey(new Uint8Array(8), "m/0'")).toThrow();
  });

  it('signs and verifies', () => {
    const privateKey = deriveEd25519PrivateKey(
      Uint8Array.from(Buffer.from(vectors.derivation[0].seedHex, 'hex')),
      vectors.derivation[0].path,
    );
    const message = utf8('helios');
    const signature = signMessage(message, privateKey);
    const publicKey = publicKeyFromPrivateKey(privateKey);
    expect(verifySignature(signature, message, publicKey)).toBe(true);
    expect(verifySignature(signature, utf8('other'), publicKey)).toBe(false);
  });
});

describe('Solana addresses', () => {
  it('validates base58 32-byte addresses only', () => {
    expect(isValidAddress(vectors.derivation[0].address)).toBe(true);
    for (const bad of [
      '',
      '0xabc',
      '1111',
      'O0Il',
      `${vectors.derivation[0].address}1`,
    ]) {
      expect(isValidAddress(bad)).toBe(false);
    }
    expect(() => decodeAddress('not-base58!')).toThrow();
  });

  it('tells wallet keys (on curve) from PDAs (off curve)', () => {
    expect(isOnCurve(decodeAddress(vectors.derivation[0].address))).toBe(true);
    expect(isOnCurve(decodeAddress(vectors.pda.metadata))).toBe(false);
  });

  it('finds program addresses like web3.js', () => {
    const [address, bump] = findProgramAddress(
      [
        utf8('metadata'),
        decodeAddress('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
        decodeAddress(vectors.pda.mint),
      ],
      decodeAddress('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'),
    );
    expect(encodeAddress(address)).toBe(vectors.pda.metadata);
    expect(bump).toBe(vectors.pda.metadataBump);
  });
});
