import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react-native';
import type { NFTItem } from '@rabby-wallet/rabby-api/dist/types';

import { NftMetadataSection } from './NftMetadataSection';
import { loadOnchainNftDetails } from '@/utils/onchainNftMedia';

jest.mock('@/components/Typography', () => ({
  Text: require('react-native').Text,
}));

jest.mock('@/utils/onchainNftMedia', () => ({
  loadOnchainNftDetails: jest.fn(),
  ONCHAIN_RETRY_DELAYS_MS: [],
}));

jest.mock('@/hooks/theme', () => ({
  useTheme2024: () => ({ styles: new Proxy({}, { get: () => ({}) }) }),
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) =>
      options.defaultValue,
  }),
}));

const NFT = {
  chain: 'eth',
  contract_id: '0xff9c1b15b16263c61d017ee9f65c50e4ae0113d7',
  inner_id: '7',
  is_erc721: true,
  description: 'Indexed description',
} as NFTItem;

describe('NftMetadataSection', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(cleanup);

  it('shows on-chain metadata, attributes and the raw JSON on demand', async () => {
    jest.mocked(loadOnchainNftDetails).mockResolvedValue({
      tokenUri: 'data:application/json,{}',
      metadata: {
        description: 'On-chain description',
        attributes: [{ trait: 'Rank', value: 'Unrated' }],
        raw: '{ "name": "Card" }',
      },
    });
    const view = render(<NftMetadataSection nft={NFT} />);

    expect(await view.findByText('On-chain')).toBeTruthy();
    expect(view.getByText('ERC-721')).toBeTruthy();
    expect(view.getByText('7')).toBeTruthy();
    expect(view.getByText('On-chain description')).toBeTruthy();
    expect(view.getByText('Rank')).toBeTruthy();
    expect(view.getByText('Unrated')).toBeTruthy();
    expect(view.queryByText('{ "name": "Card" }')).toBeNull();

    fireEvent.press(view.getByTestId('nft-metadata-raw-toggle'));
    expect(view.getByText('{ "name": "Card" }')).toBeTruthy();
  });

  it('shows a remote metadata URI as text without parsed metadata', async () => {
    jest.mocked(loadOnchainNftDetails).mockResolvedValue({
      tokenUri: 'ipfs://bafy/7.json',
      metadata: null,
    });
    const view = render(<NftMetadataSection nft={NFT} />);

    expect(await view.findByText('ipfs://bafy/7.json')).toBeTruthy();
    expect(view.getByText('Indexed description')).toBeTruthy();
    expect(view.queryByTestId('nft-metadata-raw-toggle')).toBeNull();
  });

  it('offers a retry when the chain cannot be reached', async () => {
    jest
      .mocked(loadOnchainNftDetails)
      .mockResolvedValueOnce({
        tokenUri: null,
        metadata: null,
        transient: true,
      })
      .mockResolvedValueOnce({
        tokenUri: 'data:application/json,{}',
        metadata: {},
      });
    const view = render(<NftMetadataSection nft={NFT} />);

    expect(await view.findByText('Could not reach the chain')).toBeTruthy();
    fireEvent.press(view.getByTestId('nft-metadata-retry'));

    expect(await view.findByText('On-chain')).toBeTruthy();
    expect(loadOnchainNftDetails).toHaveBeenCalledTimes(2);
  });

  it('does not query the chain for an NFT without a valid on-chain reference', async () => {
    const view = render(
      <NftMetadataSection nft={{ ...NFT, contract_id: 'not-an-address' }} />,
    );

    expect(await view.findByText('Not readable on-chain')).toBeTruthy();
    expect(loadOnchainNftDetails).not.toHaveBeenCalled();
  });
});
