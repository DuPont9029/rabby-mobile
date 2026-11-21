import React from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import RNFS, { type SafeSvgResult } from '@rabby-wallet/react-native-fs';

import { Media } from './Media';
import { loadOnchainNftArtwork } from '@/utils/onchainNftMedia';

jest.mock('@rabby-wallet/react-native-fs', () => ({
  __esModule: true,
  default: {
    isSafeSvgRasterizationAvailable: jest.fn(() => true),
    isSafeSvgDataRasterizationAvailable: jest.fn(() => true),
    resolveSvg: jest.fn(),
    resolveSvgData: jest.fn(),
  },
}));

jest.mock('@/utils/nftRefresh', () => ({
  getNftRefreshMs: () => 20_000,
  useOnchainNftRefreshTick: () => 0,
}));
jest.mock('@/utils/onchainNftMedia', () => ({
  loadOnchainNftArtwork: jest.fn(),
  ONCHAIN_RETRY_DELAYS_MS: [2_000, 6_000, 15_000],
}));

jest.mock('react-native-fast-image', () => {
  const mockReact = require('react');
  const { View: MockView } = require('react-native');
  return {
    __esModule: true,
    default: (props: any) =>
      mockReact.createElement(MockView, { testID: 'media-image', ...props }),
  };
});

jest.mock('react-native-video', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@rneui/themed', () => {
  const mockReact = require('react');
  const { View: MockView } = require('react-native');
  return {
    Skeleton: (props: any) =>
      mockReact.createElement(MockView, { testID: 'media-skeleton', ...props }),
  };
});

jest.mock('@/hooks/theme', () => ({
  useThemeColors: () => ({ 'neutral-bg-1': '#fff' }),
}));

jest.mock('@/assets/icons/nft', () => ({ IconPlay: () => null }));

jest.mock('./CustomTouchableOpacity', () => ({
  CustomTouchableOpacity: require('react-native').TouchableOpacity,
}));

const SVG_URL = 'https://static.debank.com/image/nft/logo.svg';
const SECOND_SVG_URL = 'https://static.debank.com/image/nft/second.svg';
const PNG_URI = 'file:///safe-media/logo.png';
const FAILED_PLACEHOLDER = <View testID="failed-placeholder" />;
const STATIC_PLACEHOLDER = <View testID="static-placeholder" />;

const deferredResult = () => {
  let resolve!: (result: SafeSvgResult) => void;
  const promise = new Promise<SafeSvgResult>(onResolve => {
    resolve = onResolve;
  });
  return { promise, resolve };
};

const readyResult = (uri = PNG_URI): SafeSvgResult => ({
  status: 'ready',
  uri,
  width: 64,
  height: 64,
  cacheHit: false,
});

