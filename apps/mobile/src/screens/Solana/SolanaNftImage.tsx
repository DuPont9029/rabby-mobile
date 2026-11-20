import React, { ReactNode, useEffect, useState } from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import FastImage, { FastImageProps, ImageStyle } from 'react-native-fast-image';
import RNFS from '@rabby-wallet/react-native-fs';

import { loadOffchainMetadata, resolveMediaUri } from '@/core/solana/portfolio';
import { inlineImageToSvg } from '@/utils/onchainNftMediaCore';

const MAX_SVG_BYTES = 2 * 1024 * 1024;

type ImageState =
  | { status: 'loading' }
  | { status: 'remote'; uri: string }
  | { status: 'rendered'; uri: string }
  | { status: 'failed' };

/** Renders SVG markup through the native safe-SVG pipeline. */
const renderSvg = async (svg: string, variant: 'thumbnail' | 'detail') => {
  if (!RNFS.isSafeSvgDataRasterizationAvailable()) {
    return null;
  }
  const result = await RNFS.resolveSvgData({ svg, variant });
  return result.status === 'ready' ? result.uri : null;
};

/** Fetches a remote image as SVG text (size-limited), for FastImage misses. */
const fetchSvg = async (uri: string) => {
  try {
    const response = await fetch(uri);
    const type = response.headers.get('content-type') || '';
    const length = Number(response.headers.get('content-length') || 0);
    if (!response.ok || length > MAX_SVG_BYTES) {
      return null;
    }
    const body = await response.text();
    const head = body.trimStart().slice(0, 256).toLowerCase();
    const isSvg =
      type.includes('svg') ||
      head.startsWith('<svg') ||
      (head.startsWith('<?xml') && head.includes('<svg'));
    return isSvg && body.length <= MAX_SVG_BYTES ? body : null;
  } catch {
    return null;
  }
};

/**
 * Image of a Solana NFT, from the `image` of its off-chain JSON metadata.
 * Raster images load directly (the user opted in to loading NFT images from
 * their hosts); SVGs and inline `data:` images go through the safe-SVG
 * renderer.
 */
export const SolanaNftImage = ({
  metadataUri,
  style,
  imageStyle,
  resizeMode = 'cover',
  variant = 'thumbnail',
  placeholder,
}: {
  metadataUri: string;
  style?: StyleProp<ViewStyle>;
  imageStyle?: StyleProp<ImageStyle>;
  resizeMode?: FastImageProps['resizeMode'];
  variant?: 'thumbnail' | 'detail';
  placeholder?: ReactNode;
}) => {
  const [state, setState] = useState<ImageState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    (async () => {
      const metadata = await loadOffchainMetadata(metadataUri);
      const image = resolveMediaUri(metadata?.image);
      if (!image) {
        return { status: 'failed' } as const;
      }
      const inline = inlineImageToSvg(image);
      if (inline) {
        const uri = await renderSvg(inline, variant);
        return uri
          ? ({ status: 'rendered', uri } as const)
          : ({ status: 'failed' } as const);
      }
      if (/^data:/i.test(image)) {
        return { status: 'failed' } as const;
      }
      if (/\.svg($|[?#])/i.test(image)) {
        const svg = await fetchSvg(image);
        const uri = svg ? await renderSvg(svg, variant) : null;
        return uri
          ? ({ status: 'rendered', uri } as const)
          : ({ status: 'failed' } as const);
      }
      return { status: 'remote', uri: image } as const;
    })()
      .catch(() => ({ status: 'failed' } as const))
      .then(next => {
        if (active) {
          setState(next);
        }
      });
    return () => {
      active = false;
    };
  }, [metadataUri, variant]);

  const handleError = () => {
    // Not a raster FastImage can decode: it may be an SVG without the
    // extension. Try the safe-SVG path once.
    if (state.status !== 'remote') {
      setState({ status: 'failed' });
      return;
    }
    const remote = state.uri;
    fetchSvg(remote)
      .then(svg => (svg ? renderSvg(svg, variant) : null))
      .then(uri =>
        setState(uri ? { status: 'rendered', uri } : { status: 'failed' }),
      )
      .catch(() => setState({ status: 'failed' }));
  };

  if (state.status === 'remote' || state.status === 'rendered') {
    return (
      <View style={style}>
        <FastImage
          source={{ uri: state.uri }}
          style={imageStyle}
          resizeMode={resizeMode}
          onError={handleError}
        />
      </View>
    );
  }
  return <View style={style}>{placeholder}</View>;
};
