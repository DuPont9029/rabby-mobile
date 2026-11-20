import { Buffer } from 'buffer';

import {
  inlineImageToSvg,
  inlineSvgFromMetadata,
  mayBeInlineImage,
  parseInlineTokenUri,
  toOnchainNftRef,
} from './onchainNftMediaCore';

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

describe('inlineImageToSvg', () => {
  it('decodes base64 and percent-encoded SVG data URLs', () => {
    expect(inlineImageToSvg(`data:image/svg+xml;base64,${base64(SVG)}`)).toBe(
      SVG,
    );
    expect(
      inlineImageToSvg(`data:image/svg+xml;utf8,${encodeURIComponent(SVG)}`),
    ).toBe(SVG);
    expect(inlineImageToSvg(`data:image/svg+xml,${SVG}`)).toBe(SVG);
  });

  it('passes raw SVG markup through', () => {
    expect(inlineImageToSvg(`  ${SVG}`)).toBe(`  ${SVG}`);
  });

  it('wraps raster data URLs in an SVG for the native checks', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const wrapped = inlineImageToSvg(png);
    expect(wrapped).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(wrapped).toContain(`href="${png}"`);
  });

  it('escapes the wrapped href so it cannot break out of the attribute', () => {
    const wrapped = inlineImageToSvg('data:image/png,"/><script>x</script>');
    expect(wrapped).not.toContain('<script>');
    expect(wrapped).toContain('&quot;/&gt;&lt;script&gt;');
  });

  it('never returns markup for remote or non-image values', () => {
    for (const value of [
      'https://example.com/a.svg',
      'ipfs://bafy/a.png',
      'ar://abc',
      'data:text/html,<script>alert(1)</script>',
      'data:image/svg+xml;base64,' + base64('<html></html>'),
      'data:image/bmp;base64,Qk0=',
      '',
      undefined,
      42,
    ]) {
      expect(inlineImageToSvg(value)).toBeNull();
    }
  });

  it('rejects oversized SVG payloads', () => {
    const huge = `<svg>${'a'.repeat(5 * 1024 * 1024)}</svg>`;
    expect(
      inlineImageToSvg(`data:image/svg+xml;base64,${base64(huge)}`),
    ).toBeNull();
  });
});

describe('parseInlineTokenUri', () => {
  const metadata = {
    name: 'Bag #1',
    description: 'On-chain',
    image: `data:image/svg+xml;base64,${base64(SVG)}`,
  };

  it('parses base64, percent-encoded and raw JSON data URLs', () => {
    for (const uri of [
      `data:application/json;base64,${base64(JSON.stringify(metadata))}`,
      `data:application/json;utf8,${encodeURIComponent(
        JSON.stringify(metadata),
      )}`,
      `data:application/json,${JSON.stringify(metadata)}`,
    ]) {
      expect(parseInlineTokenUri(uri)).toMatchObject(metadata);
    }
  });

  it('does not touch remote token URIs or malformed JSON', () => {
    expect(parseInlineTokenUri('https://example.com/1.json')).toBeNull();
    expect(parseInlineTokenUri('ipfs://bafy/1')).toBeNull();
    expect(parseInlineTokenUri('data:application/json,{not json')).toBeNull();
    expect(parseInlineTokenUri('data:application/json,[1,2]')).toBeNull();
    expect(parseInlineTokenUri(null)).toBeNull();
  });
});

describe('inlineSvgFromMetadata', () => {
  it('prefers image, then image_data, and never executes HTML animations', () => {
    expect(inlineSvgFromMetadata({ image_data: SVG })).toBe(SVG);
    expect(
      inlineSvgFromMetadata({
        image: 'https://example.com/a.png',
        animation_url: 'data:text/html,<script>run()</script>',
      }),
    ).toBeNull();
    expect(inlineSvgFromMetadata(null)).toBeNull();
  });
});

describe('mayBeInlineImage', () => {
  it('only flags inline image values', () => {
    expect(mayBeInlineImage('data:image/png;base64,AA')).toBe(true);
    expect(mayBeInlineImage(SVG)).toBe(true);
    expect(mayBeInlineImage('https://static.debank.com/a.svg')).toBe(false);
    expect(mayBeInlineImage(undefined)).toBe(false);
  });
});

describe('toOnchainNftRef', () => {
  it('requires a chain, a contract address and a decimal token id', () => {
    const contract = '0xff9c1b15b16263c61d017ee9f65c50e4ae0113d7';
    expect(
      toOnchainNftRef({ chain: 'eth', contract_id: contract, inner_id: '1' }),
    ).toEqual({
      chain: 'eth',
      contractId: contract,
      tokenId: '1',
    });
    expect(
      toOnchainNftRef({ chain: 'eth', contract_id: contract, inner_id: 7 })
        ?.tokenId,
    ).toBe('7');
    expect(
      toOnchainNftRef({ chain: 'eth', contract_id: 'nope', inner_id: '1' }),
    ).toBeUndefined();
    expect(
      toOnchainNftRef({ chain: 'eth', contract_id: contract, inner_id: '0x1' }),
    ).toBeUndefined();
    expect(toOnchainNftRef(undefined)).toBeUndefined();
  });
});

describe('on-chain metadata details', () => {
  it('reads attributes and a display copy of the raw JSON', () => {
    const image = `data:image/svg+xml;base64,${base64(SVG.repeat(10))}`;
    const parsed = parseInlineTokenUri(
      `data:application/json;base64,${base64(
        JSON.stringify({
          name: 'Card',
          external_url: 'https://example.com/card',
          image,
          attributes: [
            { trait_type: 'Rank', value: 'Unrated' },
            { trait_type: 'Duels', value: 0 },
            { value: true },
            { trait_type: 'Ignored', value: { nested: 1 } },
            'not-an-object',
          ],
        }),
      )}`,
    );

    expect(parsed?.externalUrl).toBe('https://example.com/card');
    expect(parsed?.attributes).toEqual([
      { trait: 'Rank', value: 'Unrated' },
      { trait: 'Duels', value: '0' },
      { trait: '', value: 'true' },
    ]);
    expect(parsed?.raw).toContain('"name": "Card"');
    // Long values such as embedded images are shortened for display.
    expect(parsed?.raw).not.toContain(image);
    expect(parsed?.raw).toContain(`(${image.length} chars)`);
  });

  it('accepts `traits` as an alias of `attributes`', () => {
    const parsed = parseInlineTokenUri(
      `data:application/json,${JSON.stringify({
        traits: [{ trait_type: 'Deck', value: 'Blue' }],
      })}`,
    );
    expect(parsed?.attributes).toEqual([{ trait: 'Deck', value: 'Blue' }]);
  });
});
