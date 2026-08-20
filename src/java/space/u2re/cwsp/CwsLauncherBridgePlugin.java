/*
 * Filename: CwsLauncherBridgePlugin.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsLauncherBridgePlugin.java
 * Change date and time: 20.30.00_20.08.2026
 * Reason for changes: clipboard:read-local for Paste shortcut — Chrome Copy link URI/Intent.
 */

package space.u2re.cwsp;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.text.TextUtils;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal {@code CwsBridge} for CWSP Launcher APK — {@code launcher:*} + local clipboard read
 * (Paste shortcut / Speed Dial). Full transfer CwsBridge is not shipped in this SKU.
 */
@CapacitorPlugin(name = "CwsBridge")
public class CwsLauncherBridgePlugin extends Plugin {

    private static final Pattern HTTP_URL = Pattern.compile(
            "https?://[^\\s<>\"'\\)\\]]+", Pattern.CASE_INSENSITIVE);
    private static final Pattern HTML_HREF = Pattern.compile(
            "href\\s*=\\s*[\"'](https?://[^\"']+)[\"']", Pattern.CASE_INSENSITIVE);

    @PluginMethod
    public void getShellInfo(PluginCall call) {
        JSObject info = new JSObject();
        info.put("shell", "capacitor");
        info.put("bridge", "cws-bridge");
        info.put("native", true);
        info.put("platform", "android");
        info.put("sku", "launcher");
        info.put("statusBarHeightCss", systemBarHeightCss(getContext(), "status_bar_height"));
        info.put("navigationBarHeightCss", systemBarHeightCss(getContext(), "navigation_bar_height"));
        call.resolve(info);
    }

    private static double systemBarHeightCss(Context context, String dimenName) {
        if (context == null) return 0;
        int resourceId = context.getResources().getIdentifier(dimenName, "dimen", "android");
        if (resourceId <= 0) return 0;
        float px = context.getResources().getDimension(resourceId);
        float density = context.getResources().getDisplayMetrics().density;
        if (density <= 0) return px;
        return px / density;
    }

    @PluginMethod
    public void invoke(PluginCall call) {
        String channel = call.getString("channel", "");
        JSObject payload = call.getObject("payload", new JSObject());
        JSObject result = dispatch(channel, payload);
        call.resolve(result);
    }

