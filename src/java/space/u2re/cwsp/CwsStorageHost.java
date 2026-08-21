/*
 * Filename: CwsStorageHost.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsStorageHost.java
 * Change date: 16.50.00_21.08.2026
 * Reason: All-files (/sdcard) + SAF tree listing for Explorer on the launcher SKU.
 */
package space.u2re.cwsp;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
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

import java.io.File;

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
