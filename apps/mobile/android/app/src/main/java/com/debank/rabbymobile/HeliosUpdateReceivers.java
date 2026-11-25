package com.debank.rabbymobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Log;

/**
 * Helios Wallet self-updates. Android 15 does not let an app open itself
 * from the background, so after an update the app posts a notification that
 * reopens it with one tap.
 */
public final class HeliosUpdateReceivers {
  static final String PREFS = "helios_self_update";
  static final String KEY_NOTIFY = "notify_after_update";
  private static final String TAG = "HeliosUpdate";
  private static final String CHANNEL = "helios_updates";
  private static final int NOTIFICATION_ID = 0x4e11;

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
        // Android wants a confirmation (shown while the app is open).
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
        prefs(context).edit().remove(KEY_NOTIFY).apply();
        Log.w(
            TAG,
            "install failed: "
                + status
                + " "
                + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
      }
    }
  }

  /** After an update the app started itself: "updated, tap to open". */
  public static class PackageReplaced extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
      if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
        return;
      }
      SharedPreferences prefs = prefs(context);
      if (!prefs.getBoolean(KEY_NOTIFY, false)) {
        return;
      }
      prefs.edit().remove(KEY_NOTIFY).apply();
      try {
        NotificationManager manager =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
          return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          manager.createNotificationChannel(
              new NotificationChannel(
                  CHANNEL, "App updates", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent launch =
            context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) {
          return;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent open =
            PendingIntent.getActivity(
                context, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder builder =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder
            .setSmallIcon(context.getApplicationInfo().icon)
            .setContentTitle("Helios Wallet updated")
            .setContentText("Tap to open")
            .setContentIntent(open)
            .setAutoCancel(true);
        manager.notify(NOTIFICATION_ID, builder.build());
      } catch (Exception e) {
        Log.w(TAG, "cannot post update notification", e);
      }
    }
  }
}
