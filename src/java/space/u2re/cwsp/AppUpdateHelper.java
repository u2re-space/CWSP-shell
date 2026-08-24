/*
 * Filename: AppUpdateHelper.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/AppUpdateHelper.java
 * FIND:apk-update
 * Change date and time: 23.09.20_23.08.2026
 * Reason for changes: Launcher channel is public — do not require ecosystem token.
 */

package space.u2re.cwsp;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Native half of {@code app:update:check} / {@code app:update:install} / {@code app:info}.
 *
 * <p>SECURITY: only HTTPS hosts in the fleet allowlist (WAN .152, LAN .200, or
 * the configured relay host) may be used as APK sources. Install also requires
 * the downloaded APK signing certificate to match the installed app (same-signer).</p>
 *
 * <p>INVARIANT: self-update stays on {@code latest-launcher.json} + {@code cwsp-launcher.apk}.
 * Launcher settings sibling sections may pass {@code sku=transfer|explorer|document|process}
 * to update that installed package — still same-signer, allowlisted host.</p>
 *
 * <p>WHY: launcher artifacts are public on the gateway — ecosystem token is optional here.</p>
 */
final class AppUpdateHelper {
    private static final String TAG = "AppUpdate";
    private static final String WAN_BASE = "https://45.147.121.152:8434";
    private static final String LAN_BASE = "https://192.168.0.200:8434";
    private static final String MANIFEST_PATH = "/releases/android/latest-launcher.json";
    private static final String DEFAULT_APK_NAME = "cwsp-launcher.apk";
    private static final Set<String> FIXED_HOSTS = new HashSet<>(Arrays.asList(
            "45.147.121.152",
            "192.168.0.200"
    ));

    private AppUpdateHelper() {}

    /** Allowlisted sibling / self channel. Client cannot pick an arbitrary manifest path. */
    private static final class UpdateChannel {
        final String sku;
        final String packageId;
        final String manifestPath;
        final String defaultApk;
        final boolean tokenRequired;

        UpdateChannel(String sku, String packageId, String manifestPath, String defaultApk, boolean tokenRequired) {
            this.sku = sku;
            this.packageId = packageId;
            this.manifestPath = manifestPath;
            this.defaultApk = defaultApk;
            this.tokenRequired = tokenRequired;
        }
    }

    private static UpdateChannel channelFor(Context context, JSObject payload) {
        String sku = str(payload, "sku", "").trim().toLowerCase(Locale.ROOT);
        if (sku.isEmpty()) {
            String pkg = str(payload, "packageName", "").trim();
            if ("space.u2re.cwsp".equals(pkg)) sku = "transfer";
            else if ("space.u2re.explorer".equals(pkg)) sku = "explorer";
            else if ("space.u2re.document".equals(pkg)) sku = "document";
            else if ("space.u2re.process".equals(pkg)) sku = "process";
            else sku = "launcher";
        }
        switch (sku) {
            case "transfer":
                return new UpdateChannel(
                        "transfer", "space.u2re.cwsp", "/releases/android/latest.json", "cwsp.apk", true);
            case "explorer":
                return new UpdateChannel(
                        "explorer",
                        "space.u2re.explorer",
                        "/releases/android/latest-explorer.json",
                        "cwsp-explorer.apk",
                        false);
            case "document":
                return new UpdateChannel(
                        "document",
                        "space.u2re.document",
                        "/releases/android/latest-document.json",
                        "cwsp-document.apk",
                        false);
            case "process":
                return new UpdateChannel(
                        "process",
                        "space.u2re.process",
                        "/releases/android/latest-process.json",
                        "cwsp-process.apk",
                        false);
            default:
                return new UpdateChannel(
                        "launcher",
                        context.getPackageName(),
                        MANIFEST_PATH,
                        DEFAULT_APK_NAME,
                        false);
        }
    }

    /** Local package version + signing cert SHA-256 (for Settings / diagnostics). */
    static JSObject info(Context context) {
        return info(context, new JSObject());
    }

