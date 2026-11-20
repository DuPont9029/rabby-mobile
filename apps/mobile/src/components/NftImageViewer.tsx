import React, { useEffect } from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import type { NFTItem } from '@rabby-wallet/rabby-api/dist/types';

import { IconDefaultNFT } from '@/assets/icons/nft';
import { toOnchainNftRef } from '@/utils/onchainNftMediaCore';
import { MODAL_GATE_IDS } from '@/utils/modalGate';
import { Media } from './Media';
import { TrackedModal } from './Modal/TrackedModal';

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const ZOOMED_EPSILON = 1.01;

const clamp = (value: number, min: number, max: number) => {
  'worklet';
  return Math.min(Math.max(value, min), max);
};

/**
 * Full-screen, zoomable view of an NFT image. Pinch to zoom (up to 5x), drag
 * to pan while zoomed, double-tap to toggle zoom; tap (when not zoomed), the
 * close button or back closes it. It reuses `Media`, so the same safe
 * rendering paths and caches apply.
 */
export const NftImageViewer = ({
  nft,
  onClose,
}: {
  nft?: NFTItem | null;
  onClose: () => void;
}) => {
  const { width, height } = useWindowDimensions();
  const frameWidth = width;
  const frameHeight = height * 0.9;

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const visible = !!nft;
  useEffect(() => {
    // Every opening starts unzoomed.
    if (visible) {
      scale.value = 1;
      savedScale.value = 1;
      translateX.value = 0;
      translateY.value = 0;
      savedTranslateX.value = 0;
      savedTranslateY.value = 0;
    }
  }, [
    visible,
    scale,
    savedScale,
    translateX,
    translateY,
    savedTranslateX,
    savedTranslateY,
  ]);

  const resetZoom = () => {
    'worklet';
    scale.value = withSpring(1);
    savedScale.value = 1;
    translateX.value = withSpring(0);
    translateY.value = withSpring(0);
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  };

  // Keeps the zoomed image covering the frame (no empty edges).
  const clampPan = (x: number, y: number, currentScale: number) => {
    'worklet';
    const maxX = (frameWidth * (currentScale - 1)) / 2;
    const maxY = (frameHeight * (currentScale - 1)) / 2;
    return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) };
  };

  const pinch = Gesture.Pinch()
    .onUpdate(event => {
      scale.value = clamp(savedScale.value * event.scale, 1, MAX_SCALE);
    })
    .onEnd(() => {
      if (scale.value <= ZOOMED_EPSILON) {
        resetZoom();
        return;
      }
      savedScale.value = scale.value;
      const next = clampPan(translateX.value, translateY.value, scale.value);
      translateX.value = withSpring(next.x);
      translateY.value = withSpring(next.y);
      savedTranslateX.value = next.x;
      savedTranslateY.value = next.y;
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .onUpdate(event => {
      if (scale.value <= ZOOMED_EPSILON) {
        return;
      }
      const next = clampPan(
        savedTranslateX.value + event.translationX,
        savedTranslateY.value + event.translationY,
        scale.value,
      );
      translateX.value = next.x;
      translateY.value = next.y;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > ZOOMED_EPSILON) {
        resetZoom();
        return;
      }
      scale.value = withSpring(DOUBLE_TAP_SCALE);
      savedScale.value = DOUBLE_TAP_SCALE;
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (scale.value <= ZOOMED_EPSILON) {
        runOnJS(onClose)();
      }
    });

  const gesture = Gesture.Simultaneous(
    pinch,
    pan,
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  const frameStyle = { width: frameWidth, height: frameHeight };

  return (
    <TrackedModal
      modalId={MODAL_GATE_IDS.nftImageViewer}
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <GestureDetector gesture={gesture}>
          <View style={styles.backdrop} testID="nft-image-viewer">
            {nft ? (
              <Animated.View style={[frameStyle, imageStyle]}>
                <Media
                  failedPlaceholder={
                    <IconDefaultNFT width={frameWidth} height={frameHeight} />
                  }
                  type={nft.content_type}
                  src={nft.content}
                  thumbnail={nft.content}
                  onchainNft={toOnchainNftRef(nft)}
                  safeSvgVariant="detail"
                  resizeMode="contain"
                  style={StyleSheet.flatten([styles.media, frameStyle])}
                  mediaStyle={styles.media}
                />
              </Animated.View>
            ) : null}
          </View>
        </GestureDetector>
        <TouchableOpacity
          style={styles.close}
          onPress={onClose}
          hitSlop={12}
          testID="nft-image-viewer-close">
          <Text style={styles.closeText}>✕</Text>
        </TouchableOpacity>
      </GestureHandlerRootView>
    </TrackedModal>
  );
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: 'rgba(0, 0, 0, 0.94)',
  },
  media: {
    backgroundColor: 'transparent',
  },
  close: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
  },
  closeText: {
    color: '#FFFFFF',
    fontSize: 18,
    lineHeight: 20,
  },
});
