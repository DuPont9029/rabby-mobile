/**
 * Update check for Helios Wallet builds: the fork's GitHub releases
 * (`helios-wallet-<sha7>`, one per build of the apk-build branch).
 *
 * The installed build knows its commit (HELIOS_BUILD_SHA, set by the CI
 * workflow). A newer release is one published after the release of that
 * commit. The APK comes straight from the release; Android only installs it
 * over this app when it is signed with the same key.
 */
export const HELIOS_RELEASES_REPO = 'DuPont9029/rabby-mobile';
const RELEASES_URL = `https://api.github.com/repos/${HELIOS_RELEASES_REPO}/releases?per_page=30`;
const TAG_PREFIX = 'helios-wallet-';
const REQUEST_TIMEOUT_MS = 10_000;

export const HELIOS_BUILD_SHA = (process.env.HELIOS_BUILD_SHA || '').slice(
  0,
  7,
);

export type GithubRelease = {
  tag_name: string;
  html_url: string;
  body?: string | null;
  draft?: boolean;
  published_at?: string | null;
  assets?: Array<{ name: string; browser_download_url: string }>;
};

export type HeliosUpdate = {
  /** Release tag of the newest build, e.g. `helios-wallet-95f22ff`. */
  latestTag: string;
  couldUpgrade: boolean;
  /** Direct APK download of the newest build. */
  apkUrl: string | null;
  releaseUrl: string;
  changelog: string;
};

const isHeliosRelease = (release: GithubRelease) =>
  !release.draft &&
  typeof release.tag_name === 'string' &&
  release.tag_name.startsWith(TAG_PREFIX) &&
  !!release.published_at;

const apkOf = (release: GithubRelease) =>
  release.assets?.find(
    asset =>
      asset.name.endsWith('.apk') &&
      asset.browser_download_url.startsWith(
        `https://github.com/${HELIOS_RELEASES_REPO}/releases/download/`,
      ),
  )?.browser_download_url || null;

/** Pure decision, for tests. */
export const pickHeliosUpdate = (
  releases: GithubRelease[],
  localSha: string,
): HeliosUpdate | null => {
  const builds = releases
    .filter(isHeliosRelease)
    .sort(
      (a, b) =>
        Date.parse(b.published_at as string) -
        Date.parse(a.published_at as string),
    );
  const latest = builds[0];
  if (!latest) {
    return null;
  }
  const current = builds.find(
    release => release.tag_name === `${TAG_PREFIX}${localSha}`,
  );
  const couldUpgrade =
    !!localSha &&
    latest.tag_name !== `${TAG_PREFIX}${localSha}` &&
    // Unknown local build (e.g. made locally): the newest release counts as
    // an update only if it is not older than ours, which we cannot tell.
    (!current ||
      Date.parse(latest.published_at as string) >
        Date.parse(current.published_at as string));
  const body = (latest.body || '').trim();
  return {
    latestTag: latest.tag_name,
    couldUpgrade,
    apkUrl: apkOf(latest),
    releaseUrl: latest.html_url,
    changelog: body.startsWith('#')
      ? body
      : `## ${latest.tag_name}\n\n${body || 'New Helios Wallet build.'}`,
  };
};

export const fetchHeliosUpdate = async (): Promise<HeliosUpdate | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub releases: HTTP ${response.status}`);
    }
    const releases = (await response.json()) as GithubRelease[];
    return pickHeliosUpdate(
      Array.isArray(releases) ? releases : [],
      HELIOS_BUILD_SHA,
    );
  } finally {
    clearTimeout(timer);
  }
};
