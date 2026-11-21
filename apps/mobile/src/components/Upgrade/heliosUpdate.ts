import { toast } from '@/components2024/Toast';
import { installDownloadedApk } from '@/core/native/heliosApkInstaller';
import { downloadLatestApk } from '@/utils/version';

let running = false;

/**
 * Downloads a Helios Wallet release APK inside the app (progress as toasts)
 * and opens Android's installer. The native installer only accepts this
 * app's package signed with the same key.
 */
export const downloadAndInstallHeliosUpdate = async (apkUrl: string) => {
  if (running) {
    return;
  }
  running = true;
  let lastStep = -1;
  try {
    toast.info('Downloading update…');
    const result = await downloadLatestApk({
      fromUrl: apkUrl,
      onProgress: ({ progressPercent }) => {
        const step = Math.floor(progressPercent * 4); // 25% steps
        if (step > lastStep && step < 4) {
          lastStep = step;
          if (step > 0) {
            toast.info(`Downloading update… ${step * 25}%`);
          }
        }
      },
    });
    if (result.downloadResult.statusCode !== 200) {
      toast.info(`Download failed (HTTP ${result.downloadResult.statusCode})`);
      return;
    }
    const outcome = await installDownloadedApk(result.downloadedApkPath);
    if (outcome === 'needs_permission') {
      toast.info(
        'Allow Helios Wallet to install apps, then start the update again',
      );
    }
  } catch (error) {
    toast.info(error instanceof Error ? error.message : 'Update failed');
  } finally {
    running = false;
  }
};
