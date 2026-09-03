/*
 * Filename: ProcessShareActivity.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/ProcessShareActivity.java
 * FIND:process-ingress
 *
 * Process SKU share/open-with receiver. No WebView — stash + FGS + finish.
 * INVARIANT: process-mode share must not bring MainActivity to the foreground.
 */
package space.u2re.cwsp;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.JSObject;

public class ProcessShareActivity extends Activity {
    private static final String TAG = "CwspProcessShare";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent intent = getIntent();
        if (intent != null) {
            try {
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
                /* grant optional */
            }
        }
        JSObject share = MainActivity.extractShareFromIntent(intent);
        if (share != null) {
            LauncherCoordinator.stashPendingShare(this, share);
        }
        String kind = ProcessIngressSnapshot.classifyKind(share);
        /* WHY: attach must open Work Center chips. FGS would flash "Processing…" and may run AI. */
        if (!ProcessIngressSnapshot.isProcessMode(this, kind)) {
            Intent main = new Intent(this, MainActivity.class);
            main.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP
                            | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                            | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            main.putExtra(MainActivity.EXTRA_CONSUME_PENDING_SHARE, true);
            startActivity(main);
            finish();
            return;
        }
        try {
            Intent svc = new Intent(this, ProcessIngressService.class);
            if (Build.VERSION.SDK_INT >= 26) {
                startForegroundService(svc);
            } else {
                startService(svc);
            }
        } catch (Exception e) {
            Log.w(TAG, "start ProcessIngressService failed — opening MainActivity", e);
            Intent main = new Intent(this, MainActivity.class);
            main.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP
                            | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                            | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            main.putExtra(MainActivity.EXTRA_CONSUME_PENDING_SHARE, true);
            startActivity(main);
        }
        finish();
    }
}