    private JSObject dispatch(String channel, JSObject payload) {
        if (channel == null) channel = "";
        switch (channel) {
            case "launcher:is-default":
                return LauncherCoordinator.isDefaultHome(getContext());
            case "launcher:request-default":
                LauncherCoordinator.requestDefaultHome(getActivity());
                return baseResult(true, channel);
            case "launcher:list": {
                String query = payload != null ? payload.getString("query", "") : "";
                return LauncherCoordinator.listApps(getContext(), query);
            }
            case "launcher:launch": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                String componentName = payload != null ? payload.getString("componentName", "") : "";
                return LauncherCoordinator.launchApp(getContext(), packageName, componentName);
            }
            case "launcher:start-shortcut": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                String shortcutId = payload != null ? payload.getString("shortcutId", "") : "";
                if (shortcutId == null || shortcutId.isEmpty()) {
                    shortcutId = payload != null ? payload.getString("id", "") : "";
                }
                return LauncherCoordinator.startShortcut(getContext(), packageName, shortcutId);
            }
            case "launcher:shortcut-icon": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                String shortcutId = payload != null ? payload.getString("shortcutId", "") : "";
                if (shortcutId == null || shortcutId.isEmpty()) {
                    shortcutId = payload != null ? payload.getString("id", "") : "";
                }
                Integer size = payload != null ? payload.getInteger("size", 96) : 96;
                return LauncherCoordinator.shortcutIcon(getContext(), packageName, shortcutId, size);
            }
            case "launcher:icon": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                if (packageName == null || packageName.isEmpty()) {
                    packageName = payload != null ? payload.getString("cacheKey", "") : "";
                }
                Integer size = payload != null ? payload.getInteger("size", 64) : 64;
                String variant = payload != null ? payload.getString("variant", "default") : "default";
                String pack = payload != null ? payload.getString("pack", "") : "";
                if (pack == null || pack.isEmpty()) {
                    pack = payload != null ? payload.getString("iconPack", "") : "";
                }
                String drawable = payload != null ? payload.getString("drawable", "") : "";
                return LauncherCoordinator.appIcon(
                        getContext(), packageName, size, variant, pack, drawable);
            }
            case "launcher:icon-variants": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                if (packageName == null || packageName.isEmpty()) {
                    packageName = payload != null ? payload.getString("cacheKey", "") : "";
                }
                return LauncherCoordinator.listIconVariants(getContext(), packageName);
            }
            case "launcher:icon-packs":
                return LauncherCoordinator.listIconPacks(getContext());
            case "launcher:icon-pack-icons": {
                String pack = payload != null ? payload.getString("pack", "") : "";
                if (pack == null || pack.isEmpty()) {
                    pack = payload != null ? payload.getString("packageName", "") : "";
                }
                String query = payload != null ? payload.getString("query", "") : "";
                Integer limit = payload != null ? payload.getInteger("limit", 120) : 120;
                return LauncherCoordinator.listPackIcons(getContext(), pack, query, limit);
            }
            case "launcher:open-uri": {
                String uri = payload != null ? payload.getString("uri", "") : "";
                if (uri == null || uri.isEmpty()) {
                    uri = payload != null ? payload.getString("url", "") : "";
                }
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                String mimeType = payload != null ? payload.getString("mimeType", "") : "";
                if (mimeType == null || mimeType.isEmpty()) {
                    mimeType = payload != null ? payload.getString("type", "") : "";
                }
                boolean chooser = true;
                if (payload != null && payload.has("chooser")) {
                    try {
                        Object rawChooser = payload.get("chooser");
                        if (rawChooser instanceof Boolean) {
                            chooser = (Boolean) rawChooser;
                        } else if (rawChooser != null) {
                            String s = String.valueOf(rawChooser).trim().toLowerCase(Locale.US);
                            chooser = !(s.equals("false") || s.equals("0") || s.equals("no"));
                        }
                    } catch (Exception ignored) {
                        chooser = true;
                    }
                }
                String chooserTitle = payload != null ? payload.getString("title", "Open with") : "Open with";
                return LauncherCoordinator.openUri(
                        getContext(), uri, packageName, chooser, chooserTitle, mimeType);
            }
            case "launcher:pending-pin":
                return LauncherCoordinator.consumePendingPin();
            /* WHY: Paste shortcut uses clipboard-device → clipboard:read-local. Slim launcher
             * bridge previously returned unhandled; Cap Clipboard.getText() is empty for many
             * Chrome "Copy link" clips (URI/Intent, not plain CharSequence). */
            case "clipboard:read-local":
            case "clipboard:paste-remote":
                return clipboardRead(channel);
            default: {
                JSObject r = baseResult(false, channel);
                JSObject echo = new JSObject();
                echo.put("error", "unhandled channel: " + channel);
                r.put("echo", echo);
                return r;
            }
        }
    }

    private JSObject clipboardRead(String channel) {
        String text = readClipboardPreferHttpUrl(getContext());
        JSObject r = baseResult(true, channel);
        JSObject echo = new JSObject();
        echo.put("text", text != null ? text : "");
        r.put("echo", echo);
        return r;
    }

    /**
     * Prefer http(s) URI / VIEW intent, then HTML href, then coerceToText with URL extraction.
     * Chrome "Copy link" often stores the address as Uri/Intent while getText() is the title or null.
     */
    static String readClipboardPreferHttpUrl(Context context) {
        if (context == null) return "";
        try {
            ClipboardManager cm =
                    (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            ClipData clip = cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() <= 0) return "";
            ClipData.Item item = clip.getItemAt(0);
            if (item == null) return "";

            Uri uri = item.getUri();
            if (uri != null && isHttpUrl(uri.toString())) {
                return uri.toString();
            }

            Intent intent = item.getIntent();
            if (intent != null && intent.getData() != null) {
                String data = intent.getData().toString();
                if (isHttpUrl(data)) return data;
            }

            CharSequence plain = item.getText();
            if (plain != null && !TextUtils.isEmpty(plain)) {
                String extracted = extractHttpUrl(plain.toString());
                if (extracted != null) return extracted;
            }

            String html = item.getHtmlText();
            if (!TextUtils.isEmpty(html)) {
                Matcher href = HTML_HREF.matcher(html);
                if (href.find()) {
                    String found = href.group(1);
                    if (isHttpUrl(found)) return found;
                }
                String extracted = extractHttpUrl(html);
                if (extracted != null) return extracted;
            }

            CharSequence coerced = item.coerceToText(context);
            if (coerced != null) {
                String s = coerced.toString().trim();
                if (s.startsWith("content://") || s.startsWith("file://")) return "";
                String extracted = extractHttpUrl(s);
                if (extracted != null) return extracted;
                return s;
            }
        } catch (Exception ignored) {
            /* permission / OEM clipboard quirks */
        }
        return "";
    }

    private static boolean isHttpUrl(String raw) {
        if (raw == null) return false;
        String s = raw.trim();
        return s.regionMatches(true, 0, "http://", 0, 7)
                || s.regionMatches(true, 0, "https://", 0, 8);
    }

    /** First http(s) URL in multiline / titled clipboard blobs from mobile browsers. */
    private static String extractHttpUrl(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        if (text.isEmpty()) return null;
        if (isHttpUrl(text) && !text.contains("\n") && !text.contains(" ")) {
            return text;
        }
        for (String line : text.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) continue;
            if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
                trimmed = trimmed.substring(1, trimmed.length() - 1).trim();
            }
            if (isHttpUrl(trimmed)) return trimmed;
            Matcher m = HTTP_URL.matcher(trimmed);
            if (m.find()) return m.group();
        }
        Matcher m = HTTP_URL.matcher(text);
        if (m.find()) return m.group();
        return null;
    }

    private static JSObject baseResult(boolean ok, String channel) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("channel", channel);
        r.put("echo", new JSObject());
        return r;
    }
}
