/*
 * Filename: DisplayRefreshUnlock.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/DisplayRefreshUnlock.java
 * Change date and time: 21.40.00_22.08.2026
 * Reason for changes: Unlock display / WebView refresh above the Android 15 default 60 Hz.
 */

package space.u2re.cwsp;

import android.app.Activity;
import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.view.Display;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

/**
 * Capacitor / WebView hosts stay at 60 Hz on Android 15+ unless the window
 * and the WebView explicitly request a higher mode (90 / 120 / 144 / 165…).
 *
 * @see <a href="https://developer.android.com/games/optimize/display-refresh-rate-change">Display refresh rate</a>
 * @see <a href="https://developer.android.com/develop/ui/views/animations/adaptive-refresh-rate">Adaptive refresh rate</a>
 */
public final class DisplayRefreshUnlock {
    private static final String TAG = "CwspDisplayRefresh";

    private DisplayRefreshUnlock() {}

    /** Process-level hook — call from {@code Application.onCreate} before any WebView. */
    public static void prepareWebViewProcess(Context context) {
        if (context == null) return;
        /* WHY: no public Chromium switch uncaps rAF; the window display mode does. */
        Log.i(TAG, "WebView process ready for high-refresh window modes");
    }

    public static void applyToWindow(Activity activity) {
        if (activity == null) return;
        Window window = activity.getWindow();
        if (window == null) return;
        try {
            window.addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
        } catch (Throwable e) {
            Log.w(TAG, "hardware flag failed", e);
        }

        Display display = resolveDisplay(activity, window);
        Display.Mode best = pickHighestRefreshMode(display);
        float hz = best != null ? best.getRefreshRate() : (display != null ? display.getRefreshRate() : 60f);

        WindowManager.LayoutParams lp = window.getAttributes();
        if (lp != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && best != null) {
                lp.preferredDisplayModeId = best.getModeId();
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                lp.preferredRefreshRate = hz;
            }
            window.setAttributes(lp);
        }

        if (Build.VERSION.SDK_INT >= 35) {
            try {
                /* WHY: ARR power-save defaults the window to 60 Hz on Android 15. */
                window.setFrameRatePowerSavingsBalanced(false);
            } catch (Throwable e) {
                Log.w(TAG, "ARR disable failed", e);
            }
            requestViewFrameRate(window.getDecorView(), hz);
        }

        Log.i(TAG, "display refresh unlock hz=" + hz
                + (best != null ? (" mode=" + best.getModeId()) : ""));
    }

    public static void applyToWebView(WebView webView) {
        if (webView == null) return;
        try {
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        } catch (Throwable e) {
            Log.w(TAG, "WebView hardware layer failed", e);
        }
        try {
            WebSettings settings = webView.getSettings();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                settings.setOffscreenPreRaster(true);
            }
        } catch (Throwable e) {
            Log.w(TAG, "WebView settings failed", e);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            } catch (Throwable e) {
                Log.w(TAG, "renderer priority failed", e);
            }
        }
        float hz = 120f;
        try {
            Display display = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? webView.getDisplay()
                    : webView.getContext().getDisplay();
            Display.Mode best = pickHighestRefreshMode(display);
            if (best != null) hz = best.getRefreshRate();
            else if (display != null) hz = display.getRefreshRate();
        } catch (Throwable ignored) {
            /* keep 120 fallback */
        }
        requestViewFrameRate(webView, hz);
    }

    public static float peekMaxRefreshHz(Context context) {
        try {
            Display display = context instanceof Activity
                    ? resolveDisplay((Activity) context, ((Activity) context).getWindow())
                    : (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? context.getDisplay() : null);
            Display.Mode best = pickHighestRefreshMode(display);
            if (best != null) return best.getRefreshRate();
            if (display != null) return display.getRefreshRate();
        } catch (Throwable ignored) {
            /* ignore */
        }
        return 60f;
    }

    private static Display resolveDisplay(Activity activity, Window window) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Display d = activity.getDisplay();
                if (d != null) return d;
            }
        } catch (Throwable ignored) {
            /* ignore */
        }
        try {
            return window.getWindowManager().getDefaultDisplay();
        } catch (Throwable e) {
            return null;
        }
    }

    /**
     * Prefer the highest refresh rate at the current resolution (do not jump to a
     * lower-res 165 Hz mode). Fall back to the global max if no same-res mode exists.
     */
    private static Display.Mode pickHighestRefreshMode(Display display) {
        if (display == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return null;
        Display.Mode[] modes;
        Display.Mode current;
        try {
            modes = display.getSupportedModes();
            current = display.getMode();
        } catch (Throwable e) {
            return null;
        }
        if (modes == null || modes.length == 0) return current;
        int w = current != null ? current.getPhysicalWidth() : 0;
        int h = current != null ? current.getPhysicalHeight() : 0;
        Display.Mode bestSame = null;
        Display.Mode bestAny = current;
        for (Display.Mode mode : modes) {
            if (mode == null) continue;
            if (bestAny == null || mode.getRefreshRate() > bestAny.getRefreshRate()) {
                bestAny = mode;
            }
            if (w > 0 && h > 0
                    && mode.getPhysicalWidth() == w
                    && mode.getPhysicalHeight() == h) {
                if (bestSame == null || mode.getRefreshRate() > bestSame.getRefreshRate()) {
                    bestSame = mode;
                }
            }
        }
        return bestSame != null ? bestSame : bestAny;
    }

    private static void requestViewFrameRate(View view, float hz) {
        if (view == null || Build.VERSION.SDK_INT < 35) return;
        try {
            float target = hz > 1f ? hz : View.REQUESTED_FRAME_RATE_CATEGORY_HIGH;
            view.setRequestedFrameRate(target);
        } catch (Throwable e) {
            try {
                view.setRequestedFrameRate(View.REQUESTED_FRAME_RATE_CATEGORY_HIGH);
            } catch (Throwable ignored) {
                /* API surface missing on some OEM 15 builds */
            }
        }
    }
}
