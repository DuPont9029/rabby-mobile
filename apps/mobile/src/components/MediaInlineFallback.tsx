import React, { ReactNode, useEffect, useState } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import FastImage, { FastImageProps, ImageStyle } from 'react-native-fast-image';
import RNFS, { type SafeSvgVariant } from '@rabby-wallet/react-native-fs';

import { inlineImageToSvg } from '@/utils/onchainNftMediaCore';
import { loadOnchainNftSvg, type OnchainNftRef } from '@/utils/onchainNftMedia';

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
}) => {
  const [state, setState] = useState<FallbackState>({ status: 'pending' });
  const chain = onchainNft?.chain;
  const contractId = onchainNft?.contractId;
  const tokenId = onchainNft?.tokenId;

  useEffect(() => {
    let active = true;
    setState({ status: 'pending' });
    const resolve = async () => {
      if (!RNFS.isSafeSvgDataRasterizationAvailable()) {
        return null;
      }
      const svg =
        inlineImageToSvg(src) ??
        inlineImageToSvg(thumbnail) ??
        (chain && contractId && tokenId
          ? await loadOnchainNftSvg({ chain, contractId, tokenId })
          : null);
      if (!svg || !active) {
        return null;
      }
      const result = await RNFS.resolveSvgData({ svg, variant });
      return result.status === 'ready' ? result.uri : null;
    };
    resolve()
      .then(uri => {
        if (active) {
          setState(uri ? { status: 'ready', uri } : { status: 'failed' });
        }
      })
      .catch(() => {
        if (active) {
          setState({ status: 'failed' });
        }
      });
    return () => {
      active = false;
    };
  }, [chain, contractId, src, thumbnail, tokenId, variant]);

  if (state.status !== 'ready') {
    return <View style={containerStyle}>{failedPlaceholder}</View>;
  }
  return (
    <View style={containerStyle}>
      <FastImage
        source={{ uri: state.uri }}
        style={mediaStyle}
        resizeMode={resizeMode}
        onLoad={onReady}
      />
    </View>
  );
};
