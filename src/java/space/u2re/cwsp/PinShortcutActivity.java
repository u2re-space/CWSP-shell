/*
 * Filename: PinShortcutActivity.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/PinShortcutActivity.java
 * Change date and time: 21.55.00_23.08.2026
 * Reason for changes: Dedicated pin receiver — singleTask HOME was dropping CONFIRM_PIN_SHORTCUT.
 * FIND:pin-shortcut
 */

package space.u2re.cwsp;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Parcelable;
import android.util.Log;

import com.getcapacitor.JSObject;

/**
 * Thin, no-Capacitor handler for Material Files / {@code requestPinShortcut}.
 * Accepts the pin, stashes a slim payload, then brings the HOME task forward.
 */
public class PinShortcutActivity extends Activity {
    private static final String TAG = "CwspPinShortcut";
    private static final String ACTION_INSTALL_SHORTCUT = "com.android.launcher.action.INSTALL_SHORTCUT";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        Log.i(TAG, "onCreate action=" + (intent != null ? intent.getAction() : "null"));
        boolean handled = LauncherCoordinator.handleConfirmPin(this, intent);
        String label = "";
        if (!handled) {
            handled = tryLegacyInstall(intent);
        }
        if (handled) {
            JSObject pending = LauncherCoordinator.peekPendingPin(this);
            if (pending != null) {
                label = pending.getString("label", "");
            }
            LauncherCoordinator.toastAndBringHome(this, label);
        } else {
            Log.w(TAG, "pin intent not handled — finishing");
        }
        finish();
    }

    private boolean tryLegacyInstall(Intent intent) {
        if (intent == null || !ACTION_INSTALL_SHORTCUT.equals(intent.getAction())) return false;
        try {
            Parcelable raw = intent.getParcelableExtra(Intent.EXTRA_SHORTCUT_INTENT);
            Intent shortcutIntent = raw instanceof Intent ? (Intent) raw : null;
            CharSequence name = intent.getCharSequenceExtra(Intent.EXTRA_SHORTCUT_NAME);
            JSObject pin =
                    MainActivity.intentToPin(
                            shortcutIntent, name != null ? name.toString() : null, "install-shortcut");
            if (pin == null) return false;
            LauncherCoordinator.stashPendingPin(this, pin);
            Log.i(TAG, "INSTALL_SHORTCUT — " + pin.toString());
            return true;
        } catch (Exception e) {
            Log.w(TAG, "INSTALL_SHORTCUT failed", e);
            return false;
        }
    }
}
