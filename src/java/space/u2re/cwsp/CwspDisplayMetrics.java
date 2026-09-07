/*
 * FIND:native-display
 * WHY: WebView `screen.width` / `availHeight` skip nav/cutout or use the wrong axis.
 * Capacitor reads DisplayMetrics + WindowMetrics and converts px → CSS via density.
 */
package space.u2re.cwsp;

import android.app.Activity;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Rect;
import android.os.Build;
import android.util.DisplayMetrics;
import android.view.WindowManager;
import android.view.WindowMetrics;

import com.getcapacitor.JSObject;

/** Native display box + DPI/PPI for `Viewport.ts` (`--screen-*`, `--native-*`). */
final class CwspDisplayMetrics {
    private CwspDisplayMetrics() {}

    static void putInto(JSObject info, Activity activity, Context context) {
        if (info == null || context == null) return;
        DisplayMetrics metrics = context.getResources().getDisplayMetrics();
        float density = metrics.density > 0f ? metrics.density : 1f;
        int windowW = metrics.widthPixels;
        int windowH = metrics.heightPixels;
        int screenW = metrics.widthPixels;
        int screenH = metrics.heightPixels;

        WindowManager wm = activity != null ? activity.getWindowManager() : null;
        if (wm == null && context instanceof Activity) {
            wm = ((Activity) context).getWindowManager();
        }
        if (wm != null && Build.VERSION.SDK_INT >= 30) {
            try {
                WindowMetrics current = wm.getCurrentWindowMetrics();
                Rect bounds = current.getBounds();
                windowW = Math.max(1, bounds.width());
                windowH = Math.max(1, bounds.height());
            } catch (Exception ignored) {
                /* fall through */
            }
            try {
                WindowMetrics max = wm.getMaximumWindowMetrics();
                Rect bounds = max.getBounds();
                screenW = Math.max(1, bounds.width());
                screenH = Math.max(1, bounds.height());
            } catch (Exception ignored) {
                /* fall through */
            }
        } else if (wm != null) {
            try {
                DisplayMetrics real = new DisplayMetrics();
                wm.getDefaultDisplay().getRealMetrics(real);
                screenW = real.widthPixels;
                screenH = real.heightPixels;
                if (real.density > 0f) density = real.density;
            } catch (Exception ignored) {
                /* fall through */
            }
        }

        float xdpi = metrics.xdpi > 0f ? metrics.xdpi : metrics.densityDpi;
        float ydpi = metrics.ydpi > 0f ? metrics.ydpi : metrics.densityDpi;
        float ppi = (xdpi + ydpi) * 0.5f;
        float scaled = metrics.scaledDensity > 0f ? metrics.scaledDensity : density;
        int orient = context.getResources().getConfiguration().orientation;
        boolean landscape = orient == Configuration.ORIENTATION_LANDSCAPE;

        info.put("windowWidthPx", windowW);
        info.put("windowHeightPx", windowH);
        info.put("windowWidthCss", windowW / density);
        info.put("windowHeightCss", windowH / density);
        info.put("displayWidthPx", screenW);
        info.put("displayHeightPx", screenH);
        info.put("displayWidthCss", screenW / density);
        info.put("displayHeightCss", screenH / density);
        info.put("density", density);
        info.put("densityDpi", metrics.densityDpi);
        info.put("xdpi", xdpi);
        info.put("ydpi", ydpi);
        info.put("ppi", ppi);
        info.put("scaledDensity", scaled);
        info.put("fontScale", density > 0f ? scaled / density : 1f);
        info.put("orientation", landscape ? "landscape" : "portrait");
    }
}
