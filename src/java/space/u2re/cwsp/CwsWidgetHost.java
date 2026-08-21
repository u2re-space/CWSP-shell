/*
 * Filename: CwsWidgetHost.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsWidgetHost.java
 * Change date: 16.15.00_21.08.2026
 * Reason: Host Android AppWidgets on the Capacitor Speed Dial (Smart Launcher-style).
 */
package space.u2re.cwsp;

import android.app.Activity;
import android.appwidget.AppWidgetHost;
import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;

import java.io.ByteArrayOutputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * AppWidgetHost overlay on the Capacitor WebView parent.
 * Touches outside hosted widgets fall through to the WebView.
 */
public final class CwsWidgetHost {
    private static final String TAG = "CwsWidgetHost";
    private static final int HOST_ID = 0x43575350; // CWSP
    static final int REQ_BIND = 0x4357;
    static final int REQ_CONFIGURE = 0x4358;

    private static CwsWidgetHost instance;

    static boolean dispatchActivityResult(int requestCode, int resultCode, Intent data) {
        if (instance == null) return false;
        if (requestCode != REQ_BIND && requestCode != REQ_CONFIGURE) return false;
        instance.onActivityResult(requestCode, resultCode, data);
        return true;
    }

    private final Plugin plugin;
    private AppWidgetHost host;
    private AppWidgetManager manager;
    private PassThroughFrame overlay;
    private final Map<Integer, AppWidgetHostView> views = new HashMap<>();
    private PluginCall pendingCall;
    private int pendingWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private String pendingProvider = "";

    CwsWidgetHost(Plugin plugin) {
        this.plugin = plugin;
        instance = this;
    }

    void startListening() {
        Activity activity = plugin.getActivity();
        if (activity == null) return;
        ensureHost(activity);
        try {
            host.startListening();
        } catch (Exception e) {
            Log.w(TAG, "startListening failed", e);
        }
        ensureOverlay(activity);
    }

    void stopListening() {
        if (host == null) return;
        try {
            host.stopListening();
        } catch (Exception e) {
            Log.w(TAG, "stopListening failed", e);
        }
    }

    void destroy() {
        stopListening();
        detachAll();
        if (overlay != null) {
            ViewGroup parent = (ViewGroup) overlay.getParent();
            if (parent != null) parent.removeView(overlay);
            overlay = null;
        }
        /* WHY: do not deleteHost() — AppWidget ids must survive activity recreate. */
    }

    JSObject list(String query) {
        JSObject r = base(true, "widget:list");
        JSArray widgets = new JSArray();
        Context ctx = plugin.getContext();
        if (ctx == null || manager == null) {
            ensureHost(plugin.getActivity());
        }
        if (manager == null) {
            r.put("ok", false);
            return r;
        }
        String q = query != null ? query.trim().toLowerCase(Locale.US) : "";
        try {
            List<AppWidgetProviderInfo> infos = manager.getInstalledProviders();
            for (AppWidgetProviderInfo info : infos) {
                if (info == null || info.provider == null) continue;
                JSObject row = providerToJson(ctx, info, false);
                if (row == null) continue;
                if (!q.isEmpty()) {
                    String hay = (row.getString("label", "") + " " + row.getString("provider", ""))
                            .toLowerCase(Locale.US);
                    if (!hay.contains(q)) continue;
                }
                widgets.put(row);
            }
        } catch (Exception e) {
            Log.w(TAG, "list failed", e);
        }
        JSObject echo = r.getJSObject("echo");
        if (echo == null) echo = new JSObject();
        echo.put("widgets", widgets);
        r.put("echo", echo);
        r.put("widgets", widgets);
        return r;
    }

    JSObject preview(String provider) {
        JSObject r = base(true, "widget:preview");
        Context ctx = plugin.getContext();
        AppWidgetProviderInfo info = resolveInfo(provider);
        if (ctx == null || info == null) {
            r.put("ok", false);
            return r;
        }
        String dataUrl = previewDataUrl(ctx, info, 192);
        JSObject echo = r.getJSObject("echo");
        if (echo == null) echo = new JSObject();
        echo.put("preview", dataUrl != null ? dataUrl : "");
        echo.put("provider", flatten(info.provider));
        r.put("echo", echo);
        return r;
    }

