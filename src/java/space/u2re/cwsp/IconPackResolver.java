/*
 * Filename: IconPackResolver.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/IconPackResolver.java
 * Change date and time: 18.20.00_20.08.2026
 * Reason for changes: Phase 1 — discover launcher icon packs + resolve themed icons via appfilter.
 */

package space.u2re.cwsp;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.content.res.AssetManager;
import android.content.res.Resources;
import android.content.res.XmlResourceParser;
import android.graphics.drawable.Drawable;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.xmlpull.v1.XmlPullParser;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Icon-pack discovery (ADW / Nova / GO / … theme intents) and appfilter-based icon resolve.
 */
public final class IconPackResolver {
    private static final String TAG = "IconPackResolver";

    private static final String[] THEME_ACTIONS = {
            "org.adw.launcher.THEMES",
            "com.gau.go.launcherex.theme",
            "com.novalauncher.THEME",
            "com.teslacoilsw.launcher.THEME",
            "com.anddoes.launcher.THEME",
            "com.fede.launcher.THEME_ICONPACK",
            "ginlemon.smartlauncher.THEME",
            "com.dlto.atom.launcher.THEME",
            "org.adw.launcher.icons.ACTION_PICK_ICON"
    };

    /** packPkg → (componentKey → drawableName) */
    private static final ConcurrentHashMap<String, Map<String, String>> APPFILTER_CACHE =
            new ConcurrentHashMap<>();

    private IconPackResolver() {}

