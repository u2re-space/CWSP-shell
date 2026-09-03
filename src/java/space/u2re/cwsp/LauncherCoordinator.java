/*
 * Filename: LauncherCoordinator.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/LauncherCoordinator.java
 * FIND:app-menu
 * Change date and time: 22.30.00_29.08.2026
 * Reason for changes: launcher:list includes install/update times and category for App Menu sort.
 */

package space.u2re.cwsp;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.role.RoleManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.LauncherActivityInfo;
import android.content.pm.LauncherApps;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.content.res.Resources;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.PorterDuff;
import android.graphics.drawable.AdaptiveIconDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Process;
import android.os.UserHandle;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Native launcher coordinator for {@code launcher:*} IPC channels. */
public final class LauncherCoordinator {
    private static final String TAG = "LauncherCoordinator";

    private static final int MAX_SHORTCUT_ICON_CACHE = 48;
    private static final Object SHORTCUT_ICON_LOCK = new Object();
    private static final LinkedHashMap<String, byte[]> SHORTCUT_ICON_PNG =
            new LinkedHashMap<String, byte[]>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, byte[]> eldest) {
                    return size() > MAX_SHORTCUT_ICON_CACHE;
                }
            };

    private LauncherCoordinator() {}

    private static String shortcutIconCacheKey(String pkg, String id) {
        return pkg + "\0" + id;
    }

    private static int shortcutMatchFlags() {
        int flags = android.content.pm.LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED
                | android.content.pm.LauncherApps.ShortcutQuery.FLAG_MATCH_DYNAMIC
                | android.content.pm.LauncherApps.ShortcutQuery.FLAG_MATCH_MANIFEST;
        if (Build.VERSION.SDK_INT >= 30) {
            flags |= android.content.pm.LauncherApps.ShortcutQuery.FLAG_MATCH_CACHED;
        }
        if (Build.VERSION.SDK_INT >= 32) {
            flags |= android.content.pm.LauncherApps.ShortcutQuery.FLAG_MATCH_PINNED_BY_ANY_LAUNCHER;
        }
        return flags;
    }

    /* WHY: ShortcutInfo.getIconResourceId() is @hide — missing from the public SDK stub. */
    private static int hiddenShortcutIconResourceId(android.content.pm.ShortcutInfo info) {
        if (info == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return 0;
        try {
            java.lang.reflect.Method m = info.getClass().getMethod("getIconResourceId");
            Object raw = m.invoke(info);
            return raw instanceof Integer ? (Integer) raw : 0;
        } catch (Exception ignored) {
            return 0;
        }
    }

    /** Pin-request ShortcutInfo often has iconRes; getShortcuts after accept() is flaky. */
    private static Drawable drawableFromShortcutInfo(
            Context ctx, LauncherApps launcherApps, android.content.pm.ShortcutInfo info) {
        if (ctx == null || launcherApps == null || info == null) return null;
        int density = ctx.getResources().getDisplayMetrics().densityDpi;
        try {
            Drawable d = launcherApps.getShortcutIconDrawable(info, density);
            if (d != null) return d;
        } catch (Exception e) {
            Log.w(TAG, "getShortcutIconDrawable failed", e);
        }
        /* WHY: getIconResourceId() is @hide — not in the public SDK stub. */
        int resId = hiddenShortcutIconResourceId(info);
        if (resId == 0) return null;
        try {
            Resources res = ctx.getPackageManager().getResourcesForApplication(info.getPackage());
            Drawable d = res.getDrawableForDensity(resId, density, null);
            return d != null ? d : res.getDrawable(resId, null);
        } catch (Exception e) {
            Log.w(TAG, "publisher shortcut iconRes failed pkg=" + info.getPackage(), e);
            return null;
        }
    }

    private static JSObject pngResult(String channel, String cacheKey, byte[] png) {
        String b64 = Base64.encodeToString(png, Base64.NO_WRAP);
        JSObject echo = new JSObject();
        echo.put("cacheKey", cacheKey);
        echo.put("mime", "image/png");
        echo.put("base64", b64);
        JSObject r = base(true, channel);
        r.put("echo", echo);
        r.put("cacheKey", cacheKey);
        r.put("mime", "image/png");
        r.put("base64", b64);
        return r;
    }

    private static void rememberShortcutPng(String pkg, String id, JSObject encoded) {
        if (encoded == null || !encoded.getBoolean("ok", false)) return;
        String b64 = encoded.getString("base64", "");
        if (b64 == null || b64.isEmpty()) return;
        try {
            byte[] png = Base64.decode(b64, Base64.NO_WRAP);
            if (png == null || png.length == 0) return;
            synchronized (SHORTCUT_ICON_LOCK) {
                SHORTCUT_ICON_PNG.put(shortcutIconCacheKey(pkg, id), png);
            }
        } catch (Exception e) {
            Log.w(TAG, "rememberShortcutPng failed", e);
        }
    }

    /**
     * Capture the pin-request icon before {@code accept()} — Material Files uses
     * {@code mipmap/file_shortcut_icon}, not a bitmap path.
     */
    public static void cacheShortcutIcon(
            Context ctx, LauncherApps launcherApps, android.content.pm.ShortcutInfo info) {
        if (ctx == null || launcherApps == null || info == null) return;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return;
        String pkg = info.getPackage() != null ? info.getPackage().trim() : "";
        String id = info.getId() != null ? info.getId().trim() : "";
        if (pkg.isEmpty() || id.isEmpty()) return;
        try {
            Drawable drawable = drawableFromShortcutInfo(ctx, launcherApps, info);
            if (drawable == null) {
                Log.w(TAG, "cacheShortcutIcon: no drawable pkg=" + pkg + " id=" + id);
                return;
            }
            JSObject encoded = encodeIconDrawable(drawable, pkg + "/" + id, 192, "default");
            rememberShortcutPng(pkg, id, encoded);
            if (encoded.getBoolean("ok", false)) {
                Log.i(TAG, "cached shortcut icon pkg=" + pkg + " id=" + id);
            }
        } catch (Exception e) {
            Log.w(TAG, "cacheShortcutIcon failed pkg=" + pkg + " id=" + id, e);
        }
    }

    /** Slim pin payload from a ShortcutInfo — never includes Intent.toUri / iconUrl. */
    public static JSObject shortcutInfoToSlimPin(android.content.pm.ShortcutInfo info) {
        if (info == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return null;
        String pkg = info.getPackage() != null ? info.getPackage().trim() : "";
        String id = info.getId() != null ? info.getId().trim() : "";
        if (pkg.isEmpty() || id.isEmpty()) return null;
        JSObject pin = new JSObject();
        pin.put("packageName", pkg);
        pin.put("shortcutId", id);
        pin.put("action", "launch-shortcut");
        pin.put("source", "pin-shortcut");
        pin.put("iconDisplay", "colored");
        try {
            CharSequence label = info.getShortLabel();
            if (label == null || label.length() == 0) label = info.getLongLabel();
            if (label != null && label.length() > 0) pin.put("label", label.toString().trim());
        } catch (Exception ignored) {
            /* OEM */
        }
        return slimPinForBridge(pin);
    }

    /**
     * Accept {@link LauncherApps#ACTION_CONFIRM_PIN_SHORTCUT} without Capacitor.
     * WHY: singleTask HOME often drops the PinItemRequest; Files then no-ops forever
     * because the OS already marks the shortcut pinned.
     */
    public static boolean handleConfirmPin(Activity activity, Intent intent) {
        if (activity == null || intent == null) return false;
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            LauncherApps launcherApps =
                    (LauncherApps) activity.getSystemService(Context.LAUNCHER_APPS_SERVICE);
            if (launcherApps == null) return false;
            LauncherApps.PinItemRequest request = launcherApps.getPinItemRequest(intent);
            if (request == null || !request.isValid()) {
                Log.w(TAG, "CONFIRM_PIN: no request action=" + intent.getAction());
                return false;
            }
            if (request.getRequestType() != LauncherApps.PinItemRequest.REQUEST_TYPE_SHORTCUT) {
                Log.i(TAG, "CONFIRM_PIN ignored type=" + request.getRequestType());
                return false;
            }
            android.content.pm.ShortcutInfo info = request.getShortcutInfo();
            cacheShortcutIcon(activity, launcherApps, info);
            JSObject pin = shortcutInfoToSlimPin(info);
            boolean accepted = request.accept();
            Log.i(TAG, "CONFIRM_PIN accept=" + accepted + " pin=" + (pin != null ? pin.toString() : "null"));
            if (pin != null) stashPendingPin(activity, pin);
            return pin != null;
        } catch (Exception e) {
            Log.w(TAG, "CONFIRM_PIN failed", e);
            return false;
        }
    }

    public static void toastAndBringHome(Activity activity, String label) {
        if (activity == null) return;
        String text =
                label != null && !label.trim().isEmpty()
                        ? ("Добавлено: " + label.trim())
                        : "Добавлено на Home";
        try {
            android.widget.Toast.makeText(activity, text, android.widget.Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Log.w(TAG, "pin toast failed", e);
        }
        try {
            Intent home = new Intent(activity, MainActivity.class);
            home.setAction(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                            | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            home.putExtra("cwsp_consume_pending_pin", true);
            activity.startActivity(home);
        } catch (Exception e) {
            Log.w(TAG, "bring home after pin failed", e);
        }
    }

    /** Shortcuts already pinned to this launcher — restore tiles Files will never re-send. */
    public static JSObject listPinnedShortcuts(Context ctx) {
        if (ctx == null) return fail("launcher:list-pinned", "context-null");
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) {
            return fail("launcher:list-pinned", "api-too-low");
        }
        JSObject r = base(true, "launcher:list-pinned");
        JSArray arr = new JSArray();
        try {
            LauncherApps launcherApps =
                    (LauncherApps) ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE);
            if (launcherApps == null) {
                return fail("launcher:list-pinned", "launcher-apps-unavailable");
            }
            android.content.pm.LauncherApps.ShortcutQuery query =
                    new android.content.pm.LauncherApps.ShortcutQuery();
            query.setQueryFlags(shortcutMatchFlags());
            java.util.List<android.content.pm.ShortcutInfo> list =
                    launcherApps.getShortcuts(query, Process.myUserHandle());
            if (list != null) {
                for (android.content.pm.ShortcutInfo info : list) {
                    if (info == null || !info.isPinned()) continue;
                    JSObject pin = shortcutInfoToSlimPin(info);
                    if (pin != null) arr.put(pin);
                }
            }
            Log.i(TAG, "listPinnedShortcuts n=" + arr.length());
        } catch (Exception e) {
            Log.w(TAG, "listPinnedShortcuts failed", e);
        }
        JSObject echo = new JSObject();
        echo.put("shortcuts", arr);
        r.put("echo", echo);
        r.put("shortcuts", arr);
        return r;
    }

    public static JSObject isDefaultHome(Context ctx) {
        boolean held = queryIsDefaultHome(ctx);
        JSObject r = base(true, "launcher:is-default");
        JSObject echo = new JSObject();
        echo.put("isDefault", held);
        r.put("echo", echo);
        r.put("isDefault", held);
        return r;
    }

    public static void requestDefaultHome(Activity activity) {
        if (activity == null) {
            Log.w(TAG, "requestDefaultHome: activity null");
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                RoleManager rm = activity.getSystemService(RoleManager.class);
                if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_HOME)) {
                    activity.startActivity(rm.createRequestRoleIntent(RoleManager.ROLE_HOME));
                    return;
                }
            }
            Intent intent = new Intent(Settings.ACTION_HOME_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "requestDefaultHome failed", e);
        }
    }

    public static JSObject listApps(Context ctx, String query) {
        if (ctx == null) {
            return fail("launcher:list", "context-null");
        }
        if (queryIsDefaultHome(ctx)) {
            return listAppsViaLauncherApps(ctx, query);
        }
        return listAppsViaPackageManager(ctx, query);
    }

    /**
     * Batch {@link PackageManager#getPackageInfo} — sibling SKU settings tabs
     * ({@code space.u2re.explorer} / document / process / transfer).
     */
    public static JSObject hasPackages(Context ctx, Object rawPackages) {
        if (ctx == null) {
            return fail("launcher:has-packages", "context-null");
        }
        PackageManager pm = ctx.getPackageManager();
        JSObject installed = new JSObject();
        try {
            for (String pkg : readPackageNames(rawPackages)) {
                installed.put(pkg, isPackageInstalled(pm, pkg));
            }
        } catch (Exception e) {
            Log.w(TAG, "hasPackages failed", e);
            return fail(
                    "launcher:has-packages",
                    e.getMessage() != null ? e.getMessage() : "has-packages-failed");
        }
        JSObject echo = new JSObject();
        echo.put("installed", installed);
        JSObject r = base(true, "launcher:has-packages");
        r.put("echo", echo);
        return r;
    }

    /** Capacitor {@code JSObject.get} yields {@link JSONArray}, not {@code getJSArray}. */
    private static List<String> readPackageNames(Object rawPackages) {
        List<String> pkgs = new ArrayList<>();
        if (rawPackages == null) return pkgs;
        if (rawPackages instanceof JSONArray) {
            JSONArray arr = (JSONArray) rawPackages;
            for (int i = 0; i < arr.length(); i++) {
                String pkg = String.valueOf(arr.opt(i)).trim();
                if (!pkg.isEmpty() && !"null".equals(pkg)) pkgs.add(pkg);
            }
            return pkgs;
        }
        if (rawPackages instanceof Iterable) {
            for (Object item : (Iterable<?>) rawPackages) {
                String pkg = String.valueOf(item).trim();
                if (!pkg.isEmpty() && !"null".equals(pkg)) pkgs.add(pkg);
            }
            return pkgs;
        }
        for (String part : String.valueOf(rawPackages).split("[,\\s]+")) {
            String pkg = part.trim();
            if (!pkg.isEmpty()) pkgs.add(pkg);
        }
        return pkgs;
    }

    private static boolean isPackageInstalled(PackageManager pm, String pkg) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0));
            } else {
                pm.getPackageInfo(pkg, 0);
            }
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    public static JSObject launchApp(Context ctx, String packageName, String componentName) {
        return launchApp(ctx, packageName, componentName, null);
    }

    public static JSObject launchApp(Context ctx, String packageName, String componentName, JSObject spec) {
        if (ctx == null) {
            return fail("launcher:launch", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (pkg.isEmpty()) {
            return fail("launcher:launch", "missing-package");
        }
        String blocked = blockedLaunchData(spec);
        if (blocked != null) {
            return fail("launcher:launch", blocked);
        }
        /* WHY: LauncherApps.startMainActivity is MAIN/LAUNCHER only — custom action/data uses PM. */
        if (queryIsDefaultHome(ctx) && !launchSpecIsCustom(spec)) {
            return launchAppViaLauncherApps(ctx, pkg, componentName);
        }
        return launchAppViaPackageManager(ctx, pkg, componentName, spec);
    }

    public static JSObject appInfo(Context ctx, String packageName) {
        if (ctx == null) {
            return fail("launcher:app-info", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (pkg.isEmpty()) {
            return fail("launcher:app-info", "missing-package");
        }
        try {
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pi = pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0));
            } else {
                pi = pm.getPackageInfo(pkg, 0);
            }
            ApplicationInfo ai = pi.applicationInfo;
            boolean system = ai != null && (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            boolean updated = ai != null && (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0;
            boolean self = pkg.equals(ctx.getPackageName());
            JSObject echo = new JSObject();
            echo.put("packageName", pkg);
            echo.put("label", ai != null ? String.valueOf(pm.getApplicationLabel(ai)) : pkg);
            echo.put("versionName", pi.versionName != null ? pi.versionName : "");
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                echo.put("versionCode", pi.getLongVersionCode());
            } else {
                echo.put("versionCode", pi.versionCode);
            }
            echo.put("installer", installerPackage(pm, pkg));
            echo.put("system", system);
            echo.put("updatedSystem", updated);
            echo.put("enabled", ai == null || ai.enabled);
            echo.put("self", self);
            echo.put("canUninstall", !self && (!system || updated));
            echo.put("firstInstallTime", pi.firstInstallTime);
            echo.put("lastUpdateTime", pi.lastUpdateTime);
            Intent launch = pm.getLaunchIntentForPackage(pkg);
            if (launch != null && launch.getComponent() != null) {
                echo.put("componentName", launch.getComponent().flattenToShortString());
            }
            JSObject r = base(true, "launcher:app-info");
            r.put("echo", echo);
            return r;
        } catch (PackageManager.NameNotFoundException e) {
            return fail("launcher:app-info", "app-not-found");
        } catch (Exception e) {
            Log.w(TAG, "appInfo failed pkg=" + pkg, e);
            return fail("launcher:app-info", e.getMessage() != null ? e.getMessage() : "info-failed");
        }
    }

    public static JSObject openAppInfo(Context ctx, String packageName) {
        if (ctx == null) {
            return fail("launcher:open-app-info", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (pkg.isEmpty()) {
            return fail("launcher:open-app-info", "missing-package");
        }
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + pkg));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
            JSObject echo = new JSObject();
            echo.put("opened", true);
            echo.put("packageName", pkg);
            JSObject r = base(true, "launcher:open-app-info");
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "openAppInfo failed pkg=" + pkg, e);
            return fail("launcher:open-app-info", e.getMessage() != null ? e.getMessage() : "open-failed");
        }
    }

    public static JSObject uninstallApp(Context ctx, String packageName) {
        return uninstallApp(ctx, null, packageName);
    }

    /**
     * WHY: {@link Intent#ACTION_DELETE} is a generic delete — many OEMs no-op {@code package:} URIs.
     * INVARIANT: show the system uninstall sheet from the Activity first. PackageInstaller is
     * fallback only (it can return without UI). Never silent ({@code DELETE_PACKAGES} is privileged).
     */
    public static JSObject uninstallApp(Context ctx, Activity activity, String packageName) {
        if (ctx == null) {
            return fail("launcher:uninstall", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (pkg.isEmpty()) {
            return fail("launcher:uninstall", "missing-package");
        }
        if (pkg.equals(ctx.getPackageName())) {
            return fail("launcher:uninstall", "self");
        }
        Context startFrom = activity != null ? activity : ctx;
        try {
            Intent intent = new Intent(Intent.ACTION_UNINSTALL_PACKAGE);
            intent.setData(Uri.fromParts("package", pkg, null));
            intent.putExtra(Intent.EXTRA_RETURN_RESULT, true);
            if (activity == null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            }
            startFrom.startActivity(intent);
            return uninstallStarted(pkg, "uninstall-package");
        } catch (Exception e) {
            Log.w(TAG, "ACTION_UNINSTALL_PACKAGE failed pkg=" + pkg, e);
        }
        if (uninstallViaPackageInstaller(ctx, pkg)) {
            return uninstallStarted(pkg, "package-installer");
        }
        return fail("launcher:uninstall", "uninstall-failed");
    }

    private static boolean uninstallViaPackageInstaller(Context ctx, String pkg) {
        try {
            PackageInstaller installer = ctx.getPackageManager().getPackageInstaller();
            if (installer == null) return false;
            Intent callback = new Intent("space.u2re.cwsp.ACTION_UNINSTALL_STATUS");
            callback.setPackage(ctx.getPackageName());
            callback.putExtra("packageName", pkg);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                flags |= PendingIntent.FLAG_MUTABLE;
            }
            PendingIntent pi =
                    PendingIntent.getBroadcast(ctx, pkg.hashCode(), callback, flags);
            installer.uninstall(pkg, pi.getIntentSender());
            return true;
        } catch (Exception e) {
            Log.w(TAG, "PackageInstaller.uninstall failed pkg=" + pkg, e);
            return false;
        }
    }

    private static JSObject uninstallStarted(String pkg, String via) {
        JSObject echo = new JSObject();
        echo.put("started", true);
        echo.put("packageName", pkg);
        echo.put("via", via);
        JSObject r = base(true, "launcher:uninstall");
        r.put("echo", echo);
        return r;
    }

    /**
     * Invoke a pinned app shortcut the way a real launcher must — Material Files document
     * pins often redact Intent data, so {@code startShortcut(pkg, id)} is the only reliable open.
     */
    public static JSObject startShortcut(Context ctx, String packageName, String shortcutId) {
        if (ctx == null) {
            return fail("launcher:start-shortcut", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        String id = shortcutId != null ? shortcutId.trim() : "";
        if (pkg.isEmpty() || id.isEmpty()) {
            return fail("launcher:start-shortcut", "missing-package-or-id");
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) {
            return fail("launcher:start-shortcut", "api-too-low");
        }
        try {
            LauncherApps launcherApps =
                    (LauncherApps) ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE);
            if (launcherApps == null) {
                return fail("launcher:start-shortcut", "launcher-apps-unavailable");
            }
            UserHandle user = Process.myUserHandle();
            launcherApps.startShortcut(pkg, id, null, null, user);
            JSObject echo = new JSObject();
            echo.put("packageName", pkg);
            echo.put("shortcutId", id);
            JSObject r = base(true, "launcher:start-shortcut");
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "startShortcut failed pkg=" + pkg + " id=" + id, e);
            return fail(
                    "launcher:start-shortcut",
                    e.getMessage() != null ? e.getMessage() : "start-failed");
        }
    }

    /**
     * Icon for a pinned app shortcut (document / dynamic) — not the publisher app icon.
     */
    public static JSObject shortcutIcon(
            Context ctx, String packageName, String shortcutId, Integer sizePx) {
        if (ctx == null) {
            return fail("launcher:shortcut-icon", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        String id = shortcutId != null ? shortcutId.trim() : "";
        if (pkg.isEmpty() || id.isEmpty()) {
            return fail("launcher:shortcut-icon", "missing-package-or-id");
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) {
            return fail("launcher:shortcut-icon", "api-too-low");
        }
        int size = sizePx != null ? sizePx : 96;
        if (size < 16) size = 16;
        if (size > 512) size = 512;
        try {
            synchronized (SHORTCUT_ICON_LOCK) {
                byte[] cached = SHORTCUT_ICON_PNG.get(shortcutIconCacheKey(pkg, id));
                if (cached != null && cached.length > 0) {
                    Log.i(TAG, "shortcutIcon cache-hit pkg=" + pkg + " id=" + id);
                    return pngResult("launcher:shortcut-icon", pkg + "/" + id, cached);
                }
            }
            LauncherApps launcherApps =
                    (LauncherApps) ctx.getSystemService(Context.LAUNCHER_APPS_SERVICE);
            if (launcherApps == null) {
                return fail("launcher:shortcut-icon", "launcher-apps-unavailable");
            }
            UserHandle user = Process.myUserHandle();
            android.content.pm.LauncherApps.ShortcutQuery query =
                    new android.content.pm.LauncherApps.ShortcutQuery();
            query.setPackage(pkg);
            query.setShortcutIds(java.util.Collections.singletonList(id));
            query.setQueryFlags(shortcutMatchFlags());
            java.util.List<android.content.pm.ShortcutInfo> list =
                    launcherApps.getShortcuts(query, user);
            if (list == null || list.isEmpty()) {
                Log.w(TAG, "shortcutIcon not-found pkg=" + pkg + " id=" + id);
                return fail("launcher:shortcut-icon", "shortcut-not-found");
            }
            android.content.pm.ShortcutInfo info = list.get(0);
            Drawable drawable = drawableFromShortcutInfo(ctx, launcherApps, info);
            if (drawable == null) {
                Log.w(TAG, "shortcutIcon icon-unavailable pkg=" + pkg + " id=" + id);
                return fail("launcher:shortcut-icon", "icon-unavailable");
            }
            JSObject encoded = encodeIconDrawable(drawable, pkg + "/" + id, size, "default");
            if (!encoded.getBoolean("ok", false)) {
                return fail("launcher:shortcut-icon", "encode-failed");
            }
            rememberShortcutPng(pkg, id, encoded);
            encoded.put("channel", "launcher:shortcut-icon");
            return encoded;
        } catch (Exception e) {
            Log.w(TAG, "shortcutIcon failed pkg=" + pkg + " id=" + id, e);
            return fail(
                    "launcher:shortcut-icon",
                    e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    /** PNG data-URL for a ShortcutInfo icon (pin-time capture). */
    public static String shortcutInfoToDataUrl(
            Context ctx, LauncherApps launcherApps, android.content.pm.ShortcutInfo info, int size) {
        if (ctx == null || launcherApps == null || info == null) return "";
        try {
            Drawable drawable = drawableFromShortcutInfo(ctx, launcherApps, info);
            if (drawable == null) return "";
            int sz = size > 0 ? size : 192;
            JSObject encoded = encodeIconDrawable(drawable, "pin-shortcut", sz, "default");
            if (!encoded.getBoolean("ok", false)) return "";
            String b64 = encoded.getString("base64", "");
            String mime = encoded.getString("mime", "image/png");
            if (b64 == null || b64.isEmpty()) return "";
            return "data:" + mime + ";base64," + b64;
        } catch (Exception e) {
            Log.w(TAG, "shortcutInfoToDataUrl failed", e);
            return "";
        }
    }

    public static JSObject appIcon(Context ctx, String packageName, Integer sizePx) {
        return appIcon(ctx, packageName, sizePx, "default");
    }

    /**
     * @param variant {@code default} | {@code monochrome} | {@code foreground}
     * @param iconPackPackage optional icon-pack package
     * @param drawableName optional explicit drawable inside the pack (browse pick)
     */
    public static JSObject appIcon(
            Context ctx,
            String packageName,
            Integer sizePx,
            String variant,
            String iconPackPackage,
            String drawableName) {
        if (ctx == null) {
            return fail("launcher:icon", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        String pack = iconPackPackage != null ? iconPackPackage.trim() : "";
        String drawable = drawableName != null ? drawableName.trim() : "";
        /* Explicit pack drawable — packageName may be target app or the pack itself. */
        if (!drawable.isEmpty()) {
            String packPkg = !pack.isEmpty() ? pack : pkg;
            if (packPkg.isEmpty()) {
                return fail("launcher:icon", "missing-pack");
            }
            Drawable d = IconPackResolver.resolveDrawableByName(ctx, packPkg, drawable);
            if (d == null) {
                return fail("launcher:icon", "icon-pack-drawable-missing");
            }
            return encodePackIconFilled(d, pkg.isEmpty() ? packPkg : pkg, sizePx, packPkg, drawable);
        }
        if (pkg.isEmpty()) {
            return fail("launcher:icon", "missing-package");
        }
        int size = sizePx != null ? sizePx : 96;
        if (size < 16) size = 16;
        if (size > 512) size = 512;
        if (!pack.isEmpty()) {
            Drawable themed = IconPackResolver.resolveThemedIcon(ctx, pkg, pack);
            if (themed == null) {
                return fail("launcher:icon", "icon-pack-unmapped");
            }
            return encodePackIconFilled(themed, pkg, size, pack, null);
        }
        String v = normalizeIconVariant(variant);
        return appIconViaPackageManager(ctx, pkg, size, v);
    }

    public static JSObject appIcon(
            Context ctx, String packageName, Integer sizePx, String variant, String iconPackPackage) {
        return appIcon(ctx, packageName, sizePx, variant, iconPackPackage, null);
    }

    /**
     * @param variant {@code default} | {@code monochrome} (Material You, API 33+) | {@code foreground}
     */
    public static JSObject appIcon(Context ctx, String packageName, Integer sizePx, String variant) {
        return appIcon(ctx, packageName, sizePx, variant, null, null);
    }

    /** Installed launcher icon packs (ADW / Nova / GO theme intents). */
    public static JSObject listIconPacks(Context ctx) {
        return IconPackResolver.listIconPacks(ctx);
    }

    /** Browse drawables declared in a pack's appfilter. */
    public static JSObject listPackIcons(
            Context ctx, String packPackage, String query, Integer limit) {
        return IconPackResolver.listPackIcons(ctx, packPackage, query, limit);
    }

    /** List which icon variants exist for a package (no bitmap payload). */
    public static JSObject listIconVariants(Context ctx, String packageName) {
        if (ctx == null) {
            return fail("launcher:icon-variants", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (pkg.isEmpty()) {
            return fail("launcher:icon-variants", "missing-package");
        }
        try {
            PackageManager pm = ctx.getPackageManager();
            Drawable drawable = pm.getApplicationIcon(pkg);
            JSArray variants = new JSArray();
            putVariant(variants, "default", "Default", true);
            boolean hasFg = false;
            boolean hasMono = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && drawable instanceof AdaptiveIconDrawable) {
                AdaptiveIconDrawable adaptive = (AdaptiveIconDrawable) drawable;
                hasFg = adaptive.getForeground() != null;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    hasMono = adaptive.getMonochrome() != null;
                }
            }
            putVariant(variants, "foreground", "Adaptive foreground", hasFg);
            putVariant(variants, "monochrome", "Material You", hasMono);
            JSObject echo = new JSObject();
            echo.put("packageName", pkg);
            echo.put("variants", variants);
            JSObject r = base(true, "launcher:icon-variants");
            r.put("echo", echo);
            r.put("variants", variants);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "listIconVariants failed pkg=" + pkg, e);
            return fail(
                    "launcher:icon-variants",
                    e.getMessage() != null ? e.getMessage() : "variants-failed");
        }
    }

    private static void putVariant(JSArray variants, String id, String label, boolean available) {
        JSObject entry = new JSObject();
        entry.put("id", id);
        entry.put("label", label);
        entry.put("available", available);
        variants.put(entry);
    }

    private static String normalizeIconVariant(String variant) {
        String v = variant != null ? variant.trim().toLowerCase(Locale.ROOT) : "default";
        if ("mono".equals(v) || "material".equals(v) || "material-you".equals(v) || "themed".equals(v)) {
            return "monochrome";
        }
        if ("fg".equals(v) || "adaptive-fg".equals(v) || "foreground".equals(v)) {
            return "foreground";
        }
        return "default";
    }

    private static String listCategory(ApplicationInfo ai, PackageManager pm, String pkg, boolean system) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && ai != null) {
            int cat = ai.category;
            if (cat == ApplicationInfo.CATEGORY_GAME) return "game";
            if (cat == ApplicationInfo.CATEGORY_AUDIO) return "audio";
            if (cat == ApplicationInfo.CATEGORY_VIDEO) return "video";
            if (cat == ApplicationInfo.CATEGORY_IMAGE) return "image";
            if (cat == ApplicationInfo.CATEGORY_SOCIAL) return "social";
            if (cat == ApplicationInfo.CATEGORY_NEWS) return "news";
            if (cat == ApplicationInfo.CATEGORY_MAPS) return "maps";
            if (cat == ApplicationInfo.CATEGORY_PRODUCTIVITY) return "productivity";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && cat == ApplicationInfo.CATEGORY_ACCESSIBILITY) {
                return "accessibility";
            }
        }
        if (system) return "system";
        String installer = installerPackage(pm, pkg);
        return installer != null && !installer.isEmpty() ? installer : "other";
    }

    private static void putListMeta(JSObject entry, PackageManager pm, String pkg) {
        try {
            PackageInfo pi;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pi = pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0));
            } else {
                pi = pm.getPackageInfo(pkg, 0);
            }
            entry.put("firstInstallTime", pi.firstInstallTime);
            entry.put("lastUpdateTime", pi.lastUpdateTime);
            ApplicationInfo ai = pi.applicationInfo;
            boolean system = ai != null && (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            entry.put("system", system);
            entry.put("installer", installerPackage(pm, pkg));
            entry.put("category", listCategory(ai, pm, pkg, system));
        } catch (Exception ignored) {
            if (!entry.has("category")) {
                entry.put("category", "other");
            }
        }
    }

    private static JSObject listAppsViaLauncherApps(Context ctx, String query) {
        try {
            LauncherApps launcherApps = ctx.getSystemService(LauncherApps.class);
            if (launcherApps == null) {
                return fail("launcher:list", "launcher-apps-unavailable");
            }
            UserHandle user = Process.myUserHandle();
            List<LauncherActivityInfo> activities = launcherApps.getActivityList(null, user);
            Map<String, LauncherActivityInfo> byPackage = new LinkedHashMap<>();
            for (LauncherActivityInfo info : activities) {
                if (info == null || info.getComponentName() == null) continue;
                String pkg = info.getComponentName().getPackageName();
                if (pkg == null || pkg.isEmpty()) continue;
                byPackage.putIfAbsent(pkg, info);
            }
            List<LauncherActivityInfo> sorted = new ArrayList<>(byPackage.values());
            Collections.sort(sorted, new Comparator<LauncherActivityInfo>() {
                @Override
                public int compare(LauncherActivityInfo a, LauncherActivityInfo b) {
                    CharSequence la = a != null ? a.getLabel() : "";
                    CharSequence lb = b != null ? b.getLabel() : "";
                    return String.valueOf(la).compareToIgnoreCase(String.valueOf(lb));
                }
            });
            String needle = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
            JSArray apps = new JSArray();
            for (LauncherActivityInfo info : sorted) {
                String label = String.valueOf(info.getLabel());
                String pkg = info.getComponentName().getPackageName();
                if (!needle.isEmpty()) {
                    if (!label.toLowerCase(Locale.ROOT).contains(needle)
                            && !pkg.toLowerCase(Locale.ROOT).contains(needle)) {
                        continue;
                    }
                }
                JSObject entry = new JSObject();
                entry.put("packageName", pkg);
                entry.put("label", label);
                entry.put("componentName", info.getComponentName().flattenToShortString());
                entry.put("iconCacheKey", pkg);
                putListMeta(entry, ctx.getPackageManager(), pkg);
                apps.put(entry);
            }
            JSObject echo = new JSObject();
            echo.put("apps", apps);
            JSObject r = base(true, "launcher:list");
            r.put("echo", echo);
            r.put("apps", apps);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "listAppsViaLauncherApps failed", e);
            return fail("launcher:list", e.getMessage() != null ? e.getMessage() : "list-failed");
        }
    }

    private static JSObject listAppsViaPackageManager(Context ctx, String query) {
        try {
            PackageManager pm = ctx.getPackageManager();
            Intent intent = new Intent(Intent.ACTION_MAIN, null);
            intent.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> resolveInfos;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                resolveInfos =
                        pm.queryIntentActivities(
                                intent, PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_ALL));
            } else {
                resolveInfos = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL);
            }
            Map<String, ResolveInfo> byPackage = new LinkedHashMap<>();
            for (ResolveInfo ri : resolveInfos) {
                if (ri == null || ri.activityInfo == null) continue;
                String pkg = ri.activityInfo.packageName;
                if (pkg == null || pkg.isEmpty()) continue;
                byPackage.putIfAbsent(pkg, ri);
            }
            List<ResolveInfo> sorted = new ArrayList<>(byPackage.values());
            Collections.sort(sorted, new Comparator<ResolveInfo>() {
                @Override
                public int compare(ResolveInfo a, ResolveInfo b) {
                    CharSequence la = a != null ? a.loadLabel(pm) : "";
                    CharSequence lb = b != null ? b.loadLabel(pm) : "";
                    return String.valueOf(la).compareToIgnoreCase(String.valueOf(lb));
                }
            });
            String needle = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
            JSArray apps = new JSArray();
            for (ResolveInfo ri : sorted) {
                String label = String.valueOf(ri.loadLabel(pm));
                String pkg = ri.activityInfo.packageName;
                if (!needle.isEmpty()) {
                    if (!label.toLowerCase(Locale.ROOT).contains(needle)
                            && !pkg.toLowerCase(Locale.ROOT).contains(needle)) {
                        continue;
                    }
                }
                ComponentName cn = new ComponentName(ri.activityInfo.packageName, ri.activityInfo.name);
                JSObject entry = new JSObject();
                entry.put("packageName", pkg);
                entry.put("label", label);
                entry.put("componentName", cn.flattenToShortString());
                entry.put("iconCacheKey", pkg);
                putListMeta(entry, pm, pkg);
                apps.put(entry);
            }
            JSObject echo = new JSObject();
            echo.put("apps", apps);
            JSObject r = base(true, "launcher:list");
            r.put("echo", echo);
            r.put("apps", apps);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "listAppsViaPackageManager failed", e);
            return fail("launcher:list", e.getMessage() != null ? e.getMessage() : "list-failed");
        }
    }

    private static JSObject launchAppViaLauncherApps(Context ctx, String pkg, String componentName) {
        try {
            LauncherApps launcherApps = ctx.getSystemService(LauncherApps.class);
            if (launcherApps == null) {
                return fail("launcher:launch", "launcher-apps-unavailable");
            }
            UserHandle user = Process.myUserHandle();
            LauncherActivityInfo target = null;
            String component = componentName != null ? componentName.trim() : "";
            if (!component.isEmpty()) {
                ComponentName cn = ComponentName.unflattenFromString(component);
                if (cn != null) {
                    for (LauncherActivityInfo info : launcherApps.getActivityList(pkg, user)) {
                        if (info != null && cn.equals(info.getComponentName())) {
                            target = info;
                            break;
                        }
                    }
                }
            }
            if (target == null) {
                List<LauncherActivityInfo> list = launcherApps.getActivityList(pkg, user);
                if (list == null || list.isEmpty()) {
                    return fail("launcher:launch", "app-not-found");
                }
                target = list.get(0);
            }
            launcherApps.startMainActivity(target.getComponentName(), user, null, null);
            JSObject echo = new JSObject();
            echo.put("launched", true);
            JSObject r = base(true, "launcher:launch");
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "launchAppViaLauncherApps failed pkg=" + pkg, e);
            return fail("launcher:launch", e.getMessage() != null ? e.getMessage() : "launch-failed");
        }
    }

    private static JSObject launchAppViaPackageManager(
            Context ctx, String pkg, String componentName, JSObject spec) {
        try {
            PackageManager pm = ctx.getPackageManager();
            Intent launch = null;
            String component = componentName != null ? componentName.trim() : "";
            if (!component.isEmpty()) {
                ComponentName cn = ComponentName.unflattenFromString(component);
                if (cn != null) {
                    launch = new Intent(Intent.ACTION_MAIN);
                    launch.addCategory(Intent.CATEGORY_LAUNCHER);
                    launch.setComponent(cn);
                }
            }
            if (launch == null) {
                launch = pm.getLaunchIntentForPackage(pkg);
            }
            if (launch == null && launchSpecIsCustom(spec)) {
                launch = new Intent(Intent.ACTION_MAIN);
                launch.setPackage(pkg);
            }
            if (launch == null) {
                return fail("launcher:launch", "app-not-found");
            }
            applyLaunchSpec(launch, spec);
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(launch);
            JSObject echo = new JSObject();
            echo.put("launched", true);
            JSObject r = base(true, "launcher:launch");
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "launchAppViaPackageManager failed pkg=" + pkg, e);
            return fail("launcher:launch", e.getMessage() != null ? e.getMessage() : "launch-failed");
        }
    }

    private static boolean launchSpecIsCustom(JSObject spec) {
        if (spec == null) return false;
        return nz(spec, "action") || nz(spec, "data") || spec.has("extras") || spec.has("flags") || spec.has("categories");
    }

    private static String blockedLaunchData(JSObject spec) {
        if (spec == null) return null;
        String data = specStr(spec, "data");
        if (data.isEmpty()) return null;
        String lower = data.toLowerCase(Locale.ROOT);
        if (lower.startsWith("javascript:")) return "blocked-data-scheme";
        return null;
    }

    private static void applyLaunchSpec(Intent launch, JSObject spec) {
        if (launch == null || spec == null) return;
        String action = specStr(spec, "action");
        String data = specStr(spec, "data");
        String mime = specStr(spec, "mimeType");
        if (mime.isEmpty()) mime = specStr(spec, "type");
        if (!action.isEmpty()) {
            launch.setAction(action);
        } else if (!data.isEmpty() && Intent.ACTION_MAIN.equals(launch.getAction())) {
            launch.setAction(Intent.ACTION_VIEW);
        }
        if (!data.isEmpty()) {
            Uri uri = Uri.parse(data);
            if (mime.isEmpty()) launch.setData(uri);
            else launch.setDataAndType(uri, mime);
        } else if (!mime.isEmpty()) {
            launch.setType(mime);
        }
        applyStringList(spec, "categories", (value) -> {
            if (!value.isEmpty()) launch.addCategory(value);
        });
        applyStringList(spec, "flags", (value) -> applyLaunchFlag(launch, value));
        JSONObject extras = specJson(spec, "extras");
        if (extras != null) {
            Iterator<String> keys = extras.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (key == null || key.isEmpty()) continue;
                Object value;
                try {
                    value = extras.get(key);
                } catch (Exception ignored) {
                    continue;
                }
                putLaunchExtra(launch, key, value);
            }
        }
    }

    private interface StringSink {
        void accept(String value);
    }

    private static void applyStringList(JSObject spec, String field, StringSink sink) {
        if (spec == null || !spec.has(field)) return;
        try {
            Object raw = spec.get(field);
            if (raw instanceof JSArray) {
                JSArray arr = (JSArray) raw;
                for (int i = 0; i < arr.length(); i++) {
                    sink.accept(String.valueOf(arr.get(i)).trim());
                }
            } else if (raw instanceof JSONArray) {
                JSONArray arr = (JSONArray) raw;
                for (int i = 0; i < arr.length(); i++) {
                    sink.accept(String.valueOf(arr.get(i)).trim());
                }
            } else if (raw != null) {
                for (String part : String.valueOf(raw).split("[,\\s]+")) {
                    sink.accept(part.trim());
                }
            }
        } catch (Exception ignored) {
            /* ignore bad extras list */
        }
    }

    private static void applyLaunchFlag(Intent launch, String raw) {
        String flag = raw != null ? raw.trim().toUpperCase(Locale.ROOT) : "";
        if (flag.startsWith("FLAG_ACTIVITY_")) flag = flag.substring("FLAG_ACTIVITY_".length());
        if (flag.startsWith("ACTIVITY_")) flag = flag.substring("ACTIVITY_".length());
        switch (flag) {
            case "NEW_TASK":
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                break;
            case "CLEAR_TOP":
                launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                break;
            case "SINGLE_TOP":
                launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
                break;
            case "CLEAR_TASK":
                launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK);
                break;
            case "NO_HISTORY":
                launch.addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY);
                break;
            case "REORDER_TO_FRONT":
                launch.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                break;
            case "MULTIPLE_TASK":
                launch.addFlags(Intent.FLAG_ACTIVITY_MULTIPLE_TASK);
                break;
            case "NEW_DOCUMENT":
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT);
                }
                break;
            case "NO_ANIMATION":
                launch.addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION);
                break;
            default:
                break;
        }
    }

    private static void putLaunchExtra(Intent launch, String key, Object value) {
        if (value instanceof Boolean) {
            launch.putExtra(key, (Boolean) value);
        } else if (value instanceof Integer) {
            launch.putExtra(key, (Integer) value);
        } else if (value instanceof Long) {
            launch.putExtra(key, (Long) value);
        } else if (value instanceof Double) {
            double d = (Double) value;
            if (d == Math.rint(d) && Math.abs(d) <= Integer.MAX_VALUE) {
                launch.putExtra(key, (int) d);
            } else {
                launch.putExtra(key, d);
            }
        } else if (value != null && value != JSONObject.NULL) {
            launch.putExtra(key, String.valueOf(value));
        }
    }

    private static boolean nz(JSObject spec, String key) {
        return !specStr(spec, key).isEmpty();
    }

    private static String specStr(JSObject spec, String key) {
        if (spec == null || key == null || !spec.has(key)) return "";
        try {
            String v = spec.getString(key, "");
            return v != null ? v.trim() : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static JSONObject specJson(JSObject spec, String key) {
        if (spec == null || key == null || !spec.has(key)) return null;
        try {
            JSObject nested = spec.getJSObject(key);
            if (nested != null) return nested;
        } catch (Exception ignored) {
            /* fall through */
        }
        try {
            Object raw = spec.get(key);
            if (raw instanceof JSONObject) return (JSONObject) raw;
            if (raw instanceof String) {
                String s = ((String) raw).trim();
                if (s.startsWith("{")) return new JSONObject(s);
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }

    private static String installerPackage(PackageManager pm, String pkg) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                String installing = pm.getInstallSourceInfo(pkg).getInstallingPackageName();
                return installing != null ? installing : "";
            }
        } catch (Exception ignored) {
            /* fall through */
        }
        try {
            String legacy = pm.getInstallerPackageName(pkg);
            return legacy != null ? legacy : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static JSObject appIconViaLauncherApps(Context ctx, String pkg, int size, String variant) {
        try {
            LauncherApps launcherApps = ctx.getSystemService(LauncherApps.class);
            if (launcherApps == null) {
                return fail("launcher:icon", "launcher-apps-unavailable");
            }
            UserHandle user = Process.myUserHandle();
            List<LauncherActivityInfo> list = launcherApps.getActivityList(pkg, user);
            if (list == null || list.isEmpty()) {
                return fail("launcher:icon", "app-not-found");
            }
            Drawable drawable = list.get(0).getIcon(ctx.getResources().getDisplayMetrics().densityDpi);
            return encodeIconDrawable(drawable, pkg, size, variant);
        } catch (Exception e) {
            Log.w(TAG, "appIconViaLauncherApps failed pkg=" + pkg, e);
            return fail("launcher:icon", e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    private static JSObject appIconViaPackageManager(Context ctx, String pkg, int size) {
        return appIconViaPackageManager(ctx, pkg, size, "default");
    }

    private static JSObject appIconViaPackageManager(Context ctx, String pkg, int size, String variant) {
        try {
            PackageManager pm = ctx.getPackageManager();
            Drawable drawable = pm.getApplicationIcon(pkg);
            return encodeIconDrawable(drawable, pkg, size, variant);
        } catch (Exception e) {
            Log.w(TAG, "appIconViaPackageManager failed pkg=" + pkg, e);
            return fail("launcher:icon", e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    private static JSObject encodeIconDrawable(Drawable drawable, String pkg, int size, String variant) {
        return encodeIconDrawableWithPack(drawable, pkg, size, variant, null);
    }

    private static JSObject encodeIconDrawableWithPack(
            Drawable drawable, String pkg, int size, String pack) {
        return encodeIconDrawableWithPack(drawable, pkg, size, "default", pack);
    }

    /**
     * Pack icons (Lena Adaptive, …) often bake large transparent padding.
     * Render → trim opaque bounds → cover-fill the tile bitmap.
     */
    private static JSObject encodePackIconFilled(
            Drawable drawable, String pkg, Integer sizePx, String pack, String drawableName) {
        int size = sizePx != null ? sizePx : 96;
        if (size < 16) size = 16;
        if (size > 512) size = 512;
        if (drawable == null) {
            return fail("launcher:icon", "icon-unavailable");
        }
        try {
            int probe = Math.max(size * 2, 256);
            Bitmap src = Bitmap.createBitmap(probe, probe, Bitmap.Config.ARGB_8888);
            Canvas srcCanvas = new Canvas(src);
            srcCanvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
            if (!drawIconDrawableUnmasked(drawable, srcCanvas, probe, "default")) {
                return fail("launcher:icon", "variant-unavailable");
            }
            int[] bounds = opaqueBounds(src);
            Bitmap out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas outCanvas = new Canvas(out);
            outCanvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
            if (bounds == null) {
                /* Fully transparent / failed trim — fall back to centered draw. */
                if (!drawIconDrawableUnmasked(drawable, outCanvas, size, "default")) {
                    return fail("launcher:icon", "variant-unavailable");
                }
            } else {
                int l = bounds[0];
                int t = bounds[1];
                int r = bounds[2];
                int b = bounds[3];
                int bw = Math.max(1, r - l);
                int bh = Math.max(1, b - t);
                /* Cover-fill with slight overscale so soft edges don't leave a halo. */
                float scale = Math.max((float) size / bw, (float) size / bh) * 1.06f;
                float dw = bw * scale;
                float dh = bh * scale;
                float dx = (size - dw) * 0.5f;
                float dy = (size - dh) * 0.5f;
                android.graphics.Rect srcRect = new android.graphics.Rect(l, t, r, b);
                android.graphics.RectF dstRect = new android.graphics.RectF(dx, dy, dx + dw, dy + dh);
                outCanvas.drawBitmap(src, srcRect, dstRect, null);
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (!out.compress(Bitmap.CompressFormat.PNG, 100, bos)) {
                return fail("launcher:icon", "compress-failed");
            }
            String base64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            String packKey = pack != null ? pack.trim() : "";
            String drawKey = drawableName != null ? drawableName.trim() : "";
            JSObject echo = new JSObject();
            echo.put("cacheKey", pkg);
            echo.put("variant", "default");
            if (!packKey.isEmpty()) echo.put("pack", packKey);
            if (!drawKey.isEmpty()) echo.put("drawable", drawKey);
            echo.put("mime", "image/png");
            echo.put("base64", base64);
            JSObject result = base(true, "launcher:icon");
            result.put("echo", echo);
            result.put("cacheKey", pkg);
            result.put("variant", "default");
            if (!packKey.isEmpty()) result.put("pack", packKey);
            if (!drawKey.isEmpty()) result.put("drawable", drawKey);
            result.put("mime", "image/png");
            result.put("base64", base64);
            return result;
        } catch (Exception e) {
            Log.w(TAG, "encodePackIconFilled failed pkg=" + pkg, e);
            return fail("launcher:icon", e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    /** @return left,top,right,bottom opaque bounds or null if empty */
    private static int[] opaqueBounds(Bitmap bitmap) {
        if (bitmap == null) return null;
        int w = bitmap.getWidth();
        int h = bitmap.getHeight();
        int left = w;
        int top = h;
        int right = -1;
        int bottom = -1;
        int[] row = new int[w];
        for (int y = 0; y < h; y++) {
            bitmap.getPixels(row, 0, w, 0, y, w, 1);
            for (int x = 0; x < w; x++) {
                if (((row[x] >>> 24) & 0xff) > 12) {
                    if (x < left) left = x;
                    if (x > right) right = x;
                    if (y < top) top = y;
                    if (y > bottom) bottom = y;
                }
            }
        }
        if (right < left || bottom < top) return null;
        /* Pad 1px so we don't shave anti-alias. */
        left = Math.max(0, left - 1);
        top = Math.max(0, top - 1);
        right = Math.min(w, right + 2);
        bottom = Math.min(h, bottom + 2);
        return new int[] {left, top, right, bottom};
    }

    private static JSObject encodeIconDrawableWithPack(
            Drawable drawable, String pkg, int size, String variant, String pack) {
        if (drawable == null) {
            return fail("launcher:icon", "icon-unavailable");
        }
        try {
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
            if (!drawIconDrawableUnmasked(drawable, canvas, size, variant)) {
                return fail("launcher:icon", "variant-unavailable");
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, bos)) {
                return fail("launcher:icon", "compress-failed");
            }
            String base64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            String packKey = pack != null ? pack.trim() : "";
            JSObject echo = new JSObject();
            echo.put("cacheKey", pkg);
            echo.put("variant", variant);
            if (!packKey.isEmpty()) echo.put("pack", packKey);
            echo.put("mime", "image/png");
            echo.put("base64", base64);
            JSObject r = base(true, "launcher:icon");
            r.put("echo", echo);
            r.put("cacheKey", pkg);
            r.put("variant", variant);
            if (!packKey.isEmpty()) r.put("pack", packKey);
            r.put("mime", "image/png");
            r.put("base64", base64);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "encodeIconDrawable failed pkg=" + pkg, e);
            return fail("launcher:icon", e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    /**
     * Draw adaptive layers full-bleed (no OS circular mask).
     * Do NOT call AdaptiveIconDrawable.draw() — it applies the system mask path.
     *
     * @return false when the requested variant is missing (e.g. no Material You monochrome).
     */
    private static boolean drawIconDrawableUnmasked(
            Drawable drawable, Canvas canvas, int size, String variant) {
        String v = normalizeIconVariant(variant);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && drawable instanceof AdaptiveIconDrawable) {
            AdaptiveIconDrawable adaptive = (AdaptiveIconDrawable) drawable;
            if ("monochrome".equals(v)) {
                if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                    return false;
                }
                Drawable mono = adaptive.getMonochrome();
                if (mono == null) return false;
                mono.setBounds(0, 0, size, size);
                mono.draw(canvas);
                return true;
            }
            if ("foreground".equals(v)) {
                Drawable foreground = adaptive.getForeground();
                if (foreground == null) return false;
                foreground.setBounds(0, 0, size, size);
                foreground.draw(canvas);
                return true;
            }
            Drawable background = adaptive.getBackground();
            Drawable foreground = adaptive.getForeground();
            if (background != null) {
                background.setBounds(0, 0, size, size);
                background.draw(canvas);
            }
            if (foreground != null) {
                foreground.setBounds(0, 0, size, size);
                foreground.draw(canvas);
            }
            return true;
        }
        if ("monochrome".equals(v) || "foreground".equals(v)) {
            /* Non-adaptive: no separate Material You / FG layers. */
            return false;
        }
        drawable.setBounds(0, 0, size, size);
        drawable.draw(canvas);
        return true;
    }

    private static boolean queryIsDefaultHome(Context ctx) {
        if (ctx == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                RoleManager rm = ctx.getSystemService(RoleManager.class);
                return rm != null
                        && rm.isRoleAvailable(RoleManager.ROLE_HOME)
                        && rm.isRoleHeld(RoleManager.ROLE_HOME);
            }
            PackageManager pm = ctx.getPackageManager();
            Intent intent = new Intent(Intent.ACTION_MAIN);
            intent.addCategory(Intent.CATEGORY_HOME);
            ResolveInfo ri = pm.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY);
            return ri != null
                    && ri.activityInfo != null
                    && ctx.getPackageName().equals(ri.activityInfo.packageName);
        } catch (Exception e) {
            Log.w(TAG, "queryIsDefaultHome failed", e);
            return false;
        }
    }

    private static JSObject fail(String channel, String error) {
        JSObject r = base(false, channel);
        JSObject echo = new JSObject();
        echo.put("error", error);
        r.put("echo", echo);
        r.put("error", error);
        return r;
    }

    private static JSObject base(boolean ok, String channel) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("channel", channel);
        return r;
    }

    /**
     * Open http(s)/deep-link via {@link Intent#ACTION_VIEW} — optional package or system chooser
     * (Chrome, YouTube, …).
     *
     * @param mimeType optional MIME (e.g. text/plain) — without it, content:// often resolves to Files
     */
    public static JSObject openUri(
            Context ctx,
            String rawUri,
            String packageName,
            boolean chooser,
            String chooserTitle,
            String mimeType) {
        String uri = rawUri != null ? rawUri.trim() : "";
        if (uri.isEmpty()) {
            return fail("launcher:open-uri", "uri-missing");
        }
        try {
            Intent view;
            String resolvedMime = mimeType != null ? mimeType.trim() : "";
            if (uri.regionMatches(true, 0, "intent:", 0, 7)) {
                view = Intent.parseUri(uri, Intent.URI_INTENT_SCHEME);
                if (view == null) {
                    return fail("launcher:open-uri", "intent-uri-invalid");
                }
                /*
                 * WHY: pinned intent: URIs often embed the publisher package (Material Files).
                 * For document schemes, clear package/component so the system picks the
                 * correct viewer (Gallery, PDF, …) instead of always reopening Files.
                 */
                try {
                    android.net.Uri d = view.getData();
                    String sch =
                            d != null && d.getScheme() != null
                                    ? d.getScheme().toLowerCase(java.util.Locale.US)
                                    : "";
                    if ("content".equals(sch) || "file".equals(sch)) {
                        view.setPackage(null);
                        view.setComponent(null);
                        view.addFlags(
                                Intent.FLAG_GRANT_READ_URI_PERMISSION
                                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                        if (resolvedMime.isEmpty() && view.getType() != null) {
                            resolvedMime = view.getType().trim();
                        }
                        if (!resolvedMime.isEmpty() && d != null) {
                            view.setDataAndType(d, resolvedMime);
                        }
                    }
                } catch (Exception ignored) {
                    /* ignore */
                }
            } else {
                android.net.Uri parsed = android.net.Uri.parse(uri);
                if (parsed == null || parsed.getScheme() == null || parsed.getScheme().isEmpty()) {
                    return fail("launcher:open-uri", "uri-invalid");
                }
                String scheme = parsed.getScheme().toLowerCase(java.util.Locale.US);
                if (resolvedMime.isEmpty()) {
                    resolvedMime = guessMimeFromUri(uri);
                }
                if (("content".equals(scheme) || "file".equals(scheme)) && !resolvedMime.isEmpty()) {
                    view = new Intent(Intent.ACTION_VIEW);
                    view.setDataAndType(parsed, resolvedMime);
                } else {
                    view = new Intent(Intent.ACTION_VIEW, parsed);
                }
                if ("content".equals(scheme) || "file".equals(scheme)) {
                    view.addFlags(
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    /* WHY: grants apply via ClipData on some OEMs when using chooser. */
                    try {
                        if (view.getClipData() == null) {
                            view.setClipData(
                                    android.content.ClipData.newUri(
                                            ctx.getContentResolver(), "cwsp", parsed));
                        }
                    } catch (Exception ignored) {
                        /* ignore */
                    }
                }
            }
            view.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                            | Intent.FLAG_ACTIVITY_CLEAR_TOP
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            String pkg = packageName != null ? packageName.trim() : "";
            /*
             * WHY: never force package for content/file — caller may still pass publisher pkg
             * from older pinned tiles.
             */
            String openScheme = "";
            try {
                if (view.getData() != null && view.getData().getScheme() != null) {
                    openScheme = view.getData().getScheme().toLowerCase(java.util.Locale.US);
                }
            } catch (Exception ignored) {
                /* ignore */
            }
            boolean documentUri = "content".equals(openScheme) || "file".equals(openScheme);
            boolean ecosystemPkg = pkg.startsWith("space.u2re.");
            /*
             * WHY: skip publisher pkg on content/file (old Files tiles), but honor
             * ecosystem SKUs so Explorer can ACTION_VIEW into CWSP-document.
             */
            if (!pkg.isEmpty() && view.getPackage() == null && (!documentUri || ecosystemPkg)) {
                view.setPackage(pkg);
                if (documentUri && view.getData() != null) {
                    try {
                        ctx.grantUriPermission(
                                pkg,
                                view.getData(),
                                Intent.FLAG_GRANT_READ_URI_PERMISSION
                                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    } catch (Exception ignored) {
                        /* ignore */
                    }
                }
            }
            /*
             * WHY: previously we skipped chooser for all content:// — default handler for
             * untyped text documents is Material Files, so .txt shortcuts "duplicated" Files.
             * With MIME (text/plain) + chooser, the user gets a real editor.
             */
            boolean useChooser =
                    chooser
                            && pkg.isEmpty()
                            && view.getPackage() == null
                            && !uri.regionMatches(true, 0, "intent:", 0, 7);
            Intent launch = view;
            if (useChooser) {
                String title =
                        chooserTitle != null && !chooserTitle.trim().isEmpty()
                                ? chooserTitle.trim()
                                : "Open with";
                launch = Intent.createChooser(view, title);
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                if (documentUri) {
                    launch.addFlags(
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                }
            }
            ctx.startActivity(launch);
            JSObject echo = new JSObject();
            echo.put("opened", true);
            echo.put("uri", uri);
            if (!pkg.isEmpty()) echo.put("packageName", pkg);
            if (!resolvedMime.isEmpty()) echo.put("mimeType", resolvedMime);
            echo.put("chooser", useChooser);
            JSObject r = base(true, "launcher:open-uri");
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "openUri failed uri=" + uri, e);
            return fail(
                    "launcher:open-uri",
                    e.getMessage() != null ? e.getMessage() : "open-failed");
        }
    }

    /** Overload for callers that omit MIME. */
    public static JSObject openUri(
            Context ctx, String rawUri, String packageName, boolean chooser, String chooserTitle) {
        return openUri(ctx, rawUri, packageName, chooser, chooserTitle, "");
    }

    /**
     * WHY: Explorer OPFS {@code /user/} has no content://. Write bytes to this APK's
     * cache FileProvider, then ACTION_VIEW the sibling (Document / Transfer).
     */
    public static JSObject openBytes(
            Context ctx,
            String name,
            String mimeType,
            String dataUrl,
            String packageName,
            boolean chooser,
            String chooserTitle) {
        if (ctx == null) return fail("launcher:open-bytes", "context-null");
        byte[] bytes = decodeDataUrlOrBase64(dataUrl);
        if (bytes == null || bytes.length == 0) {
            return fail("launcher:open-bytes", "data-missing");
        }
        if (bytes.length > 8L * 1024 * 1024) {
            return fail("launcher:open-bytes", "too-large");
        }
        File dir = new File(ctx.getCacheDir(), "files");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            return fail("launcher:open-bytes", "cache-mkdir");
        }
        String safe = safeShareName(name);
        File dest = new File(dir, safe);
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(dest);
            out.write(bytes);
            out.flush();
        } catch (Exception e) {
            Log.w(TAG, "openBytes write failed", e);
            return fail(
                    "launcher:open-bytes",
                    e.getMessage() != null ? e.getMessage() : "write-failed");
        } finally {
            try {
                if (out != null) out.close();
            } catch (Exception ignored) {
                /* ignore */
            }
        }
        String uri;
        try {
            uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", dest)
                    .toString();
        } catch (Exception e) {
            Log.w(TAG, "openBytes FileProvider failed", e);
            return fail("launcher:open-bytes", "fileprovider-failed");
        }
        String mime = mimeType != null ? mimeType.trim() : "";
        if (mime.isEmpty()) mime = guessMimeFromUri(safe);
        /* WHY: Document's SEND filters match text/* / image/* reliably; VIEW+pathPattern often misses FileProvider. */
        return sendToPackage(ctx, uri, safe, mime, packageName, chooser, chooserTitle);
    }

    public static JSObject sendToPackage(
            Context ctx,
            String rawUri,
            String name,
            String mimeType,
            String packageName,
            boolean chooser,
            String chooserTitle) {
        if (ctx == null) return fail("launcher:send-to-package", "context-null");
        String uri = rawUri != null ? rawUri.trim() : "";
        if (uri.isEmpty()) return fail("launcher:send-to-package", "uri-missing");
        android.net.Uri parsed;
        try {
            parsed = android.net.Uri.parse(uri);
        } catch (Exception e) {
            return fail("launcher:send-to-package", "uri-invalid");
        }
        if (parsed == null || parsed.getScheme() == null) {
            return fail("launcher:send-to-package", "uri-invalid");
        }
        String mime = mimeType != null ? mimeType.trim() : "";
        if (mime.isEmpty()) mime = guessMimeFromUri(uri);
        if (mime.isEmpty()) mime = "application/octet-stream";
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime);
        send.putExtra(Intent.EXTRA_STREAM, parsed);
        if (name != null && !name.trim().isEmpty()) {
            send.putExtra(Intent.EXTRA_TITLE, name.trim());
        }
        send.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        try {
            send.setClipData(
                    android.content.ClipData.newUri(ctx.getContentResolver(), "cwsp", parsed));
        } catch (Exception ignored) {
            /* optional */
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (!pkg.isEmpty()) {
            send.setPackage(pkg);
            try {
                ctx.grantUriPermission(
                        pkg,
                        parsed,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
                /* ignore */
            }
        }
        try {
            Intent launch = send;
            if (chooser && pkg.isEmpty()) {
                String title =
                        chooserTitle != null && !chooserTitle.trim().isEmpty()
                                ? chooserTitle.trim()
                                : "Open with";
                launch = Intent.createChooser(send, title);
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            }
            ctx.startActivity(launch);
            JSObject echo = new JSObject();
            echo.put("opened", true);
            echo.put("uri", uri);
            echo.put("sent", true);
            if (!pkg.isEmpty()) echo.put("packageName", pkg);
            echo.put("mimeType", mime);
            JSObject r = base(true, "launcher:send-to-package");
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "sendToPackage failed, falling back to VIEW", e);
            return openUri(ctx, uri, packageName, chooser, chooserTitle, mime);
        }
    }

    private static byte[] decodeDataUrlOrBase64(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.isEmpty()) return null;
        int comma = s.indexOf(',');
        if (s.regionMatches(true, 0, "data:", 0, 5) && comma > 0) {
            s = s.substring(comma + 1);
        }
        try {
            return Base64.decode(s, Base64.DEFAULT);
        } catch (Exception e) {
            return null;
        }
    }

    private static String safeShareName(String name) {
        String n = name != null ? name.trim() : "";
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        if (slash >= 0) n = n.substring(slash + 1);
        n = n.replaceAll("[^A-Za-z0-9._-]", "_");
        if (n.isEmpty() || ".".equals(n) || "..".equals(n)) n = "shared.bin";
        if (n.length() > 120) n = n.substring(n.length() - 120);
        return n;
    }

    private static String guessMimeFromUri(String uri) {
        String s = uri != null ? uri.toLowerCase(java.util.Locale.US) : "";
        if (s.contains(".txt") || s.contains(".log") || s.contains(".csv")) return "text/plain";
        if (s.contains(".md")) return "text/markdown";
        if (s.contains(".pdf")) return "application/pdf";
        if (s.contains(".png")) return "image/png";
        if (s.contains(".jpg") || s.contains(".jpeg")) return "image/jpeg";
        if (s.contains(".gif")) return "image/gif";
        if (s.contains(".webp")) return "image/webp";
        if (s.contains(".mp4")) return "video/mp4";
        if (s.contains(".mp3")) return "audio/mpeg";
        if (s.contains(".html") || s.contains(".htm")) return "text/html";
        if (s.contains(".json")) return "application/json";
        if (s.contains(".zip")) return "application/zip";
        return "";
    }

    /**
     * Last Share / pin payload. Memory + prefs — process death after a WebView crash
     * must not lose the tile. Bridge sees only {@link #slimPinForBridge}.
     */
    private static final Object PENDING_PIN_LOCK = new Object();
    private static final String PIN_PREFS = "cwsp_launcher";
    private static final String PIN_PREFS_KEY = "pending_pin_json";
    private static final int BRIDGE_URI_MAX = 512;
    private static final int BRIDGE_LABEL_MAX = 180;
    private static JSObject pendingPin = null;

    public static void stashPendingPin(JSObject pin) {
        stashPendingPin(null, pin);
    }

    public static void stashPendingPin(Context ctx, JSObject pin) {
        JSObject slim = slimPinForBridge(pin);
        if (slim != null && !slim.has("stashedAt")) {
            slim.put("stashedAt", System.currentTimeMillis());
        }
        synchronized (PENDING_PIN_LOCK) {
            pendingPin = slim;
        }
        if (ctx == null || slim == null) return;
        try {
            ctx.getApplicationContext()
                    .getSharedPreferences(PIN_PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(PIN_PREFS_KEY, slim.toString())
                    .apply();
        } catch (Exception e) {
            Log.w(TAG, "stashPendingPin persist failed", e);
        }
    }

    /** Non-destructive peek (memory, then prefs). */
    public static JSObject peekPendingPin() {
        return peekPendingPin(null);
    }

    public static JSObject peekPendingPin(Context ctx) {
        synchronized (PENDING_PIN_LOCK) {
            if (pendingPin != null) return pendingPin;
        }
        if (ctx == null) return null;
        try {
            String json =
                    ctx.getApplicationContext()
                            .getSharedPreferences(PIN_PREFS, Context.MODE_PRIVATE)
                            .getString(PIN_PREFS_KEY, "");
            if (json == null || json.isEmpty()) return null;
            JSObject stored = new JSObject(json);
            synchronized (PENDING_PIN_LOCK) {
                if (pendingPin == null) pendingPin = stored;
                return pendingPin;
            }
        } catch (Exception e) {
            Log.w(TAG, "peekPendingPin prefs failed", e);
            return null;
        }
    }

    public static void ackPendingPin(Context ctx) {
        synchronized (PENDING_PIN_LOCK) {
            pendingPin = null;
        }
        if (ctx == null) return;
        try {
            ctx.getApplicationContext()
                    .getSharedPreferences(PIN_PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .remove(PIN_PREFS_KEY)
                    .apply();
        } catch (Exception e) {
            Log.w(TAG, "ackPendingPin failed", e);
        }
    }

    /**
     * INVARIANT: never copy iconUrl / intentUri / share text onto the Capacitor bridge.
     * evaluateJavascript of those strings killed the WebView; the tile then vanished
     * because the in-memory stash died with the process.
     */
    public static JSObject slimPinForBridge(JSObject pin) {
        if (pin == null) return null;
        JSObject slim = new JSObject();
        putClipped(slim, pin, "action", 64);
        putClipped(slim, pin, "packageName", 256);
        putClipped(slim, pin, "shortcutId", 1024);
        putClipped(slim, pin, "label", BRIDGE_LABEL_MAX);
        putClipped(slim, pin, "mimeType", 128);
        putClipped(slim, pin, "iconDisplay", 32);
        putClipped(slim, pin, "source", 64);
        putClipped(slim, pin, "componentName", 256);
        if (pin.has("stashedAt")) {
            try {
                slim.put("stashedAt", pin.getLong("stashedAt"));
            } catch (Exception ignored) {
                /* optional */
            }
        }
        String url = firstPinString(pin, "url", "href");
        if (isBridgeSafeUri(url)) {
            slim.put("url", url);
            slim.put("href", url);
        }
        return slim;
    }

    private static void putClipped(JSObject dest, JSObject src, String key, int max) {
        String v = firstPinString(src, key);
        if (v.isEmpty()) return;
        if (v.length() > max) v = v.substring(0, max);
        dest.put(key, v);
    }

    private static String firstPinString(JSObject src, String... keys) {
        if (src == null || keys == null) return "";
        for (String key : keys) {
            if (key == null || !src.has(key)) continue;
            try {
                String v = String.valueOf(src.get(key)).trim();
                if ("null".equals(v)) continue;
                if (!v.isEmpty()) return v;
            } catch (Exception ignored) {
                /* missing */
            }
        }
        return "";
    }

    private static boolean isBridgeSafeUri(String uri) {
        if (uri == null) return false;
        String s = uri.trim();
        if (s.isEmpty() || s.length() > BRIDGE_URI_MAX) return false;
        String lower = s.toLowerCase(Locale.US);
        if (lower.startsWith("data:")
                || lower.startsWith("blob:")
                || lower.startsWith("intent:")
                || lower.startsWith("android-app:")) {
            return false;
        }
        return lower.startsWith("http://")
                || lower.startsWith("https://")
                || lower.startsWith("content://")
                || lower.startsWith("file://")
                || lower.startsWith("www.");
    }

    /** Peek only — JS must {@link #ackPendingPin} after the tile is added. */
    public static JSObject consumePendingPin() {
        return consumePendingPin(null);
    }

    public static JSObject consumePendingPin(Context ctx) {
        JSObject pin = peekPendingPin(ctx);
        JSObject r = base(true, "launcher:pending-pin");
        JSObject echo = new JSObject();
        JSObject slim = slimPinForBridge(pin);
        if (slim != null) {
            echo.put("pin", slim);
            r.put("pin", slim);
        }
        r.put("echo", echo);
        return r;
    }

    public static JSObject ackPendingPinResult(Context ctx) {
        ackPendingPin(ctx);
        return base(true, "launcher:ack-pin");
    }

    /**
     * Share / VIEW / PROCESS_TEXT file stash. Bytes stay on disk — never on
     * {@code evaluateJavascript}. JS reads via {@link #readPendingShareFile}.
     */
    private static final Object PENDING_SHARE_LOCK = new Object();
    private static final String SHARE_PREFS_KEY = "pending_share_json";
    private static final String SHARE_FILE_NAME = "pending-share.bin";
    private static final long MAX_SHARE_BYTES = 32L * 1024 * 1024;
    private static JSObject pendingShare = null;

    private static File pendingShareFile(Context ctx) {
        if (ctx == null) return null;
        return new File(ctx.getApplicationContext().getFilesDir(), SHARE_FILE_NAME);
    }

    public static void stashPendingShare(Context ctx, JSObject share) {
        if (share == null) return;
        JSObject slim = new JSObject();
        /* WHY: PROCESS_TEXT without a stream is the document. Pin 4k clip dropped most of it. */
        boolean hasUri = share.has("uri") || share.has("url");
        putClipped(slim, share, "text", hasUri ? 4000 : 64 * 1024);
        putClipped(slim, share, "title", BRIDGE_LABEL_MAX);
        putClipped(slim, share, "name", 256);
        putClipped(slim, share, "mime", 128);
        slim.put("stashedAt", System.currentTimeMillis());
        boolean copied = false;
        String uriRaw = firstPinString(share, "uri", "url");
        /* WHY: MediaStore/SAF content:// is often > pin BRIDGE_URI_MAX (512). Restash needs the full URI. */
        if (!uriRaw.isEmpty() && uriRaw.length() <= 8 * 1024) {
            slim.put("url", uriRaw);
            slim.put("uri", uriRaw);
        }
        if (ctx != null && !uriRaw.isEmpty()) {
            try {
                android.net.Uri uri = android.net.Uri.parse(uriRaw);
                try {
                    ctx.getContentResolver()
                            .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception ignored) {
                    /* grant is optional — file:// and one-shot content:// */
                }
                copied = copyShareUriToDisk(ctx, uri);
                String display = queryShareDisplayName(ctx, uri);
                if (!display.isEmpty()) slim.put("name", display);
                else if (!slim.has("name")) {
                    String seg = uri.getLastPathSegment();
                    if (seg != null && !seg.isEmpty()) slim.put("name", android.net.Uri.decode(seg));
                }
            } catch (Exception e) {
                Log.w(TAG, "stashPendingShare copy failed", e);
            }
        }
        slim.put("hasFile", copied);
        synchronized (PENDING_SHARE_LOCK) {
            pendingShare = slim;
        }
        if (ctx == null) return;
        try {
            ctx.getApplicationContext()
                    .getSharedPreferences(PIN_PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(SHARE_PREFS_KEY, slim.toString())
                    .apply();
        } catch (Exception e) {
            Log.w(TAG, "stashPendingShare persist failed", e);
        }
    }

    private static String queryShareDisplayName(Context ctx, android.net.Uri uri) {
        if (ctx == null || uri == null) return "";
        android.database.Cursor cursor = null;
        try {
            cursor = ctx.getContentResolver().query(
                    uri,
                    new String[] { android.provider.OpenableColumns.DISPLAY_NAME },
                    null,
                    null,
                    null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                if (index >= 0) {
                    String name = cursor.getString(index);
                    if (name != null && !name.trim().isEmpty()) return name.trim();
                }
            }
        } catch (Exception ignored) {
            /* display name optional */
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
        return "";
    }

    private static boolean copyShareUriToDisk(Context ctx, android.net.Uri uri) {
        if (ctx == null || uri == null) return false;
        File dest = pendingShareFile(ctx);
        if (dest == null) return false;
        InputStream in = null;
        FileOutputStream out = null;
        try {
            try {
                in = ctx.getContentResolver().openInputStream(uri);
            } catch (Exception e) {
                Log.w(TAG, "openInputStream failed, try file path", e);
            }
            /* WHY: Open-with from Notes/etc often ships file:///storage/... — resolver is null. */
            if (in == null && "file".equalsIgnoreCase(uri.getScheme())) {
                String path = uri.getPath();
                if (path != null && !path.isEmpty()) {
                    File src = new File(path);
                    if (src.isFile() && src.canRead()) in = new FileInputStream(src);
                }
            }
            if (in == null) return false;
            out = new FileOutputStream(dest);
            byte[] buf = new byte[16 * 1024];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_SHARE_BYTES) {
                    dest.delete();
                    return false;
                }
                out.write(buf, 0, n);
            }
            out.flush();
            return dest.length() > 0;
        } catch (Exception e) {
            Log.w(TAG, "copyShareUriToDisk failed", e);
            try {
                dest.delete();
            } catch (Exception ignored) {
                /* ignore */
            }
            return false;
        } finally {
            try {
                if (in != null) in.close();
            } catch (Exception ignored) {
                /* ignore */
            }
            try {
                if (out != null) out.close();
            } catch (Exception ignored) {
                /* ignore */
            }
        }
    }

    public static JSObject peekPendingShare(Context ctx) {
        synchronized (PENDING_SHARE_LOCK) {
            if (pendingShare != null) return pendingShare;
        }
        if (ctx == null) return null;
        try {
            String json =
                    ctx.getApplicationContext()
                            .getSharedPreferences(PIN_PREFS, Context.MODE_PRIVATE)
                            .getString(SHARE_PREFS_KEY, "");
            if (json == null || json.isEmpty()) return null;
            JSObject stored = new JSObject(json);
            synchronized (PENDING_SHARE_LOCK) {
                if (pendingShare == null) pendingShare = stored;
                return pendingShare;
            }
        } catch (Exception e) {
            Log.w(TAG, "peekPendingShare prefs failed", e);
            return null;
        }
    }

    public static JSObject consumePendingShare(Context ctx) {
        JSObject share = peekPendingShare(ctx);
        JSObject r = base(true, "launcher:pending-share");
        JSObject echo = new JSObject();
        if (share != null) {
            putClipped(echo, share, "text", 64 * 1024);
            putClipped(echo, share, "title", BRIDGE_LABEL_MAX);
            putClipped(echo, share, "name", 256);
            putClipped(echo, share, "mime", 128);
            String url = firstPinString(share, "url", "uri");
            if (!url.isEmpty() && url.length() <= 8 * 1024) echo.put("url", url);
            boolean hasFile = false;
            try {
                String flag = share.getString("hasFile", "");
                hasFile = "true".equalsIgnoreCase(flag) || "1".equals(flag);
            } catch (Exception ignored) {
                /* optional */
            }
            File disk = pendingShareFile(ctx);
            if (disk != null && disk.isFile() && disk.length() > 0) hasFile = true;
            echo.put("hasFile", hasFile);
            long stashedAt = readStashedAt(share);
            if (stashedAt > 0L) echo.put("stashedAt", stashedAt);
        }
        r.put("echo", echo);
        return r;
    }

    static long readStashedAt(JSObject row) {
        if (row == null) return 0L;
        try {
            if (!row.has("stashedAt")) return 0L;
            Object raw = row.get("stashedAt");
            if (raw instanceof Number) return ((Number) raw).longValue();
            if (raw != null) {
                String text = String.valueOf(raw).trim();
                if (!text.isEmpty() && !"null".equals(text)) return Long.parseLong(text);
            }
        } catch (Exception ignored) {
            /* optional generation */
        }
        return 0L;
    }

    /** Re-copy `url`/`uri` after the user grants all-files access. */
    public static JSObject restashPendingShareFile(Context ctx) {
        JSObject r = base(true, "launcher:restash-share-file");
        JSObject echo = new JSObject();
        JSObject share = peekPendingShare(ctx);
        boolean copied = false;
        if (ctx != null && share != null) {
            String raw = firstPinString(share, "url");
            if (raw.isEmpty()) raw = firstPinString(share, "uri");
            if (!raw.isEmpty()) {
                try {
                    copied = copyShareUriToDisk(ctx, android.net.Uri.parse(raw));
                    share.put("hasFile", copied);
                    persistPendingShare(ctx, share);
                } catch (Exception e) {
                    Log.w(TAG, "restashPendingShareFile failed", e);
                }
            }
        }
        echo.put("hasFile", copied);
        r.put("echo", echo);
        return r;
    }

    private static void persistPendingShare(Context ctx, JSObject slim) {
        if (ctx == null || slim == null) return;
        try {
            ctx.getApplicationContext()
                    .getSharedPreferences(PIN_PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(SHARE_PREFS_KEY, slim.toString())
                    .apply();
        } catch (Exception e) {
            Log.w(TAG, "persistPendingShare failed", e);
        }
    }

    public static JSObject readPendingShareFile(Context ctx) {
        JSObject r = base(true, "launcher:read-share-file");
        JSObject echo = new JSObject();
        File disk = pendingShareFile(ctx);
        JSObject meta = peekPendingShare(ctx);
        if (disk != null && disk.isFile() && disk.length() > 0 && disk.length() <= MAX_SHARE_BYTES) {
            FileInputStream in = null;
            try {
                in = new FileInputStream(disk);
                byte[] bytes = new byte[(int) disk.length()];
                int off = 0;
                while (off < bytes.length) {
                    int n = in.read(bytes, off, bytes.length - off);
                    if (n < 0) break;
                    off += n;
                }
                String mime = meta != null ? firstPinString(meta, "mime") : "";
                if (mime.isEmpty()) mime = "application/octet-stream";
                String name = meta != null ? firstPinString(meta, "name") : "";
                if (name.isEmpty()) name = "shared.bin";
                echo.put("data", "data:" + mime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
                echo.put("mime", mime);
                echo.put("name", name);
            } catch (Exception e) {
                Log.w(TAG, "readPendingShareFile failed", e);
            } finally {
                try {
                    if (in != null) in.close();
                } catch (Exception ignored) {
                    /* ignore */
                }
            }
        }
        r.put("echo", echo);
        return r;
    }

    public static JSObject ackPendingShare(Context ctx) {
        return ackPendingShare(ctx, null);
    }

    public static JSObject ackPendingShare(Context ctx, JSObject payload) {
        long expect = readStashedAt(payload);
        synchronized (PENDING_SHARE_LOCK) {
            if (expect > 0L && pendingShare != null) {
                long have = readStashedAt(pendingShare);
                /* INVARIANT: a newer Open-with/Share must survive a late ack of the previous stash. */
                if (have > 0L && have != expect) {
                    return base(true, "launcher:ack-share");
                }
            }
            pendingShare = null;
        }
        if (ctx != null) {
            try {
                ctx.getApplicationContext()
                        .getSharedPreferences(PIN_PREFS, Context.MODE_PRIVATE)
                        .edit()
                        .remove(SHARE_PREFS_KEY)
                        .apply();
            } catch (Exception e) {
                Log.w(TAG, "ackPendingShare prefs failed", e);
            }
            try {
                File disk = pendingShareFile(ctx);
                if (disk != null) disk.delete();
            } catch (Exception e) {
                Log.w(TAG, "ackPendingShare file failed", e);
            }
        }
        return base(true, "launcher:ack-share");
    }
}
