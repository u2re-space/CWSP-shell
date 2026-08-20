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
}
