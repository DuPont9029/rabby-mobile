import { PermissionsAndroid, Platform } from 'react-native';
import { toast } from '@/components2024/Toast';
import { installUpdateSilently } from '@/core/native/heliosApkInstaller';
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
    // Once: allow the "updated, tap to open" notification (Android 13+).
    // Android 15 does not let an app reopen itself after an update.
    if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
      await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      ).catch(() => undefined);
    }
    toast.info('Downloading update…');
    const result = await downloadLatestApk({
      fromUrl: apkUrl,
      onProgress: ({ progressPercent }) => {
        const step = Math.floor(progressPercent * 2); // one toast at 50%
        if (step > lastStep && step === 1) {
          lastStep = step;
          toast.info('Downloading update… 50%');
        }
      },
    });
    if (result.downloadResult.statusCode !== 200) {
      toast.info(`Download failed (HTTP ${result.downloadResult.statusCode})`);
      return;
    }
    toast.info('Installing update…');
    const outcome = await installUpdateSilently(result.downloadedApkPath);
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
