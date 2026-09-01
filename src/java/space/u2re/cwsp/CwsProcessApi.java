/*
 * Filename: CwsProcessApi.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/CwsProcessApi.java
 * FIND:process
 *
 * Capacitor Java fallback for POST /api/process — same OpenAI-compatible
 * contract as subsystem process-local (request credentials only).
 */
package space.u2re.cwsp;

import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class CwsProcessApi {
    public static final String CHANNEL = "process:api";
    public static final String DEFAULT_BASE_URL = "https://api.proxyapi.ru/openai/v1";
    public static final String DEFAULT_MODEL = "gpt-5.6-luna";

    private CwsProcessApi() {}

    public static JSObject error(String message) {
        JSObject row = new JSObject();
        row.put("ok", false);
        row.put("error", message == null ? "Process API failed" : message);
        row.put("layer", "api");
        row.put("fallback", "java");
        return row;
    }

    public static JSObject miss() {
        return error("Missing credentials");
    }

    public static JSObject run(JSObject body) {
        if (body == null) return miss();
        String apiKey = pick(body, "apiKey", "bearerToken", "token");
        if (apiKey.isEmpty()) {
            JSObject provider = body.getJSObject("provider");
            if (provider != null) apiKey = pick(provider, "apiKey", "bearerToken");
        }
        if (apiKey.isEmpty()) return miss();

        String input = pick(body, "input", "text", "url", "content");
        if (input.isEmpty()) return error("Missing input (text/url/input)");

        String baseUrl = pick(body, "baseUrl");
        JSObject provider = body.getJSObject("provider");
        if (baseUrl.isEmpty() && provider != null) baseUrl = pick(provider, "baseUrl");
        if (baseUrl.isEmpty()) baseUrl = DEFAULT_BASE_URL;
        while (baseUrl.endsWith("/")) baseUrl = baseUrl.substring(0, baseUrl.length() - 1);

        String model = pick(body, "model");
        if (model.isEmpty() && provider != null) model = pick(provider, "model");
        if (model.isEmpty()) model = DEFAULT_MODEL;
        String instruction = pick(body, "customInstruction");

        try {
            JSONArray messages = new JSONArray();
            if (!instruction.isEmpty()) {
                JSONObject system = new JSONObject();
                system.put("role", "system");
                system.put("content", instruction);
                messages.put(system);
            }
            JSONObject user = new JSONObject();
            user.put("role", "user");
            user.put("content", input);
            messages.put(user);

            JSONObject req = new JSONObject();
            req.put("model", model);
            req.put("messages", messages);

            HttpURLConnection conn = (HttpURLConnection) new URL(baseUrl + "/chat/completions").openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Authorization", "Bearer " + apiKey);
            byte[] bytes = req.toString().getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream out = conn.getOutputStream()) {
                out.write(bytes);
            }

            int status = conn.getResponseCode();
            String raw = readStream(status >= 400 ? conn.getErrorStream() : conn.getInputStream());
            conn.disconnect();

            JSONObject json = raw == null || raw.isEmpty() ? new JSONObject() : new JSONObject(raw);
            if (status < 200 || status >= 300) {
                String err = json.optJSONObject("error") != null
                        ? json.optJSONObject("error").optString("message", "Provider " + status)
                        : ("Provider " + status);
                return error(err);
            }
            JSONArray choices = json.optJSONArray("choices");
            String text = "";
            if (choices != null && choices.length() > 0) {
                JSONObject message = choices.optJSONObject(0) != null
                        ? choices.optJSONObject(0).optJSONObject("message")
                        : null;
                if (message != null) text = message.optString("content", "").trim();
            }
            if (text.isEmpty()) return error("Empty provider response");

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("text", text);
            JSObject out = new JSObject();
            out.put("ok", true);
            out.put("mode", pick(body, "mode").isEmpty() ? "smartRecognize" : pick(body, "mode"));
            out.put("customInstruction", !instruction.isEmpty());
            JSObject providerInfo = new JSObject();
            providerInfo.put("baseUrl", baseUrl);
            providerInfo.put("model", model);
            providerInfo.put("apiKeySource", "request");
            out.put("provider", providerInfo);
            out.put("result", result);
            out.put("fallback", "java");
            return out;
        } catch (Exception e) {
            return error(e.getMessage());
        }
    }

    private static String pick(JSObject row, String... keys) {
        if (row == null) return "";
        for (String key : keys) {
            String value = row.getString(key, "");
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return "";
    }

    private static String readStream(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }
}
