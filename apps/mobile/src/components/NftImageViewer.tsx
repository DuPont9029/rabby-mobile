import React from 'react';
import { Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import type { NFTItem } from '@rabby-wallet/rabby-api/dist/types';

import { IconDefaultNFT } from '@/assets/icons/nft';
import { toOnchainNftRef } from '@/utils/onchainNftMediaCore';
import { MODAL_GATE_IDS } from '@/utils/modalGate';
import { Media } from './Media';
import { TrackedModal } from './Modal/TrackedModal';

/**
 * Full-screen view of an NFT image, scaled to fit the whole artwork on
 * screen. Tap anywhere (or use back) to close. It reuses `Media`, so the same
 * safe rendering paths and caches apply.
 */
export const NftImageViewer = ({
  nft,
  onClose,
}: {
  nft?: NFTItem | null;
  onClose: () => void;
}) => {
  const { width, height } = useWindowDimensions();
  const frame = { width, height: height * 0.9 };

  return (
    <TrackedModal
      modalId={MODAL_GATE_IDS.nftImageViewer}
      visible={!!nft}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}>
      <Pressable
        style={styles.backdrop}
        onPress={onClose}
        testID="nft-image-viewer">
        {nft ? (
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
        ) : null}
      </Pressable>
    </TrackedModal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.92)',
  },
  media: {
    backgroundColor: 'transparent',
  },
});
