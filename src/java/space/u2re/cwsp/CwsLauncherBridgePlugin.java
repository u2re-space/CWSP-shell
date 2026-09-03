/*
 * Filename: CwsLauncherBridgePlugin.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsLauncherBridgePlugin.java
 * FIND:app-menu
 * Change date and time: 12.28.00_28.08.2026
 * Reason for changes: Uninstall uses Activity + ACTION_UNINSTALL_PACKAGE.
 */

package space.u2re.cwsp;

import android.app.WallpaperColors;
import android.app.WallpaperManager;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.text.TextUtils;
import android.util.TypedValue;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal {@code CwsBridge} for Launcher / Process APKs — {@code launcher:*} + local clipboard.
 * INVARIANT: Process share writes via {@code clipboard:write-local}; {@code @capacitor/clipboard}
 * is not in sibling SKU gradle. Full transfer CwsBridge is not shipped here.
 */
@CapacitorPlugin(name = "CwsBridge")
public class CwsLauncherBridgePlugin extends Plugin {

    private CwsWidgetHost widgetHost;
    private CwsStorageHost storageHost;

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
        info.put("sku", BuildConfig.CWSP_SKU);
        info.put("statusBarHeightCss", systemBarHeightCss(getContext(), "status_bar_height"));
        // WHY: resource navigation_bar_height is the 3-button pad even when SystemBars
        // already reserved it — injecting it into CSS painted a second empty strip.
        info.put("navigationBarHeightCss", 0);
        String accent = materialYouAccentHex(getContext());
        if (!TextUtils.isEmpty(accent)) info.put("accentColor", accent);
        String wallpaper = wallpaperPrimaryHex(getContext());
        if (!TextUtils.isEmpty(wallpaper)) info.put("wallpaperColor", wallpaper);
        try {
            info.put("displayRefreshHz", DisplayRefreshUnlock.peekMaxRefreshHz(getContext()));
        } catch (Exception ignored) {
            /* ignore */
        }
        call.resolve(info);
    }

    /** Material You `system_accent1_*` (API 31+), then theme accent, then wallpaper primary. */
    private static String materialYouAccentHex(Context context) {
        if (context == null) return "";
        if (Build.VERSION.SDK_INT >= 31) {
            int[] ids = {
                    android.R.color.system_accent1_200,
                    android.R.color.system_accent1_400,
                    android.R.color.system_accent1_100
            };
            for (int id : ids) {
                try {
                    String hex = colorToHex(context.getResources().getColor(id, context.getTheme()));
                    if (!isGenericAccentHex(hex)) return hex;
                } catch (Exception ignored) {
                    /* OEM without this tone */
                }
            }
        }
        try {
            TypedValue tv = new TypedValue();
            if (context.getTheme().resolveAttribute(android.R.attr.colorAccent, tv, true)) {
                int color = 0;
                if (tv.type >= TypedValue.TYPE_FIRST_COLOR_INT && tv.type <= TypedValue.TYPE_LAST_COLOR_INT) {
                    color = tv.data;
                } else if (tv.resourceId != 0) {
                    color = context.getResources().getColor(tv.resourceId, context.getTheme());
                }
                String hex = colorToHex(color);
                if (!isGenericAccentHex(hex)) return hex;
            }
        } catch (Exception ignored) {
            /* no theme accent */
        }
        return wallpaperPrimaryHex(context);
    }

    private static String wallpaperPrimaryHex(Context context) {
        if (context == null || Build.VERSION.SDK_INT < 27) return "";
        try {
            WallpaperManager wm = WallpaperManager.getInstance(context);
            WallpaperColors colors = wm.getWallpaperColors(WallpaperManager.FLAG_SYSTEM);
            if (colors == null || colors.getPrimaryColor() == null) return "";
            String hex = colorToHex(colors.getPrimaryColor().toArgb());
            return isGenericAccentHex(hex) ? "" : hex;
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String colorToHex(int color) {
        return String.format(
                Locale.US,
                "#%02x%02x%02x",
                Color.red(color),
                Color.green(color),
                Color.blue(color)
        );
    }

    private static boolean isGenericAccentHex(String hex) {
        if (hex == null || hex.isEmpty()) return true;
        String n = hex.toLowerCase(Locale.US);
        return "#000000".equals(n) || "#ffffff".equals(n) || "#0000ee".equals(n) || "#0000ff".equals(n);
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

    @Override
    public void load() {
        widgetHost = new CwsWidgetHost(this);
        storageHost = new CwsStorageHost(this);
    }

    @Override
    protected void handleOnStart() {
        super.handleOnStart();
        if (widgetHost != null) widgetHost.startListening();
    }

    @Override
    protected void handleOnStop() {
        if (widgetHost != null) widgetHost.stopListening();
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        if (widgetHost != null) widgetHost.destroy();
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnActivityResult(int requestCode, int resultCode, Intent data) {
        if (widgetHost != null
                && (requestCode == CwsWidgetHost.REQ_BIND || requestCode == CwsWidgetHost.REQ_CONFIGURE)) {
            widgetHost.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (storageHost != null && requestCode == CwsStorageHost.REQ_SAF) {
            storageHost.onActivityResult(requestCode, resultCode, data);
            return;
        }
        super.handleOnActivityResult(requestCode, resultCode, data);
    }

    @PluginMethod
    public void processApi(PluginCall call) {
        JSObject body = call.getObject("payload", null);
        if (body == null) body = call.getData();
        if (body == null) body = new JSObject();
        final JSObject payload = body;
        new Thread(() -> {
            try {
                call.resolve(CwsProcessApi.run(payload));
            } catch (Exception e) {
                call.resolve(CwsProcessApi.error(e.getMessage()));
            }
        }, "cwsp-process-api").start();
    }

    @PluginMethod
    public void invoke(PluginCall call) {
        String channel = call.getString("channel", "");
        JSObject payload = call.getObject("payload", new JSObject());
        if (CwsProcessApi.CHANNEL.equals(channel) || "process.api".equals(channel)) {
            processApi(call);
            return;
        }
        if ("widget:bind".equals(channel)) {
            if (widgetHost == null) widgetHost = new CwsWidgetHost(this);
            String provider = payload != null ? payload.getString("provider", "") : "";
            if (provider == null || provider.isEmpty()) {
                provider = payload != null ? payload.getString("componentName", "") : "";
            }
            widgetHost.bind(call, provider);
            return;
        }
        if ("storage:pick-saf".equals(channel) || "files:storage:pick-landing".equals(channel)) {
            if (storageHost == null) storageHost = new CwsStorageHost(this);
            storageHost.pickSaf(call);
            return;
        }
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
            case "launcher:has-packages": {
                Object packages = null;
                try {
                    packages = payload != null ? payload.get("packages") : null;
                } catch (Exception ignored) {
                    packages = null;
                }
                return LauncherCoordinator.hasPackages(getContext(), packages);
            }
            case "launcher:launch": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                String componentName = payload != null ? payload.getString("componentName", "") : "";
                return LauncherCoordinator.launchApp(getContext(), packageName, componentName, payload);
            }
            case "launcher:app-info": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                return LauncherCoordinator.appInfo(getContext(), packageName);
            }
            case "launcher:open-app-info": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                return LauncherCoordinator.openAppInfo(getContext(), packageName);
            }
            case "launcher:uninstall": {
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                return LauncherCoordinator.uninstallApp(getContext(), getActivity(), packageName);
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
            case "launcher:open-bytes": {
                String name = payload != null ? payload.getString("name", "shared.bin") : "shared.bin";
                String mimeType = payload != null ? payload.getString("mimeType", "") : "";
                if (mimeType == null || mimeType.isEmpty()) {
                    mimeType = payload != null ? payload.getString("type", "") : "";
                }
                String data = payload != null ? payload.getString("data", "") : "";
                String packageName = payload != null ? payload.getString("packageName", "") : "";
                boolean chooser = false;
                if (payload != null && payload.has("chooser")) {
                    try {
                        Object rawChooser = payload.get("chooser");
                        if (rawChooser instanceof Boolean) {
                            chooser = (Boolean) rawChooser;
                        }
                    } catch (Exception ignored) {
                        chooser = false;
                    }
                }
                String chooserTitle = payload != null ? payload.getString("title", "Open") : "Open";
                return LauncherCoordinator.openBytes(
                        getContext(), name, mimeType, data, packageName, chooser, chooserTitle);
            }
            case "launcher:pending-pin":
                return LauncherCoordinator.consumePendingPin(getContext());
            case "launcher:ack-pin":
                return LauncherCoordinator.ackPendingPinResult(getContext());
            case "launcher:pending-share":
                return LauncherCoordinator.consumePendingShare(getContext());
            case "launcher:read-share-file":
                return LauncherCoordinator.readPendingShareFile(getContext());
            case "launcher:restash-share-file":
                return LauncherCoordinator.restashPendingShareFile(getContext());
            case "launcher:ack-share":
                return LauncherCoordinator.ackPendingShare(getContext(), payload);
            case "launcher:list-pinned":
                return LauncherCoordinator.listPinnedShortcuts(getContext());
            /* WHY: Paste shortcut uses clipboard-device → clipboard:read-local. Slim launcher
             * bridge previously returned unhandled; Cap Clipboard.getText() is empty for many
             * Chrome "Copy link" clips (URI/Intent, not plain CharSequence). */
            case "clipboard:read-local":
            case "clipboard:paste-remote":
                return clipboardRead(channel);
            case "settings:snapshot":
                return ProcessIngressSnapshot.save(getContext(), payload);
            case "clipboard:write-local":
            case "clipboard:write":
                return clipboardWrite(channel, payload);
            case "clipboard:write-local-image":
            case "storage:copy-image": {
                if (storageHost == null) storageHost = new CwsStorageHost(this);
                return storageHost.copyImage(payload);
            }
            case "widget:list": {
                if (widgetHost == null) widgetHost = new CwsWidgetHost(this);
                widgetHost.startListening();
                String query = payload != null ? payload.getString("query", "") : "";
                return widgetHost.list(query);
            }
            case "widget:preview": {
                if (widgetHost == null) widgetHost = new CwsWidgetHost(this);
                String provider = payload != null ? payload.getString("provider", "") : "";
                return widgetHost.preview(provider);
            }
            case "widget:attach": {
                if (widgetHost == null) widgetHost = new CwsWidgetHost(this);
                widgetHost.startListening();
                return widgetHost.attach(payload);
            }
            case "widget:layout": {
                if (widgetHost == null) return CwsWidgetHost.fail("widget:layout", "no host");
                return widgetHost.layout(payload);
            }
            case "widget:detach": {
                if (widgetHost == null) return CwsWidgetHost.base(true, "widget:detach");
                Integer id = payload != null ? payload.getInteger("widgetId", 0) : 0;
                return widgetHost.detach(id != null ? id : 0);
            }
            case "widget:delete": {
                if (widgetHost == null) return CwsWidgetHost.base(true, "widget:delete");
                Integer id = payload != null ? payload.getInteger("widgetId", 0) : 0;
                return widgetHost.delete(id != null ? id : 0);
            }
            case "widget:hide": {
                if (widgetHost == null) return CwsWidgetHost.base(true, "widget:hide");
                return widgetHost.hideAll();
            }
            case "storage:list":
            case "storage:read":
            case "storage:uri":
            case "storage:open":
            case "storage:share":
            case "storage:delete":
            case "storage:realpath":
            case "files:storage:status":
            case "files:storage:show-paths": {
                if (storageHost == null) storageHost = new CwsStorageHost(this);
                if ("storage:list".equals(channel)) return storageHost.list(payload);
                if ("storage:read".equals(channel)) return storageHost.read(payload);
                if ("storage:uri".equals(channel)) return storageHost.uri(payload);
                if ("storage:open".equals(channel)) return storageHost.open(payload);
                if ("storage:share".equals(channel)) return storageHost.share(payload);
                if ("storage:delete".equals(channel)) return storageHost.delete(payload);
                if ("storage:realpath".equals(channel)) return storageHost.realPath(payload);
                return storageHost.showPaths();
            }
            case "storage:all-files-status":
            case "files:storage:permissions-status": {
                if (storageHost == null) storageHost = new CwsStorageHost(this);
                return storageHost.allFilesStatus();
            }
            case "storage:all-files-request":
            case "files:storage:request-all-files": {
                if (storageHost == null) storageHost = new CwsStorageHost(this);
                return storageHost.requestAllFiles();
            }
            case "files:storage:request-media": {
                if (storageHost == null) storageHost = new CwsStorageHost(this);
                return storageHost.requestMedia();
            }
            case "files:storage:open-explorer": {
                if (storageHost == null) storageHost = new CwsStorageHost(this);
                return storageHost.openExplorer();
            }
            case "files:storage:share-readme": {
                JSObject r = baseResult(true, channel);
                JSObject echo = new JSObject();
                echo.put("note", "Use Explorer /sdcard/ or /saf/ — README share is not in the launcher SKU.");
                r.put("echo", echo);
                return r;
            }
            case "app:info":
            case "app:version":
                return AppUpdateHelper.info(getContext(), payload != null ? payload : new JSObject());
            case "app:update:check":
                return AppUpdateHelper.check(getContext(), payload);
            case "app:update:install":
                return AppUpdateHelper.install(getContext(), getActivity(), payload);
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
     * WHY: Android 10+ setPrimaryClip needs a focused window. Use the Activity,
     * not only application context. Process AI-after-share has no @capacitor/clipboard.
     */
    private JSObject clipboardWrite(String channel, JSObject payload) {
        String text = payload != null ? payload.getString("text", "") : "";
        if (text == null) text = "";
        boolean ok = writeClipboardPlainText(text);
        JSObject r = baseResult(ok, channel);
        JSObject echo = new JSObject();
        echo.put("ok", ok);
        echo.put("text", text);
        if (!ok) echo.put("error", "setPrimaryClip failed");
        r.put("echo", echo);
        return r;
    }

    private boolean writeClipboardPlainText(String text) {
        android.app.Activity activity = getActivity();
        Context context = activity != null ? activity : getContext();
        if (context == null) return false;
        try {
            ClipboardManager cm =
                    (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return false;
            cm.setPrimaryClip(ClipData.newPlainText("cwsp", text));
            return true;
        } catch (Exception ignored) {
            return false;
        }
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