    public static JSObject listIconPacks(Context ctx) {
        if (ctx == null) {
            return fail("launcher:icon-packs", "context-null");
        }
        try {
            PackageManager pm = ctx.getPackageManager();
            Map<String, ResolveInfo> byPkg = new LinkedHashMap<>();
            for (String action : THEME_ACTIONS) {
                Intent intent = new Intent(action);
                List<ResolveInfo> hits;
                try {
                    hits = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL);
                } catch (Exception e) {
                    continue;
                }
                if (hits == null) continue;
                for (ResolveInfo ri : hits) {
                    if (ri == null || ri.activityInfo == null) continue;
                    String pkg = ri.activityInfo.packageName;
                    if (pkg == null || pkg.isEmpty()) continue;
                    byPkg.putIfAbsent(pkg, ri);
                }
            }

            List<Map.Entry<String, ResolveInfo>> sorted = new ArrayList<>(byPkg.entrySet());
            Collections.sort(
                    sorted,
                    new Comparator<Map.Entry<String, ResolveInfo>>() {
                        @Override
                        public int compare(
                                Map.Entry<String, ResolveInfo> a, Map.Entry<String, ResolveInfo> b) {
                            String la = labelOf(pm, a.getKey(), a.getValue());
                            String lb = labelOf(pm, b.getKey(), b.getValue());
                            return la.compareToIgnoreCase(lb);
                        }
                    });

            JSArray packs = new JSArray();
            for (Map.Entry<String, ResolveInfo> e : sorted) {
                String pkg = e.getKey();
                JSObject entry = new JSObject();
                entry.put("packageName", pkg);
                entry.put("label", labelOf(pm, pkg, e.getValue()));
                entry.put("iconCacheKey", pkg);
                packs.put(entry);
            }

            JSObject echo = new JSObject();
            echo.put("packs", packs);
            JSObject r = base(true, "launcher:icon-packs");
            r.put("echo", echo);
            r.put("packs", packs);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "listIconPacks failed", e);
            return fail(
                    "launcher:icon-packs",
                    e.getMessage() != null ? e.getMessage() : "icon-packs-failed");
        }
    }

    /**
     * Resolve themed drawable for {@code targetPackage} from {@code packPackage} via appfilter.
     *
     * @return drawable or null when unmapped / unloadable
     */
    public static Drawable resolveThemedIcon(Context ctx, String targetPackage, String packPackage) {
        if (ctx == null) return null;
        String target = targetPackage != null ? targetPackage.trim() : "";
        String pack = packPackage != null ? packPackage.trim() : "";
        if (target.isEmpty() || pack.isEmpty()) return null;

        try {
            PackageManager pm = ctx.getPackageManager();
            Map<String, String> filter = loadAppfilter(ctx, pm, pack);
            if (filter == null || filter.isEmpty()) return null;

            String drawableName = lookupDrawable(pm, target, filter);
            if (drawableName == null || drawableName.isEmpty()) return null;

            Context packCtx =
                    ctx.createPackageContext(pack, Context.CONTEXT_IGNORE_SECURITY);
            Resources res = packCtx.getResources();
            int id = res.getIdentifier(drawableName, "drawable", pack);
            if (id == 0) {
                id = res.getIdentifier(drawableName, "mipmap", pack);
            }
            if (id == 0) return null;
            return res.getDrawable(id, packCtx.getTheme());
        } catch (Exception e) {
            Log.w(TAG, "resolveThemedIcon failed target=" + target + " pack=" + pack, e);
            return null;
        }
    }

    /**
     * Load a named drawable from an icon pack.
     */
    public static Drawable resolveDrawableByName(Context ctx, String packPackage, String drawableName) {
        if (ctx == null) return null;
        String pack = packPackage != null ? packPackage.trim() : "";
        String name = drawableName != null ? drawableName.trim() : "";
        if (pack.isEmpty() || name.isEmpty()) return null;
        try {
            Context packCtx =
                    ctx.createPackageContext(pack, Context.CONTEXT_IGNORE_SECURITY);
            Resources res = packCtx.getResources();
            int id = res.getIdentifier(name, "drawable", pack);
            if (id == 0) id = res.getIdentifier(name, "mipmap", pack);
            if (id == 0) return null;
            return res.getDrawable(id, packCtx.getTheme());
        } catch (Exception e) {
            Log.w(TAG, "resolveDrawableByName failed pack=" + pack + " name=" + name, e);
            return null;
        }
    }

    /**
     * Unique drawable names from the pack's appfilter (optionally filtered).
     */
    public static JSObject listPackIcons(
            Context ctx, String packPackage, String query, Integer limitPx) {
        if (ctx == null) {
            return fail("launcher:icon-pack-icons", "context-null");
        }
        String pack = packPackage != null ? packPackage.trim() : "";
        if (pack.isEmpty()) {
            return fail("launcher:icon-pack-icons", "missing-pack");
        }
        int limit = limitPx != null ? limitPx : 120;
        if (limit < 8) limit = 8;
        if (limit > 400) limit = 400;
        String needle = query != null ? query.trim().toLowerCase(Locale.ROOT) : "";
        try {
            PackageManager pm = ctx.getPackageManager();
            Map<String, String> filter = loadAppfilter(ctx, pm, pack);
            LinkedHashMap<String, Boolean> unique = new LinkedHashMap<>();
            if (filter != null) {
                for (String drawable : filter.values()) {
                    if (drawable == null || drawable.isEmpty()) continue;
                    String key = drawable.trim();
                    if (key.isEmpty()) continue;
                    if (!needle.isEmpty() && !key.toLowerCase(Locale.ROOT).contains(needle)) {
                        continue;
                    }
                    unique.putIfAbsent(key, Boolean.TRUE);
                }
            }
            JSArray icons = new JSArray();
            int count = 0;
            for (String drawable : unique.keySet()) {
                if (count >= limit) break;
                JSObject entry = new JSObject();
                entry.put("drawable", drawable);
                entry.put("label", drawable.replace('_', ' '));
                icons.put(entry);
                count++;
            }
            JSObject echo = new JSObject();
            echo.put("packageName", pack);
            echo.put("icons", icons);
            echo.put("total", unique.size());
            JSObject r = base(true, "launcher:icon-pack-icons");
            r.put("echo", echo);
            r.put("icons", icons);
            r.put("total", unique.size());
            return r;
        } catch (Exception e) {
            Log.w(TAG, "listPackIcons failed pack=" + pack, e);
            return fail(
                    "launcher:icon-pack-icons",
                    e.getMessage() != null ? e.getMessage() : "icon-pack-icons-failed");
        }
    }

    private static String lookupDrawable(
            PackageManager pm, String targetPkg, Map<String, String> filter) {
        ComponentName launch = launchComponent(pm, targetPkg);
        if (launch != null) {
            String key = componentKey(launch.getPackageName(), launch.getClassName());
            String hit = filter.get(key);
            if (hit != null) return hit;
            /* Some packs omit ComponentInfo braces / use short class. */
            hit = filter.get(launch.getPackageName() + "/" + launch.getClassName());
            if (hit != null) return hit;
        }
        /* Package-level fallback: first ComponentInfo for this package. */
        String prefix = "componentinfo{" + targetPkg.toLowerCase(Locale.ROOT) + "/";
        for (Map.Entry<String, String> e : filter.entrySet()) {
            if (e.getKey().startsWith(prefix)) return e.getValue();
        }
        return null;
    }

    private static ComponentName launchComponent(PackageManager pm, String pkg) {
        try {
            Intent launch = pm.getLaunchIntentForPackage(pkg);
            if (launch != null && launch.getComponent() != null) {
                return launch.getComponent();
            }
        } catch (Exception ignored) {
            /* fall through */
        }
        return null;
    }

    private static String componentKey(String pkg, String cls) {
        return ("componentinfo{" + pkg + "/" + cls + "}").toLowerCase(Locale.ROOT);
    }

    private static Map<String, String> loadAppfilter(
            Context ctx, PackageManager pm, String packPkg) {
        Map<String, String> cached = APPFILTER_CACHE.get(packPkg);
        if (cached != null) return cached;

        Map<String, String> map = new LinkedHashMap<>();
        try {
            Context packCtx =
                    ctx.createPackageContext(packPkg, Context.CONTEXT_IGNORE_SECURITY);
            /* Prefer assets/appfilter.xml (most ADW-style packs). */
            parseAppfilterStream(openAsset(packCtx, "appfilter.xml"), map);
            if (map.isEmpty()) {
                parseAppfilterStream(openAsset(packCtx, "appfilter"), map);
            }
            if (map.isEmpty()) {
                parseAppfilterRes(packCtx, packPkg, "appfilter", map);
            }
            if (map.isEmpty()) {
                parseAppfilterRes(packCtx, packPkg, "theme_main", map);
            }
        } catch (Exception e) {
            Log.w(TAG, "loadAppfilter failed pack=" + packPkg, e);
        }

        APPFILTER_CACHE.put(packPkg, map);
        return map;
    }

    private static InputStream openAsset(Context packCtx, String name) {
        try {
            AssetManager am = packCtx.getAssets();
            return am.open(name);
        } catch (Exception e) {
            return null;
        }
    }

    private static void parseAppfilterRes(
            Context packCtx, String packPkg, String xmlName, Map<String, String> out) {
        try {
            Resources res = packCtx.getResources();
            int id = res.getIdentifier(xmlName, "xml", packPkg);
            if (id == 0) return;
            XmlResourceParser parser = res.getXml(id);
            try {
                parseAppfilterParser(parser, out);
            } finally {
                parser.close();
            }
        } catch (Exception e) {
            Log.w(TAG, "parseAppfilterRes " + xmlName + " failed", e);
        }
    }

    private static void parseAppfilterStream(InputStream in, Map<String, String> out) {
        if (in == null) return;
        try {
            XmlPullParser parser =
                    android.util.Xml.newPullParser();
            parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false);
            parser.setInput(in, "UTF-8");
            parseAppfilterParser(parser, out);
        } catch (Exception e) {
            Log.w(TAG, "parseAppfilterStream failed", e);
        } finally {
            try {
                in.close();
            } catch (Exception ignored) {
                /* ignore */
            }
        }
    }

    private static void parseAppfilterParser(XmlPullParser parser, Map<String, String> out)
            throws Exception {
        int event = parser.getEventType();
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.START_TAG) {
                String tag = parser.getName();
                if ("item".equalsIgnoreCase(tag)) {
                    String component = attr(parser, "component");
                    String drawable = attr(parser, "drawable");
                    if (component != null && drawable != null && !drawable.isEmpty()) {
                        String key = normalizeComponentAttr(component);
                        if (key != null && !key.isEmpty()) {
                            out.putIfAbsent(key, drawable.trim());
                        }
                    }
                }
            }
            event = parser.next();
        }
    }

    private static String attr(XmlPullParser parser, String name) {
        String v = parser.getAttributeValue(null, name);
        if (v != null) return v;
        /* Some packs use android: prefixes oddly — scan all. */
        for (int i = 0; i < parser.getAttributeCount(); i++) {
            if (name.equalsIgnoreCase(parser.getAttributeName(i))) {
                return parser.getAttributeValue(i);
            }
        }
        return null;
    }

    /**
     * Normalize {@code ComponentInfo{pkg/cls}} (and bare {@code pkg/cls}) to a lowercase lookup key.
     */
    private static String normalizeComponentAttr(String raw) {
        String s = raw != null ? raw.trim() : "";
        if (s.isEmpty()) return "";
        String lower = s.toLowerCase(Locale.ROOT);
        int start = lower.indexOf("componentinfo{");
        if (start >= 0) {
            int open = lower.indexOf('{', start);
            int close = lower.indexOf('}', open + 1);
            if (open >= 0 && close > open) {
                String inner = lower.substring(open + 1, close).trim();
                return "componentinfo{" + inner + "}";
            }
        }
        if (lower.contains("/")) {
            return "componentinfo{" + lower + "}";
        }
        return lower;
    }

    private static String labelOf(PackageManager pm, String pkg, ResolveInfo ri) {
        try {
            CharSequence label = ri != null ? ri.loadLabel(pm) : null;
            if (label != null && label.length() > 0) return String.valueOf(label);
        } catch (Exception ignored) {
            /* fall through */
        }
        try {
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            CharSequence label = pm.getApplicationLabel(ai);
            if (label != null && label.length() > 0) return String.valueOf(label);
        } catch (Exception ignored) {
            /* fall through */
        }
        return pkg;
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
