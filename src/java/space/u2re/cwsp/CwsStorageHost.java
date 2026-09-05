/*
 * Filename: CwsStorageHost.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsStorageHost.java
 * FIND:file-markdown
 * Change date: 15.55.00_05.09.2026
 * Reason: CREATE_DOCUMENT result on Capacitor 8 + persist write URI.
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
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Native storage for Explorer: {@code /sdcard/} via {@code MANAGE_EXTERNAL_STORAGE}
 * and {@code /saf/} via a persisted {@link DocumentsContract} tree.
 */
public final class CwsStorageHost {
    private static final String TAG = "CwsStorageHost";
    static final int REQ_SAF = 0x5341;
    static final int REQ_CREATE = 0x5343;
    private static final String PREFS = "cwsp_storage";
    private static final String KEY_SAF = "saf_tree_uri";
    private static final long MAX_WRITE_BYTES = 16L * 1024 * 1024;

    private static CwsStorageHost instance;

    static boolean dispatchActivityResult(int requestCode, int resultCode, Intent data) {
        if (instance == null) return false;
        if (requestCode == REQ_SAF) {
            instance.onActivityResult(requestCode, resultCode, data);
            return true;
        }
        /* WHY: Capacitor 8 may still deliver CREATE via Activity.onActivityResult. */
        if (requestCode == REQ_CREATE) {
            instance.onCreateDocumentResult(requestCode, resultCode, data);
            return true;
        }
        return false;
    }

    private final Plugin plugin;
    private PluginCall pendingPick;
    private PluginCall pendingCreate;
    private JSObject pendingCreatePayload;

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

