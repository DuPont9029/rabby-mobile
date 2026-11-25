package com.debank.rabbymobile;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

/**
 * Receives the result of a self-update session as an activity PendingIntent,
 * so the system (not the app in background) starts it: shows Android's
 * confirmation when one is required, and reopens the app once the update is
 * installed.
 */
public class HeliosUpdateResultActivity extends Activity {
  private static final String TAG = "HeliosUpdate";

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    Intent intent = getIntent();
    int status =
        intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
    try {
      if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
        Intent confirm;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
        } else {
          confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
        }
        if (confirm != null) {
          startActivity(confirm);
        }
      } else if (status == PackageInstaller.STATUS_SUCCESS) {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
          launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
          startActivity(launch);
        }
      } else {
        Log.w(
            TAG,
            "install failed: "
                + status
                + " "
                + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
      }
    } catch (Exception e) {
      Log.w(TAG, "update result handling failed", e);
    }
    finish();
  }
}
