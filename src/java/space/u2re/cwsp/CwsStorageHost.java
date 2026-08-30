/*
 * Filename: CwsStorageHost.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsStorageHost.java
 * Change date: 11.10.00_30.08.2026
 * Reason: storage:share (ACTION_SEND chooser) + storage:realpath.
 */
package space.u2re.cwsp;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.DocumentsContract;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;

import android.util.Base64;

import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * Native storage for Explorer: {@code /sdcard/} via {@code MANAGE_EXTERNAL_STORAGE}
 * and {@code /saf/} via a persisted {@link DocumentsContract} tree.
 */
public final class CwsStorageHost {
    private static final String TAG = "CwsStorageHost";
    static final int REQ_SAF = 0x5341;
    private static final String PREFS = "cwsp_storage";
    private static final String KEY_SAF = "saf_tree_uri";

    private static CwsStorageHost instance;

    static boolean dispatchActivityResult(int requestCode, int resultCode, Intent data) {
        if (instance == null || requestCode != REQ_SAF) return false;
        instance.onActivityResult(requestCode, resultCode, data);
        return true;
    }

    private final Plugin plugin;
    private PluginCall pendingPick;

    CwsStorageHost(Plugin plugin) {
        this.plugin = plugin;
        instance = this;
    }

    void pickSaf(PluginCall call) {
        Activity activity = plugin.getActivity();
        if (activity == null) {
            call.resolve(fail("storage:pick-saf", "no activity"));
            return;
        }
        pendingPick = call;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        try {
            activity.startActivityForResult(intent, REQ_SAF);
        } catch (Exception e) {
            Log.w(TAG, "OPEN_DOCUMENT_TREE failed", e);
            pendingPick = null;
            call.resolve(fail("storage:pick-saf", "picker failed"));
        }
    }

