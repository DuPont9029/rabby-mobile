import React from 'react';
import { StyleSheet } from 'react-native';
import type { NFTItem } from '@rabby-wallet/rabby-api/dist/types';

import { IconDefaultNFT } from '@/assets/icons/nft';
import { toOnchainNftRef } from '@/utils/onchainNftMediaCore';
import { Media } from './Media';
import { ZoomableModal } from './ZoomableModal';

/**
 * Full-screen, zoomable view of an NFT image (see `ZoomableModal`). It
 * reuses `Media`, so the same safe rendering paths and caches apply.
 */
export const NftImageViewer = ({
  nft,
  onClose,
}: {
  nft?: NFTItem | null;
  onClose: () => void;
}) => (
  <ZoomableModal visible={!!nft} onClose={onClose}>
    {frame =>
      nft ? (
        <Media
          failedPlaceholder={
            <IconDefaultNFT width={frame.width} height={frame.height} />
          }
          type={nft.content_type}
          src={nft.content}
          thumbnail={nft.content}
          onchainNft={toOnchainNftRef(nft)}
          safeSvgVariant="detail"
          resizeMode="contain"
          style={StyleSheet.flatten([styles.media, frame])}
          mediaStyle={styles.media}
        />
      ) : null
    }
  </ZoomableModal>
);

const styles = StyleSheet.create({
  media: {
    backgroundColor: 'transparent',
  },
});
