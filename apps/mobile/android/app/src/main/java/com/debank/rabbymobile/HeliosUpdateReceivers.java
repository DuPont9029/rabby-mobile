package com.debank.rabbymobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

/** Receivers for Helios Wallet self-updates. */
public final class HeliosUpdateReceivers {
  static final String PREFS = "helios_self_update";
  static final String KEY_RELAUNCH = "relaunch_after_update";
  private static final String TAG = "HeliosUpdate";

  private HeliosUpdateReceivers() {}

  static SharedPreferences prefs(Context context) {
    return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  /** Result of the PackageInstaller session started by the app. */
  public static class InstallResult extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
      int status =
          intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        // Android wants a confirmation (e.g. the first self-update).
        Intent confirm;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
        } else {
          confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
        }
        if (confirm != null) {
          confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          try {
            context.startActivity(confirm);
          } catch (Exception e) {
            Log.w(TAG, "cannot show install confirmation", e);
          }
        }
        return;
      }
      if (status != PackageInstaller.STATUS_SUCCESS) {
        prefs(context).edit().remove(KEY_RELAUNCH).apply();
        Log.w(
            TAG,
            "install failed: "
                + status
                + " "
                + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
      }
    }
  }

  /** After an update the app started itself, open it again. */
  public static class PackageReplaced extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
      if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
        return;
      }
      SharedPreferences prefs = prefs(context);
      if (!prefs.getBoolean(KEY_RELAUNCH, false)) {
        return;
      }
      prefs.edit().remove(KEY_RELAUNCH).apply();
      Intent launch =
          context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
      if (launch != null) {
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        try {
          context.startActivity(launch);
        } catch (Exception e) {
          Log.w(TAG, "cannot relaunch after update", e);
        }
      }
    }
  }
}
