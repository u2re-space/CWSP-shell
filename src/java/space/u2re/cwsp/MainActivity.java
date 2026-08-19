/*
 * Filename: MainActivity.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/MainActivity.java
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher APK — system HOME Capacitor shell (no hub bridge daemon).
 */

package space.u2re.cwsp;

import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.WindowManager;
import android.util.Log;

import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * CWSP Launcher Capacitor entrypoint — default HOME launcher SKU.
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "CwspLauncherMain";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(CwsLauncherBridgePlugin.class);
        super.onCreate(savedInstanceState);
        try {
            WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
            getWindow().setBackgroundDrawableResource(android.R.color.transparent);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
        } catch (Exception e) {
            Log.w(TAG, "transparent window failed", e);
        }
        installLauncherBackHandler();
        handleLauncherHomeIntent(getIntent());
    }

    @Override
    public void onStart() {
        super.onStart();
        try {
            Bridge bridge = getBridge();
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);
            }
        } catch (Exception e) {
            Log.w(TAG, "transparent WebView failed", e);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLauncherHomeIntent(intent);
    }

    private static boolean isLauncherHomeIntent(Intent intent) {
        if (intent == null) return false;
        if (!Intent.ACTION_MAIN.equals(intent.getAction())) return false;
        return intent.hasCategory(Intent.CATEGORY_HOME);
    }

    private void handleLauncherHomeIntent(Intent intent) {
        if (!isLauncherHomeIntent(intent)) return;
        Log.i(TAG, "HOME intent — notify WebView");
        notifyLauncherHomePressed();
    }

    private void notifyLauncherHomePressed() {
        try {
            Bridge bridge = getBridge();
            if (bridge != null) {
                bridge.triggerWindowJSEvent("launcherHomePressed", "{}");
            }
        } catch (Exception e) {
            Log.w(TAG, "launcherHomePressed failed", e);
        }
    }

    private void installLauncherBackHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                Bridge bridge = getBridge();
                if (bridge == null) {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                    return;
                }
                bridge.eval(
                        "(function(){try{var s=globalThis.__CWSP_LAUNCHER_HOME__;"
                                + "return s&&s.handleBackPress&&s.handleBackPress()?\"1\":\"0\"}"
                                + "catch(e){return \"0\"}})()",
                        value -> {
                            boolean consumed = value != null && value.contains("1");
                            if (consumed) return;
                            setEnabled(false);
                            getOnBackPressedDispatcher().onBackPressed();
                            setEnabled(true);
                        });
            }
        });
    }
}
