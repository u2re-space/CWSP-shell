/*
 * Filename: ProcessClipboardWriteActivity.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/ProcessClipboardWriteActivity.java
 * FIND:process-ingress
 *
 * WHY: Android 10+ denies ClipboardManager.setPrimaryClip from an FGS.
 * This focused trampoline writes the AI result, then exits — no Work Center UI.
 */
package space.u2re.cwsp;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

public class ProcessClipboardWriteActivity extends Activity {
    public static final String EXTRA_TEXT = "cwsp_process_clip_text";
    public static final String EXTRA_OK = "cwsp_process_ok";

    private boolean handled = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (handled) {
            finish();
            return;
        }
        handled = true;
        Intent intent = getIntent();
        boolean ok = intent == null || intent.getBooleanExtra(EXTRA_OK, true);
        String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
        if (text == null) text = "";
        boolean wrote = false;
        if (ok && !text.trim().isEmpty()) {
            wrote = writeClipboard(text);
        }
        Toast.makeText(
                        this,
                        wrote
                                ? "Processed and copied"
                                : (ok ? "Processed, but clipboard write failed" : text),
                        Toast.LENGTH_LONG)
                .show();
        /* WHY: FGS acks by stashedAt. A blank ack here would delete a newer share. */
        finish();
    }

    private boolean writeClipboard(String text) {
        try {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(ClipData.newPlainText("cwsp", text));
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }
}
