/*
 * Filename: AppUpdateHelper.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/AppUpdateHelper.java
 * FIND:apk-update
 * Change date and time: 18.05.00_27.08.2026
 * Reason for changes: Detect updates by versionCode, versionName, or a newer published build.
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
 * to update that installed package — still same-signer when the target is already installed.
 * Missing sibling packages sideload without pretending the launcher version is theirs.
 * Check treats a higher {@code versionCode}, a newer {@code versionName}, or a first install
 * as available. Equal code + equal name is current (install still sideloads).</p>
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

    private static String hostSku() {
        try {
            String sku = String.valueOf(BuildConfig.CWSP_SKU).trim().toLowerCase(Locale.ROOT);
            return sku.isEmpty() ? "launcher" : sku;
        } catch (Throwable ignored) {
            return "launcher";
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
            else sku = hostSku();
        }
        // INVARIANT: only the launcher APK may update a sibling package. Sibling APKs stay on self.
        String host = hostSku();
        if (!"launcher".equals(host) && !sku.equals(host)) {
            sku = host;
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
            boolean installed = isPackagePresent(context.getPackageManager(), ch.packageId);
            long code = installed ? localVersionCode(context, ch.packageId) : 0;
            String name = installed ? localVersionName(context, ch.packageId) : "";
            JSObject echo = localVersionEcho(context, ch.packageId, installed);
            echo.put("sku", ch.sku);
            echo.put("installed", installed);
            r.put("echo", echo);
            putVersionCode(r, "versionCode", code);
            r.put("versionName", name);
            r.put("installed", installed);
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
            long remoteCode = optVersionCode(manifest);
            String remoteName = optVersionName(manifest);
            String apkRel = manifest.optString("apk", manifest.optString("apkUrl", ch.defaultApk));
            String sha256 = manifest.optString("sha256", "");
            String remoteSig = normalizeHex(manifest.optString("signatureSha256", ""));
            long size = manifest.optLong("size", 0);

            boolean installed = isPackagePresent(context.getPackageManager(), ch.packageId);
            long localCode = installed ? localVersionCode(context, ch.packageId) : 0;
            String localName = installed ? localVersionName(context, ch.packageId) : "";
            Set<String> compareCerts = installed
                    ? localSigningCerts(context, ch.packageId, false)
                    : localSigningCerts(context, context.getPackageName(), false);
            String localSig = compareCerts.isEmpty() ? "" : compareCerts.iterator().next();
            boolean codeNewer = remoteCode > 0 && remoteCode > localCode;
            boolean nameNewer = compareVersionName(remoteName, localName) > 0;
            // WHY: gateway used to publish version.properties while the APK stayed at 1 — name/code both count.
            boolean newer = codeNewer || nameNewer;
            boolean signatureCompatible =
                    remoteSig.isEmpty()
                            || !installed
                            || compareCerts.isEmpty()
                            || compareCerts.contains(remoteSig);
            boolean updateAvailable = (!installed || newer) && signatureCompatible;
            String reason = !installed
                    ? "not-installed"
                    : codeNewer
                      ? "newer-code"
                      : nameNewer
                        ? "newer-name"
                        : remoteCode > 0 && remoteCode < localCode
                          ? "gateway-older"
                          : "current";

            JSObject echo = new JSObject();
            echo.put("sku", ch.sku);
            echo.put("packageId", ch.packageId);
            echo.put("source", source);
            echo.put("baseUrl", base);
            echo.put("manifestUrl", manifestUrl);
            echo.put("installed", installed);
            putVersionCode(echo, "localVersionCode", localCode);
            echo.put("localVersionName", localName);
            echo.put("localSignatureSha256", localSig);
            putVersionCode(echo, "remoteVersionCode", remoteCode);
            echo.put("remoteVersionName", remoteName);
            echo.put("remoteSignatureSha256", remoteSig);
            echo.put("signatureCompatible", signatureCompatible);
            echo.put("updateAvailable", updateAvailable);
            echo.put("reason", reason);
            echo.put("canSideload", signatureCompatible);
            echo.put("apk", apkRel);
            echo.put("sha256", sha256);
            putVersionCode(echo, "size", size);
            echo.put("canRequestPackageInstalls", canRequestPackageInstalls(context));
            if (installed && newer && !signatureCompatible) {
                echo.put(
                        "warning",
                        "Remote APK signing certificate differs from installed app — update blocked"
                );
            }
            r.put("echo", echo);
            r.put("updateAvailable", updateAvailable);
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

            long remoteCode = optVersionCode(manifest);
            boolean installed = isPackagePresent(context.getPackageManager(), ch.packageId);
            long localCode = installed ? localVersionCode(context, ch.packageId) : 0;
            // INVARIANT: block downgrade only. Equal versionCode is a sideload/reinstall.
            if (installed && remoteCode > 0 && remoteCode < localCode) {
                return fail(
                        "app:update:install",
                        "Remote versionCode " + remoteCode + " is older than local " + localCode
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

            Set<String> apkCerts = archiveSigningCerts(context, apkFile);
            if (apkCerts.isEmpty()) {
                //noinspection ResultOfMethodCallIgnored
                apkFile.delete();
                return fail("app:update:install", "could not read APK signing certificates");
            }
            if (installed) {
                Set<String> localCerts = localSigningCerts(context, ch.packageId, false);
                if (localCerts.isEmpty()) {
                    //noinspection ResultOfMethodCallIgnored
                    apkFile.delete();
                    return fail("app:update:install", "could not read installed package signing certificates");
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
            putVersionCode(echo, "size", apkFile.length());
            putVersionCode(echo, "remoteVersionCode", remoteCode);
            putVersionCode(echo, "localVersionCode", localCode);
            echo.put("installed", installed);
            echo.put("signatureVerified", true);
            echo.put("launchedInstaller", true);
            r.put("echo", echo);
            return r;
        } catch (Exception e) {
            Log.w(TAG, "install failed", e);
            return fail("app:update:install", e.getMessage() != null ? e.getMessage() : e.toString());
        }
    }

    private static JSObject localVersionEcho(Context context, String packageId, boolean installed)
            throws Exception {
        JSObject echo = new JSObject();
        echo.put("packageId", packageId);
        echo.put("installed", installed);
        long code = installed ? localVersionCode(context, packageId) : 0;
        // Capacitor JSObject prefers int/double — longs drop on the WebView side.
        putVersionCode(echo, "versionCode", code);
        putVersionCode(echo, "localVersionCode", code);
        echo.put("versionName", installed ? localVersionName(context, packageId) : "");
        echo.put("localVersionName", installed ? localVersionName(context, packageId) : "");
        Set<String> certs = installed
                ? localSigningCerts(context, packageId, false)
                : new LinkedHashSet<String>();
        String primary = certs.isEmpty() ? "" : certs.iterator().next();
        echo.put("signatureSha256", primary);
        com.getcapacitor.JSArray arr = new com.getcapacitor.JSArray();
        for (String c : certs) arr.put(c);
        echo.put("signatureSha256All", arr);
        return echo;
    }

    /** Capacitor JSObject drops Long — always emit int. */
    private static int asIntCode(long code) {
        if (code <= 0) return 0;
        if (code > Integer.MAX_VALUE) return Integer.MAX_VALUE;
        return (int) code;
    }

    private static void putVersionCode(JSObject o, String key, long code) {
        if (o == null || key == null) return;
        o.put(key, asIntCode(code));
    }

    private static long optVersionCode(JSONObject manifest) {
        if (manifest == null) return 0;
        String[] keys = { "versionCode", "version_code", "code" };
        for (String key : keys) {
            if (!manifest.has(key) || manifest.isNull(key)) continue;
            Object raw = manifest.opt(key);
            if (raw instanceof Number) {
                long n = ((Number) raw).longValue();
                if (n > 0) return n;
            }
            String s = String.valueOf(raw == null ? "" : raw).trim();
            if (s.isEmpty()) continue;
            try {
                long n = Long.parseLong(s.replaceAll("[^0-9].*$", ""));
                if (n > 0) return n;
            } catch (Exception ignored) {
                /* next key */
            }
        }
        return 0;
    }

    private static String optVersionName(JSONObject manifest) {
        if (manifest == null) return "";
        String[] keys = { "versionName", "version_name", "version" };
        for (String key : keys) {
            String v = manifest.optString(key, "").trim();
            if (!v.isEmpty() && !"null".equalsIgnoreCase(v)) return v;
        }
        return "";
    }

    private static int[] parseVersionParts(String raw) {
        String s = String.valueOf(raw == null ? "" : raw).trim();
        if (s.isEmpty()) return new int[0];
        String core = s.split("[+-]", 2)[0];
        String[] bits = core.split("\\.");
        int[] out = new int[bits.length];
        for (int i = 0; i < bits.length; i++) {
            try {
                out[i] = Integer.parseInt(bits[i].replaceAll("[^0-9]", ""));
            } catch (Exception e) {
                out[i] = 0;
            }
        }
        return out;
    }

    /** Semver-ish: 0.0.3 > 0.0.1. Empty names compare equal. */
    private static int compareVersionName(String remote, String local) {
        int[] a = parseVersionParts(remote);
        int[] b = parseVersionParts(local);
        if (a.length == 0 && b.length == 0) return 0;
        int n = Math.max(a.length, b.length);
        for (int i = 0; i < n; i++) {
            int av = i < a.length ? a[i] : 0;
            int bv = i < b.length ? b[i] : 0;
            if (av != bv) return Integer.compare(av, bv);
        }
        return 0;
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

    private static Set<String> localSigningCerts(Context context, String packageId, boolean fallbackToHost)
            throws Exception {
        PackageManager pm = context.getPackageManager();
        String pkg = packageId != null && !packageId.isEmpty() ? packageId : context.getPackageName();
        if (!isPackagePresent(pm, pkg)) {
            if (!fallbackToHost) return new LinkedHashSet<>();
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

    private static long selfBuildVersionCode() {
        try {
            return BuildConfig.CWSP_VERSION_CODE;
        } catch (Throwable ignored) {
            return 0;
        }
    }

    private static String selfBuildVersionName() {
        try {
            String name = String.valueOf(BuildConfig.CWSP_VERSION_NAME).trim();
            return name.isEmpty() || "null".equals(name) ? "" : name;
        } catch (Throwable ignored) {
            return "";
        }
    }

    private static long localVersionCode(Context context, String packageId) {
        String pkg = packageId != null && !packageId.isEmpty() ? packageId : context.getPackageName();
        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo info = pm.getPackageInfo(pkg, 0);
            long code = Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
            if (code > 0) return code;
        } catch (Exception ignored) {
            /* fall through */
        }
        if (pkg.equals(context.getPackageName())) return selfBuildVersionCode();
        return 0;
    }

    private static String localVersionName(Context context, String packageId) {
        String pkg = packageId != null && !packageId.isEmpty() ? packageId : context.getPackageName();
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(pkg, 0);
            if (info.versionName != null && !info.versionName.isEmpty()) return info.versionName;
        } catch (Exception ignored) {
            /* fall through */
        }
        if (pkg.equals(context.getPackageName())) return selfBuildVersionName();
        return "";
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