    void onActivityResult(int requestCode, int resultCode, Intent data) {
        PluginCall call = pendingPick;
        pendingPick = null;
        if (call == null) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(fail("storage:pick-saf", "cancelled"));
            return;
        }
        Uri tree = data.getData();
        Context ctx = plugin.getContext();
        if (ctx != null) {
            int flags = data.getFlags()
                    & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            try {
                ctx.getContentResolver().takePersistableUriPermission(tree, flags);
            } catch (Exception e) {
                Log.w(TAG, "takePersistableUriPermission failed", e);
            }
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString(KEY_SAF, tree.toString())
                    .apply();
        }
        JSObject r = base(true, "storage:pick-saf");
        JSObject echo = new JSObject();
        echo.put("uri", tree.toString());
        echo.put("treeUri", tree.toString());
        echo.put("incomingDir", tree.toString());
        r.put("echo", echo);
        call.resolve(r);
    }

    JSObject list(JSObject payload) {
        String root = payload != null ? payload.getString("root", "sdcard") : "sdcard";
        String path = payload != null ? payload.getString("path", "/") : "/";
        if ("saf".equals(root)) return listSaf(path);
        return listSdcard(path);
    }

    /** Read one file as a data URL. Used by Explorer dbl-tap on `/sdcard/` `/saf/`. */
    JSObject read(JSObject payload) {
        String root = payload != null ? payload.getString("root", "sdcard") : "sdcard";
        String path = payload != null ? payload.getString("path", "/") : "/";
        if ("saf".equals(root)) return readSaf(path);
        return readSdcard(path);
    }

    /** content:// (FileProvider / SAF) so CWSP-document can ACTION_VIEW without copying bytes. */
    JSObject uri(JSObject payload) {
        String root = payload != null ? payload.getString("root", "sdcard") : "sdcard";
        String path = payload != null ? payload.getString("path", "/") : "/";
        if ("saf".equals(root)) return uriSaf(path);
        return uriSdcard(path);
    }

    /**
     * WHY: Explorer tap on {@code /sdcard/} must not copy bytes through the WebView.
     * Resolve FileProvider/SAF, then SEND to a sibling SKU or VIEW+chooser.
     */
    /**
     * ACTION_SEND + chooser. Direct Share targets appear in the system sheet.
     */
    JSObject share(JSObject payload) {
        String mimeType = payload != null ? payload.getString("mimeType", "") : "";
        if (mimeType == null || mimeType.isEmpty()) {
            mimeType = payload != null ? payload.getString("type", "") : "";
        }
        if (mimeType == null) mimeType = "";
        String title = payload != null ? payload.getString("title", "Share") : "Share";
        if (title == null || title.trim().isEmpty()) title = "Share";
        JSObject resolved = uri(payload);
        boolean ok = false;
        try {
            ok = resolved.getBoolean("ok", false);
        } catch (Exception ignored) {
            /* Capacitor JSObject */
        }
        JSObject echo = null;
        try {
            echo = resolved.getJSObject("echo");
        } catch (Exception ignored) {
            /* optional */
        }
        String uri = echo != null ? echo.getString("uri", "") : "";
        if (!ok || uri == null || uri.isEmpty()) {
            String err = echo != null ? echo.getString("error", "not a file") : "not a file";
            return fail("storage:share", err != null && !err.isEmpty() ? err : "not a file");
        }
        String name = echo.getString("name", "file");
        String mime = mimeType.trim().isEmpty() ? echo.getString("mime", "") : mimeType.trim();
        if (mime == null || mime.isEmpty()) mime = guessMime(name);
        Context ctx = plugin.getContext();
        if (ctx == null) return fail("storage:share", "no context");
        return LauncherCoordinator.sendToPackage(ctx, uri, name, mime, "", true, title);
    }

    /**
     * WHY: Android WebView {@code navigator.clipboard.write(ClipboardItem)} does not
     * put a bitmap on the system clipboard. Use FileProvider/SAF URI + ClipData.
     */
    JSObject copyImage(JSObject payload) {
        Context ctx = plugin.getContext();
        if (ctx == null) return fail("storage:copy-image", "no context");
        String root = payload != null ? payload.getString("root", "") : "";
        String path = payload != null ? payload.getString("path", "") : "";
        if (root != null && !root.trim().isEmpty() && path != null && !path.trim().isEmpty()) {
            JSObject resolved = uri(payload);
            boolean ok = false;
            try {
                ok = resolved.getBoolean("ok", false);
            } catch (Exception ignored) {
                /* Capacitor JSObject */
            }
            JSObject echo = null;
            try {
                echo = resolved.getJSObject("echo");
            } catch (Exception ignored) {
                /* optional */
            }
            String uri = echo != null ? echo.getString("uri", "") : "";
            if (ok && uri != null && !uri.isEmpty()) {
                String name = echo.getString("name", "image");
                String mime = echo.getString("mime", "");
                if (mime == null || mime.isEmpty()) mime = guessMime(name);
                if (mime == null || !mime.startsWith("image/")) mime = "image/*";
                return setClipboardImageUri(ctx, uri, mime, name);
            }
        }
        String data = payload != null ? payload.getString("data", "") : "";
        if (data == null || data.isEmpty()) {
            data = payload != null ? payload.getString("dataUrl", "") : "";
        }
        if (data == null || data.trim().isEmpty()) {
            return fail("storage:copy-image", "no image");
        }
        String mime = payload != null ? payload.getString("mimeType", "") : "";
        if (mime == null || mime.isEmpty()) {
            mime = payload != null ? payload.getString("mime", "") : "";
        }
        if (mime == null || mime.isEmpty()) mime = "image/png";
        String name = payload != null ? payload.getString("name", "image.png") : "image.png";
        try {
            String raw = data.trim();
            int comma = raw.indexOf(',');
            if (raw.regionMatches(true, 0, "data:", 0, 5) && comma > 0) {
                raw = raw.substring(comma + 1);
            }
            byte[] bytes = Base64.decode(raw.replaceAll("\\s+", ""), Base64.DEFAULT);
            if (bytes == null || bytes.length == 0) return fail("storage:copy-image", "decode");
            File file = writeClipPng(ctx, bytes, mime, name);
            if (file == null) return fail("storage:copy-image", "write");
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            return setClipboardImageUri(ctx, uri.toString(), "image/png", file.getName());
        } catch (Exception e) {
            Log.w(TAG, "copyImage failed", e);
            return fail("storage:copy-image", String.valueOf(e.getMessage()));
        }
    }

    private static JSObject setClipboardImageUri(Context ctx, String rawUri, String mime, String label) {
        try {
            Uri parsed = Uri.parse(rawUri);
            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return fail("storage:copy-image", "no clipboard");
            String type = mime != null && !mime.isEmpty() ? mime : "image/*";
            String[] mimes = type.startsWith("image/")
                    ? new String[] { type, "image/*" }
                    : new String[] { "image/*", type };
            ClipData clip = new ClipData(new ClipDescription(label != null ? label : "image", mimes),
                    new ClipData.Item(parsed));
            cm.setPrimaryClip(clip);
            JSObject r = base(true, "storage:copy-image");
            JSObject echo = new JSObject();
            echo.put("copied", true);
            echo.put("uri", rawUri);
            echo.put("mime", type);
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "setClipboardImageUri failed", e);
            return fail("storage:copy-image", String.valueOf(e.getMessage()));
        }
    }

    private static File writeClipPng(Context ctx, byte[] bytes, String mime, String name) {
        File dir = new File(ctx.getCacheDir(), "cwsp-clip");
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        byte[] out = bytes;
        String ext = ".png";
        if (mime == null || !mime.equals("image/png")) {
            Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
            if (bmp != null) {
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                boolean ok = bmp.compress(Bitmap.CompressFormat.PNG, 100, bos);
                bmp.recycle();
                if (ok) out = bos.toByteArray();
            } else {
                ext = extFromName(name);
            }
        }
        File file = new File(dir, "clip-" + System.currentTimeMillis() + ext);
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(out);
            return file;
        } catch (Exception e) {
            Log.w(TAG, "writeClipPng failed", e);
            return null;
        }
    }

    private static String extFromName(String name) {
        if (name == null) return ".bin";
        int i = name.lastIndexOf('.');
        if (i < 0) return ".bin";
        String ext = name.substring(i).toLowerCase();
        if (ext.length() > 8) return ".bin";
        return ext;
    }

    /** Absolute filesystem path or SAF content:// — for “Copy real path”. */
    JSObject realPath(JSObject payload) {
        String root = payload != null ? payload.getString("root", "sdcard") : "sdcard";
        String path = payload != null ? payload.getString("path", "/") : "/";
        JSObject r = base(true, "storage:realpath");
        JSObject echo = new JSObject();
        echo.put("root", root);
        if ("saf".equals(root)) {
            JSObject uri = uriSaf(path);
            JSObject uriEcho = null;
            try {
                uriEcho = uri.getJSObject("echo");
            } catch (Exception ignored) {
                /* optional */
            }
            String content = uriEcho != null ? uriEcho.getString("uri", "") : "";
            if (content == null || content.isEmpty()) {
                echo.put("error", "not found");
                r.put("ok", false);
                r.put("echo", echo);
                return r;
            }
            echo.put("path", content);
            echo.put("uri", content);
            r.put("echo", echo);
            return r;
        }
        File base = Environment.getExternalStorageDirectory();
        File file = base != null ? resolveUnder(base, path) : null;
        if (file == null || !file.exists()) {
            echo.put("error", "not found");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        echo.put("path", file.getAbsolutePath());
        r.put("echo", echo);
        return r;
    }

    JSObject open(JSObject payload) {
        String packageName = payload != null ? payload.getString("packageName", "") : "";
        if (packageName == null) packageName = "";
        packageName = packageName.trim();
        String mimeType = payload != null ? payload.getString("mimeType", "") : "";
        if (mimeType == null || mimeType.isEmpty()) {
            mimeType = payload != null ? payload.getString("type", "") : "";
        }
        if (mimeType == null) mimeType = "";
        String title = payload != null ? payload.getString("title", "Open with") : "Open with";
        if (title == null || title.trim().isEmpty()) title = "Open with";
        boolean chooser = packageName.isEmpty();
        if (payload != null && payload.has("chooser")) {
            try {
                Object raw = payload.get("chooser");
                if (raw instanceof Boolean) {
                    chooser = (Boolean) raw;
                } else if (raw != null) {
                    String s = String.valueOf(raw).trim().toLowerCase();
                    chooser = !("false".equals(s) || "0".equals(s) || "no".equals(s));
                }
            } catch (Exception ignored) {
                /* keep default */
            }
        }
        JSObject resolved = uri(payload);
        boolean ok = false;
        try {
            ok = resolved.getBoolean("ok", false);
        } catch (Exception ignored) {
            /* Capacitor JSObject */
        }
        JSObject echo = null;
        try {
            echo = resolved.getJSObject("echo");
        } catch (Exception ignored) {
            /* optional */
        }
        String uri = echo != null ? echo.getString("uri", "") : "";
        if (!ok || uri == null || uri.isEmpty()) {
            String err = echo != null ? echo.getString("error", "not a file") : "not a file";
            return fail("storage:open", err != null && !err.isEmpty() ? err : "not a file");
        }
        String name = echo.getString("name", "file");
        String mime = mimeType.trim().isEmpty() ? echo.getString("mime", "") : mimeType.trim();
        if (mime == null || mime.isEmpty()) mime = guessMime(name);
        Context ctx = plugin.getContext();
        if (ctx == null) return fail("storage:open", "no context");
        if (!packageName.isEmpty()) {
            JSObject sent = LauncherCoordinator.sendToPackage(
                    ctx, uri, name, mime, packageName, false, title);
            boolean sentOk = false;
            try {
                sentOk = sent != null && sent.getBoolean("ok", false);
            } catch (Exception ignored) {
                /* fall through */
            }
            if (sentOk) return sent;
            /* WHY: setPackage can miss OEM filters — chooser still lists Document. */
            return LauncherCoordinator.openUri(ctx, uri, "", true, title, mime);
        }
        if (chooser) {
            return LauncherCoordinator.openUri(ctx, uri, "", true, title, mime);
        }
        return LauncherCoordinator.sendToPackage(ctx, uri, name, mime, "", false, title);
    }

    JSObject allFilesStatus() {
        JSObject r = base(true, "storage:all-files-status");
        JSObject echo = new JSObject();
        boolean granted = isAllFilesGranted();
        echo.put("allFilesAccess", granted);
        echo.put("runtimeGranted", granted);
        echo.put("note", granted
                ? "All-files access is granted."
                : "All-files access is off. Open system settings to allow manage-all-files.");
        String saf = readSafUri();
        if (saf != null && !saf.isEmpty()) echo.put("incomingDir", saf);
        r.put("echo", echo);
        return r;
    }

    JSObject requestAllFiles() {
        Activity activity = plugin.getActivity();
        JSObject r = base(activity != null, "storage:all-files-request");
        JSObject echo = new JSObject();
        if (activity == null) {
            echo.put("error", "no activity");
            r.put("echo", echo);
            return r;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            echo.put("opened", true);
        } catch (Exception e) {
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                echo.put("opened", true);
            } catch (Exception e2) {
                Log.w(TAG, "all-files settings failed", e2);
                echo.put("error", "settings unavailable");
                r.put("ok", false);
            }
        }
        echo.put("allFilesAccess", isAllFilesGranted());
        r.put("echo", echo);
        return r;
    }

    JSObject requestMedia() {
        JSObject r = base(true, "files:storage:request-media");
        JSObject echo = new JSObject();
        echo.put("runtimeGranted", isAllFilesGranted());
        echo.put("allFilesAccess", isAllFilesGranted());
        echo.put("note", "Launcher uses all-files access for /sdcard/.");
        r.put("echo", echo);
        return r;
    }

    JSObject openExplorer() {
        Activity activity = plugin.getActivity();
        JSObject r = base(activity != null, "files:storage:open-explorer");
        JSObject echo = new JSObject();
        if (activity == null) {
            echo.put("error", "no activity");
            r.put("echo", echo);
            return r;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse("content://com.android.externalstorage.documents/root/primary"),
                    DocumentsContract.Document.MIME_TYPE_DIR);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            echo.put("opened", true);
        } catch (Exception e) {
            echo.put("note", "Use in-app Explorer /sdcard/ or /saf/.");
        }
        r.put("echo", echo);
        return r;
    }

    JSObject showPaths() {
        JSObject r = base(true, "files:storage:status");
        JSObject echo = new JSObject();
        File ext = Environment.getExternalStorageDirectory();
        echo.put("outgoingDir", ext != null ? ext.getAbsolutePath() : "/sdcard");
        echo.put("incomingAppDir", ext != null ? new File(ext, "Download").getAbsolutePath() : "/sdcard/Download");
        echo.put("landingMode", readSafUri().isEmpty() ? "app" : "saf");
        echo.put("incomingDir", readSafUri());
        echo.put("readmePath", "");
        echo.put("allFilesAccess", isAllFilesGranted());
        r.put("echo", echo);
        return r;
    }

    private static final long MAX_READ_BYTES = 16L * 1024 * 1024;

    private JSObject uriSdcard(String path) {
        JSObject r = base(true, "storage:uri");
        JSObject echo = new JSObject();
        echo.put("root", "sdcard");
        File base = Environment.getExternalStorageDirectory();
        File file = base != null ? resolveUnder(base, path) : null;
        if (file == null || !file.isFile()) {
            echo.put("error", "not a file");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        Context ctx = plugin.getContext();
        String uri = "";
        if (ctx != null) {
            try {
                uri = FileProvider.getUriForFile(
                                ctx, ctx.getPackageName() + ".fileprovider", file)
                        .toString();
            } catch (Exception e) {
                uri = Uri.fromFile(file).toString();
            }
        }
        echo.put("uri", uri);
        echo.put("name", file.getName());
        echo.put("mime", guessMime(file.getName()));
        r.put("echo", echo);
        return r;
    }

    private JSObject uriSaf(String path) {
        JSObject r = base(true, "storage:uri");
        JSObject echo = new JSObject();
        echo.put("root", "saf");
        String stored = readSafUri();
        if (stored.isEmpty()) {
            echo.put("error", "No SAF tree mounted.");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        Context ctx = plugin.getContext();
        if (ctx == null) {
            echo.put("error", "no context");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        try {
            Uri tree = Uri.parse(stored);
            String docId = walkSafFileDocumentId(ctx.getContentResolver(), tree, path);
            if (docId == null) {
                echo.put("error", "not found");
                r.put("ok", false);
                r.put("echo", echo);
                return r;
            }
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
            String name = lastPathSegment(path);
            echo.put("uri", doc.toString());
            echo.put("name", name);
            echo.put("mime", guessMime(name));
        } catch (Exception e) {
            Log.w(TAG, "uriSaf failed", e);
            echo.put("error", String.valueOf(e.getMessage()));
            r.put("ok", false);
        }
        r.put("echo", echo);
        return r;
    }

    private JSObject readSdcard(String path) {
        JSObject r = base(true, "storage:read");
        JSObject echo = new JSObject();
        echo.put("root", "sdcard");
        File base = Environment.getExternalStorageDirectory();
        File file = base != null ? resolveUnder(base, path) : null;
        if (file == null || !file.isFile()) {
            echo.put("error", "not a file");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        if (file.length() <= 0 || file.length() > MAX_READ_BYTES) {
            echo.put("error", file.length() > MAX_READ_BYTES ? "too large" : "empty");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        try (FileInputStream in = new FileInputStream(file)) {
            fillReadEcho(echo, in, file.getName(), guessMime(file.getName()), file.length());
        } catch (Exception e) {
            Log.w(TAG, "readSdcard failed", e);
            echo.put("error", String.valueOf(e.getMessage()));
            r.put("ok", false);
        }
        r.put("echo", echo);
        return r;
    }

    private JSObject readSaf(String path) {
        JSObject r = base(true, "storage:read");
        JSObject echo = new JSObject();
        echo.put("root", "saf");
        String stored = readSafUri();
        if (stored.isEmpty()) {
            echo.put("error", "No SAF tree mounted.");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        Context ctx = plugin.getContext();
        if (ctx == null) {
            echo.put("error", "no context");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        try {
            Uri tree = Uri.parse(stored);
            String docId = walkSafFileDocumentId(ctx.getContentResolver(), tree, path);
            if (docId == null) {
                echo.put("error", "not found");
                r.put("ok", false);
                r.put("echo", echo);
                return r;
            }
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
            String name = lastPathSegment(path);
            try (InputStream in = ctx.getContentResolver().openInputStream(doc)) {
                if (in == null) {
                    echo.put("error", "unreadable");
                    r.put("ok", false);
                } else {
                    fillReadEcho(echo, in, name, guessMime(name), -1);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "readSaf failed", e);
            echo.put("error", String.valueOf(e.getMessage()));
            r.put("ok", false);
        }
        r.put("echo", echo);
        return r;
    }

    private static void fillReadEcho(JSObject echo, InputStream in, String name, String mime, long knownSize)
            throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > MAX_READ_BYTES) {
                throw new Exception("too large");
            }
            out.write(buf, 0, n);
        }
        byte[] bytes = out.toByteArray();
        String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
        echo.put("name", name != null && !name.isEmpty() ? name : "file");
        echo.put("mime", type);
        echo.put("size", knownSize > 0 ? knownSize : bytes.length);
        echo.put("data", "data:" + type + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
    }

    private static String lastPathSegment(String path) {
        if (path == null) return "file";
        String[] parts = path.split("/");
        for (int i = parts.length - 1; i >= 0; i--) {
            if (parts[i] != null && !parts[i].isEmpty()) return parts[i];
        }
        return "file";
    }

    private static String guessMime(String name) {
        String n = name != null ? name.toLowerCase() : "";
        if (n.endsWith(".txt") || n.endsWith(".log") || n.endsWith(".csv")) return "text/plain";
        if (n.endsWith(".md") || n.endsWith(".markdown")) return "text/markdown";
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".pdf")) return "application/pdf";
        return "application/octet-stream";
    }

    /** Walk a SAF tree to a file document id (last segment is the file). */
    private static String walkSafFileDocumentId(ContentResolver cr, Uri tree, String path) {
        String docId = DocumentsContract.getTreeDocumentId(tree);
        if (path == null || path.isEmpty() || "/".equals(path)) return null;
        String[] segs = path.split("/");
        int last = -1;
        for (int i = 0; i < segs.length; i++) {
            if (segs[i] != null && !segs[i].isEmpty()) last = i;
        }
        if (last < 0) return null;
        for (int i = 0; i < segs.length; i++) {
            String seg = segs[i];
            if (seg == null || seg.isEmpty()) continue;
            boolean wantFile = i == last;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
            String next = null;
            try (Cursor cursor = cr.query(
                    children,
                    new String[]{
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                            DocumentsContract.Document.COLUMN_MIME_TYPE
                    },
                    null, null, null)) {
                if (cursor == null) break;
                while (cursor.moveToNext()) {
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    boolean isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
                    if (seg.equals(name) && (wantFile ? !isDir : isDir)) {
                        next = cursor.getString(0);
                        break;
                    }
                }
            }
            if (next == null) return null;
            docId = next;
        }
        return docId;
    }

    private JSObject listSdcard(String path) {
        JSObject r = base(true, "storage:list");
        JSObject echo = new JSObject();
        echo.put("root", "sdcard");
        echo.put("allFilesAccess", isAllFilesGranted());
        File base = Environment.getExternalStorageDirectory();
        if (base == null) {
            echo.put("error", "no external storage");
            echo.put("entries", new JSArray());
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        File dir = resolveUnder(base, path);
        File[] files = dir != null ? dir.listFiles() : null;
        JSArray entries = new JSArray();
        if (files != null) {
            for (File file : files) {
                if (file == null) continue;
                JSObject row = new JSObject();
                row.put("name", file.getName());
                row.put("kind", file.isDirectory() ? "directory" : "file");
                row.put("size", file.length());
                row.put("lastModified", file.lastModified());
                entries.put(row);
            }
        } else if (!isAllFilesGranted()) {
            echo.put("note", "All-files access is required to list /sdcard/.");
        }
        echo.put("entries", entries);
        r.put("echo", echo);
        return r;
    }

    private JSObject listSaf(String path) {
        JSObject r = base(true, "storage:list");
        JSObject echo = new JSObject();
        echo.put("root", "saf");
        String stored = readSafUri();
        echo.put("incomingDir", stored);
        if (stored.isEmpty()) {
            echo.put("entries", new JSArray());
            echo.put("note", "No SAF tree mounted.");
            r.put("echo", echo);
            return r;
        }
        Context ctx = plugin.getContext();
        if (ctx == null) {
            echo.put("error", "no context");
            echo.put("entries", new JSArray());
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        try {
            Uri tree = Uri.parse(stored);
            String docId = walkSafDocumentId(ctx.getContentResolver(), tree, path);
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
            echo.put("entries", queryChildren(ctx.getContentResolver(), children));
        } catch (Exception e) {
            Log.w(TAG, "listSaf failed", e);
            echo.put("entries", new JSArray());
            echo.put("error", String.valueOf(e.getMessage()));
        }
        r.put("echo", echo);
        return r;
    }

    private static String walkSafDocumentId(ContentResolver cr, Uri tree, String path) {
        String docId = DocumentsContract.getTreeDocumentId(tree);
        if (path == null || path.isEmpty() || "/".equals(path)) return docId;
        for (String seg : path.split("/")) {
            if (seg == null || seg.isEmpty()) continue;
            Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId);
            String next = null;
            try (Cursor cursor = cr.query(
                    children,
                    new String[]{
                            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                            DocumentsContract.Document.COLUMN_MIME_TYPE
                    },
                    null, null, null)) {
                if (cursor == null) break;
                while (cursor.moveToNext()) {
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    if (seg.equals(name) && DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                        next = cursor.getString(0);
                        break;
                    }
                }
            }
            if (next == null) return docId;
            docId = next;
        }
        return docId;
    }

    private static JSArray queryChildren(ContentResolver cr, Uri children) {
        JSArray entries = new JSArray();
        try (Cursor cursor = cr.query(
                children,
                new String[]{
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE,
                        DocumentsContract.Document.COLUMN_SIZE,
                        DocumentsContract.Document.COLUMN_LAST_MODIFIED
                },
                null, null, null)) {
            if (cursor == null) return entries;
            while (cursor.moveToNext()) {
                JSObject row = new JSObject();
                String name = cursor.getString(0);
                String mime = cursor.getString(1);
                if (name == null || name.isEmpty()) continue;
                row.put("name", name);
                row.put("kind", DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)
                        ? "directory" : "file");
                if (!cursor.isNull(2)) row.put("size", cursor.getLong(2));
                if (!cursor.isNull(3)) row.put("lastModified", cursor.getLong(3));
                entries.put(row);
            }
        } catch (Exception e) {
            Log.w(TAG, "queryChildren failed", e);
        }
        return entries;
    }

    private boolean isAllFilesGranted() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return true;
        try {
            return Environment.isExternalStorageManager();
        } catch (Exception e) {
            return false;
        }
    }

    private String readSafUri() {
        Context ctx = plugin.getContext();
        if (ctx == null) return "";
        String stored = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SAF, "");
        if (stored == null) stored = "";
        if (stored.isEmpty()) {
            for (UriPermission perm : ctx.getContentResolver().getPersistedUriPermissions()) {
                if (perm.isReadPermission() && perm.getUri() != null) {
                    return perm.getUri().toString();
                }
            }
        }
        return stored;
    }

    private static File resolveUnder(File root, String path) {
        File dir = root;
        if (path == null) return dir;
        for (String seg : path.split("/")) {
            if (seg == null || seg.isEmpty() || ".".equals(seg)) continue;
            if ("..".equals(seg)) continue;
            dir = new File(dir, seg);
        }
        return dir;
    }

    static JSObject fail(String channel, String error) {
        JSObject r = base(false, channel);
        JSObject echo = new JSObject();
        echo.put("error", error);
        r.put("echo", echo);
        return r;
    }

    static JSObject base(boolean ok, String channel) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("channel", channel);
        r.put("echo", new JSObject());
        return r;
    }
}