describe('Media SVG loading presentation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(RNFS.isSafeSvgRasterizationAvailable).mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('uses the opted-in static placeholder instead of a pulsing skeleton while pending', () => {
    const pending = deferredResult();
    jest.mocked(RNFS.resolveSvg).mockReturnValue(pending.promise);
    const view = render(
      <Media
        src={SVG_URL}
        loadingPlaceholder={STATIC_PLACEHOLDER}
        failedPlaceholder={STATIC_PLACEHOLDER}
      />,
    );

    expect(view.getByTestId('static-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    expect(view.queryByTestId('media-image')).toBeNull();
    const loadingOverlay = view
      .UNSAFE_getAllByType(View)
      .find(node => node.props.pointerEvents === 'none');
    expect(loadingOverlay).toBeDefined();
    expect(StyleSheet.flatten(loadingOverlay?.props.style)).toEqual(
      expect.objectContaining({
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      }),
    );
    expect(RNFS.resolveSvg).toHaveBeenCalledWith({
      url: SVG_URL,
      variant: 'thumbnail',
    });

    act(() => jest.advanceTimersByTime(1500));

    expect(view.getByTestId('static-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
  });

  it('keeps the same static fallback when SVG conversion fails', async () => {
    const pending = deferredResult();
    const handleError = jest.fn();
    jest.mocked(RNFS.resolveSvg).mockReturnValue(pending.promise);
    const view = render(
      <Media
        src={SVG_URL}
        loadingPlaceholder={STATIC_PLACEHOLDER}
        failedPlaceholder={STATIC_PLACEHOLDER}
        handleError={handleError}
      />,
    );

    await act(async () => {
      pending.resolve({ status: 'failed', reason: 'invalid_svg' });
      await pending.promise;
    });

    expect(view.getByTestId('static-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    expect(view.queryByTestId('media-image')).toBeNull();
    expect(handleError).toHaveBeenCalledTimes(1);
  });

  it('renders the converted PNG and removes the static loading placeholder after image load', async () => {
    const pending = deferredResult();
    const handleSuccess = jest.fn();
    jest.mocked(RNFS.resolveSvg).mockReturnValue(pending.promise);
    const view = render(
      <Media
        src={SVG_URL}
        loadingPlaceholder={STATIC_PLACEHOLDER}
        failedPlaceholder={FAILED_PLACEHOLDER}
        handleSuccess={handleSuccess}
      />,
    );

    await act(async () => {
      pending.resolve(readyResult());
      await pending.promise;
    });

    const image = view.getByTestId('media-image');
    expect(image.props.source).toEqual({ uri: PNG_URI });
    expect(view.getByTestId('static-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    fireEvent(image, 'load');

    expect(view.queryByTestId('static-placeholder')).toBeNull();
    expect(view.queryByTestId('failed-placeholder')).toBeNull();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    expect(handleSuccess).toHaveBeenCalledTimes(1);
  });

  it('preserves the default pulse and 1500ms loading timeout for non-opted-in SVG media', () => {
    const pending = deferredResult();
    jest.mocked(RNFS.resolveSvg).mockReturnValue(pending.promise);
    const view = render(
      <Media src={SVG_URL} failedPlaceholder={FAILED_PLACEHOLDER} />,
    );

    expect(view.getByTestId('media-skeleton').props.animation).toBe('pulse');
    expect(view.queryByTestId('failed-placeholder')).toBeNull();
    act(() => jest.advanceTimersByTime(1499));
    expect(view.getByTestId('media-skeleton')).toBeTruthy();
    act(() => jest.advanceTimersByTime(1));
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    expect(view.getByTestId('failed-placeholder')).toBeTruthy();
  });

  it('leaves ordinary raster images on the direct image path', () => {
    const uri = 'https://static.debank.com/image/nft/logo.png';
    const view = render(
      <Media
        src={uri}
        loadingPlaceholder={STATIC_PLACEHOLDER}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    expect(view.getByTestId('media-image').props.source).toEqual({ uri });
    expect(view.queryByTestId('static-placeholder')).toBeNull();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    expect(RNFS.resolveSvg).not.toHaveBeenCalled();
  });

  it('keeps the placeholder static when a fallback URL remounts the image', () => {
    const primary = deferredResult();
    const fallback = deferredResult();
    jest
      .mocked(RNFS.resolveSvg)
      .mockReturnValueOnce(primary.promise)
      .mockReturnValueOnce(fallback.promise);
    const view = render(
      <View>
        <Media
          key={SVG_URL}
          src={SVG_URL}
          loadingPlaceholder={STATIC_PLACEHOLDER}
          failedPlaceholder={STATIC_PLACEHOLDER}
        />
      </View>,
    );
    expect(view.getByTestId('static-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-skeleton')).toBeNull();

    view.rerender(
      <View>
        <Media
          key={SECOND_SVG_URL}
          src={SECOND_SVG_URL}
          loadingPlaceholder={STATIC_PLACEHOLDER}
          failedPlaceholder={STATIC_PLACEHOLDER}
        />
      </View>,
    );
    expect(view.getByTestId('static-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    expect(RNFS.resolveSvg).toHaveBeenCalledTimes(2);
  });

  it('still renders a PNG that resolves after the placeholder timeout', async () => {
    const pending = deferredResult();
    const handleSuccess = jest.fn();
    jest.mocked(RNFS.resolveSvg).mockReturnValue(pending.promise);
    const view = render(
      <Media
        src={SVG_URL}
        loadingPlaceholder={STATIC_PLACEHOLDER}
        failedPlaceholder={STATIC_PLACEHOLDER}
        handleSuccess={handleSuccess}
      />,
    );
    act(() => jest.advanceTimersByTime(1500));
    expect(view.getByTestId('static-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-image')).toBeNull();

    await act(async () => {
      pending.resolve(readyResult());
      await pending.promise;
    });

    const image = view.getByTestId('media-image');
    expect(image.props.source).toEqual({ uri: PNG_URI });
    fireEvent(image, 'load');
    expect(view.queryByTestId('static-placeholder')).toBeNull();
    expect(view.queryByTestId('media-skeleton')).toBeNull();
    expect(handleSuccess).toHaveBeenCalledTimes(1);
  });

  it('ignores an old SVG response after the image source changes', async () => {
    const previous = deferredResult();
    const current = deferredResult();
    jest
      .mocked(RNFS.resolveSvg)
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const view = render(
      <Media
        src={SVG_URL}
        loadingPlaceholder={STATIC_PLACEHOLDER}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );
    view.rerender(
      <Media
        src={SECOND_SVG_URL}
        loadingPlaceholder={STATIC_PLACEHOLDER}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    await act(async () => {
      previous.resolve(readyResult('file:///safe-media/stale.png'));
      await previous.promise;
    });
    expect(view.queryByTestId('media-image')).toBeNull();

    await act(async () => {
      current.resolve(readyResult());
      await current.promise;
    });
    expect(view.getByTestId('media-image').props.source).toEqual({
      uri: PNG_URI,
    });
  });
});

describe('Media inline and on-chain artwork fallback', () => {
  const ONCHAIN_NFT = {
    chain: 'eth',
    contractId: '0xff9c1b15b16263c61d017ee9f65c50e4ae0113d7',
    tokenId: '1',
  };
  const INLINE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(RNFS.isSafeSvgRasterizationAvailable).mockReturnValue(true);
    jest.mocked(RNFS.isSafeSvgDataRasterizationAvailable).mockReturnValue(true);
    jest.mocked(RNFS.resolveSvgData).mockResolvedValue(readyResult());
  });

  afterEach(cleanup);

  it('renders an inline SVG data URL through the native data pipeline', async () => {
    const view = render(
      <Media
        src={`data:image/svg+xml;utf8,${encodeURIComponent(INLINE_SVG)}`}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    expect(await view.findByTestId('media-image')).toBeTruthy();
    expect(RNFS.resolveSvgData).toHaveBeenCalledWith({
      svg: INLINE_SVG,
      variant: 'thumbnail',
    });
    expect(view.getByTestId('media-image').props.source).toEqual({
      uri: PNG_URI,
    });
    expect(loadOnchainNftArtwork).not.toHaveBeenCalled();
  });

  it('reads on-chain artwork when the indexed media is missing', async () => {
    jest.mocked(loadOnchainNftArtwork).mockResolvedValue({
      svg: INLINE_SVG,
      transient: false,
    });
    const view = render(
      <Media
        src=""
        onchainNft={ONCHAIN_NFT}
        safeSvgVariant="detail"
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    expect(await view.findByTestId('media-image')).toBeTruthy();
    expect(loadOnchainNftArtwork).toHaveBeenCalledWith(ONCHAIN_NFT, undefined);
    expect(RNFS.resolveSvgData).toHaveBeenCalledWith({
      svg: INLINE_SVG,
      variant: 'detail',
    });
  });

  it('reads on-chain artwork when the indexer sends a null content type', async () => {
    jest.mocked(loadOnchainNftArtwork).mockResolvedValue({
      svg: INLINE_SVG,
      transient: false,
    });
    const view = render(
      <Media
        type={null as never}
        src=""
        onchainNft={ONCHAIN_NFT}
        safeSvgVariant="detail"
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    expect(await view.findByTestId('media-image')).toBeTruthy();
    expect(loadOnchainNftArtwork).toHaveBeenCalledWith(ONCHAIN_NFT, undefined);
  });

  it('falls back to on-chain artwork when the indexed SVG fails the safe profile', async () => {
    jest.mocked(RNFS.resolveSvg).mockResolvedValue({
      status: 'failed',
      reason: 'unsafe_svg',
    });
    jest.mocked(loadOnchainNftArtwork).mockResolvedValue({
      svg: INLINE_SVG,
      transient: false,
    });
    const view = render(
      <Media
        src={SVG_URL}
        onchainNft={ONCHAIN_NFT}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    expect(await view.findByTestId('media-image')).toBeTruthy();
    expect(loadOnchainNftArtwork).toHaveBeenCalledWith(ONCHAIN_NFT, undefined);
  });

  it('keeps the failed placeholder when the token has no inline artwork', async () => {
    jest.mocked(loadOnchainNftArtwork).mockResolvedValue({
      svg: null,
      transient: false,
    });
    const view = render(
      <Media
        src=""
        onchainNft={ONCHAIN_NFT}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    await waitFor(() => expect(loadOnchainNftArtwork).toHaveBeenCalled());
    expect(view.getByTestId('failed-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-image')).toBeNull();
    expect(RNFS.resolveSvgData).not.toHaveBeenCalled();
  });

  it('keeps the failed placeholder when native rendering rejects the artwork', async () => {
    jest.mocked(RNFS.resolveSvgData).mockResolvedValue({
      status: 'failed',
      reason: 'unsafe_svg',
    });
    const view = render(
      <Media
        src={`data:image/svg+xml,${INLINE_SVG}`}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    await waitFor(() => expect(RNFS.resolveSvgData).toHaveBeenCalled());
    expect(view.getByTestId('failed-placeholder')).toBeTruthy();
    expect(view.queryByTestId('media-image')).toBeNull();
  });

  it('opens inline artwork on press once it is shown', async () => {
    jest.mocked(loadOnchainNftArtwork).mockResolvedValue({
      svg: INLINE_SVG,
      transient: false,
    });
    const onPress = jest.fn();
    const view = render(
      <Media
        src=""
        onchainNft={ONCHAIN_NFT}
        onPress={onPress}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    fireEvent.press(await view.findByTestId('media-image'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('retries the chain after a temporary failure instead of giving up', async () => {
    jest.useFakeTimers();
    jest
      .mocked(loadOnchainNftArtwork)
      .mockResolvedValueOnce({ svg: null, transient: true })
      .mockResolvedValueOnce({ svg: INLINE_SVG, transient: false });
    const view = render(
      <Media
        src=""
        onchainNft={ONCHAIN_NFT}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByTestId('failed-placeholder')).toBeTruthy();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    expect(view.getByTestId('media-image')).toBeTruthy();
    expect(loadOnchainNftArtwork).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('re-renders the artwork when the rendered image cannot be shown', async () => {
    jest.mocked(loadOnchainNftArtwork).mockResolvedValue({
      svg: INLINE_SVG,
      transient: false,
    });
    const view = render(
      <Media
        src=""
        onchainNft={ONCHAIN_NFT}
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    const image = await view.findByTestId('media-image');
    expect(RNFS.resolveSvgData).toHaveBeenCalledTimes(1);
    act(() => image.props.onError());

    expect(await view.findByTestId('media-image')).toBeTruthy();
    expect(RNFS.resolveSvgData).toHaveBeenCalledTimes(2);
  });

  it('does not try any fallback for remote media without an on-chain reference', () => {
    const view = render(
      <Media
        src="https://example.com/a.png"
        failedPlaceholder={FAILED_PLACEHOLDER}
      />,
    );

    expect(view.getByTestId('failed-placeholder')).toBeTruthy();
    expect(RNFS.resolveSvgData).not.toHaveBeenCalled();
    expect(loadOnchainNftArtwork).not.toHaveBeenCalled();
  });
});
