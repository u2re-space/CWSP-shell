/*
 * Filename: ProcessIngressSnapshot.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/ProcessIngressSnapshot.java
 * FIND:process-ingress
 *
 * WebView settings → SharedPreferences so Process FGS can run without IDB.
 * INVARIANT: apiKey stays in MODE_PRIVATE prefs; never log it.
 */
package space.u2re.cwsp;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

public final class ProcessIngressSnapshot {
    private static final String PREFS = "cwsp_process_ingress";
    private static final String KEY_API = "apiKey";
    private static final String KEY_BASE = "baseUrl";
    private static final String KEY_MODEL = "model";
    private static final String KEY_INSTRUCTION = "instruction";
    private static final String KEY_KINDS = "kindsJson";

    private ProcessIngressSnapshot() {}

    static JSObject save(Context context, JSObject payload) {
        JSObject r = new JSObject();
        r.put("ok", true);
        r.put("channel", "settings:snapshot");
        r.put("echo", new JSObject());
        if (context == null || payload == null) return r;
        try {
            String kindsRaw = payload.getString("kindsJson", "");
            if (kindsRaw == null || kindsRaw.isEmpty()) {
                kindsRaw = payload.getJSObject("kinds") != null
                        ? payload.getJSObject("kinds").toString()
                        : "";
            }
            if (kindsRaw == null) kindsRaw = "";
            context.getApplicationContext()
                    .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_API, payload.getString("apiKey", ""))
                    .putString(KEY_BASE, payload.getString("baseUrl", ""))
                    .putString(KEY_MODEL, payload.getString("model", ""))
                    .putString(KEY_INSTRUCTION, payload.getString("instruction", ""))
                    .putString(KEY_KINDS, kindsRaw)
                    .apply();
        } catch (Exception ignored) {
            r.put("ok", false);
        }
        return r;
    }

    static String apiKey(Context context) {
        return pref(context, KEY_API);
    }

    static String baseUrl(Context context) {
        return pref(context, KEY_BASE);
    }

    static String model(Context context) {
        return pref(context, KEY_MODEL);
    }

    static String instruction(Context context) {
        return pref(context, KEY_INSTRUCTION);
    }

    /**
     * Process only when the WebView snapshot explicitly says so.
     * Missing/empty snapshot → attach (open MainActivity). Do not invent process.
     */
    static boolean isProcessMode(Context context, String kind) {
        String key = kind == null ? "other" : kind;
        String raw = pref(context, KEY_KINDS);
        if (raw.isEmpty()) return false;
        try {
            String mode = new JSONObject(raw).optString(key, "");
            return "process".equals(mode);
        } catch (Exception ignored) {
            return false;
        }
    }

    static String classifyKind(JSObject share) {
        String mime = first(share, "mime").toLowerCase(java.util.Locale.US);
        String name = first(share, "name");
        if (name.isEmpty()) name = first(share, "title");
        if (name.isEmpty()) name = first(share, "url");
        String lower = name.toLowerCase(java.util.Locale.US);
        if (mime.startsWith("image/") || lower.matches(".*\\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)$")) {
            return "image";
        }
        if (mime.contains("markdown") || lower.matches(".*\\.(md|markdown|mdown)$")) return "markdown";
        if (mime.equals("application/pdf")
                || mime.contains("officedocument")
                || mime.contains("msword")
                || lower.matches(".*\\.(pdf|docx?|odt|rtf|pptx?|xlsx?)$")) {
            return "document";
        }
        if (mime.startsWith("text/") || lower.matches(".*\\.(txt|html|json|csv|xml|ya?ml)$")) return "text";
        String url = first(share, "url");
        String text = first(share, "text");
        if ((url.startsWith("http://") || url.startsWith("https://")) && text.isEmpty()) return "url";
        if (!text.isEmpty()) return "text";
        return "other";
    }

    private static String first(JSObject row, String key) {
        if (row == null) return "";
        try {
            String value = row.getString(key, "");
            return value != null ? value.trim() : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String pref(Context context, String key) {
        if (context == null) return "";
        try {
            SharedPreferences prefs =
                    context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String value = prefs.getString(key, "");
            return value != null ? value : "";
        } catch (Exception ignored) {
            return "";
        }
    }
}
