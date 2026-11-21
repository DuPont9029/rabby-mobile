/**
 * Per-account NFT list preferences: rows the user hid (e.g. spam) and rows
 * pinned to the top. Keys are NFT list row keys (`collection-…` / `nft-…`),
 * so a whole spam collection is hidden at once. Stored locally only.
 */
import { useEffect, useState } from 'react';

import { appJsonStore } from '@/core/storage/mmkv';

const STORAGE_KEY = 'helios:nftPrefs:v1';
const MAX_KEYS = 2_000;

export type NftPrefs = { hidden: string[]; pinned: string[] };

const EMPTY: NftPrefs = { hidden: [], pinned: [] };

type Stored = Record<string, Partial<NftPrefs>>;

const readAll = (): Stored => {
  try {
    const value = appJsonStore.getItem(STORAGE_KEY, null);
    return value && typeof value === 'object' ? (value as Stored) : {};
  } catch {
    return {};
  }
};

const cleanList = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, MAX_KEYS)
    : [];

export const getNftPrefs = (address?: string | null): NftPrefs => {
  if (!address) {
    return EMPTY;
  }
  const entry = readAll()[address.toLowerCase()];
  return entry
    ? { hidden: cleanList(entry.hidden), pinned: cleanList(entry.pinned) }
    : EMPTY;
};

const listeners = new Set<() => void>();

const write = (address: string, prefs: NftPrefs) => {
  const all = readAll();
  all[address.toLowerCase()] = prefs;
  appJsonStore.setItem(STORAGE_KEY, all);
  listeners.forEach(listener => listener());
};

const toggle = (list: string[], key: string, on: boolean) =>
  on
    ? list.includes(key)
      ? list
      : [...list, key]
    : list.filter(item => item !== key);

/** Hiding unpins; pinning unhides. */
export const setNftHidden = (address: string, key: string, hidden: boolean) => {
  const prefs = getNftPrefs(address);
  write(address, {
    hidden: toggle(prefs.hidden, key, hidden),
    pinned: hidden ? toggle(prefs.pinned, key, false) : prefs.pinned,
  });
};

export const setNftPinned = (address: string, key: string, pinned: boolean) => {
  const prefs = getNftPrefs(address);
  write(address, {
    pinned: toggle(prefs.pinned, key, pinned),
    hidden: pinned ? toggle(prefs.hidden, key, false) : prefs.hidden,
  });
};

export const useNftPrefs = (address?: string | null) => {
  const [prefs, setPrefs] = useState(() => getNftPrefs(address));
  useEffect(() => {
    const update = () => setPrefs(getNftPrefs(address));
    update();
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, [address]);
  return prefs;
};

/**
 * Applies the preferences to an ordered row list: pinned rows first (in pin
 * order), hidden rows split out.
 */
export const applyNftPrefs = <T>(
  rows: T[],
  keyOf: (row: T) => string,
  prefs: NftPrefs,
): { pinned: T[]; visible: T[]; hidden: T[] } => {
  const hiddenSet = new Set(prefs.hidden);
  const pinOrder = new Map(prefs.pinned.map((key, index) => [key, index]));
  const pinned: T[] = [];
  const visible: T[] = [];
  const hidden: T[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (hiddenSet.has(key)) {
      hidden.push(row);
    } else if (pinOrder.has(key)) {
      pinned.push(row);
    } else {
      visible.push(row);
    }
  }
  pinned.sort((a, b) => pinOrder.get(keyOf(a))! - pinOrder.get(keyOf(b))!);
  return { pinned, visible, hidden };
};