    /** Async bind + optional configure. Caller must not resolve the PluginCall. */
    void bind(PluginCall call, String provider) {
        Activity activity = plugin.getActivity();
        ensureHost(activity);
        if (activity == null || host == null || manager == null) {
            call.resolve(fail("widget:bind", "no activity"));
            return;
        }
        ComponentName cn = parseProvider(provider);
        if (cn == null) {
            call.resolve(fail("widget:bind", "bad provider"));
            return;
        }
        int widgetId = host.allocateAppWidgetId();
        boolean bound = false;
        try {
            bound = manager.bindAppWidgetIdIfAllowed(widgetId, cn);
        } catch (Exception e) {
            Log.w(TAG, "bindAppWidgetIdIfAllowed failed", e);
        }
        pendingCall = call;
        pendingWidgetId = widgetId;
        pendingProvider = flatten(cn);
        if (!bound) {
            Intent intent = new Intent(AppWidgetManager.ACTION_APPWIDGET_BIND);
            intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId);
            intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER, cn);
            try {
                activity.startActivityForResult(intent, REQ_BIND);
                return;
            } catch (Exception e) {
                Log.w(TAG, "ACTION_APPWIDGET_BIND failed", e);
                host.deleteAppWidgetId(widgetId);
                pendingCall = null;
                call.resolve(fail("widget:bind", "bind intent failed"));
                return;
            }
        }
        continueAfterBind(activity);
    }

    void onActivityResult(int requestCode, int resultCode, Intent data) {
        Activity activity = plugin.getActivity();
        if (pendingCall == null) return;
        if (requestCode == REQ_BIND) {
            if (resultCode != Activity.RESULT_OK) {
                abortPending("bind cancelled");
                return;
            }
            continueAfterBind(activity);
            return;
        }
        if (requestCode == REQ_CONFIGURE) {
            if (resultCode != Activity.RESULT_OK) {
                abortPending("configure cancelled");
                return;
            }
            resolvePendingBound();
        }
    }

    JSObject attach(JSObject payload) {
        Activity activity = plugin.getActivity();
        ensureHost(activity);
        ensureOverlay(activity);
        JSObject r = base(true, "widget:attach");
        if (activity == null || overlay == null || host == null || manager == null) {
            r.put("ok", false);
            return r;
        }
        int widgetId = payload != null ? payload.getInteger("widgetId", 0) : 0;
        if (widgetId <= 0) {
            r.put("ok", false);
            return r;
        }
        AppWidgetProviderInfo info = manager.getAppWidgetInfo(widgetId);
        if (info == null) {
            r.put("ok", false);
            JSObject echo = new JSObject();
            echo.put("error", "missing widget " + widgetId);
            r.put("echo", echo);
            return r;
        }
        int[] box = cssBoxToOverlayPx(payload);
        AppWidgetHostView view = views.get(widgetId);
        if (view == null) {
            view = host.createView(activity, widgetId, info);
            view.setTag(widgetId);
            views.put(widgetId, view);
            overlay.addView(view);
        }
        applyBox(view, box[0], box[1], box[2], box[3]);
        JSObject echo = new JSObject();
        echo.put("widgetId", widgetId);
        r.put("echo", echo);
        return r;
    }

    JSObject layout(JSObject payload) {
        JSObject r = base(true, "widget:layout");
        int widgetId = payload != null ? payload.getInteger("widgetId", 0) : 0;
        AppWidgetHostView view = views.get(widgetId);
        if (view == null) {
            r.put("ok", false);
            return r;
        }
        int[] box = cssBoxToOverlayPx(payload);
        applyBox(view, box[0], box[1], box[2], box[3]);
        return r;
    }

    JSObject detach(int widgetId) {
        JSObject r = base(true, "widget:detach");
        AppWidgetHostView view = views.remove(widgetId);
        if (view != null && overlay != null) {
            overlay.removeView(view);
        }
        return r;
    }

    JSObject delete(int widgetId) {
        detach(widgetId);
        if (host != null && widgetId > 0) {
            try {
                host.deleteAppWidgetId(widgetId);
            } catch (Exception e) {
                Log.w(TAG, "deleteAppWidgetId failed", e);
            }
        }
        return base(true, "widget:delete");
    }

    JSObject hideAll() {
        /* WHY: GONE keeps AppWidget ids alive across workspace page turns. */
        for (AppWidgetHostView view : views.values()) {
            if (view != null) view.setVisibility(View.GONE);
        }
        return base(true, "widget:hide");
    }

    private void continueAfterBind(Activity activity) {
        AppWidgetProviderInfo info = manager != null ? manager.getAppWidgetInfo(pendingWidgetId) : null;
        if (info == null) {
            abortPending("provider missing after bind");
            return;
        }
        if (info.configure != null && activity != null) {
            Intent configure = new Intent(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE);
            configure.setComponent(info.configure);
            configure.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, pendingWidgetId);
            try {
                activity.startActivityForResult(configure, REQ_CONFIGURE);
                return;
            } catch (Exception e) {
                Log.w(TAG, "configure intent failed", e);
            }
        }
        resolvePendingBound();
    }

    private void resolvePendingBound() {
        PluginCall call = pendingCall;
        int widgetId = pendingWidgetId;
        String provider = pendingProvider;
        pendingCall = null;
        pendingWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
        pendingProvider = "";
        if (call == null) return;
        AppWidgetProviderInfo info = manager != null ? manager.getAppWidgetInfo(widgetId) : null;
        JSObject r = base(true, "widget:bind");
        JSObject echo = providerToJson(plugin.getContext(), info, true);
        if (echo == null) echo = new JSObject();
        echo.put("widgetId", widgetId);
        echo.put("provider", provider);
        r.put("echo", echo);
        r.put("widgetId", widgetId);
        call.resolve(r);
    }

    private void abortPending(String reason) {
        if (host != null && pendingWidgetId > 0) {
            try {
                host.deleteAppWidgetId(pendingWidgetId);
            } catch (Exception ignored) {
                /* ignore */
            }
        }
        PluginCall call = pendingCall;
        pendingCall = null;
        pendingWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
        pendingProvider = "";
        if (call != null) call.resolve(fail("widget:bind", reason));
    }

    private void ensureHost(Activity activity) {
        Context ctx = activity != null ? activity : plugin.getContext();
        if (ctx == null) return;
        if (manager == null) manager = AppWidgetManager.getInstance(ctx);
        if (host == null) {
            host = new AppWidgetHost(ctx.getApplicationContext(), HOST_ID);
        }
    }

    private void ensureOverlay(Activity activity) {
        if (activity == null || plugin.getBridge() == null || plugin.getBridge().getWebView() == null) {
            return;
        }
        if (overlay != null && overlay.getParent() != null) return;
        View web = plugin.getBridge().getWebView();
        ViewParentWait:
        {
            android.view.ViewParent parent = web.getParent();
            if (!(parent instanceof ViewGroup)) break ViewParentWait;
            ViewGroup group = (ViewGroup) parent;
            overlay = new PassThroughFrame(activity);
            overlay.setLayoutParams(
                    new ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            group.addView(overlay);
        }
    }

    private void detachAll() {
        if (overlay != null) overlay.removeAllViews();
        views.clear();
    }

    private void applyBox(View view, int x, int y, int w, int h) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.max(1, w), Math.max(1, h));
        lp.leftMargin = x;
        lp.topMargin = y;
        view.setLayoutParams(lp);
        view.setVisibility(View.VISIBLE);
    }

    /** CSS viewport rect → overlay-local px. */
    private int[] cssBoxToOverlayPx(JSObject payload) {
        float density = 1f;
        try {
            DisplayMetrics metrics = plugin.getContext().getResources().getDisplayMetrics();
            density = metrics.density > 0 ? metrics.density : 1f;
        } catch (Exception ignored) {
            /* ignore */
        }
        double dpr = jsNumber(payload, "dpr", 0);
        if (dpr > 0.2) density = (float) dpr;
        double left = jsNumber(payload, "x", jsNumber(payload, "left", 0));
        double top = jsNumber(payload, "y", jsNumber(payload, "top", 0));
        double width = jsNumber(payload, "w", jsNumber(payload, "width", 0));
        double height = jsNumber(payload, "h", jsNumber(payload, "height", 0));
        int x = (int) Math.round(left * density);
        int y = (int) Math.round(top * density);
        int w = (int) Math.round(width * density);
        int h = (int) Math.round(height * density);
        try {
            View web = plugin.getBridge() != null ? plugin.getBridge().getWebView() : null;
            if (web != null && overlay != null) {
                int[] webLoc = new int[2];
                int[] overLoc = new int[2];
                web.getLocationOnScreen(webLoc);
                overlay.getLocationOnScreen(overLoc);
                x += webLoc[0] - overLoc[0];
                y += webLoc[1] - overLoc[1];
            }
        } catch (Exception ignored) {
            /* ignore */
        }
        return new int[] {x, y, w, h};
    }

    private AppWidgetProviderInfo resolveInfo(String provider) {
        ensureHost(plugin.getActivity());
        ComponentName cn = parseProvider(provider);
        if (cn == null || manager == null) return null;
        try {
            for (AppWidgetProviderInfo info : manager.getInstalledProviders()) {
                if (info != null && cn.equals(info.provider)) return info;
            }
        } catch (Exception e) {
            Log.w(TAG, "resolveInfo failed", e);
        }
        return null;
    }

    private JSObject providerToJson(Context ctx, AppWidgetProviderInfo info, boolean withPreview) {
        if (info == null || info.provider == null) return null;
        JSObject row = new JSObject();
        row.put("provider", flatten(info.provider));
        row.put("packageName", info.provider.getPackageName());
        row.put("className", info.provider.getClassName());
        String label = "";
        try {
            CharSequence loaded = info.loadLabel(ctx.getPackageManager());
            if (loaded != null) label = loaded.toString();
        } catch (Exception ignored) {
            /* ignore */
        }
        if (label.isEmpty()) label = info.provider.getPackageName();
        row.put("label", label);
        row.put("minWidth", info.minWidth);
        row.put("minHeight", info.minHeight);
        row.put("minResizeWidth", info.minResizeWidth);
        row.put("minResizeHeight", info.minResizeHeight);
        row.put("resizeMode", info.resizeMode);
        row.put("configure", info.configure != null);
        int spanX = 1;
        int spanY = 1;
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                if (info.targetCellWidth > 0) spanX = info.targetCellWidth;
                if (info.targetCellHeight > 0) spanY = info.targetCellHeight;
            } catch (Exception ignored) {
                /* ignore */
            }
        }
        if (spanX <= 1) spanX = Math.max(1, Math.round(info.minWidth / 70f));
        if (spanY <= 1) spanY = Math.max(1, Math.round(info.minHeight / 70f));
        row.put("spanCols", Math.max(1, Math.min(8, spanX)));
        row.put("spanRows", Math.max(1, Math.min(8, spanY)));
        if (withPreview && ctx != null) {
            String preview = previewDataUrl(ctx, info, 128);
            if (preview != null) row.put("preview", preview);
        }
        return row;
    }

    private String previewDataUrl(Context ctx, AppWidgetProviderInfo info, int size) {
        try {
            Drawable d = info.loadPreviewImage(ctx, 0);
            if (d == null) d = info.loadIcon(ctx, 0);
            if (d == null) return "";
            Bitmap bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
            Canvas canvas = new Canvas(bmp);
            d.setBounds(0, 0, size, size);
            d.draw(canvas);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.PNG, 90, out);
            return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            Log.w(TAG, "preview failed", e);
            return "";
        }
    }

    private static ComponentName parseProvider(String raw) {
        String s = raw != null ? raw.trim() : "";
        if (s.isEmpty()) return null;
        ComponentName cn = ComponentName.unflattenFromString(s);
        if (cn != null) return cn;
        int slash = s.indexOf('/');
        if (slash > 0 && slash + 1 < s.length()) {
            return new ComponentName(s.substring(0, slash), s.substring(slash + 1));
        }
        return null;
    }

    private static double jsNumber(JSObject obj, String key, double fallback) {
        if (obj == null || key == null || !obj.has(key)) return fallback;
        try {
            Object raw = obj.get(key);
            if (raw instanceof Number) return ((Number) raw).doubleValue();
            if (raw != null) return Double.parseDouble(String.valueOf(raw));
        } catch (Exception ignored) {
            /* ignore */
        }
        return fallback;
    }

    private static String flatten(ComponentName cn) {
        return cn != null ? cn.flattenToShortString() : "";
    }

    static JSObject base(boolean ok, String channel) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("channel", channel);
        r.put("echo", new JSObject());
        return r;
    }

    static JSObject fail(String channel, String reason) {
        JSObject r = base(false, channel);
        JSObject echo = new JSObject();
        echo.put("error", reason != null ? reason : "failed");
        r.put("echo", echo);
        return r;
    }

    /** Full-screen overlay that only consumes hits on hosted widget views. */
    static final class PassThroughFrame extends FrameLayout {
        PassThroughFrame(Context context) {
            super(context);
            setClickable(false);
            setFocusable(false);
        }

        @Override
        public boolean dispatchTouchEvent(MotionEvent ev) {
            final float x = ev.getX();
            final float y = ev.getY();
            for (int i = getChildCount() - 1; i >= 0; i--) {
                View child = getChildAt(i);
                if (child.getVisibility() != VISIBLE) continue;
                if (x >= child.getLeft()
                        && x < child.getRight()
                        && y >= child.getTop()
                        && y < child.getBottom()) {
                    return super.dispatchTouchEvent(ev);
                }
            }
            return false;
        }
    }
}
