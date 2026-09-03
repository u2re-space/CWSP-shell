/*
 * Filename: MainActivity.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/MainActivity.java
 * Change date and time: 12.24.00_30.08.2026
 * Reason for changes: onResume kicks JS theme/adopted-sheet restore after background.
 */

package space.u2re.cwsp;

import android.content.Intent;
import android.content.pm.LauncherApps;
import android.content.pm.ShortcutInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Parcelable;
import android.view.WindowManager;
import android.util.Log;

import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.JSObject;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * CWSP Launcher Capacitor entrypoint — default HOME launcher SKU.
 * Accepts Share / Open-with URLs and system pin-shortcut requests (Material Files, etc.).
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "CwspLauncherMain";
    static final String EXTRA_CONSUME_PENDING_SHARE = "cwsp_consume_pending_share";
    private static final String ACTION_INSTALL_SHORTCUT = "com.android.launcher.action.INSTALL_SHORTCUT";
    private boolean shareNotifyPending = false;
    private static final Pattern URL_IN_TEXT =
            Pattern.compile("(https?://[^\\s<>\"']+|www\\.[^\\s<>\"']+)", Pattern.CASE_INSENSITIVE);

    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        registerPlugin(CwsLauncherBridgePlugin.class);
        try {
            EdgeToEdge.enable(
                    this,
                    SystemBarStyle.dark(Color.TRANSPARENT),
                    SystemBarStyle.dark(Color.TRANSPARENT));
        } catch (Exception e) {
            Log.w(TAG, "EdgeToEdge.enable failed", e);
        }
        super.onCreate(savedInstanceState);
        hideNativeTitleBar();
        try {
            DisplayRefreshUnlock.applyToWindow(this);
            applyTransparentSystemBars();
            getWindow().setBackgroundDrawableResource(android.R.color.transparent);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
        } catch (Exception e) {
            Log.w(TAG, "transparent window failed", e);
        }
        installLauncherBackHandler();
        handleIncomingIntent(getIntent());
    }

    @Override
    public void onStart() {
        super.onStart();
        hideNativeTitleBar();
        applyTransparentSystemBars();
        DisplayRefreshUnlock.applyToWindow(this);
        try {
            Bridge bridge = getBridge();
            if (bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().setBackgroundColor(Color.TRANSPARENT);
                DisplayRefreshUnlock.applyToWebView(bridge.getWebView());
            }
        } catch (Exception e) {
            Log.w(TAG, "transparent WebView failed", e);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        applyTransparentSystemBars();
        DisplayRefreshUnlock.applyToWindow(this);
        try {
            Bridge bridge = getBridge();
            if (bridge != null && bridge.getWebView() != null) {
                DisplayRefreshUnlock.applyToWebView(bridge.getWebView());
                /* WHY: visibilitychange is not reliable after recents; adopted sheets stay empty. */
                bridge.eval(
                        "(function(){try{var f=globalThis.__CWSP_THEME_RESUME__;"
                                + "if(typeof f==='function'){f(true);return\"1\"}return\"0\"}catch(e){return\"0\"}})()",
                        value -> {});
            }
        } catch (Exception e) {
            Log.w(TAG, "refresh unlock onResume failed", e);
        }
        JSObject pendingShare = LauncherCoordinator.peekPendingShare(this);
        if (shareNotifyPending && pendingShare != null) {
            notifyShareIntent(pendingShare);
        } else if (pendingShare != null) {
            /* WHY: attach Open-with while already resumed can miss cws:shareIntent.
             * Process-mode stash belongs to ProcessIngressService — do not ack it from JS. */
            String kind = ProcessIngressSnapshot.classifyKind(pendingShare);
            if (!ProcessIngressSnapshot.isProcessMode(this, kind)) {
                notifyShareIntent(pendingShare);
            }
        }
    }

    /** WHY: Application AppTheme was DarkActionBar — splash/EdgeToEdge can revive a title strip. */
    private void hideNativeTitleBar() {
        try {
            setTitle("");
            androidx.appcompat.app.ActionBar bar = getSupportActionBar();
            if (bar != null) bar.hide();
        } catch (Exception e) {
            Log.w(TAG, "hide title bar failed", e);
        }
    }

    /**
     * FIND:navbar
     * WHY: Transparent 3-button nav still reserves a slab. Hide it (swipe to peek).
     * Wallpaper stays visible via FLAG_SHOW_WALLPAPER + transparent WebView.
     */
    private void applyTransparentSystemBars() {
        android.view.Window window = getWindow();
        if (window == null) return;
        try {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                WindowManager.LayoutParams lp = window.getAttributes();
                lp.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
                window.setAttributes(lp);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                window.setNavigationBarDividerColor(Color.TRANSPARENT);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                window.setNavigationBarContrastEnforced(false);
                window.setStatusBarContrastEnforced(false);
            }
            WindowInsetsControllerCompat insets =
                    WindowCompat.getInsetsController(window, window.getDecorView());
            if (insets != null) {
                insets.setAppearanceLightStatusBars(false);
                insets.setAppearanceLightNavigationBars(false);
                insets.setSystemBarsBehavior(
                        WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                insets.hide(WindowInsetsCompat.Type.navigationBars());
            }
        } catch (Exception e) {
            Log.w(TAG, "transparent system bars failed", e);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyTransparentSystemBars();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (CwsWidgetHost.dispatchActivityResult(requestCode, resultCode, data)) return;
        if (CwsStorageHost.dispatchActivityResult(requestCode, resultCode, data)) return;
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null) return;
        Log.i(TAG, "incoming action=" + intent.getAction());
        /* WHY: ProcessShareActivity stashes then opens MainActivity without SEND extras.
         * Warm start would never fire cws:shareIntent unless we peek the stash here. */
        if (intent.getBooleanExtra(EXTRA_CONSUME_PENDING_SHARE, false)) {
            JSObject pending = LauncherCoordinator.peekPendingShare(this);
            if (pending != null) notifyShareIntent(pending);
        }

        if (tryHandlePinShortcutRequest(intent)) {
            clearTransientIntent(intent);
            return;
        }

        if (tryHandleLegacyInstallShortcut(intent)) {
            clearTransientIntent(intent);
            return;
        }

        if (isLauncherHomeIntent(intent) || intent.getBooleanExtra("cwsp_consume_pending_pin", false)) {
            Log.i(TAG, "HOME intent — notify WebView");
            notifyLauncherHomePressed();
            try {
                JSObject pending = LauncherCoordinator.peekPendingPin(this);
                if (pending != null) notifyLauncherPinShortcut(pending);
            } catch (Exception e) {
                Log.w(TAG, "pending pin notify failed", e);
            }
            return;
        }
        JSObject pin = extractPinFromIntent(intent);
        JSObject share = extractShareFromIntent(intent);
        boolean shareHasLocalUri = shareHasLocalUri(share);
        /*
         * WHY: Process/Document/Explorer must ingest URL SEND/VIEW as share, not a
         * launcher pin. Only the HOME SKU keeps the pin path.
         */
        if (share != null && (shareHasLocalUri || pin == null || !BuildConfig.CWSP_LAUNCHER_SKU)) {
            Log.i(TAG, "share-intent — pending file/text");
            LauncherCoordinator.stashPendingShare(this, share);
            notifyShareIntent(share);
        }
        if (pin != null && BuildConfig.CWSP_LAUNCHER_SKU) {
            Log.i(TAG, "pin-shortcut intent — " + pin.toString());
            LauncherCoordinator.stashPendingPin(this, pin);
            notifyLauncherPinShortcut(pin);
        }
        if (share != null || pin != null) clearTransientIntent(intent);
    }

    private static boolean shareHasLocalUri(JSObject share) {
        if (share == null || !share.has("uri")) return false;
        try {
            String uri = String.valueOf(share.get("uri")).trim().toLowerCase(Locale.US);
            return uri.startsWith("content:") || uri.startsWith("file:");
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * SEND / VIEW / PROCESS_TEXT → JS SKU pipeline. Bytes stay on disk
     * ({@link LauncherCoordinator#stashPendingShare}); the event is metadata only.
     */
    static JSObject extractShareFromIntent(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        if (action == null) return null;
        boolean send = Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action);
        boolean view = Intent.ACTION_VIEW.equals(action);
        boolean process = Intent.ACTION_PROCESS_TEXT.equals(action);
        if (!send && !view && !process) return null;

        /* WHY: Transfer opens Explorer with results via space.u2re.explorer://open?path= */
        if (view) {
            try {
                Uri data = intent.getData();
                String sch =
                        data != null && data.getScheme() != null
                                ? data.getScheme().toLowerCase(Locale.US)
                                : "";
                if (sch.startsWith("space.u2re.")) {
                    String path = data.getQueryParameter("path");
                    if (path == null || path.isEmpty()) path = data.getQueryParameter("src");
                    if (path != null && !path.trim().isEmpty()) {
                        String folder = path.trim();
                        if ("/saf".equals(folder) || "/saf/".equals(folder)) {
                            folder = "/sdcard/Download/";
                        } else {
                            String mapped = fileOsPathToSdcard(folder);
                            if (mapped.isEmpty() && (folder.startsWith("content:") || folder.startsWith("file:"))) {
                                try {
                                    mapped = toExplorerSdcardDir(Uri.parse(folder));
                                } catch (Exception ignored) {
                                    mapped = "";
                                }
                            }
                            if (!mapped.isEmpty()) folder = mapped;
                        }
                        JSObject open = new JSObject();
                        open.put("url", folder);
                        open.put("text", folder);
                        return open;
                    }
                }
                String mime = intent.getType();
                String ml = mime != null ? mime.toLowerCase(Locale.US) : "";
                if ("vnd.android.document/directory".equals(ml)
                        || "resource/folder".equals(ml)
                        || "inode/directory".equals(ml)) {
                    JSObject open = new JSObject();
                    String folder = virtualFolderFromBrowseUri(data);
                    open.put("url", folder);
                    open.put("text", folder);
                    return open;
                }
            } catch (Exception ignored) {
                /* fall through */
            }
        }

        JSObject share = new JSObject();
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (process) {
            CharSequence pt = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT);
            if (pt != null) text = pt.toString();
        }
        String title = firstNonEmpty(
                intent.getStringExtra(Intent.EXTRA_TITLE),
                intent.getStringExtra(Intent.EXTRA_SUBJECT));
        if (text != null && !text.trim().isEmpty()) share.put("text", text.trim());
        if (title != null && !title.trim().isEmpty()) share.put("title", title.trim());

        Uri uri = extractDocumentUri(intent);
        if (uri != null) {
            String raw = uri.toString();
            if (raw != null && !raw.isEmpty()) {
                share.put("uri", raw);
                share.put("url", raw);
                String name = uri.getLastPathSegment();
                if (name != null && !name.isEmpty()) share.put("name", name);
            }
        }
        String mime = guessMimeType(share.getString("name", title), intent.getType());
        if (mime != null && !mime.trim().isEmpty()) share.put("mime", mime.trim());

        if (!share.has("text") && !share.has("uri")) return null;
        return share;
    }

    private void clearTransientIntent(Intent intent) {
        try {
            intent.replaceExtras((Bundle) null);
            intent.setAction(Intent.ACTION_MAIN);
            /* WHY: CATEGORY_HOME is launcher-only. Document/Explorer must not become a HOME intent. */
            if (BuildConfig.CWSP_LAUNCHER_SKU) {
                intent.addCategory(Intent.CATEGORY_HOME);
            }
        } catch (Exception e) {
            Log.w(TAG, "clear pin intent failed", e);
        }
    }

    /**
     * API 26+: {@link LauncherApps#ACTION_CONFIRM_PIN_SHORTCUT} from Material Files / apps
     * that call {@code ShortcutManager.requestPinShortcut}.
     */
    private boolean tryHandlePinShortcutRequest(Intent intent) {
        if (!LauncherCoordinator.handleConfirmPin(this, intent)) return false;
        notifyLauncherPinShortcut(null);
        notifyLauncherHomePressed();
        return true;
    }

    /** Older file managers: INSTALL_SHORTCUT activity / extras. */
    private boolean tryHandleLegacyInstallShortcut(Intent intent) {
        if (intent == null) return false;
        String action = intent.getAction();
        if (action == null || !ACTION_INSTALL_SHORTCUT.equals(action)) return false;
        try {
            Intent shortcutIntent = null;
            Parcelable raw = intent.getParcelableExtra(Intent.EXTRA_SHORTCUT_INTENT);
            if (raw instanceof Intent) shortcutIntent = (Intent) raw;
            CharSequence name = intent.getCharSequenceExtra(Intent.EXTRA_SHORTCUT_NAME);
            JSObject pin = intentToPin(shortcutIntent, name != null ? name.toString() : null, "install-shortcut");
            if (pin == null) return false;
            Log.i(TAG, "INSTALL_SHORTCUT — " + pin.toString());
            LauncherCoordinator.stashPendingPin(this, pin);
            notifyLauncherPinShortcut(pin);
            notifyLauncherHomePressed();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "INSTALL_SHORTCUT failed", e);
            return false;
        }
    }

    private JSObject shortcutInfoToPin(ShortcutInfo info) {
        if (info == null) return null;
        String label = null;
        try {
            CharSequence shortLabel = info.getShortLabel();
            if (shortLabel != null && shortLabel.length() > 0) label = shortLabel.toString();
            if (label == null || label.trim().isEmpty()) {
                CharSequence longLabel = info.getLongLabel();
                if (longLabel != null && longLabel.length() > 0) label = longLabel.toString();
            }
        } catch (Exception ignored) {
            /* ignore */
        }

        String pkg = null;
        String shortcutId = null;
        try {
            pkg = info.getPackage();
            shortcutId = info.getId();
        } catch (Exception ignored) {
            /* ignore */
        }

        /* WHY: do not bake PNG data-URLs into the pin payload — evaluateJavascript
         * of that JSON killed Capacitor when pinning Material Files .txt shortcuts.
         * WebView hydrates via launcher:shortcut-icon (package + shortcutId). */
        Intent[] intents = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
                intents = info.getIntents();
            }
        } catch (Exception e) {
            Log.w(TAG, "ShortcutInfo.getIntents failed", e);
        }
        if (intents == null || intents.length == 0) {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
                    Intent one = info.getIntent();
                    if (one != null) intents = new Intent[] {one};
                }
            } catch (Exception e) {
                Log.w(TAG, "ShortcutInfo.getIntent failed", e);
            }
        }

        /* Prefer a real document/http target over ACTION_MAIN → Files. */
        JSObject docPin = null;
        Intent docLaunch = null;
        if (intents != null) {
            for (Intent launch : intents) {
                if (launch == null) continue;
                JSObject candidate = intentToPin(launch, label, "pin-shortcut");
                if (candidate == null) continue;
                String action = candidate.getString("action", "");
                if ("open-uri".equals(action) || "open-link".equals(action)) {
                    docPin = candidate;
                    docLaunch = launch;
                    break;
                }
            }
        }

        if (docPin == null) {
            Uri fromExtras = extractUriFromShortcutExtras(info);
            if (fromExtras != null) {
                String uri = fromExtras.toString();
                if (uri != null && !uri.isEmpty()) {
                    docPin = new JSObject();
                    docPin.put("url", uri);
                    docPin.put("href", uri);
                    if (label != null && !label.trim().isEmpty()) docPin.put("label", label.trim());
                    docPin.put("source", "pin-shortcut");
                    String scheme = fromExtras.getScheme();
                    if (scheme != null
                            && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
                        docPin.put("action", "open-link");
                    } else {
                        docPin.put("action", "open-uri");
                    }
                    String mime = guessMimeType(label, null);
                    if (mime != null && !mime.isEmpty()) docPin.put("mimeType", mime);
                }
            }
        }

        if (docPin != null) {
            try {
                if (shortcutId != null && !shortcutId.isEmpty()) docPin.put("shortcutId", shortcutId);
                if (pkg != null && !pkg.isEmpty()) {
                    docPin.put("publisherPackage", pkg);
                }
                if (!docPin.has("mimeType") || docPin.getString("mimeType", "").isEmpty()) {
                    String mime =
                            guessMimeType(label, docLaunch != null ? docLaunch.getType() : null);
                    if (mime != null && !mime.isEmpty()) docPin.put("mimeType", mime);
                }
                docPin.put("iconDisplay", "colored");
            } catch (Exception ignored) {
                /* ignore */
            }
            Log.i(TAG, "pin document shortcut — " + docPin.toString());
            return docPin;
        }

        /*
         * WHY: Material Files / DocumentsUI often redact Intent data when another app
         * reads ShortcutInfo.getIntent(). Launchers must use LauncherApps.startShortcut
         * with package + shortcutId — NOT launch the publisher app via ACTION_MAIN.
         */
        if (pkg != null
                && !pkg.isEmpty()
                && shortcutId != null
                && !shortcutId.isEmpty()) {
            JSObject pin = new JSObject();
            pin.put("packageName", pkg);
            pin.put("shortcutId", shortcutId);
            pin.put("action", "launch-shortcut");
            if (label != null && !label.trim().isEmpty()) pin.put("label", label.trim());
            pin.put("source", "pin-shortcut");
            String mime = guessMimeType(label, null);
            if (mime != null && !mime.isEmpty()) pin.put("mimeType", mime);
            pin.put("iconDisplay", "colored");
            Log.i(TAG, "pin via startShortcut — " + pin.toString());
            return pin;
        }

        Log.w(TAG, "CONFIRM_PIN_SHORTCUT: no document URI and no shortcutId");
        return null;
    }

    /** Scan ShortcutInfo extras for a content/file/http URI string. */
    private static Uri extractUriFromShortcutExtras(ShortcutInfo info) {
        if (info == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return null;
        try {
            android.os.PersistableBundle extras = info.getExtras();
            if (extras == null) return null;
            for (String key : extras.keySet()) {
                if (key == null) continue;
                try {
                    Object raw = extras.get(key);
                    if (raw instanceof String) {
                        Uri u = uriIfDocumentScheme((String) raw);
                        if (u != null) return u;
                    }
                } catch (Exception ignored) {
                    /* ignore bad extra */
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "ShortcutInfo extras scan failed", e);
        }
        return null;
    }

    private static Uri uriIfDocumentScheme(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        String lower = s.toLowerCase(Locale.US);
        if (!(lower.startsWith("content:")
                || lower.startsWith("file:")
                || lower.startsWith("http:")
                || lower.startsWith("https:"))) {
            return null;
        }
        try {
            return Uri.parse(s);
        } catch (Exception e) {
            return null;
        }
    }

    /** Prefer Intent data; Material Files often puts the document URI in ClipData / EXTRA_STREAM. */
    static Uri extractDocumentUri(Intent launch) {
        if (launch == null) return null;
        try {
            Uri data = launch.getData();
            if (data != null) return data;
        } catch (Exception ignored) {
            /* ignore */
        }
        try {
            android.content.ClipData clip = launch.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                Uri u = clip.getItemAt(0).getUri();
                if (u != null) return u;
            }
        } catch (Exception ignored) {
            /* ignore */
        }
        try {
            Parcelable stream = launch.getParcelableExtra(Intent.EXTRA_STREAM);
            if (stream instanceof Uri) return (Uri) stream;
        } catch (Exception ignored) {
            /* ignore */
        }
        try {
            java.util.ArrayList<Parcelable> many = launch.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) {
                for (Parcelable item : many) {
                    if (item instanceof Uri) return (Uri) item;
                }
            }
        } catch (Exception ignored) {
            /* SEND_MULTIPLE */
        }
        /* String extras some file managers use. */
        try {
            Bundle extras = launch.getExtras();
            if (extras != null) {
                for (String key : extras.keySet()) {
                    Object v = extras.get(key);
                    if (v instanceof Uri) {
                        Uri u = (Uri) v;
                        if (u.getScheme() != null) return u;
                    } else if (v instanceof String) {
                        Uri u = uriIfDocumentScheme((String) v);
                        if (u != null) return u;
                    }
                }
            }
        } catch (Exception ignored) {
            /* ignore */
        }
        return null;
    }

    static String guessMimeType(String label, String declared) {
        if (declared != null) {
            String t = declared.trim();
            if (!t.isEmpty() && !"*/*".equals(t)) return t;
        }
        String name = label != null ? label.trim().toLowerCase(Locale.US) : "";
        int slash = name.lastIndexOf('/');
        if (slash >= 0 && slash + 1 < name.length()) name = name.substring(slash + 1);
        if (name.endsWith(".txt") || name.endsWith(".log") || name.endsWith(".csv")) {
            return "text/plain";
        }
        if (name.endsWith(".md") || name.endsWith(".markdown")) return "text/markdown";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".mp4")) return "video/mp4";
        if (name.endsWith(".mp3")) return "audio/mpeg";
        if (name.endsWith(".html") || name.endsWith(".htm")) return "text/html";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".zip")) return "application/zip";
        return declared != null ? declared.trim() : "";
    }

    public static JSObject intentToPin(Intent launch, String label, String source) {
        if (launch == null) return null;
        Uri data = extractDocumentUri(launch);
        String action = launch.getAction();
        String pkg = launch.getPackage();
        if ((pkg == null || pkg.isEmpty()) && launch.getComponent() != null) {
            pkg = launch.getComponent().getPackageName();
        }
        String mime = guessMimeType(label, launch.getType());

        if (data != null) {
            String uri = data.toString();
            if (uri != null && !uri.isEmpty()) {
                JSObject pin = new JSObject();
                pin.put("url", uri);
                pin.put("href", uri);
                if (label != null && !label.trim().isEmpty()) pin.put("label", label.trim());
                pin.put("source", source != null ? source : "intent");
                String scheme = data.getScheme();
                if (scheme != null) {
                    String lower = scheme.toLowerCase(Locale.US);
                    if ("http".equals(lower) || "https".equals(lower)) {
                        pin.put("action", "open-link");
                    } else {
                        pin.put("action", "open-uri");
                    }
                }
                if (mime != null && !mime.isEmpty()) pin.put("mimeType", mime);
                /* WHY: never attach publisher package or Intent.toUri — both crashed the WebView. */
                return pin;
            }
        }

        if (Intent.ACTION_MAIN.equals(action) && pkg != null && !pkg.isEmpty()) {
            JSObject pin = new JSObject();
            pin.put("packageName", pkg);
            pin.put("action", "launch-app");
            if (label != null && !label.trim().isEmpty()) pin.put("label", label.trim());
            pin.put("source", source != null ? source : "intent");
            if (launch.getComponent() != null) {
                pin.put("componentName", launch.getComponent().flattenToShortString());
            }
            return pin;
        }

        /* Last resort: package tile only — Intent.toUri must not enter the WebView bridge. */
        if (pkg != null && !pkg.isEmpty()) {
            JSObject pin = new JSObject();
            pin.put("packageName", pkg);
            pin.put("action", "launch-app");
            if (label != null && !label.trim().isEmpty()) pin.put("label", label.trim());
            pin.put("source", source != null ? source : "intent");
            if (launch.getComponent() != null) {
                pin.put("componentName", launch.getComponent().flattenToShortString());
            }
            return pin;
        }
        return null;
    }

    private static boolean isLauncherHomeIntent(Intent intent) {
        if (intent == null) return false;
        if (!Intent.ACTION_MAIN.equals(intent.getAction())) return false;
        return intent.hasCategory(Intent.CATEGORY_HOME);
    }

    /** Share text / Open-with http(s) → Speed Dial open-link tile payload. */
    private static JSObject extractPinFromIntent(Intent intent) {
        if (intent == null) return null;
        String action = intent.getAction();
        if (action == null) return null;

        if (Intent.ACTION_SEND.equals(action) || Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            String type = intent.getType();
            if (type != null && type.startsWith("text/")) {
                String text = intent.getStringExtra(Intent.EXTRA_TEXT);
                String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                String title = intent.getStringExtra(Intent.EXTRA_TITLE);
                String url = firstUrl(text);
                if (url == null || url.isEmpty()) url = firstUrl(subject);
                if (url == null || url.isEmpty()) return null;
                return pinPayload(url, firstNonEmpty(title, subject), text, "share");
            }
            return null;
        }

        if (Intent.ACTION_VIEW.equals(action)) {
            Uri data = intent.getData();
            if (data == null) return null;
            String scheme = data.getScheme();
            if (scheme == null) return null;
            String lower = scheme.toLowerCase(Locale.US);
            if (!"http".equals(lower) && !"https".equals(lower)) return null;
            String url = data.toString();
            if (url == null || url.isEmpty()) return null;
            return pinPayload(url, null, null, "view");
        }

        return null;
    }

    private static JSObject pinPayload(String url, String label, String text, String source) {
        JSObject pin = new JSObject();
        pin.put("url", normalizeUrl(url));
        pin.put("href", normalizeUrl(url));
        if (label != null && !label.trim().isEmpty()) pin.put("label", label.trim());
        if (text != null && !text.trim().isEmpty()) pin.put("text", text.trim());
        pin.put("source", source != null ? source : "intent");
        pin.put("action", "open-link");
        return pin;
    }

    private static String normalizeUrl(String raw) {
        String s = raw != null ? raw.trim() : "";
        if (s.isEmpty()) return "";
        if (s.toLowerCase(Locale.US).startsWith("www.")) {
            return "https://" + s;
        }
        return s;
    }

    private static String firstUrl(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        if (s.matches("(?i)^https?://.+") || s.matches("(?i)^www\\..+")) {
            return s.split("\\s+")[0];
        }
        Matcher m = URL_IN_TEXT.matcher(s);
        if (m.find()) return m.group(1);
        return null;
    }

    /**
     * Map a folder VIEW onto Explorer {@code /sdcard/…/}.
     * WHY: Transfer SAF trees are {@code primary:Download/…}, not Explorer {@code /saf/}.
     */
    private static String virtualFolderFromBrowseUri(Uri data) {
        if (data == null) return "/sdcard/Download/";
        String mapped = toExplorerSdcardDir(data);
        return mapped.isEmpty() ? "/sdcard/Download/" : mapped;
    }

    private static String toExplorerSdcardDir(Uri uri) {
        if (uri == null) return "";
        if ("file".equalsIgnoreCase(uri.getScheme())) {
            return fileOsPathToSdcard(uri.getPath());
        }
        String docId = "";
        try {
            docId = android.provider.DocumentsContract.getDocumentId(uri);
        } catch (Exception ignored) {
            /* tree */
        }
        if (docId == null || docId.isEmpty()) {
            try {
                docId = android.provider.DocumentsContract.getTreeDocumentId(uri);
            } catch (Exception ignored) {
                /* last segment */
            }
        }
        if (docId == null || docId.isEmpty()) {
            java.util.List<String> segs = uri.getPathSegments();
            if (segs != null) {
                for (int i = segs.size() - 1; i >= 0; i--) {
                    String seg = segs.get(i);
                    if (seg != null && seg.contains(":")) {
                        docId = seg;
                        break;
                    }
                }
            }
        }
        String fromDoc = documentIdToSdcard(docId);
        if (!fromDoc.isEmpty()) return fromDoc;
        return fileOsPathToSdcard(uri.getPath());
    }

    private static String documentIdToSdcard(String docId) {
        if (docId == null || docId.isEmpty()) return "";
        int colon = docId.indexOf(':');
        if (colon < 0) return "";
        String volume = docId.substring(0, colon);
        String rel = docId.substring(colon + 1).replace('\\', '/');
        while (rel.startsWith("/")) rel = rel.substring(1);
        if (!"primary".equalsIgnoreCase(volume) && !"home".equalsIgnoreCase(volume)) {
            return "";
        }
        if (rel.isEmpty()) return "/sdcard/";
        return rel.endsWith("/") ? "/sdcard/" + rel : "/sdcard/" + rel + "/";
    }

    private static String fileOsPathToSdcard(String path) {
        if (path == null || path.trim().isEmpty()) return "";
        String p = path.trim().replace('\\', '/');
        String[] prefixes = { "/storage/emulated/0", "/mnt/sdcard", "/sdcard" };
        for (String pre : prefixes) {
            if (p.equals(pre) || p.startsWith(pre + "/")) {
                String rest = p.substring(pre.length());
                if (rest.isEmpty() || "/".equals(rest)) return "/sdcard/";
                if (!rest.startsWith("/")) rest = "/" + rest;
                return rest.endsWith("/") ? "/sdcard" + rest : "/sdcard" + rest + "/";
            }
        }
        return "";
    }

    private static String firstNonEmpty(String a, String b) {
        if (a != null && !a.trim().isEmpty()) return a.trim();
        if (b != null && !b.trim().isEmpty()) return b.trim();
        return null;
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

    private void notifyShareIntent(JSObject share) {
        try {
            Bridge bridge = getBridge();
            if (bridge == null) {
                shareNotifyPending = true;
                return;
            }
            /* WHY: metadata ping only — file bytes go through launcher:pending-share. */
            JSObject slim = new JSObject();
            slim.put("type", "share-received");
            slim.put("source", "share-target");
            slim.put("pending", true);
            if (share != null) {
                try {
                    if (share.has("title")) slim.put("title", String.valueOf(share.get("title")));
                    if (share.has("name")) slim.put("name", String.valueOf(share.get("name")));
                    if (share.has("mime")) slim.put("mime", String.valueOf(share.get("mime")));
                    if (share.has("stashedAt")) slim.put("stashedAt", LauncherCoordinator.readStashedAt(share));
                    if (share.has("text")) {
                        String text = String.valueOf(share.get("text"));
                        if (text.length() > 400) text = text.substring(0, 400);
                        if (!text.isEmpty() && !"null".equals(text)) slim.put("text", text);
                    }
                } catch (Exception ignored) {
                    /* metadata optional */
                }
            }
            bridge.triggerWindowJSEvent("cws:shareIntent", slim.toString());
            /* WHY: Capacitor window events can drop while the WebView is paused under ProcessShareActivity. */
            bridge.eval(
                    "(function(){try{window.dispatchEvent(new CustomEvent(\"cws:shareIntent\",{detail:{pending:true}}));return\"1\"}catch(e){return\"0\"}})()",
                    value -> {});
            shareNotifyPending = false;
        } catch (Exception e) {
            shareNotifyPending = true;
            Log.w(TAG, "cws:shareIntent notify failed", e);
        }
    }

    private void notifyLauncherPinShortcut(JSObject pin) {
        try {
            Bridge bridge = getBridge();
            if (bridge != null) {
                /* WHY: never inject pin JSON into evaluateJavascript — intentUri/data:
                 * payloads crashed Capacitor. JS reads the slim stash via launcher:pending-pin. */
                bridge.triggerWindowJSEvent("launcherPinShortcut", "{\"pending\":true}");
            }
        } catch (Exception e) {
            Log.w(TAG, "launcherPinShortcut failed", e);
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
                        "(function(){try{"
                                + "var n=globalThis.__CWSP_NATIVE_BACK__;"
                                + "if(n&&n.handleBackPress&&n.handleBackPress())return\"1\";"
                                + "var s=globalThis.__CWSP_LAUNCHER_HOME__;"
                                + "return s&&s.handleBackPress&&s.handleBackPress()?\"1\":\"0\""
                                + "}catch(e){return\"0\"}})()",
                        value -> {
                            boolean consumed = value != null && value.contains("1");
                            if (consumed) return;
                            /*
                             * WHY: Default back runs WebView.goBack() or finishes the activity —
                             * on a HOME launcher that reads as a cold restart + blank wallpaper.
                             */
                            try {
                                moveTaskToBack(true);
                            } catch (Exception e) {
                                Log.w(TAG, "moveTaskToBack fallback failed", e);
                            }
                        });
            }
        });
    }
}
