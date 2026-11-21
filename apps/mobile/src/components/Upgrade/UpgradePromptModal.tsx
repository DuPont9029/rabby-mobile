import React, { useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import { useUpgradeInfo } from '@/hooks/version';
import { MODAL_GATE_IDS, useVisibleBlockingModalIds } from '@/utils/modalGate';
import { APP_URLS } from '@/constant';
import { RootNames } from '@/constant/layout';
import { openExternalUrl, openInAppBrowser } from '@/core/utils/linking';
import {
  apisHomeTabIndex,
  HomeTabName as TabName,
  useCurrentRouteName,
} from '@/hooks/navigation';
import { useValueFromSharedValue } from '@/hooks/reanimated';
import { homeDrawerAnimateMutable } from '@/screens/Home/hooks/useHomeDrawerAnimate';
import {
  dismissUpgradePrompt,
  showPendingAutoUpgradePrompt,
  usePendingAutoUpgradePrompt,
  useUpgradePromptVisible,
} from './useUpgradePrompt';
import { UpgradePromptDialog } from './UpgradePromptDialog';
import { HELIOS_BUILD_SHA } from '@/utils/heliosReleases';
import { isApkInstallerAvailable } from '@/core/native/heliosApkInstaller';
import { downloadAndInstallHeliosUpdate } from './heliosUpdate';

export function UpgradePromptModal() {
  const visible = useUpgradePromptVisible();
  const pendingAutoPrompt = usePendingAutoUpgradePrompt();
  const { currentRouteName } = useCurrentRouteName();
  const visibleBlockingModalIds = useVisibleBlockingModalIds();
  const hasOtherVisibleModal = visibleBlockingModalIds.some(
    modalId => modalId !== MODAL_GATE_IDS.upgradePrompt,
  );
  const isHomeDrawerExpanded = useValueFromSharedValue(
    homeDrawerAnimateMutable.isExpanded,
  );
  const homeTabName = useValueFromSharedValue(apisHomeTabIndex.svTabName);
  const { remoteVersion } = useUpgradeInfo();

  useEffect(() => {
    return () => {
      dismissUpgradePrompt();
    };
  }, []);

  useEffect(() => {
    if (
      currentRouteName === RootNames.Home &&
      homeTabName === TabName.overview &&
      !isHomeDrawerExpanded &&
      !hasOtherVisibleModal &&
      pendingAutoPrompt
    ) {
      showPendingAutoUpgradePrompt();
    }
  }, [
    currentRouteName,
    hasOtherVisibleModal,
    homeTabName,
    isHomeDrawerExpanded,
    pendingAutoPrompt,
  ]);

  const handleUpdate = useCallback(async () => {
    dismissUpgradePrompt();

    // Helios builds: download the release APK and open Android's installer.
    if (
      HELIOS_BUILD_SHA &&
      isApkInstallerAvailable() &&
      remoteVersion.downloadUrl
    ) {
      await downloadAndInstallHeliosUpdate(remoteVersion.downloadUrl);
      return;
    }

    try {
      if (Platform.OS !== 'android') {
        await openExternalUrl(
          remoteVersion.downloadUrl ||
            remoteVersion.storeUrl ||
            APP_URLS.STORE_URL,
        );
        return;
      }

      if (remoteVersion.externalUrlToOpen) {
        await openExternalUrl(remoteVersion.externalUrlToOpen);
      } else {
        await openInAppBrowser(APP_URLS.DOWNLOAD_PAGE);
      }
    } catch {
      await openExternalUrl(APP_URLS.DOWNLOAD_PAGE);
    }
  }, [remoteVersion]);

  return (
    <UpgradePromptDialog
      visible={visible}
      remoteVersion={remoteVersion}
      onClose={dismissUpgradePrompt}
      onUpdate={handleUpdate}
    />
  );
}
