/*
 * Filename: WebViewPlatformFlags.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/WebViewPlatformFlags.java
 * FIND:webview-flags
 * WHY: Capacitor WebView ships CSS @scope / nesting / cascade layers off or
 * incomplete. Force experimental web-platform + blink CSS features before the
 * first WebView instance (CommandLine is process-global).
 */

package space.u2re.cwsp;

import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;

import java.lang.reflect.Method;

/**
 * Best-effort Chromium switches. Retail WebView ignores {@code /data/local/tmp}
 * flag files; this uses the WebView ClassLoader {@code CommandLine} instead.
 */
public final class WebViewPlatformFlags {
    private static final String TAG = "CwspWebViewFlags";
    /* WHY: umbrella ExperimentalWebPlatformFeatures plus CSS blink names WebView
     * still gates separately (@scope, nesting, overflow-block, stretch, VKB). */
    private static final String BLINK_FEATURES =
            "ExperimentalWebPlatformFeatures,"
            + "CSSNesting,CSSScope,CSSCascadeLayers,CSSHasPseudo,CSSLogical,CSSLogicalOverflow,"
            + "ContainerQueries,ContainerStyleQueries,ContainerQueriesOverflow,"
            + "CSSAnchorPositioning,CSSAnchorPositioningOverlay,"
            + "CSSFunctions,CSSMixins,CSSRelativeColor,CSSColorContrast,"
            + "FieldSizingContent,CSSTextWrapPretty,CSSTextWrapBalance,"
            + "VirtualKeyboardAPI,CSSCustomHighlightAPI,CSSCustomState,"
            + "CSSReadingFlow,CSSScrollStateContainerQueries,CSSGapDecoration";
    private static final String[] PROCESS_SWITCHES = {
            "webview",
            "--enable-experimental-web-platform-features",
            "--enable-blink-features=" + BLINK_FEATURES,
            "--enable-features=ExperimentalWebPlatformFeatures"
    };
    private static boolean processFlagsTried = false;

    private WebViewPlatformFlags() {}

    /** Call from {@code Application.attachBaseContext} before any WebView API besides this. */
    public static void installProcessFlags(Context context) {
        if (processFlagsTried) return;
        processFlagsTried = true;
        if (context == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return;
        try {
            ClassLoader cl = WebView.getWebViewClassLoader();
            Class<?> cmdLine = Class.forName("org.chromium.base.CommandLine", false, cl);
            Method isInitialized = findMethod(cmdLine, "isInitialized", 0);
            boolean inited = false;
            if (isInitialized != null) {
                Object raw = isInitialized.invoke(null);
                inited = raw instanceof Boolean && (Boolean) raw;
            }
            if (!inited) {
                Method init = findMethod(cmdLine, "init", 1);
                if (init != null) {
                    init.invoke(null, (Object) PROCESS_SWITCHES);
                    Log.i(TAG, "CommandLine.init experimental web-platform + " + BLINK_FEATURES);
                    return;
                }
            }
            Object inst = invokeStatic(cmdLine, "getInstance");
            if (inst == null) return;
            appendSwitch(inst, "enable-experimental-web-platform-features");
            appendSwitchWithValue(inst, "enable-blink-features", BLINK_FEATURES);
            appendSwitchWithValue(inst, "enable-features", "ExperimentalWebPlatformFeatures");
            Log.i(TAG, "CommandLine.append experimental web-platform + " + BLINK_FEATURES);
        } catch (Throwable e) {
            Log.w(TAG, "CommandLine flags unavailable", e);
        }
    }

    /** Per-WebView hidden settings after the bridge creates the view. */
    public static void applyToWebView(WebView webView) {
        if (webView == null) return;
        try {
            WebSettings settings = webView.getSettings();
            invokeBooleanSetter(settings, "setExperimentalWebPlatformFeaturesEnabled", true);
            invokeBooleanSetter(settings, "setOffscreenPreRaster", true);
        } catch (Throwable e) {
            Log.w(TAG, "WebSettings experimental setter skipped", e);
        }
    }

    private static Method findMethod(Class<?> type, String name, int argc) {
        for (Method m : type.getMethods()) {
            if (name.equals(m.getName()) && m.getParameterCount() == argc) return m;
        }
        try {
            for (Method m : type.getDeclaredMethods()) {
                if (name.equals(m.getName()) && m.getParameterCount() == argc) {
                    m.setAccessible(true);
                    return m;
                }
            }
        } catch (Throwable ignored) {
            /* hidden */
        }
        return null;
    }

    private static Object invokeStatic(Class<?> type, String name) {
        try {
            Method m = findMethod(type, name, 0);
            return m != null ? m.invoke(null) : null;
        } catch (Throwable e) {
            return null;
        }
    }

    private static void appendSwitch(Object inst, String name) {
        try {
            Method m = inst.getClass().getMethod("appendSwitch", String.class);
            m.invoke(inst, name);
        } catch (Throwable ignored) {
            /* API shape differs */
        }
    }

    private static void appendSwitchWithValue(Object inst, String name, String value) {
        try {
            Method m = inst.getClass().getMethod("appendSwitchWithValue", String.class, String.class);
            m.invoke(inst, name, value);
        } catch (Throwable ignored) {
            /* API shape differs */
        }
    }

    private static void invokeBooleanSetter(Object target, String name, boolean value) {
        try {
            Method m = target.getClass().getMethod(name, boolean.class);
            m.invoke(target, value);
        } catch (Throwable ignored) {
            /* not on this WebView */
        }
    }
}