    /**
     * Android stand-in for {@code showSaveFilePicker}: ACTION_CREATE_DOCUMENT, then write UTF-8.
     * WHY: Capacitor WebView has no File System Access picker; the path bar write is preferred.
     */
    void createDocument(PluginCall call, JSObject payload) {
        Activity activity = plugin.getActivity();
        if (activity == null) {
            call.resolve(fail("storage:create-document", "no activity"));
            return;
        }
        pendingCreate = call;
        pendingCreatePayload = payload != null ? payload : new JSObject();
        String name = pendingCreatePayload.getString("name", "document.md");
        if (name == null || name.trim().isEmpty()) name = "document.md";
        String mime = pendingCreatePayload.getString("mimeType", "text/markdown");
        if (mime == null || mime.trim().isEmpty()) mime = "text/markdown";
        mime = sanitizeCreateDocumentMime(name, mime);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_TITLE, name);
        intent.addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            /* WHY: Capacitor 8 Activity Result API — raw startActivityForResult
             * never reaches handleOnActivityResult, so Save hung after the sheet. */
            if (plugin instanceof CwsLauncherBridgePlugin) {
                ((CwsLauncherBridgePlugin) plugin).startStorageCreateDocument(call, intent);
            } else {
                activity.startActivityForResult(intent, REQ_CREATE);
            }
        } catch (Exception e) {
            Log.w(TAG, "CREATE_DOCUMENT failed", e);
            pendingCreate = null;
            pendingCreatePayload = null;
            call.resolve(fail("storage:create-document", "picker failed"));
        }
    }

    void onCreateDocumentResult(int requestCode, int resultCode, Intent data) {
        PluginCall call = pendingCreate;
        JSObject payload = pendingCreatePayload;
        pendingCreate = null;
        pendingCreatePayload = null;
        if (call == null) return;
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve(fail("storage:create-document", "cancelled"));
            return;
        }
        Uri uri = data.getData();
        Context ctx = plugin.getContext();
        if (ctx == null) {
            call.resolve(fail("storage:create-document", "no context"));
            return;
        }
        int flags = data.getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        if (flags == 0) {
            flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
        }
        try {
            ctx.getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (Exception e) {
            Log.w(TAG, "takePersistableUriPermission create failed", e);
        }
        String text = payload != null ? payload.getString("text", "") : "";
        if (text == null) text = "";
        JSObject written = writeBytesToUri(uri, text.getBytes(StandardCharsets.UTF_8), "storage:create-document");
        try {
            JSObject echo = written.getJSObject("echo");
            if (echo == null) {
                echo = new JSObject();
                written.put("echo", echo);
            }
            echo.put("uri", uri.toString());
        } catch (Exception ignored) {
            /* uri still on a successful write echo */
        }
        call.resolve(written);
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
     * WHY: Explorer Delete used OPFS {@code remove()} — Capacitor {@code /sdcard/} {@code /saf/}
     * never hit the filesystem. All-files or SAF write grant required.
     */
    JSObject delete(JSObject payload) {
        String root = payload != null ? payload.getString("root", "sdcard") : "sdcard";
        String path = payload != null ? payload.getString("path", "/") : "/";
        if ("saf".equals(root)) return deleteSaf(path);
        return deleteSdcard(path);
    }

    /**
     * Create or overwrite a file under {@code /sdcard/} or {@code /saf/}.
     * INVARIANT: refuses the storage root itself; creates missing parent folders.
     */
    JSObject write(JSObject payload) {
        String root = payload != null ? payload.getString("root", "sdcard") : "sdcard";
        String path = payload != null ? payload.getString("path", "/") : "/";
        String text = payload != null ? payload.getString("text", "") : "";
        if (text == null) text = "";
        String mime = payload != null ? payload.getString("mimeType", "text/markdown") : "text/markdown";
        if (mime == null || mime.trim().isEmpty()) mime = "text/markdown";
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_WRITE_BYTES) return fail("storage:write", "too large");
        if ("saf".equals(root)) return writeSaf(path, bytes, mime);
        return writeSdcard(path, bytes);
    }

    /** Overwrite a persisted {@code content://} from a previous create-document pick. */
    JSObject writeUri(JSObject payload) {
        String uri = payload != null ? payload.getString("uri", "") : "";
        String text = payload != null ? payload.getString("text", "") : "";
        if (text == null) text = "";
        if (uri == null || uri.trim().isEmpty()) return fail("storage:write-uri", "no uri");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_WRITE_BYTES) return fail("storage:write-uri", "too large");
        return writeBytesToUri(Uri.parse(uri.trim()), bytes, "storage:write-uri");
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
            if ("all-files-required".equals(err)) requestAllFiles();
            return fail("storage:open", err != null && !err.isEmpty() ? err : "not a file");
        }
        String name = echo.getString("name", "file");
        String mime = mimeType.trim().isEmpty() ? echo.getString("mime", "") : mimeType.trim();
        if (mime == null || mime.isEmpty()) mime = guessMime(name);
        Context ctx = plugin.getContext();
        if (ctx == null) return fail("storage:open", "no context");
        /* WHY: file:// is blocked for QuickEdit / editors on API 24+. Need FileProvider. */
        if (uri.regionMatches(true, 0, "file:", 0, 5)) {
            return fail("storage:open", "fileprovider-required");
        }
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
            /* WHY: setPackage can miss OEM filters — VIEW chooser lists QuickEdit + Document. */
            return LauncherCoordinator.openUri(
                    ctx, uri, "", true, title, LauncherCoordinator.systemOpenMime(name, mime));
        }
        if (chooser) {
            return LauncherCoordinator.openUri(
                    ctx, uri, "", true, title, LauncherCoordinator.systemOpenMime(name, mime));
        }
        return LauncherCoordinator.openUri(
                ctx, uri, "", true, title, LauncherCoordinator.systemOpenMime(name, mime));
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
    private static final long MAX_SHARE_COPY = 32L * 1024 * 1024;

    /** Keep the original basename so QuickEdit / Process attachments are not `open-123-note_md`. */
    private static String shareDisplayName(File file) {
        String raw = file != null ? file.getName() : "";
        if (raw == null) raw = "";
        raw = raw.replace('\\', '_').replace('/', '_').trim();
        if (raw.isEmpty() || ".".equals(raw) || "..".equals(raw)) return "file";
        return raw;
    }

    /**
     * Fallback only: copy into cache under the original name.
     * Prefer the real `/sdcard/` file so FileProvider path is `…/Download/note.md`.
     */
    private static File copyIntoShareCache(Context ctx, File file) {
        if (ctx == null || file == null || !file.isFile()) return null;
        if (file.length() <= 0 || file.length() > MAX_SHARE_COPY) return null;
        File dir = new File(ctx.getCacheDir(), "files");
        if (!dir.isDirectory() && !dir.mkdirs()) return null;
        File dest = new File(dir, shareDisplayName(file));
        try (FileInputStream in = new FileInputStream(file);
                FileOutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            return dest;
        } catch (Exception e) {
            Log.w(TAG, "copyIntoShareCache failed", e);
            if (dest.exists()) {
                //noinspection ResultOfMethodCallIgnored
                dest.delete();
            }
            return null;
        }
    }

    private static Uri shareableFileUri(Context ctx, File file) {
        if (ctx == null || file == null || !file.isFile()) return null;
        String authority = ctx.getPackageName() + ".fileprovider";
        try {
            return FileProvider.getUriForFile(ctx, authority, file);
        } catch (Exception e) {
            Log.w(TAG, "FileProvider on original file failed — cache copy", e);
        }
        File copied = copyIntoShareCache(ctx, file);
        if (copied == null) return null;
        try {
            return FileProvider.getUriForFile(ctx, authority, copied);
        } catch (Exception e) {
            Log.w(TAG, "shareable FileProvider failed", e);
            return null;
        }
    }

    private JSObject uriSdcard(String path) {
        JSObject r = base(true, "storage:uri");
        JSObject echo = new JSObject();
        echo.put("root", "sdcard");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !isAllFilesGranted()) {
            echo.put("error", "all-files-required");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
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
            Uri share = shareableFileUri(ctx, file);
            if (share != null) uri = share.toString();
        }
        if (uri == null || uri.isEmpty()) {
            echo.put("error", "fileprovider-failed");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !isAllFilesGranted()) {
            echo.put("error", "all-files-required");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
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
        String lowerName = name != null ? name.toLowerCase() : "";
        boolean asText = type.startsWith("text/")
                || type.contains("json")
                || type.contains("xml")
                || type.contains("markdown")
                || lowerName.endsWith(".md")
                || lowerName.endsWith(".markdown")
                || lowerName.endsWith(".txt");
        /* WHY: data: base64 + Binder (~1MB) freezes Capacitor invoke — Document stayed on Loading. */
        if (asText) {
            echo.put("text", new String(bytes, java.nio.charset.StandardCharsets.UTF_8));
        } else {
            echo.put("data", "data:" + type + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
        }
    }

    private static String lastPathSegment(String path) {
        if (path == null) return "file";
        String[] parts = path.split("/");
        for (int i = parts.length - 1; i >= 0; i--) {
            if (parts[i] != null && !parts[i].isEmpty()) return parts[i];
        }
        return "file";
    }

    /**
     * WHY: Android {@code MimeTypeMap} maps {@code .ts} → {@code video/mp2t}.
     * CREATE_DOCUMENT then opens as video or strips the TypeScript name.
     */
    private static String sanitizeCreateDocumentMime(String name, String mime) {
        String n = name != null ? name.toLowerCase() : "";
        String m = mime != null ? mime.trim().toLowerCase() : "";
        if (m.startsWith("video/") || "video/mp2t".equals(m)) return "application/octet-stream";
        if (n.endsWith(".ts") || n.endsWith(".tsx") || n.endsWith(".mts") || n.endsWith(".cts")
                || n.endsWith(".js") || n.endsWith(".jsx") || n.endsWith(".mjs") || n.endsWith(".cjs")
                || n.endsWith(".css") || n.endsWith(".scss") || n.endsWith(".json")
                || n.endsWith(".yml") || n.endsWith(".yaml") || n.endsWith(".py")
                || n.endsWith(".sh") || n.endsWith(".xml")) {
            return "application/octet-stream";
        }
        if (!n.isEmpty() && n.contains(".") && !n.endsWith(".md") && !n.endsWith(".markdown")
                && ("text/markdown".equals(m) || m.isEmpty())) {
            return "application/octet-stream";
        }
        return m.isEmpty() ? "application/octet-stream" : mime.trim();
    }

    private static String guessMime(String name) {
        String n = name != null ? name.toLowerCase() : "";
        if (n.endsWith(".ts") || n.endsWith(".tsx") || n.endsWith(".mts") || n.endsWith(".cts")) {
            return "text/plain";
        }
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

    private JSObject deleteSdcard(String path) {
        JSObject r = base(true, "storage:delete");
        JSObject echo = new JSObject();
        echo.put("root", "sdcard");
        File base = Environment.getExternalStorageDirectory();
        if (base == null) return fail("storage:delete", "no external storage");
        File file = resolveUnder(base, path);
        if (file == null) return fail("storage:delete", "bad path");
        try {
            String rootPath = base.getCanonicalPath();
            String targetPath = file.getCanonicalPath();
            if (targetPath.equals(rootPath) || !targetPath.startsWith(rootPath + File.separator)) {
                return fail("storage:delete", "refused");
            }
        } catch (Exception e) {
            return fail("storage:delete", "path");
        }
        if (!file.exists()) return fail("storage:delete", "not found");
        if (!isAllFilesGranted() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            echo.put("error", "All-files access is required to delete /sdcard/.");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        boolean isDir = file.isDirectory();
        boolean ok = deleteRecursive(file);
        echo.put("deleted", ok);
        echo.put("name", file.getName());
        echo.put("kind", isDir ? "directory" : "file");
        if (!ok) {
            echo.put("error", "delete failed");
            r.put("ok", false);
        }
        r.put("echo", echo);
        return r;
    }

    private JSObject deleteSaf(String path) {
        JSObject r = base(true, "storage:delete");
        JSObject echo = new JSObject();
        echo.put("root", "saf");
        String stored = readSafUri();
        if (stored.isEmpty()) return fail("storage:delete", "No SAF tree mounted.");
        if (path == null || path.isEmpty() || "/".equals(path)) {
            return fail("storage:delete", "refused");
        }
        Context ctx = plugin.getContext();
        if (ctx == null) return fail("storage:delete", "no context");
        try {
            Uri tree = Uri.parse(stored);
            ContentResolver cr = ctx.getContentResolver();
            String docId = walkSafAnyDocumentId(cr, tree, path);
            if (docId == null) return fail("storage:delete", "not found");
            String treeId = DocumentsContract.getTreeDocumentId(tree);
            if (docId.equals(treeId)) return fail("storage:delete", "refused");
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
            boolean ok = DocumentsContract.deleteDocument(cr, doc);
            echo.put("deleted", ok);
            echo.put("name", lastPathSegment(path));
            if (!ok) {
                echo.put("error", "delete failed");
                r.put("ok", false);
            }
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "deleteSaf failed", e);
            return fail("storage:delete", String.valueOf(e.getMessage()));
        }
    }

    private static boolean deleteRecursive(File file) {
        if (file == null || !file.exists()) return false;
        if (file.isDirectory()) {
            File[] kids = file.listFiles();
            if (kids != null) {
                for (File kid : kids) {
                    if (!deleteRecursive(kid)) return false;
                }
            }
        }
        return file.delete();
    }

    /** Last path segment may be a file or a folder. Missing child → null (do not delete parent). */
    private static String walkSafAnyDocumentId(ContentResolver cr, Uri tree, String path) {
        String docId = DocumentsContract.getTreeDocumentId(tree);
        if (path == null || path.isEmpty() || "/".equals(path)) return null;
        String[] raw = path.split("/");
        java.util.ArrayList<String> segs = new java.util.ArrayList<>();
        for (String seg : raw) {
            if (seg != null && !seg.isEmpty() && !".".equals(seg) && !"..".equals(seg)) {
                segs.add(seg);
            }
        }
        if (segs.isEmpty()) return null;
        for (int i = 0; i < segs.size(); i++) {
            String seg = segs.get(i);
            boolean last = i == segs.size() - 1;
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
                if (cursor == null) return null;
                while (cursor.moveToNext()) {
                    String name = cursor.getString(1);
                    String mime = cursor.getString(2);
                    boolean isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(mime);
                    if (!seg.equals(name)) continue;
                    if (!last && !isDir) continue;
                    next = cursor.getString(0);
                    break;
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

    private JSObject writeSdcard(String path, byte[] bytes) {
        JSObject r = base(true, "storage:write");
        JSObject echo = new JSObject();
        echo.put("root", "sdcard");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && !isAllFilesGranted()) {
            echo.put("error", "all-files-required");
            r.put("ok", false);
            r.put("echo", echo);
            return r;
        }
        File base = Environment.getExternalStorageDirectory();
        if (base == null) return fail("storage:write", "no external storage");
        File file = resolveUnder(base, path);
        if (file == null) return fail("storage:write", "bad path");
        try {
            String rootPath = base.getCanonicalPath();
            String targetPath = file.getCanonicalPath();
            if (targetPath.equals(rootPath) || !targetPath.startsWith(rootPath + File.separator)) {
                return fail("storage:write", "refused");
            }
        } catch (Exception e) {
            return fail("storage:write", "path");
        }
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            return fail("storage:write", "mkdir");
        }
        try (FileOutputStream out = new FileOutputStream(file, false)) {
            out.write(bytes != null ? bytes : new byte[0]);
            out.flush();
            echo.put("written", true);
            echo.put("name", file.getName());
            echo.put("path", file.getAbsolutePath());
        } catch (Exception e) {
            Log.w(TAG, "writeSdcard failed", e);
            return fail("storage:write", String.valueOf(e.getMessage()));
        }
        r.put("echo", echo);
        return r;
    }

    private JSObject writeSaf(String path, byte[] bytes, String mime) {
        String stored = readSafUri();
        if (stored.isEmpty()) return fail("storage:write", "No SAF tree mounted.");
        if (path == null || path.isEmpty() || "/".equals(path)) return fail("storage:write", "refused");
        Context ctx = plugin.getContext();
        if (ctx == null) return fail("storage:write", "no context");
        try {
            Uri tree = Uri.parse(stored);
            ContentResolver cr = ctx.getContentResolver();
            String docId = ensureSafFileDocumentId(cr, tree, path, mime);
            if (docId == null) return fail("storage:write", "create failed");
            Uri doc = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
            JSObject written = writeBytesToUri(doc, bytes, "storage:write");
            JSObject writtenEcho = null;
            try {
                writtenEcho = written.getJSObject("echo");
            } catch (Exception ignored) {
                /* optional */
            }
            if (writtenEcho != null) {
                writtenEcho.put("root", "saf");
                writtenEcho.put("name", lastPathSegment(path));
            }
            return written;
        } catch (Exception e) {
            Log.w(TAG, "writeSaf failed", e);
            return fail("storage:write", String.valueOf(e.getMessage()));
        }
    }

    private JSObject writeBytesToUri(Uri uri, byte[] bytes, String channel) {
        JSObject r = base(true, channel);
        JSObject echo = new JSObject();
        Context ctx = plugin.getContext();
        if (ctx == null || uri == null) return fail(channel, "no context");
        OutputStream out = null;
        try {
            out = ctx.getContentResolver().openOutputStream(uri, "wt");
            if (out == null) out = ctx.getContentResolver().openOutputStream(uri, "w");
            if (out == null) return fail(channel, "no stream");
            out.write(bytes != null ? bytes : new byte[0]);
            out.flush();
            echo.put("written", true);
            echo.put("uri", uri.toString());
            echo.put("ok", true);
        } catch (Exception e) {
            Log.w(TAG, "writeBytesToUri failed", e);
            return fail(channel, String.valueOf(e.getMessage()));
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (Exception ignored) {
                    /* already flushed */
                }
            }
        }
        r.put("echo", echo);
        return r;
    }

    /** Walk or create each SAF segment; last segment is the file. */
    private static String ensureSafFileDocumentId(ContentResolver cr, Uri tree, String path, String mime) {
        String docId = DocumentsContract.getTreeDocumentId(tree);
        java.util.ArrayList<String> segs = new java.util.ArrayList<>();
        if (path != null) {
            for (String seg : path.split("/")) {
                if (seg != null && !seg.isEmpty() && !".".equals(seg) && !"..".equals(seg)) {
                    segs.add(seg);
                }
            }
        }
        if (segs.isEmpty()) return null;
        String fileMime = mime != null && !mime.trim().isEmpty() ? mime : "text/markdown";
        for (int i = 0; i < segs.size(); i++) {
            String seg = segs.get(i);
            boolean last = i == segs.size() - 1;
            String next = findSafChildId(cr, tree, docId, seg, last);
            if (next == null) {
                try {
                    Uri parent = DocumentsContract.buildDocumentUriUsingTree(tree, docId);
                    String type = last ? fileMime : DocumentsContract.Document.MIME_TYPE_DIR;
                    Uri created = DocumentsContract.createDocument(cr, parent, type, seg);
                    if (created == null) return null;
                    next = DocumentsContract.getDocumentId(created);
                } catch (Exception e) {
                    return null;
                }
            }
            docId = next;
        }
        return docId;
    }

    private static String findSafChildId(
            ContentResolver cr,
            Uri tree,
            String parentDocId,
            String name,
            boolean wantFile
    ) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId);
        try (Cursor cursor = cr.query(
                children,
                new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                        DocumentsContract.Document.COLUMN_MIME_TYPE
                },
                null, null, null)) {
            if (cursor == null) return null;
            while (cursor.moveToNext()) {
                String display = cursor.getString(1);
                String childMime = cursor.getString(2);
                boolean isDir = DocumentsContract.Document.MIME_TYPE_DIR.equals(childMime);
                if (!name.equals(display)) continue;
                if (wantFile ? isDir : !isDir) continue;
                return cursor.getString(0);
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    private static File resolveUnder(File root, String path) {
        File dir = root;
        if (path == null) return dir;
        for (String seg : path.split("/")) {
            if (seg == null || seg.isEmpty() || ".".equals(seg)) continue;
            if ("..".equals(seg)) continue;
            try {
                seg = java.net.URLDecoder.decode(seg, "UTF-8");
            } catch (Exception ignored) {
                /* keep raw segment */
            }
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