    static JSObject info(Context context, JSObject payload) {
        JSObject r = base(true, "app:info");
        try {
            UpdateChannel ch = channelFor(context, payload != null ? payload : new JSObject());
            long code = localVersionCode(context, ch.packageId);
            String name = localVersionName(context, ch.packageId);
            JSObject echo = localVersionEcho(context, ch.packageId);
            echo.put("sku", ch.sku);
            r.put("echo", echo);
            r.put("versionCode", code);
            r.put("versionName", name);
            return r;
        } catch (Exception e) {
            return fail("app:info", e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    static JSObject check(Context context, JSObject payload) {
        JSObject r = base(true, "app:update:check");
        try {
            UpdateChannel ch = channelFor(context, payload);
            String source = str(payload, "source", "wan");
            String token = resolveToken(context, payload);
            if (ch.tokenRequired && token.isEmpty()) {
                return fail("app:update:check", "ecosystem token required for " + ch.sku + " updates");
            }
            boolean allowInsecure = bool(payload, "allowInsecureTls", false);
            String base = resolveBaseUrl(source, str(payload, "endpointUrl", ""));
            if (base == null) {
                return fail("app:update:check", "untrusted or empty update source");
            }

            String manifestUrl = base + ch.manifestPath;
            JSONObject manifest = fetchJson(manifestUrl, token, allowInsecure);
            long remoteCode = manifest.optLong("versionCode", 0);
            String remoteName = manifest.optString("versionName", "");
            String apkRel = manifest.optString("apk", manifest.optString("apkUrl", ch.defaultApk));
            String sha256 = manifest.optString("sha256", "");
            String remoteSig = normalizeHex(manifest.optString("signatureSha256", ""));
            long size = manifest.optLong("size", 0);

            long localCode = localVersionCode(context, ch.packageId);
            String localName = localVersionName(context, ch.packageId);
            Set<String> localCerts = localSigningCerts(context, ch.packageId);
            String localSig = localCerts.isEmpty() ? "" : localCerts.iterator().next();
            boolean updateAvailable = remoteCode > localCode;
            boolean signatureCompatible =
                    remoteSig.isEmpty()
                            || localCerts.isEmpty()
                            || localCerts.contains(remoteSig);

            JSObject echo = new JSObject();
            echo.put("sku", ch.sku);
            echo.put("packageId", ch.packageId);
            echo.put("source", source);
            echo.put("baseUrl", base);
            echo.put("manifestUrl", manifestUrl);
            echo.put("localVersionCode", localCode);
            echo.put("localVersionName", localName);
            echo.put("localSignatureSha256", localSig);
            echo.put("remoteVersionCode", remoteCode);
            echo.put("remoteVersionName", remoteName);
            echo.put("remoteSignatureSha256", remoteSig);
            echo.put("signatureCompatible", signatureCompatible);
            echo.put("updateAvailable", updateAvailable && signatureCompatible);
            echo.put("apk", apkRel);
            echo.put("sha256", sha256);
            echo.put("size", size);
            echo.put("canRequestPackageInstalls", canRequestPackageInstalls(context));
            if (updateAvailable && !signatureCompatible) {
                echo.put(
                        "warning",
                        "Remote APK signing certificate differs from installed app — update blocked"
                );
            }
            r.put("echo", echo);
            r.put("updateAvailable", updateAvailable && signatureCompatible);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "check failed", e);
            return fail("app:update:check", e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    static JSObject install(Context context, Activity activity, JSObject payload) {
        JSObject r = base(true, "app:update:install");
        try {
            UpdateChannel ch = channelFor(context, payload);
            String source = str(payload, "source", "wan");
            String token = resolveToken(context, payload);
            if (ch.tokenRequired && token.isEmpty()) {
                return fail("app:update:install", "ecosystem token required for " + ch.sku + " updates");
            }
            boolean allowInsecure = bool(payload, "allowInsecureTls", false);
            String base = resolveBaseUrl(source, str(payload, "endpointUrl", ""));
            if (base == null) {
                return fail("app:update:install", "untrusted or empty update source");
            }
            if (!canRequestPackageInstalls(context)) {
                openInstallPermissionSettings(context, activity);
                return fail(
                        "app:update:install",
                        "Install unknown apps permission required — opened system settings"
                );
            }

            String manifestUrl = base + ch.manifestPath;
            JSONObject manifest = fetchJson(manifestUrl, token, allowInsecure);
            String apkField = manifest.optString("apkUrl", "");
            if (apkField.isEmpty()) {
                String apkName = manifest.optString("apk", ch.defaultApk);
                apkField = apkName.startsWith("http")
                        ? apkName
                        : "/releases/android/" + apkName.replaceFirst("^/+", "");
            }
            String apkUrl = apkField.startsWith("http") ? apkField : base + (apkField.startsWith("/") ? apkField : "/" + apkField);
            if (!isTrustedUrl(apkUrl, base)) {
                return fail("app:update:install", "apk url host not allowlisted");
            }

            long remoteCode = manifest.optLong("versionCode", 0);
            long localCode = localVersionCode(context, ch.packageId);
            if (remoteCode > 0 && remoteCode <= localCode) {
                return fail(
                        "app:update:install",
                        "Remote versionCode " + remoteCode + " is not newer than local " + localCode
                );
            }

            String expectSha = manifest.optString("sha256", "");
            String expectSig = normalizeHex(manifest.optString("signatureSha256", ""));
            File apkFile = downloadApk(context, apkUrl, token, allowInsecure);
            if (expectSha != null && !expectSha.isEmpty()) {
                String got = sha256Hex(apkFile);
                if (!expectSha.equalsIgnoreCase(got)) {
                    //noinspection ResultOfMethodCallIgnored
                    apkFile.delete();
                    return fail("app:update:install", "sha256 mismatch");
                }
            }

            // INVARIANT: same signing certificate as the target package (or launcher, if sibling missing).
            Set<String> localCerts = localSigningCerts(context, ch.packageId);
            Set<String> apkCerts = archiveSigningCerts(context, apkFile);
            if (localCerts.isEmpty() || apkCerts.isEmpty()) {
                //noinspection ResultOfMethodCallIgnored
                apkFile.delete();
                return fail("app:update:install", "could not read APK/package signing certificates");
            }
            boolean sameSigner = false;
            for (String c : apkCerts) {
                if (localCerts.contains(c)) {
                    sameSigner = true;
                    break;
                }
            }
            if (!sameSigner) {
                //noinspection ResultOfMethodCallIgnored
                apkFile.delete();
                return fail("app:update:install", "APK signing certificate does not match installed app");
            }
            if (!expectSig.isEmpty() && !apkCerts.contains(expectSig)) {
                //noinspection ResultOfMethodCallIgnored
                apkFile.delete();
                return fail("app:update:install", "APK signature does not match " + ch.manifestPath + " signatureSha256");
            }

            Uri uri = FileProvider.getUriForFile(
                    context,
                    context.getPackageName() + ".fileprovider",
                    apkFile
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (activity != null) {
                activity.startActivity(intent);
            } else {
                context.startActivity(intent);
            }

            JSObject echo = new JSObject();
            echo.put("sku", ch.sku);
            echo.put("packageId", ch.packageId);
            echo.put("source", source);
            echo.put("baseUrl", base);
            echo.put("apkUrl", apkUrl);
            echo.put("path", apkFile.getAbsolutePath());
            echo.put("size", apkFile.length());
            echo.put("remoteVersionCode", remoteCode);
            echo.put("localVersionCode", localCode);
            echo.put("signatureVerified", true);
            echo.put("launchedInstaller", true);
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "install failed", e);
            return fail("app:update:install", e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    private static JSObject localVersionEcho(Context context, String packageId) throws Exception {
        JSObject echo = new JSObject();
        long code = localVersionCode(context, packageId);
        echo.put("packageId", packageId);
        // Capacitor JSObject prefers int/double for numeric getInteger.
        echo.put("versionCode", code > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) code);
        echo.put("versionName", localVersionName(context, packageId));
        Set<String> certs = localSigningCerts(context, packageId);
        String primary = certs.isEmpty() ? "" : certs.iterator().next();
        echo.put("signatureSha256", primary);
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        for (String c : certs) arr.put(c);
        echo.put("signatureSha256All", arr);
        return echo;
    }

    private static String normalizeHex(String raw) {
        return String.valueOf(raw == null ? "" : raw)
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^0-9a-f]", "");
    }

    private static String sha256OfBytes(byte[] data) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(data);
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    @SuppressWarnings("deprecation")
    private static Set<String> signaturesToSha256(Signature[] signatures) throws Exception {
        Set<String> out = new LinkedHashSet<>();
        if (signatures == null) return out;
        for (Signature sig : signatures) {
            if (sig == null) continue;
            out.add(sha256OfBytes(sig.toByteArray()));
        }
        return out;
    }

    private static Set<String> localSigningCerts(Context context, String packageId) throws Exception {
        PackageManager pm = context.getPackageManager();
        String pkg = packageId != null && !packageId.isEmpty() ? packageId : context.getPackageName();
        if (!isPackagePresent(pm, pkg)) {
            pkg = context.getPackageName();
        }
        if (Build.VERSION.SDK_INT >= 28) {
            PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES);
            SigningInfo si = info.signingInfo;
            if (si == null) return new LinkedHashSet<>();
            Signature[] sigs = si.hasMultipleSigners()
                    ? si.getApkContentsSigners()
                    : si.getSigningCertificateHistory();
            return signaturesToSha256(sigs);
        }
        PackageInfo info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES);
        return signaturesToSha256(info.signatures);
    }

    private static Set<String> archiveSigningCerts(Context context, File apkFile) throws Exception {
        PackageManager pm = context.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        PackageInfo info = pm.getPackageArchiveInfo(apkFile.getAbsolutePath(), flags);
        if (info == null) return new LinkedHashSet<>();
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) {
            SigningInfo si = info.signingInfo;
            Signature[] sigs = si.hasMultipleSigners()
                    ? si.getApkContentsSigners()
                    : si.getSigningCertificateHistory();
            return signaturesToSha256(sigs);
        }
        //noinspection deprecation
        return signaturesToSha256(info.signatures);
    }

    /** Resolve WAN / LAN / relay base; null if untrusted. */
    static String resolveBaseUrl(String source, String endpointUrl) {
        String s = source == null ? "wan" : source.trim().toLowerCase(Locale.ROOT);
        if ("wan".equals(s) || "152".equals(s)) return WAN_BASE;
        if ("lan".equals(s) || "200".equals(s)) return LAN_BASE;
        if ("relay".equals(s) || "endpoint".equals(s) || "current".equals(s)) {
            String base = normalizeBase(endpointUrl);
            if (base == null) return null;
            String host = hostOf(base);
            if (host == null) return null;
            if (FIXED_HOSTS.contains(host) || isPrivateOrConfiguredHost(host, endpointUrl)) {
                return base;
            }
            return null;
        }
        // Absolute URL passed as source
        if (s.startsWith("https://")) {
            String base = normalizeBase(source);
            if (base == null) return null;
            String host = hostOf(base);
            if (host != null && (FIXED_HOSTS.contains(host) || isPrivateOrConfiguredHost(host, endpointUrl))) {
                return base;
            }
        }
        return null;
    }

    private static boolean isPrivateOrConfiguredHost(String host, String endpointUrl) {
        if (FIXED_HOSTS.contains(host)) return true;
        String relayHost = hostOf(normalizeBase(endpointUrl));
        return relayHost != null && relayHost.equalsIgnoreCase(host);
    }

    private static boolean isTrustedUrl(String url, String allowedBase) {
        String host = hostOf(url);
        String baseHost = hostOf(allowedBase);
        if (host == null || baseHost == null) return false;
        // INVARIANT: APK must come from the same host we already allowlisted as base.
        return host.equalsIgnoreCase(baseHost);
    }

    private static String normalizeBase(String raw) {
        if (raw == null) return null;
        String u = raw.trim();
        if (u.isEmpty()) return null;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (!u.startsWith("https://") && !u.startsWith("http://")) {
            u = "https://" + u;
        }
        // Prefer https for fleet TLS endpoints.
        if (u.startsWith("http://")) {
            u = "https://" + u.substring("http://".length());
        }
        try {
            URL parsed = new URL(u);
            String host = parsed.getHost();
            if (host == null || host.isEmpty()) return null;
            int port = parsed.getPort();
            if (port < 0) port = 8434;
            return "https://" + host + ":" + port;
        } catch (Exception e) {
            return null;
        }
    }

    private static String hostOf(String url) {
        try {
            if (url == null || url.isEmpty()) return null;
            return new URL(url).getHost();
        } catch (Exception e) {
            return null;
        }
    }

    private static String resolveToken(Context context, JSObject payload) {
        String token = str(payload, "token", "");
        if (token.isEmpty()) token = str(payload, "ecosystemToken", "");
        if (token.isEmpty()) token = str(payload, "accessToken", "");
        return token != null ? token.trim() : "";
    }

    private static boolean isPackagePresent(PackageManager pm, String pkg) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(0));
            } else {
                pm.getPackageInfo(pkg, 0);
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static long localVersionCode(Context context, String packageId) {
        String pkg = packageId != null && !packageId.isEmpty() ? packageId : context.getPackageName();
        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo info = pm.getPackageInfo(pkg, 0);
            if (Build.VERSION.SDK_INT >= 28) {
                return info.getLongVersionCode();
            }
            //noinspection deprecation
            return info.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private static String localVersionName(Context context, String packageId) {
        String pkg = packageId != null && !packageId.isEmpty() ? packageId : context.getPackageName();
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(pkg, 0);
            return info.versionName != null ? info.versionName : "";
        } catch (Exception e) {
            return "";
        }
    }

    private static boolean canRequestPackageInstalls(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return context.getPackageManager().canRequestPackageInstalls();
    }

    private static void openInstallPermissionSettings(Context context, Activity activity) {
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            i.setData(Uri.parse("package:" + context.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (activity != null) activity.startActivity(i);
            else context.startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "open install permission settings failed", e);
        }
    }

    private static JSONObject fetchJson(String url, String token, boolean allowInsecure) throws Exception {
        HttpURLConnection conn = open(url, token, allowInsecure);
        try {
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(20000);
            int code = conn.getResponseCode();
            InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String body = readAll(stream);
            if (code == 401 || code == 403) {
                throw new IllegalStateException("Unauthorized (" + code + ") downloading manifest");
            }
            if (code >= 400) {
                throw new IllegalStateException("HTTP " + code + ": " + truncate(body, 180));
            }
            return new JSONObject(body);
        } finally {
            conn.disconnect();
        }
    }

    private static File downloadApk(Context context, String url, String token, boolean allowInsecure)
            throws Exception {
        File dir = new File(context.getCacheDir(), "cwsp/apk");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("cannot create apk cache dir");
        }
        File out = new File(dir, "cwsp-update.apk");
        HttpURLConnection conn = open(url, token, allowInsecure);
        try {
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(120000);
            int code = conn.getResponseCode();
            if (code == 401 || code == 403) {
                throw new IllegalStateException("Unauthorized (" + code + ") downloading APK");
            }
            if (code >= 400) {
                throw new IllegalStateException("APK download HTTP " + code);
            }
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) >= 0) {
                    fos.write(buf, 0, n);
                }
            }
        } finally {
            conn.disconnect();
        }
        if (!out.isFile() || out.length() < 64) {
            throw new IllegalStateException("downloaded APK empty or too small");
        }
        return out;
    }

    private static HttpURLConnection open(String url, String token, boolean allowInsecure) throws Exception {
        URL u = new URL(url);
        HttpURLConnection conn = (HttpURLConnection) u.openConnection();
        if (conn instanceof HttpsURLConnection && allowInsecure) {
            applyInsecureTls((HttpsURLConnection) conn);
        }
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("X-API-Key", token);
            conn.setRequestProperty("x-auth-token", token);
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
        conn.setInstanceFollowRedirects(true);
        return conn;
    }

    /** TRUST: only when settings allowInsecureTls — fleet self-signed certs. */
    private static void applyInsecureTls(HttpsURLConnection conn) {
        try {
            TrustManager[] trustAll = new TrustManager[]{
                    new X509TrustManager() {
                        public void checkClientTrusted(X509Certificate[] c, String a) {}
                        public void checkServerTrusted(X509Certificate[] c, String a) {}
                        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                    }
            };
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, trustAll, new SecureRandom());
            conn.setSSLSocketFactory(sc.getSocketFactory());
            HostnameVerifier allHosts = (hostname, session) -> true;
            conn.setHostnameVerifier(allHosts);
        } catch (Exception e) {
            Log.w(TAG, "applyInsecureTls failed", e);
        }
    }

    private static String sha256Hex(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) >= 0) digest.update(buf, 0, n);
        }
        byte[] hash = digest.digest();
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader br = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private static String truncate(String s, int max) {
        if (s == null) return "";
        String t = s.replaceAll("\\s+", " ").trim();
        return t.length() <= max ? t : t.substring(0, max) + "…";
    }

    private static String str(JSObject payload, String key, String fallback) {
        if (payload == null) return fallback;
        String v = payload.getString(key, fallback);
        return v != null ? v : fallback;
    }

    private static boolean bool(JSObject payload, String key, boolean fallback) {
        if (payload == null) return fallback;
        try {
            if (!payload.has(key)) return fallback;
            return payload.getBool(key);
        } catch (Exception e) {
            return fallback;
        }
    }

    private static JSObject base(boolean ok, String channel) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("channel", channel);
        return r;
    }

    private static JSObject fail(String channel, String error) {
        JSObject r = base(false, channel);
        JSObject echo = new JSObject();
        echo.put("error", error != null ? error : "error");
        r.put("echo", echo);
        r.put("error", error != null ? error : "error");
        return r;
    }
}
