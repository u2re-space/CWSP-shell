/*
 * Filename: ProcessIngressService.java
 * FullPath: apps/CWSP-shell/src/java/space/u2re/cwsp/ProcessIngressService.java
 * FIND:process-ingress
 *
 * Background Process share job: classify → attach opens MainActivity, process
 * runs CwsProcessApi and a clipboard trampoline. No Work Center UI for process.
 */
package space.u2re.cwsp;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;

public class ProcessIngressService extends Service {
    private static final String TAG = "CwspProcessIngress";
    private static final String CHANNEL_ID = "cwsp-process-ingress";
    private static final int NOTIFY_ID = 8436;
    private static final String EXTRACT_NOW =
            "Extract all readable text, equations, tables, and data. "
                    + "Output the recognized content now using the user's format rules. "
                    + "Do not ask what to do with the image.";

    private boolean running = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startProcessingNotification();
        if (!running) {
            running = true;
            new Thread(this::runJob, "cwsp-process-ingress").start();
        }
        return START_NOT_STICKY;
    }

    private void runJob() {
        boolean handoffToMain = false;
        long startedAt = 0L;
        try {
            JSObject share = LauncherCoordinator.peekPendingShare(this);
            if (share == null) {
                notifyDone("Nothing to process", false);
                return;
            }
            startedAt = LauncherCoordinator.readStashedAt(share);
            String kind = ProcessIngressSnapshot.classifyKind(share);
            if (!ProcessIngressSnapshot.isProcessMode(this, kind)) {
                handoffToMain = true;
                openMainApp();
                return;
            }
            String apiKey = ProcessIngressSnapshot.apiKey(this);
            if (apiKey.isEmpty()) {
                notifyDone("Open Process and save an API key", false);
                return;
            }
            JSObject file = LauncherCoordinator.readPendingShareFile(this);
            JSObject echo = file != null ? file.getJSObject("echo") : null;
            String dataUrl = echo != null ? echo.getString("data", "") : "";
            String text = first(share, "text");
            String url = first(share, "url");
            String input = !dataUrl.isEmpty() ? dataUrl : (!text.isEmpty() ? text : url);
            if (input == null || input.trim().isEmpty()) {
                notifyDone("No content to process", false);
                return;
            }
            JSObject body = new JSObject();
            body.put("apiKey", apiKey);
            String baseUrl = ProcessIngressSnapshot.baseUrl(this);
            if (!baseUrl.isEmpty()) body.put("baseUrl", baseUrl);
            String model = ProcessIngressSnapshot.model(this);
            if (!model.isEmpty()) body.put("model", model);
            String instruction = ProcessIngressSnapshot.instruction(this);
            body.put("customInstruction", instruction.isEmpty() ? EXTRACT_NOW : EXTRACT_NOW + "\n\n" + instruction);
            body.put("input", input);
            body.put("content", input);
            body.put("mode", "smartRecognize");
            JSObject result = CwsProcessApi.run(body);
            String out = readResultText(result);
            boolean ok = resultOk(result) && out != null && !out.trim().isEmpty();
            launchClipboardWrite(ok ? out : String.valueOf(result != null ? result.getString("error") : "Processing failed"), ok);
        } catch (Exception e) {
            Log.w(TAG, "process ingress failed", e);
            notifyDone("Processing failed", false);
        } finally {
            if (!handoffToMain) {
                if (startedAt > 0L) {
                    JSObject ack = new JSObject();
                    ack.put("stashedAt", startedAt);
                    LauncherCoordinator.ackPendingShare(this, ack);
                }
                JSObject leftover = LauncherCoordinator.peekPendingShare(this);
                if (leftover != null
                        && ProcessIngressSnapshot.isProcessMode(
                                this, ProcessIngressSnapshot.classifyKind(leftover))) {
                    new Thread(this::runJob, "cwsp-process-ingress").start();
                } else {
                    running = false;
                    stopForeground(true);
                    stopSelf();
                }
            } else {
                running = false;
            }
        }
    }

    private void launchClipboardWrite(String text, boolean ok) {
        Intent trampoline = new Intent(this, ProcessClipboardWriteActivity.class);
        trampoline.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_HISTORY);
        trampoline.putExtra(ProcessClipboardWriteActivity.EXTRA_TEXT, text != null ? text : "");
        trampoline.putExtra(ProcessClipboardWriteActivity.EXTRA_OK, ok);
        try {
            startActivity(trampoline);
        } catch (Exception e) {
            Log.w(TAG, "clipboard trampoline failed", e);
            notifyDone(ok ? "Processed, but clipboard write failed" : "Processing failed", ok);
        }
    }

    private void openMainApp() {
        Intent main = new Intent(this, MainActivity.class);
        main.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        main.putExtra(MainActivity.EXTRA_CONSUME_PENDING_SHARE, true);
        startActivity(main);
        stopForeground(true);
        stopSelf();
    }

    private void notifyDone(String message, boolean ok) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            ensureChannel(nm);
            Intent open = new Intent(this, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent pi = PendingIntent.getActivity(
                    this,
                    0,
                    open,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setContentTitle(ok ? "Process" : "Process failed")
                    .setContentText(message)
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            nm.notify(NOTIFY_ID + 1, n);
        } catch (Exception ignored) {
            /* toast path may still run */
        }
    }

    private void startProcessingNotification() {
        ensureChannel((NotificationManager) getSystemService(NOTIFICATION_SERVICE));
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Process")
                .setContentText("Processing shared content…")
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFY_ID, n);
        }
    }

    private void ensureChannel(NotificationManager nm) {
        if (nm == null || Build.VERSION.SDK_INT < 26) return;
        NotificationChannel ch =
                new NotificationChannel(CHANNEL_ID, "Process", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Background share processing");
        nm.createNotificationChannel(ch);
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

    private static boolean resultOk(JSObject result) {
        if (result == null) return false;
        try {
            Object raw = result.get("ok");
            return Boolean.TRUE.equals(raw) || "true".equalsIgnoreCase(String.valueOf(raw));
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String readResultText(JSObject result) {
        if (result == null) return "";
        try {
            JSObject inner = result.getJSObject("result");
            if (inner != null) {
                String text = inner.getString("text", "");
                if (text != null && !text.trim().isEmpty()) return text.trim();
            }
            String top = result.getString("text", "");
            return top != null ? top.trim() : "";
        } catch (Exception ignored) {
            return "";
        }
    }
}
