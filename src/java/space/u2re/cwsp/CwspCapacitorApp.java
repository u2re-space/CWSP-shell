/*
 * Filename: CwspCapacitorApp.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwspCapacitorApp.java
 * Change date and time: 21.40.00_22.08.2026
 * Reason for changes: Application hook so WebView refresh unlock runs before BridgeActivity.
 */

package space.u2re.cwsp;

import android.app.Application;

/** Capacitor process entry — display/WebView refresh unlock before the first WebView. */
public class CwspCapacitorApp extends Application {
    @Override
    public void onCreate() {
        DisplayRefreshUnlock.prepareWebViewProcess(this);
        super.onCreate();
    }
}
