import { pickHeliosUpdate, GithubRelease } from './heliosReleases';

const release = (
  sha: string,
  publishedAt: string,
  extra: Partial<GithubRelease> = {},
): GithubRelease => ({
  tag_name: `helios-wallet-${sha}`,
  html_url: `https://github.com/DuPont9029/rabby-mobile/releases/tag/helios-wallet-${sha}`,
  body: `## Helios Wallet ${sha}\n\nchanges`,
  published_at: publishedAt,
  assets: [
    {
      name: `helios-wallet-${sha}-arm64.apk`,
      browser_download_url: `https://github.com/DuPont9029/rabby-mobile/releases/download/helios-wallet-${sha}/helios-wallet-${sha}-arm64.apk`,
    },
  ],
  ...extra,
});

const releases = [
  release('aaaaaaa', '2026-11-20T10:00:00Z'),
  release('ccccccc', '2026-11-21T10:00:00Z'),
  release('bbbbbbb', '2026-11-20T20:00:00Z'),
];

describe('Helios release update check', () => {
  it('offers the newest release to an older build', () => {
    const update = pickHeliosUpdate(releases, 'aaaaaaa')!;
    expect(update.couldUpgrade).toBe(true);
    expect(update.latestTag).toBe('helios-wallet-ccccccc');
    expect(update.apkUrl).toContain('/helios-wallet-ccccccc/');
    expect(update.changelog.startsWith('## ')).toBe(true);
  });

  it('reports up to date on the newest build', () => {
    expect(pickHeliosUpdate(releases, 'ccccccc')!.couldUpgrade).toBe(false);
  });

  it('does not offer a release older than the installed one', () => {
    const list = [
      release('aaaaaaa', '2026-11-20T10:00:00Z'),
      release('bbbbbbb', '2026-11-21T00:00:00Z'),
    ];
    expect(pickHeliosUpdate(list, 'bbbbbbb')!.couldUpgrade).toBe(false);
  });

  it('ignores drafts, other tags and foreign download links', () => {
    const update = pickHeliosUpdate(
      [
        release('ddddddd', '2026-11-22T00:00:00Z', { draft: true }),
        { ...release('eeeeeee', '2026-11-23T00:00:00Z'), tag_name: 'v1.0.0' },
        release('fffffff', '2026-11-21T12:00:00Z', {
          assets: [
            {
              name: 'x.apk',
              browser_download_url: 'https://evil.example/x.apk',
            },
          ],
        }),
      ],
      'aaaaaaa',
    )!;
    expect(update.latestTag).toBe('helios-wallet-fffffff');
    expect(update.apkUrl).toBeNull();
  });

  it('does nothing without a known local build', () => {
    expect(pickHeliosUpdate(releases, '')!.couldUpgrade).toBe(false);
    expect(pickHeliosUpdate([], 'aaaaaaa')).toBeNull();
  });
});
