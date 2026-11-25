package com.debank.rabbymobile;

import android.app.ActivityOptions;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

import androidx.annotation.NonNull;
import androidx.core.content.FileProvider;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/**
 * Installs an app update downloaded from the Helios Wallet GitHub releases.
 *
 * Only files in the app's own download folder (cache/install) are accepted,
 * and only when the APK is this very app (same package) signed with the same
 * certificate(s) as the installed app; Android's installer then shows its own
 * confirmation.
 */
public class HeliosApkInstallerModule extends ReactContextBaseJavaModule {
  private static final String APK_MIME = "application/vnd.android.package-archive";

  HeliosApkInstallerModule(ReactApplicationContext context) {
    super(context);
  }

  @NonNull
  @Override
  public String getName() {
    return "HeliosApkInstaller";
  }

  /** Whether the user allowed this app to install apps (Android 8+). */
  @ReactMethod
  public void canInstall(Promise promise) {
    Context context = getReactApplicationContext();
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      promise.resolve(context.getPackageManager().canRequestPackageInstalls());
    } else {
      promise.resolve(true);
    }
  }

  /** Opens "Install unknown apps" for this app. */
  @ReactMethod
  public void openInstallPermissionSettings(Promise promise) {
    Context context = getReactApplicationContext();
    try {
      Intent intent =
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
              ? new Intent(
                  Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                  Uri.parse("package:" + context.getPackageName()))
              : new Intent(Settings.ACTION_SECURITY_SETTINGS);
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      context.startActivity(intent);
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_SETTINGS", e);
    }
  }

  @ReactMethod
  public void install(String path, Promise promise) {
    Context context = getReactApplicationContext();
    try {
      File installDir = new File(context.getCacheDir(), "install").getCanonicalFile();
      File apk = new File(path).getCanonicalFile();
      if (!apk.isFile() || !installDir.equals(apk.getParentFile())) {
        promise.reject("E_PATH", "APK must be in the app download folder");
        return;
      }
      PackageManager pm = context.getPackageManager();
      PackageInfo archive = archiveInfo(pm, apk.getAbsolutePath());
      if (archive == null || !context.getPackageName().equals(archive.packageName)) {
        promise.reject("E_PACKAGE", "The APK is not an update of this app");
        return;
      }
      if (!sameSigners(installedSigners(pm, context.getPackageName()), signersOf(archive))) {
        promise.reject("E_SIGNATURE", "The APK is not signed with this app's key");
        return;
      }
      Uri uri =
          FileProvider.getUriForFile(context, context.getPackageName() + ".provider", apk);
      Intent intent = new Intent(Intent.ACTION_VIEW);
      intent.setDataAndType(uri, APK_MIME);
      intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
      context.startActivity(intent);
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_INSTALL", e);
    }
  }

  /**
   * Installs the update through PackageInstaller without asking when Android
   * allows it (the app is the installer of record, Android 12+); otherwise
   * Android shows its confirmation. The app restarts itself afterwards.
   */
  @ReactMethod
  public void installSilently(String path, Promise promise) {
    Context context = getReactApplicationContext();
    try {
      File apk = verifiedApk(context, path);
      PackageInstaller installer = context.getPackageManager().getPackageInstaller();
      PackageInstaller.SessionParams params =
          new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
      params.setAppPackageName(context.getPackageName());
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
      }
      if (Build.VERSION.SDK_INT >= 34) {
        params.setRequestUpdateOwnership(true);
      }
      int sessionId = installer.createSession(params);
      try (PackageInstaller.Session session = installer.openSession(sessionId)) {
        try (InputStream in = new FileInputStream(apk);
            OutputStream out = session.openWrite("base.apk", 0, apk.length())) {
          byte[] buffer = new byte[64 * 1024];
          int read;
          while ((read = in.read(buffer)) != -1) {
            out.write(buffer, 0, read);
          }
          session.fsync(out);
        }
        // The result goes to an activity started by the system: it can show
        // a required confirmation and reopen the app after the update
        // (an app in background may not start activities itself).
        Intent callback = new Intent(context, HeliosUpdateResultActivity.class);
        callback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          flags |= PendingIntent.FLAG_MUTABLE;
        }
        Bundle options = null;
        if (Build.VERSION.SDK_INT >= 34) {
          options =
              ActivityOptions.makeBasic()
                  .setPendingIntentCreatorBackgroundActivityStartMode(
                      ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                  .toBundle();
        }
        PendingIntent pending =
            PendingIntent.getActivity(context, sessionId, callback, flags, options);
        session.commit(pending.getIntentSender());
      }
      promise.resolve(true);
    } catch (Exception e) {
      promise.reject("E_INSTALL", e);
    }
  }

  /** The APK file if it is this app, signed with the same key, in cache/install. */
  private static File verifiedApk(Context context, String path) throws Exception {
    File installDir = new File(context.getCacheDir(), "install").getCanonicalFile();
    File apk = new File(path).getCanonicalFile();
    if (!apk.isFile() || !installDir.equals(apk.getParentFile())) {
      throw new SecurityException("APK must be in the app download folder");
    }
    PackageManager pm = context.getPackageManager();
    PackageInfo archive = archiveInfo(pm, apk.getAbsolutePath());
    if (archive == null || !context.getPackageName().equals(archive.packageName)) {
      throw new SecurityException("The APK is not an update of this app");
    }
    if (!sameSigners(installedSigners(pm, context.getPackageName()), signersOf(archive))) {
      throw new SecurityException("The APK is not signed with this app's key");
    }
    return apk;
  }

  @SuppressWarnings("deprecation")
  private static PackageInfo archiveInfo(PackageManager pm, String path) {
    int flags =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
    PackageInfo info = pm.getPackageArchiveInfo(path, flags);
    if (info != null && info.applicationInfo != null) {
      info.applicationInfo.sourceDir = path;
      info.applicationInfo.publicSourceDir = path;
    }
    return info;
  }

  @SuppressWarnings("deprecation")
  private static Set<String> installedSigners(PackageManager pm, String pkg) throws Exception {
    int flags =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
    return signersOf(pm.getPackageInfo(pkg, flags));
  }

  @SuppressWarnings("deprecation")
  private static Set<String> signersOf(PackageInfo info) throws Exception {
    Signature[] signatures = null;
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      if (info.signingInfo != null) {
        signatures =
            info.signingInfo.hasMultipleSigners()
                ? info.signingInfo.getApkContentsSigners()
                : info.signingInfo.getSigningCertificateHistory();
      }
    } else {
      signatures = info.signatures;
    }
    Set<String> out = new HashSet<>();
    if (signatures == null) {
      return out;
    }
    MessageDigest digest = MessageDigest.getInstance("SHA-256");
    for (Signature signature : signatures) {
      byte[] hash = digest.digest(signature.toByteArray());
      StringBuilder hex = new StringBuilder();
      for (byte b : hash) {
        hex.append(String.format("%02x", b));
      }
      out.add(hex.toString());
    }
    return out;
  }

  private static boolean sameSigners(Set<String> installed, Set<String> candidate) {
    return !installed.isEmpty() && installed.equals(candidate);
  }
}
