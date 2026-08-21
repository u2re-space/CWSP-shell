/*
 * Filename: MainActivity.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/MainActivity.java
 * Change date and time: 21.20.00_20.08.2026
 * Reason for changes: Accept system pin-shortcut (Material Files) + Share/VIEW → Speed Dial.
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

import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.WindowCompat;

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
    private static final String ACTION_INSTALL_SHORTCUT = "com.android.launcher.action.INSTALL_SHORTCUT";
    private static final Pattern URL_IN_TEXT =
            Pattern.compile("(https?://[^\\s<>\"']+|www\\.[^\\s<>\"']+)", Pattern.CASE_INSENSITIVE);

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
        handleIncomingIntent(getIntent());
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
                JSObject pending = LauncherCoordinator.peekPendingPin();
                if (pending != null) notifyLauncherPinShortcut(pending);
            } catch (Exception e) {
                Log.w(TAG, "pending pin notify failed", e);
            }
            return;
        }
        JSObject pin = extractPinFromIntent(intent);
        if (pin == null) return;
        Log.i(TAG, "pin-shortcut intent — " + pin.toString());
        LauncherCoordinator.stashPendingPin(pin);
        notifyLauncherPinShortcut(pin);
        clearTransientIntent(intent);
    }

    private void clearTransientIntent(Intent intent) {
        try {
            intent.replaceExtras((Bundle) null);
            intent.setAction(Intent.ACTION_MAIN);
            intent.addCategory(Intent.CATEGORY_HOME);
        } catch (Exception e) {
            Log.w(TAG, "clear pin intent failed", e);
        }
    }

    /**
     * API 26+: {@link LauncherApps#ACTION_CONFIRM_PIN_SHORTCUT} from Material Files / apps
     * that call {@code ShortcutManager.requestPinShortcut}.
     */
    private boolean tryHandlePinShortcutRequest(Intent intent) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            LauncherApps launcherApps = (LauncherApps) getSystemService(LAUNCHER_APPS_SERVICE);
            if (launcherApps == null) return false;
            LauncherApps.PinItemRequest request = launcherApps.getPinItemRequest(intent);
            if (request == null || !request.isValid()) return false;
            if (request.getRequestType() != LauncherApps.PinItemRequest.REQUEST_TYPE_SHORTCUT) {
                Log.i(TAG, "pin request ignored type=" + request.getRequestType());
                return false;
            }
            ShortcutInfo info = request.getShortcutInfo();
            JSObject pin = shortcutInfoToPin(info, launcherApps);
            boolean accepted = request.accept();
            Log.i(TAG, "CONFIRM_PIN_SHORTCUT accept=" + accepted + " pin=" + (pin != null ? pin.toString() : "null"));
            if (pin != null) {
                LauncherCoordinator.stashPendingPin(pin);
                notifyLauncherPinShortcut(pin);
                notifyLauncherHomePressed();
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "CONFIRM_PIN_SHORTCUT failed", e);
            return false;
        }
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
            LauncherCoordinator.stashPendingPin(pin);
            notifyLauncherPinShortcut(pin);
            notifyLauncherHomePressed();
            return true;
        } catch (Exception e) {
            Log.w(TAG, "INSTALL_SHORTCUT failed", e);
            return false;
        }
    }

    private JSObject shortcutInfoToPin(ShortcutInfo info, LauncherApps launcherApps) {
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

        /* Capture the shortcut's own icon (file type / thumbnail), not the Files app icon. */
        String iconUrl = "";
        try {
            iconUrl = LauncherCoordinator.shortcutInfoToDataUrl(this, launcherApps, info, 192);
        } catch (Exception e) {
            Log.w(TAG, "shortcut icon capture failed", e);
        }

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
                if (iconUrl != null && !iconUrl.isEmpty()) {
                    docPin.put("iconUrl", iconUrl);
                    docPin.put("iconDisplay", "colored");
                }
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
            if (iconUrl != null && !iconUrl.isEmpty()) {
                pin.put("iconUrl", iconUrl);
                pin.put("iconDisplay", "colored");
            }
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

    static JSObject intentToPin(Intent launch, String label, String source) {
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
                /*
                 * WHY: never attach launch.getPackage() for content/file/http — that is often
                 * the shortcut publisher (Files) and would force the wrong app on open.
                 * Persist intentUri only as a secondary payload for exact replay if needed.
                 */
                try {
                    pin.put("intentUri", launch.toUri(Intent.URI_INTENT_SCHEME));
                } catch (Exception ignored) {
                    /* ignore */
                }
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

        /* Last resort: serialize intent URI so Cap can ACTION_VIEW it. */
        try {
            String intentUri = launch.toUri(Intent.URI_INTENT_SCHEME);
            if (intentUri != null && !intentUri.isEmpty()) {
                JSObject pin = new JSObject();
                pin.put("url", intentUri);
                pin.put("href", intentUri);
                pin.put("intentUri", intentUri);
                pin.put("action", "open-uri");
                if (label != null && !label.trim().isEmpty()) pin.put("label", label.trim());
                pin.put("source", source != null ? source : "intent");
                if (mime != null && !mime.isEmpty()) pin.put("mimeType", mime);
                return pin;
            }
        } catch (Exception ignored) {
            /* ignore */
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

    private void notifyLauncherPinShortcut(JSObject pin) {
        try {
            Bridge bridge = getBridge();
            if (bridge != null) {
                bridge.triggerWindowJSEvent("launcherPinShortcut", pin.toString());
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
                        "(function(){try{var s=globalThis.__CWSP_LAUNCHER_HOME__;"
                                + "return s&&s.handleBackPress&&s.handleBackPress()?\"1\":\"0\"}"
                                + "catch(e){return \"0\"}})()",
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
