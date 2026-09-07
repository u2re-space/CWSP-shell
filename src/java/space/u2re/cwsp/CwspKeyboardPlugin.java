/*
 * Filename: CwspKeyboardPlugin.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwspKeyboardPlugin.java
 * FIND:virtual-keyboard
 * WHY: Sibling SKUs do not ship @capacitor/keyboard in gradle. adjustNothing
 * leaves visualViewport full-screen; JS reads Capacitor.Plugins.Keyboard.
 */

package space.u2re.cwsp;

import android.app.Activity;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Overlay-IME height for {@code --virtual-keyboard-height}.
 * INVARIANT: report CSS pixels (px / density). Do not install OnApplyWindowInsetsListener
 * on the WebView or decor — that stole cutout / safe-area and zeroed env(safe-area-inset-*).
 */
@CapacitorPlugin(name = "Keyboard")
public class CwspKeyboardPlugin extends Plugin {
    private static final String TAG = "CwspKeyboard";
    private int lastCssPx = -1;
    private boolean attached = false;

    @Override
    public void load() {
        attachImeListener();
    }

    private void attachImeListener() {
        if (attached) return;
        Activity activity = getActivity();
        if (activity == null || activity.getWindow() == null) return;
        View decor = activity.getWindow().getDecorView();
        if (decor == null) return;
        attached = true;
        decor.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(decor);
            if (insets != null) publishIme(insets);
        });
        WindowInsetsCompat now = ViewCompat.getRootWindowInsets(decor);
        if (now != null) publishIme(now);
    }

    private void publishIme(WindowInsetsCompat insets) {
        Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
        float density = 1f;
        try {
            DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
            if (dm != null && dm.density > 0f) density = dm.density;
        } catch (Exception ignored) {
            /* keep 1 */
        }
        int cssPx = Math.max(0, Math.round(ime.bottom / density));
        if (cssPx == lastCssPx) return;
        lastCssPx = cssPx;
        JSObject info = new JSObject();
        info.put("keyboardHeight", cssPx);
        if (cssPx > 0) {
            notifyListeners("keyboardWillShow", info);
            notifyListeners("keyboardDidShow", info);
            triggerWindow("keyboardWillShow", info);
            triggerWindow("keyboardDidShow", info);
        } else {
            JSObject empty = new JSObject();
            notifyListeners("keyboardWillHide", empty);
            notifyListeners("keyboardDidHide", empty);
            triggerWindow("keyboardWillHide", empty);
            triggerWindow("keyboardDidHide", empty);
        }
    }

    private void triggerWindow(String name, JSObject info) {
        try {
            if (getBridge() != null) {
                getBridge().triggerWindowJSEvent(name, info.toString());
            }
        } catch (Exception e) {
            Log.w(TAG, "window event " + name + " failed", e);
        }
    }

    @PluginMethod
    public void setScroll(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void setResizeMode(PluginCall call) {
        call.resolve();
    }
}
