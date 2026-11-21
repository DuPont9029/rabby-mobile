import {
  applyNftPrefs,
  getNftPrefs,
  setNftHidden,
  setNftPinned,
} from './nftPrefs';

const mockStore = new Map<string, unknown>();
jest.mock('@/core/storage/mmkv', () => ({
  appJsonStore: {
    getItem: (key: string, fallback: unknown) =>
      mockStore.has(key) ? mockStore.get(key) : fallback,
    setItem: (key: string, value: unknown) => mockStore.set(key, value),
  },
}));

const ME = '0xAbC0000000000000000000000000000000000001';

describe('NFT list preferences', () => {
  beforeEach(() => mockStore.clear());

  it('pins rows to the top in pin order and splits hidden rows out', () => {
    const rows = ['a', 'b', 'c', 'd', 'spam'];
    const result = applyNftPrefs(rows, row => row, {
      pinned: ['d', 'b'],
      hidden: ['spam'],
    });
    expect(result.pinned).toEqual(['d', 'b']);
    expect(result.visible).toEqual(['a', 'c']);
    expect(result.hidden).toEqual(['spam']);
  });

  it('stores preferences per account, case-insensitively', () => {
    setNftHidden(ME, 'collection-spam', true);
    setNftPinned(ME, 'nft-card', true);
    expect(getNftPrefs(ME.toLowerCase())).toEqual({
      hidden: ['collection-spam'],
      pinned: ['nft-card'],
    });
    expect(getNftPrefs('0x0000000000000000000000000000000000000002')).toEqual({
      hidden: [],
      pinned: [],
    });
  });

  it('hiding unpins and pinning unhides', () => {
    setNftPinned(ME, 'x', true);
    setNftHidden(ME, 'x', true);
    expect(getNftPrefs(ME)).toEqual({ hidden: ['x'], pinned: [] });
    setNftPinned(ME, 'x', true);
    expect(getNftPrefs(ME)).toEqual({ hidden: [], pinned: ['x'] });
  });

  it('ignores damaged stored data', () => {
    mockStore.set('helios:nftPrefs:v1', {
      [ME.toLowerCase()]: { hidden: [1, null, 'ok'], pinned: 'nope' },
    });
    expect(getNftPrefs(ME)).toEqual({ hidden: ['ok'], pinned: [] });
  });
});
