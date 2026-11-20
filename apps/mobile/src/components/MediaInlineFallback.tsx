import React, { ReactNode, useCallback, useEffect, useState } from 'react';
import {
  StyleProp,
  TouchableOpacity,
  TouchableOpacityProps,
  View,
  ViewStyle,
} from 'react-native';
import FastImage, { FastImageProps, ImageStyle } from 'react-native-fast-image';
import RNFS, { type SafeSvgVariant } from '@rabby-wallet/react-native-fs';

import { inlineImageToSvg } from '@/utils/onchainNftMediaCore';
import {
  loadOnchainNftArtwork,
  ONCHAIN_RETRY_DELAYS_MS,
  type OnchainNftRef,
} from '@/utils/onchainNftMedia';

type FallbackState =
  | { status: 'pending' }
  | { status: 'ready'; uri: string }
  | { status: 'failed' };

/**
 * Shown by `Media` instead of its failed placeholder for image media.
 *
 * It looks for artwork inside the NFT itself, in this order: an inline
 * `data:`/SVG value in `src`/`thumbnail`, then (when `onchainNft` is given)
 * the token's on-chain `tokenURI` metadata. Whatever it finds is rendered by
 * the native safe-SVG pipeline (`RNFS.resolveSvgData`); remote URLs chosen by
 * the NFT's creator are never fetched. If nothing renders, the original
 * failed placeholder stays.
 */
/** Re-render attempts when the rendered PNG cannot be displayed. */
const MAX_IMAGE_RELOADS = 2;

export const MediaInlineFallback = ({
  src,
  thumbnail,
  onchainNft,
  variant,
  containerStyle,
  mediaStyle,
  resizeMode,
  failedPlaceholder,
  onReady,
  onPress,
}: {
  src?: string;
  thumbnail?: string;
  onchainNft?: OnchainNftRef;
  variant: SafeSvgVariant;
  containerStyle: StyleProp<ViewStyle>;
  mediaStyle: StyleProp<ImageStyle>;
  resizeMode?: FastImageProps['resizeMode'];
  failedPlaceholder?: ReactNode;
  onReady?: () => void;
  /** Only wired once artwork is shown, like the regular `Media` path. */
  onPress?: TouchableOpacityProps['onPress'];
}) => {
  const [state, setState] = useState<FallbackState>({ status: 'pending' });
  // Bumped to re-run the resolution (on-chain retry or image reload).
  const [attempt, setAttempt] = useState(0);
  const [imageReloads, setImageReloads] = useState(0);
  const chain = onchainNft?.chain;
  const contractId = onchainNft?.contractId;
  const tokenId = onchainNft?.tokenId;

  useEffect(() => {
    setAttempt(0);
    setImageReloads(0);
  }, [chain, contractId, src, thumbnail, tokenId, variant]);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setState({ status: 'pending' });
    const resolve = async (): Promise<{
      uri: string | null;
      retry: boolean;
    }> => {
      if (!RNFS.isSafeSvgDataRasterizationAvailable()) {
        return { uri: null, retry: false };
      }
      let svg = inlineImageToSvg(src) ?? inlineImageToSvg(thumbnail);
      let transient = false;
      if (!svg && chain && contractId && tokenId) {
        const artwork = await loadOnchainNftArtwork({
          chain,
          contractId,
          tokenId,
        });
        svg = artwork.svg;
        transient = artwork.transient;
      }
      if (!svg || !active) {
        return { uri: null, retry: transient };
      }
      const result = await RNFS.resolveSvgData({ svg, variant });
      return result.status === 'ready'
        ? { uri: result.uri, retry: false }
        : { uri: null, retry: result.reason === 'io_error' };
    };
    resolve()
      .catch(() => ({ uri: null, retry: true }))
      .then(({ uri, retry }) => {
        if (!active) {
          return;
        }
        if (uri) {
          setState({ status: 'ready', uri });
          return;
        }
        setState({ status: 'failed' });
        const delay = ONCHAIN_RETRY_DELAYS_MS[attempt];
        if (retry && delay !== undefined) {
          retryTimer = setTimeout(() => setAttempt(value => value + 1), delay);
        }
      });
    return () => {
      active = false;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [attempt, chain, contractId, src, thumbnail, tokenId, variant]);

  const handleImageError = useCallback(() => {
    // The rendered PNG could not be shown (e.g. evicted from the cache):
    // render it again rather than leaving an empty frame.
    if (imageReloads < MAX_IMAGE_RELOADS) {
      setImageReloads(value => value + 1);
      setAttempt(value => value + 1);
    } else {
      setState({ status: 'failed' });
    }
  }, [imageReloads]);

  if (state.status !== 'ready') {
    return <View style={containerStyle}>{failedPlaceholder}</View>;
  }
  const image = (
    <FastImage
      source={{ uri: state.uri }}
      style={mediaStyle}
      resizeMode={resizeMode}
      onLoad={onReady}
      onError={handleImageError}
    />
  );
  return onPress ? (
    <TouchableOpacity style={containerStyle} onPress={onPress}>
      {image}
    </TouchableOpacity>
  ) : (
    <View style={containerStyle}>{image}</View>
  );
};
