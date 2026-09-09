/*
 * Filename: CwsDocumentLoad.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsDocumentLoad.java
 * FIND:document-load
 * Change date and time: 17.40.00_09.09.2026
 * Reason: document:load always reads stash UTF-8; MIME must not hide the body.
 */
package space.u2re.cwsp;

import android.content.Context;
import android.net.Uri;

import com.getcapacitor.JSObject;

/**
 * Canonical CWSP-document open on Android.
 * INVARIANT: echo always has {@code content}/{@code text} or {@code error} — never a data: URL.
 */
final class CwsDocumentLoad {
    private CwsDocumentLoad() {}

    static JSObject load(Context ctx, CwsStorageHost storage, JSObject payload) {
        boolean pending = bool(payload, "pending");
        String uri = str(payload, "uri");
        if (uri.isEmpty()) uri = str(payload, "url");
        String path = str(payload, "path");
        if (path.isEmpty()) path = str(payload, "virtualPath");

        if (pending || (uri.isEmpty() && path.isEmpty())) {
            JSObject share = LauncherCoordinator.consumePendingShare(ctx);
            JSObject echo = echoOf(share);
            if (hasBody(echo)) return ok(echo);
            String stash = LauncherCoordinator.pendingShareUtf8(ctx);
            if (stash != null && !stash.isEmpty()) {
                if (echo == null) echo = new JSObject();
                echo.put("content", stash);
                echo.put("text", stash);
                return ok(echo);
            }
            if (uri.isEmpty()) uri = first(echo, "url", "uri");
            if (path.isEmpty()) path = first(echo, "virtualPath", "path");
        }

        if (!uri.isEmpty() && (uri.startsWith("content:") || uri.startsWith("file:"))) {
            JSObject got = storage.readUri(payloadOf("uri", uri));
            if (hasBody(echoOf(got))) return ok(echoOf(got));
            String mapped = CwsStorageHost.uriToSdcardVirtualFile(Uri.parse(uri));
            if (mapped != null && !mapped.isEmpty()) path = mapped;
        }

        if (!path.isEmpty()) {
            JSObject got = readVirtual(storage, path);
            if (hasBody(echoOf(got))) return ok(echoOf(got));
        }

        return fail("unreadable", uri, path);
    }

    private static JSObject readVirtual(CwsStorageHost storage, String raw) {
        String path = raw != null ? raw.trim() : "";
        String root = "sdcard";
        String rel = path;
        if (path.equals("/saf") || path.startsWith("/saf/")) {
            root = "saf";
            rel = path.length() <= 5 ? "/" : path.substring(5);
        } else if (path.equals("/sdcard") || path.startsWith("/sdcard/")) {
            rel = path.length() <= 8 ? "/" : path.substring(8);
        }
        if (rel.isEmpty()) rel = "/";
        JSObject pl = new JSObject();
        pl.put("root", root);
        pl.put("path", rel);
        return storage.read(pl);
    }

    private static JSObject ok(JSObject echo) {
        JSObject r = new JSObject();
        r.put("ok", true);
        r.put("channel", "document:load");
        if (echo != null) {
            r.put("echo", echo);
            /* WHY: flatten — Capacitor sometimes delivers nested echo as a JSON string. */
            String content = first(echo, "content", "text");
            if (!content.isEmpty()) {
                r.put("content", content);
                r.put("text", content);
            }
            String uri = first(echo, "uri", "url");
            if (!uri.isEmpty()) {
                r.put("uri", uri);
                r.put("url", uri);
            }
            String path = first(echo, "virtualPath", "path");
            if (!path.isEmpty()) {
                r.put("virtualPath", path);
                r.put("path", path);
            }
            String name = str(echo, "name");
            if (name.isEmpty()) name = str(echo, "title");
            if (!name.isEmpty()) r.put("name", name);
            try {
                if (echo.has("stashedAt")) r.put("stashedAt", echo.get("stashedAt"));
            } catch (Exception ignored) {
                /* optional */
            }
        }
        return r;
    }

    private static JSObject fail(String error) {
        return fail(error, "", "");
    }

    private static JSObject fail(String error, String uri, String path) {
        JSObject r = new JSObject();
        r.put("ok", false);
        r.put("channel", "document:load");
        JSObject echo = new JSObject();
        echo.put("error", error);
        if (uri != null && !uri.isEmpty()) {
            echo.put("uri", uri);
            echo.put("url", uri);
        }
        if (path != null && !path.isEmpty()) {
            echo.put("path", path);
            echo.put("virtualPath", path);
        }
        r.put("echo", echo);
        r.put("error", error);
        return r;
    }

    private static JSObject echoOf(JSObject r) {
        if (r == null) return null;
        try {
            JSObject echo = r.getJSObject("echo");
            return echo != null ? echo : r;
        } catch (Exception e) {
            return r;
        }
    }

    private static boolean hasBody(JSObject echo) {
        if (echo == null) return false;
        String content = first(echo, "content", "text");
        return content != null && !content.isEmpty();
    }

    private static JSObject payloadOf(String key, String value) {
        JSObject pl = new JSObject();
        pl.put(key, value);
        return pl;
    }

    private static String first(JSObject obj, String a, String b) {
        String v = str(obj, a);
        return !v.isEmpty() ? v : str(obj, b);
    }

    private static String str(JSObject obj, String key) {
        if (obj == null || key == null) return "";
        try {
            String v = obj.getString(key, "");
            return v != null ? v.trim() : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean bool(JSObject obj, String key) {
        if (obj == null) return false;
        try {
            return obj.getBool(key);
        } catch (Exception e) {
            try {
                return "true".equalsIgnoreCase(obj.getString(key, ""));
            } catch (Exception e2) {
                return false;
            }
        }
    }
}
