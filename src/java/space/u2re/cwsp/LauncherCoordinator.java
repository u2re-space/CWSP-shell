/*
 * Filename: LauncherCoordinator.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/LauncherCoordinator.java
 * Change date and time: 18.50.00_19.08.2026
 * Reason for changes: PackageManager fallback when not default HOME — list/launch/icon still work.
 */

package space.u2re.cwsp;

import android.app.Activity;
import android.app.role.RoleManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.LauncherActivityInfo;
import android.content.pm.LauncherApps;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
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

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Native launcher coordinator for {@code launcher:*} IPC channels. */
public final class LauncherCoordinator {
    private static final String TAG = "LauncherCoordinator";

    private LauncherCoordinator() {}

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

    public static JSObject launchApp(Context ctx, String packageName, String componentName) {
        if (ctx == null) {
            return fail("launcher:launch", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (pkg.isEmpty()) {
            return fail("launcher:launch", "missing-package");
        }
        if (queryIsDefaultHome(ctx)) {
            return launchAppViaLauncherApps(ctx, pkg, componentName);
        }
        return launchAppViaPackageManager(ctx, pkg, componentName);
    }

    public static JSObject appIcon(Context ctx, String packageName, Integer sizePx) {
        if (ctx == null) {
            return fail("launcher:icon", "context-null");
        }
        String pkg = packageName != null ? packageName.trim() : "";
        if (pkg.isEmpty()) {
            return fail("launcher:icon", "missing-package");
        }
        int size = sizePx != null ? sizePx : 96;
        if (size < 16) size = 16;
        if (size > 192) size = 192;
        /* WHY: PackageManager adaptive layers — no LauncherApps circular badge/mask. */
        return appIconViaPackageManager(ctx, pkg, size);
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

    private static JSObject launchAppViaPackageManager(Context ctx, String pkg, String componentName) {
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
            if (launch == null) {
                return fail("launcher:launch", "app-not-found");
            }
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

    private static JSObject appIconViaLauncherApps(Context ctx, String pkg, int size) {
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
            return encodeIconDrawable(drawable, pkg, size);
        } catch (Exception e) {
            Log.w(TAG, "appIconViaLauncherApps failed pkg=" + pkg, e);
            return fail("launcher:icon", e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    private static JSObject appIconViaPackageManager(Context ctx, String pkg, int size) {
        try {
            PackageManager pm = ctx.getPackageManager();
            Drawable drawable = pm.getApplicationIcon(pkg);
            return encodeIconDrawable(drawable, pkg, size);
        } catch (Exception e) {
            Log.w(TAG, "appIconViaPackageManager failed pkg=" + pkg, e);
            return fail("launcher:icon", e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    private static JSObject encodeIconDrawable(Drawable drawable, String pkg, int size) {
        if (drawable == null) {
            return fail("launcher:icon", "icon-unavailable");
        }
        try {
            Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bitmap);
            canvas.drawColor(Color.TRANSPARENT, PorterDuff.Mode.CLEAR);
            drawIconDrawableUnmasked(drawable, canvas, size);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, bos)) {
                return fail("launcher:icon", "compress-failed");
            }
            String base64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
            JSObject echo = new JSObject();
            echo.put("cacheKey", pkg);
            echo.put("mime", "image/png");
            echo.put("base64", base64);
            JSObject r = base(true, "launcher:icon");
            r.put("echo", echo);
            r.put("cacheKey", pkg);
            r.put("mime", "image/png");
            r.put("base64", base64);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "encodeIconDrawable failed pkg=" + pkg, e);
            return fail("launcher:icon", e.getMessage() != null ? e.getMessage() : "icon-failed");
        }
    }

    /**
     * Draw adaptive foreground/background layers full-bleed (no OS circular mask).
     * Do NOT call AdaptiveIconDrawable.draw() — it applies the system mask path.
     */
    private static void drawIconDrawableUnmasked(Drawable drawable, Canvas canvas, int size) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && drawable instanceof AdaptiveIconDrawable) {
            AdaptiveIconDrawable adaptive = (AdaptiveIconDrawable) drawable;
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
            return;
        }
        drawable.setBounds(0, 0, size, size);
        drawable.draw(canvas);
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
}
