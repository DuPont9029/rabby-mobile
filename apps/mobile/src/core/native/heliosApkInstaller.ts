import { NativeModules, Platform } from 'react-native';

type NativeInstaller = {
  canInstall(): Promise<boolean>;
  openInstallPermissionSettings(): Promise<boolean>;
  install(path: string): Promise<boolean>;
};

const native: NativeInstaller | undefined =
  Platform.OS === 'android'
    ? (NativeModules.HeliosApkInstaller as NativeInstaller | undefined)
    : undefined;

export const isApkInstallerAvailable = () => !!native;

/**
 * Opens Android's installer for a downloaded update. The native side only
 * accepts the app's download folder and an APK of this app signed with the
 * same key. If the user has not allowed installing apps yet, opens that
 * setting instead and returns 'needs_permission'.
 */
export const installDownloadedApk = async (
  path: string,
): Promise<'started' | 'needs_permission'> => {
  if (!native) {
    throw new Error('In-app install is not available');
  }
  if (!(await native.canInstall())) {
    await native.openInstallPermissionSettings();
    return 'needs_permission';
  }
  await native.install(path);
  return 'started';
};
