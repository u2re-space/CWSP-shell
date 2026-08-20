/*
 * Filename: CwsLauncherBridgePlugin.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsLauncherBridgePlugin.java
 * Change date and time: 18.35.00_19.08.2026
 * Reason for changes: CWSP Launcher SKU — slim CwsBridge Capacitor plugin (launcher:* only).
 */

package space.u2re.cwsp;

import android.content.Context;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Minimal {@code CwsBridge} for CWSP Launcher APK — only {@code launcher:*} IPC channels.
 */
@CapacitorPlugin(name = "CwsBridge")
public class CwsLauncherBridgePlugin extends Plugin {

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
            default: {
                JSObject r = baseResult(false, channel);
                JSObject echo = new JSObject();
                echo.put("error", "unhandled channel: " + channel);
                r.put("echo", echo);
                return r;
            }
        }
    }

    private static JSObject baseResult(boolean ok, String channel) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("channel", channel);
        r.put("echo", new JSObject());
        return r;
    }
}
