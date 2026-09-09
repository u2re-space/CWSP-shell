/*
 * Filename: CwsNetworkProbe.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsNetworkProbe.java
 * FIND:network-probe
 * Change date and time: 15.50.00_09.09.2026
 * Reason: Capacitor WebView fetch to a dead host froze the UI; probe on a worker with short timeouts.
 */
package space.u2re.cwsp;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * {@code network:probe} / {@code network:dispatch-probe} for Capacitor.
 * INVARIANT: always return a {@code results} array so JS does not fall through to WebView {@code fetch}.
 */
final class CwsNetworkProbe {
    private static final String TAG = "CwsNetworkProbe";
    private static final int CONNECT_MS = 3500;
    private static final int READ_MS = 3500;
    private static final int MAX_ORIGINS = 8;

    private CwsNetworkProbe() {}

    static JSObject probe(JSObject payload) {
        JSObject r = base(true, "network:probe");
        JSArray results = new JSArray();
        for (String origin : collectOrigins(payload)) {
            results.put(probeOrigin(origin));
        }
        JSObject echo = new JSObject();
        echo.put("results", results);
        r.put("echo", echo);
        r.put("results", results);
        return r;
    }

    static JSObject dispatchProbe(JSObject payload) {
        JSObject r = base(true, "network:dispatch-probe");
        String origin = normalizeOrigin(str(payload, "origin"));
        JSObject echo = new JSObject();
        if (origin.isEmpty()) {
            r.put("ok", false);
            echo.put("error", "no origin");
            r.put("echo", echo);
            r.put("error", "no origin");
            return r;
        }
        String clientId = str(payload, "clientId");
        String token = str(payload, "token");
        String access = str(payload, "accessToken");
        if (access.isEmpty()) access = token;
        HttpURLConnection conn = null;
        try {
            conn = open(origin + "/api/network/dispatch");
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            if (!access.isEmpty()) {
                conn.setRequestProperty("x-auth-token", access);
                conn.setRequestProperty("Authorization", "Bearer " + access);
            }
            if (!token.isEmpty()) conn.setRequestProperty("x-cws-token", token);
            JSONObject body = new JSONObject();
            body.put("userId", clientId);
            body.put("byId", clientId);
            body.put("from", clientId);
            body.put("clientId", clientId);
            body.put("userKey", access);
            body.put("token", token.isEmpty() ? access : token);
            body.put("accessToken", access);
            body.put("op", "ask");
            body.put("what", "debug:isReady");
            body.put("payload", new JSONObject());
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            OutputStream out = conn.getOutputStream();
            out.write(bytes);
            out.flush();
            int code = conn.getResponseCode();
            InputStream stream = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String snippet = readSnippet(stream);
            boolean ok = code >= 200 && code < 300;
            r.put("ok", ok);
            r.put("statusCode", code);
            echo.put("ok", ok);
            echo.put("statusCode", code);
            echo.put("bodySnippet", snippet);
            if (!ok) {
                String err = "HTTP " + code;
                echo.put("error", err);
                r.put("error", err);
            }
        } catch (Exception e) {
            r.put("ok", false);
            String err = e.getMessage() != null ? e.getMessage() : "dispatch failed";
            echo.put("error", err);
            r.put("error", err);
            Log.w(TAG, "dispatch-probe failed", e);
        } finally {
            if (conn != null) conn.disconnect();
        }
        r.put("echo", echo);
        return r;
    }

    private static JSObject probeOrigin(String origin) {
        JSObject row = new JSObject();
        row.put("url", origin);
        HttpURLConnection conn = null;
        try {
            conn = open(origin + "/lna-probe");
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            boolean ok = code >= 200 && code < 500;
            row.put("reachable", ok);
            row.put("statusCode", code);
            if (!ok) row.put("error", "HTTP " + code);
        } catch (Exception e) {
            row.put("reachable", false);
            row.put("error", e.getMessage() != null ? e.getMessage() : "unreachable");
        } finally {
            if (conn != null) conn.disconnect();
        }
        return row;
    }

    private static List<String> collectOrigins(JSObject payload) {
        LinkedHashSet<String> out = new LinkedHashSet<>();
        addOrigin(out, str(payload, "relay"));
        addOrigin(out, str(payload, "direct"));
        if (payload != null) {
            /* WHY: Capacitor JSObject.get yields JSONArray — getJSArray does not exist. */
            try {
                Object raw = payload.get("candidates");
                if (raw instanceof JSONArray) {
                    JSONArray arr = (JSONArray) raw;
                    for (int i = 0; i < arr.length() && out.size() < MAX_ORIGINS; i++) {
                        addOrigin(out, arr.optString(i, ""));
                    }
                }
            } catch (Exception ignored) {
                /* optional */
            }
        }
        return new ArrayList<>(out);
    }

    private static void addOrigin(LinkedHashSet<String> out, String raw) {
        if (out.size() >= MAX_ORIGINS) return;
        String origin = normalizeOrigin(raw);
        if (!origin.isEmpty()) out.add(origin);
    }

    private static String normalizeOrigin(String raw) {
        if (raw == null) return "";
        String u = raw.trim();
        if (u.isEmpty()) return "";
        u = u.replaceAll("(?i)/lna-probe/?$", "");
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        if (!u.startsWith("https://") && !u.startsWith("http://")) {
            u = "https://" + u;
        }
        if (u.startsWith("http://")) {
            u = "https://" + u.substring("http://".length());
        }
        try {
            URL parsed = new URL(u);
            String host = parsed.getHost();
            if (host == null || host.isEmpty()) return "";
            int port = parsed.getPort();
            if (port < 0) port = 8434;
            return "https://" + host.toLowerCase(Locale.ROOT) + ":" + port;
        } catch (Exception e) {
            return "";
        }
    }

    private static HttpURLConnection open(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(CONNECT_MS);
        conn.setReadTimeout(READ_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setUseCaches(false);
        if (conn instanceof HttpsURLConnection) {
            applyInsecureTls((HttpsURLConnection) conn);
        }
        return conn;
    }

    /** TRUST: fleet endpoints use a self-signed cert; probe is reachability only. */
    private static void applyInsecureTls(HttpsURLConnection conn) {
        try {
            TrustManager[] trustAll = new TrustManager[] {
                new X509TrustManager() {
                    public void checkClientTrusted(X509Certificate[] c, String a) {}
                    public void checkServerTrusted(X509Certificate[] c, String a) {}
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                }
            };
            SSLContext sc = SSLContext.getInstance("TLS");
            sc.init(null, trustAll, new SecureRandom());
            conn.setSSLSocketFactory(sc.getSocketFactory());
            HostnameVerifier allHosts = (hostname, session) -> true;
            conn.setHostnameVerifier(allHosts);
        } catch (Exception e) {
            Log.w(TAG, "insecure TLS setup failed", e);
        }
    }

    private static String readSnippet(InputStream stream) {
        if (stream == null) return "";
        try {
            byte[] buf = new byte[240];
            int n = stream.read(buf);
            if (n <= 0) return "";
            return new String(buf, 0, n, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
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

    private static JSObject base(boolean ok, String channel) {
        JSObject r = new JSObject();
        r.put("ok", ok);
        r.put("channel", channel);
        return r;
    }
}
