/*
 * Filename: CwspCapacitorApp.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwspCapacitorApp.java
 * Change date and time: 21.40.00_22.08.2026
 * Reason for changes: Application hook so WebView refresh unlock runs before BridgeActivity.
 */

package space.u2re.cwsp;

import android.app.Application;
import android.content.Context;

/** Capacitor process entry — WebView flags + refresh unlock before the first WebView. */
public class CwspCapacitorApp extends Application {
    @Override
    protected void attachBaseContext(Context base) {
        super.attachBaseContext(base);
        /* WHY: CommandLine must be set before BridgeActivity creates a WebView. */
        WebViewPlatformFlags.installProcessFlags(this);
    }

    @Override
    public void onCreate() {
        WebViewPlatformFlags.installProcessFlags(this);
        DisplayRefreshUnlock.prepareWebViewProcess(this);
        super.onCreate();
    }
}
