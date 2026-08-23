/*
 * Filename: InstallShortcutReceiver.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/InstallShortcutReceiver.java
 * Change date and time: 21.20.00_20.08.2026
 * Reason for changes: Legacy INSTALL_SHORTCUT broadcast → Speed Dial pin queue.
 */

package space.u2re.cwsp;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Parcelable;
import android.util.Log;

import com.getcapacitor.JSObject;

/**
 * Older apps (and some file managers) still broadcast INSTALL_SHORTCUT.
 * Queue the same pending-pin payload MainActivity uses for CONFIRM_PIN_SHORTCUT.
 */
public class InstallShortcutReceiver extends BroadcastReceiver {
    private static final String TAG = "CwspInstallShortcut";
    private static final String ACTION_INSTALL_SHORTCUT = "com.android.launcher.action.INSTALL_SHORTCUT";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_INSTALL_SHORTCUT.equals(intent.getAction())) return;
        try {
            Intent shortcutIntent = null;
            Parcelable raw = intent.getParcelableExtra(Intent.EXTRA_SHORTCUT_INTENT);
            if (raw instanceof Intent) shortcutIntent = (Intent) raw;
            CharSequence name = intent.getCharSequenceExtra(Intent.EXTRA_SHORTCUT_NAME);
            JSObject pin = MainActivity.intentToPin(
                    shortcutIntent, name != null ? name.toString() : null, "install-shortcut-broadcast");
            if (pin == null) {
                Log.w(TAG, "INSTALL_SHORTCUT broadcast without usable intent");
                return;
            }
            Log.i(TAG, "INSTALL_SHORTCUT broadcast — " + pin.toString());
            LauncherCoordinator.stashPendingPin(context, pin);
            Intent home = new Intent(context, MainActivity.class);
            home.setAction(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            home.putExtra("cwsp_consume_pending_pin", true);
            context.startActivity(home);
        } catch (Exception e) {
            Log.w(TAG, "INSTALL_SHORTCUT broadcast failed", e);
        }
    }
}
