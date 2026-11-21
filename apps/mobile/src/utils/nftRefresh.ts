/**
 * Periodic refresh of on-chain NFT data (artwork and metadata change for
 * dynamic NFTs). One shared ticker drives every mounted view; it only runs
 * while something subscribes and the app is in the foreground.
 */
import { useEffect, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

import { appJsonStore } from '@/core/storage/mmkv';

const STORAGE_KEY = 'helios:nftRefreshSeconds:v1';
export const DEFAULT_NFT_REFRESH_SECONDS = 20;
/** Choices offered in the UI (seconds). */
export const NFT_REFRESH_CHOICES = [5, 10, 20, 30, 60];
const MIN_SECONDS = 5;
const MAX_SECONDS = 3_600;

export const getNftRefreshSeconds = () => {
  try {
    const value = appJsonStore.getItem(STORAGE_KEY, null);
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= MIN_SECONDS &&
      value <= MAX_SECONDS
      ? Math.round(value)
      : DEFAULT_NFT_REFRESH_SECONDS;
  } catch {
    return DEFAULT_NFT_REFRESH_SECONDS;
  }
};

export const getNftRefreshMs = () => getNftRefreshSeconds() * 1000;

const settingListeners = new Set<() => void>();

export const setNftRefreshSeconds = (seconds: number) => {
  const clamped = Math.min(
    MAX_SECONDS,
    Math.max(MIN_SECONDS, Math.round(seconds)),
  );
  appJsonStore.setItem(STORAGE_KEY, clamped);
  settingListeners.forEach(listener => listener());
  restartTicker();
};

export const useNftRefreshSeconds = () => {
  const [seconds, setSeconds] = useState(getNftRefreshSeconds);
  useEffect(() => {
    const update = () => setSeconds(getNftRefreshSeconds());
    settingListeners.add(update);
    return () => {
      settingListeners.delete(update);
    };
  }, []);
  return seconds;
};

// ---- shared ticker ---------------------------------------------------------

let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let appState: AppStateStatus = AppState.currentState;
const tickListeners = new Set<(value: number) => void>();

const stopTicker = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};

const startTicker = () => {
  if (timer || tickListeners.size === 0 || appState !== 'active') {
    return;
  }
  timer = setInterval(() => {
    tick += 1;
    tickListeners.forEach(listener => listener(tick));
  }, getNftRefreshMs());
};

function restartTicker() {
  stopTicker();
  startTicker();
}

AppState.addEventListener?.('change', next => {
  const wasActive = appState === 'active';
  appState = next;
  if (next === 'active' && !wasActive) {
    // Coming back: refresh right away, then on the usual schedule.
    tick += 1;
    tickListeners.forEach(listener => listener(tick));
    startTicker();
  } else if (next !== 'active') {
    stopTicker();
  }
});

/**
 * A counter that increases on every refresh while `enabled`. Use it as an
 * effect dependency to re-read on-chain data.
 */
export const useOnchainNftRefreshTick = (enabled = true) => {
  const [value, setValue] = useState(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const listener = (next: number) => setValue(next);
    tickListeners.add(listener);
    startTicker();
    return () => {
      tickListeners.delete(listener);
      if (tickListeners.size === 0) {
        stopTicker();
      }
    };
  }, [enabled]);
  return value;
};
