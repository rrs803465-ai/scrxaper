package app.scrxaper.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/**
 * Keeps one server-sent-events connection open and, when a call arrives, rings like a phone: the person's own ringtone on the
 * ringer volume, vibration, a wake lock and a full-screen notification over the lock screen. The web app rings by itself while it
 * is on screen, so this service stays quiet then.
 */
public class CallService extends Service {
    static final String CH_SERVICE = "service", CH_CALLS = "calls", CH_MESSAGES = "messages";
    static final String A_DECLINE = "app.scrxaper.DECLINE", A_STOP_RING = "app.scrxaper.STOP_RING", A_REFRESH = "app.scrxaper.REFRESH";
    static final String ACTION_CALL_ENDED = "app.scrxaper.CALL_ENDED";
    static final int NOTE_SERVICE = 1, NOTE_CALL = 2, NOTE_MESSAGE_BASE = 100;
    private static final long RING_MS = 45000;

    static volatile boolean running = false;

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean alive = false;
    private volatile HttpURLConnection conn;
    private Thread worker;
    private volatile JSONObject me = new JSONObject();
    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wake;
    private int ringingId = 0;
    private final Runnable autoStop = this::stopRing;

    @Override public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        makeChannels();
        Notification n = new Notification.Builder(this, CH_SERVICE).setSmallIcon(R.drawable.ic_stat_call).setContentTitle("Scrxaper")
                .setContentText("Ready for calls").setOngoing(true).setShowWhen(false)
                .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE)).build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(NOTE_SERVICE, n);
        running = true;
        Util.prefs(this).edit().putBoolean("enabled", true).apply();

        String act = intent == null ? null : intent.getAction();
        if (A_DECLINE.equals(act)) {
            final int id = intent.getIntExtra("call", ringingId);
            new Thread(() -> {
                try { Util.postJson(this, "/api/call/decline", "{\"call\":" + id + "}"); } catch (Exception ignored) { /* server will time the call out */ }
            }).start();
            main.post(this::stopRing);
        } else if (A_STOP_RING.equals(act)) {
            main.post(this::stopRing);
        } else if (A_REFRESH.equals(act)) {
            new Thread(this::loadPrefs).start();
        }
        if (!alive) {
            alive = true;
            worker = new Thread(this::loop, "scrx-events");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        alive = false;
        running = false;
        try { if (conn != null) conn.disconnect(); } catch (Exception ignored) { /* closing */ }
        main.post(this::stopRing);
        super.onDestroy();
    }

    /* ------------------------------------------------------------------ connection */
    private void loop() {
        long backoff = 2000;
        while (alive) {
            try {
                if (Util.server(this).isEmpty() || Util.cookie(this).isEmpty()) { Thread.sleep(15000); continue; }
                loadPrefs();
                stream();
                backoff = 2000;
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                // network drop or timeout: try again
            }
            try { Thread.sleep(backoff); } catch (InterruptedException e) { return; }
            backoff = Math.min(backoff * 2, 30000);
        }
    }

    private void stream() throws Exception {
        HttpURLConnection h = Util.open(this, "/api/events", "GET", 75000);
        conn = h;
        try {
            int code = h.getResponseCode();
            if (code == 401 || code == 403) { Thread.sleep(60000); return; }
            if (code >= 300) throw new Exception("HTTP " + code);
            BufferedReader r = new BufferedReader(new InputStreamReader(h.getInputStream(), StandardCharsets.UTF_8));
            String event = "message", line;
            StringBuilder data = new StringBuilder();
            while (alive && (line = r.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) dispatch(event, data.toString());
                    event = "message";
                    data.setLength(0);
                } else if (line.startsWith("event:")) event = line.substring(6).trim();
                else if (line.startsWith("data:")) data.append(line.substring(5).trim());
            }
        } finally {
            h.disconnect();
        }
    }

    private void dispatch(String event, String data) {
        try {
            JSONObject d = new JSONObject(data);
            if (event.equals("call")) {
                String type = d.optString("type");
                if (type.equals("incoming")) main.post(() -> startRing(d));
                else if ((type.equals("ended") || type.equals("answered")) && d.optInt("id") == ringingId) main.post(this::stopRing);
            } else if (event.equals("message")) {
                showMessage(d);
            } else if (event.equals("banned")) {
                Util.prefs(this).edit().putBoolean("enabled", false).apply();
                stopSelf();
            }
        } catch (Exception ignored) { /* malformed event */ }
    }

    /** Fetch my sound settings and cache any custom ringtones so a call can ring instantly. */
    private void loadPrefs() {
        try {
            JSONObject j = new JSONObject(Util.getText(this, "/api/me"));
            me = j;
            JSONObject sound = j.optJSONObject("sound");
            if (sound == null) return;
            cacheTone(sound.optString("ringtone"));
            JSONArray ov = sound.optJSONArray("overrides");
            if (ov != null) for (int i = 0; i < ov.length(); i++) cacheTone(ov.getJSONObject(i).optString("tone"));
        } catch (Exception ignored) { /* offline: keep what we have */ }
    }

    private void cacheTone(String tone) {
        if (tone == null || !tone.startsWith("custom:")) return;
        String id = tone.substring(7).replaceAll("[^0-9]", "");
        if (id.isEmpty()) return;
        File f = new File(getCacheDir(), "ring-" + id);
        if (!f.exists() || f.length() == 0) Util.download(this, "/files/" + id, f);
    }

    /* ------------------------------------------------------------------ calls */
    private void startRing(JSONObject d) {
        if (MainActivity.visible) return;
        JSONObject privacy = me.optJSONObject("privacy");
        if (privacy != null && privacy.optBoolean("dnd")) return;
        int id = d.optInt("id");
        stopRing();
        ringingId = id;
        String name = d.optString("name", "Someone");
        boolean video = d.optBoolean("video");

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "scrxaper:ring");
        wake.acquire(RING_MS + 5000);

        Intent full = new Intent(this, IncomingCallActivity.class).putExtra("call", id).putExtra("name", name).putExtra("video", video)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent fullPi = PendingIntent.getActivity(this, id, full, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent answer = new Intent(this, MainActivity.class).putExtra("call", id).putExtra("act", "answer").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent answerPi = PendingIntent.getActivity(this, id + 1000, answer, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent decline = new Intent(this, CallService.class).setAction(A_DECLINE).putExtra("call", id);
        PendingIntent declinePi = PendingIntent.getService(this, id + 2000, decline, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification.Builder nb = new Notification.Builder(this, CH_CALLS).setSmallIcon(R.drawable.ic_stat_call)
                .setContentTitle(name + " is calling").setContentText(video ? "Incoming video call" : "Incoming voice call")
                .setCategory(Notification.CATEGORY_CALL).setOngoing(true).setAutoCancel(false).setTimeoutAfter(RING_MS)
                .setFullScreenIntent(fullPi, true).setContentIntent(fullPi)
                .addAction(new Notification.Action.Builder(0, "Decline", declinePi).build())
                .addAction(new Notification.Action.Builder(0, "Answer", answerPi).build());
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTE_CALL, nb.build());

        AudioManager am = (AudioManager) getSystemService(AUDIO_SERVICE);
        int mode = am.getRingerMode();
        if (mode == AudioManager.RINGER_MODE_NORMAL) playTone(toneFor(d.optString("from")));
        if (mode != AudioManager.RINGER_MODE_SILENT) vibrate();
        main.postDelayed(autoStop, RING_MS);
    }

    private String toneFor(String from) {
        JSONObject sound = me.optJSONObject("sound");
        if (sound == null) return "";
        JSONArray ov = sound.optJSONArray("overrides");
        if (ov != null) for (int i = 0; i < ov.length(); i++) {
            JSONObject o = ov.optJSONObject(i);
            if (o != null && "ring".equals(o.optString("kind")) && from.equals(o.optString("target"))) return o.optString("tone");
        }
        return sound.optString("ringtone");
    }

    private void playTone(String tone) {
        try {
            MediaPlayer p = new MediaPlayer();
            p.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build());
            File custom = null;
            if (tone != null && tone.startsWith("custom:")) {
                File f = new File(getCacheDir(), "ring-" + tone.substring(7).replaceAll("[^0-9]", ""));
                if (f.exists() && f.length() > 0) custom = f;
            }
            if (custom != null) p.setDataSource(custom.getAbsolutePath());
            else {
                // The built-in web tones are synthesised in the page, so the phone's own ringtone stands in for them here.
                Uri u = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                p.setDataSource(this, u);
            }
            p.setLooping(true);
            p.setOnPreparedListener(MediaPlayer::start);
            p.setOnErrorListener((mp, w, e) -> { try { mp.release(); } catch (Exception ignored) { /* done */ } return true; });
            p.prepareAsync();
            player = p;
        } catch (Exception e) {
            player = null;
        }
    }

    private void vibrate() {
        try {
            vibrator = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (vibrator != null && vibrator.hasVibrator()) vibrator.vibrate(VibrationEffect.createWaveform(new long[] {0, 700, 500, 700, 1200}, 0));
        } catch (Exception ignored) { /* no vibrator */ }
    }

    private void stopRing() {
        main.removeCallbacks(autoStop);
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) { /* not started */ }
            try { player.release(); } catch (Exception ignored) { /* released */ }
            player = null;
        }
        if (vibrator != null) { try { vibrator.cancel(); } catch (Exception ignored) { /* none */ } vibrator = null; }
        if (wake != null && wake.isHeld()) { try { wake.release(); } catch (Exception ignored) { /* released */ } }
        wake = null;
        if (ringingId != 0) {
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).cancel(NOTE_CALL);
            sendBroadcast(new Intent(ACTION_CALL_ENDED).setPackage(getPackageName()));
            ringingId = 0;
        }
    }

    /* ------------------------------------------------------------------ messages */
    private void showMessage(JSONObject d) {
        if (MainActivity.visible || d.has("to") || d.optString("kind").equals("call")) return;
        JSONObject privacy = me.optJSONObject("privacy");
        if (privacy != null && privacy.optBoolean("dnd")) return;
        String from = d.optString("from");
        if (from.isEmpty()) return;
        boolean preview = privacy == null || privacy.optBoolean("previews", true);
        String kind = d.optString("kind");
        String body = kind.equals("e2ee") ? "Encrypted message" : d.optString("body");
        if (body.isEmpty()) body = "Sent an attachment";
        if (!preview) body = "New message";
        PendingIntent open = PendingIntent.getActivity(this, 5, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CH_MESSAGES).setSmallIcon(R.drawable.ic_stat_call).setContentTitle(d.optString("name", from))
                .setContentText(body).setAutoCancel(true).setContentIntent(open).build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(NOTE_MESSAGE_BASE + Math.abs(from.hashCode() % 5000), n);
    }

    private void makeChannels() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.createNotificationChannel(new NotificationChannel(CH_SERVICE, "Background connection", NotificationManager.IMPORTANCE_MIN));
        NotificationChannel calls = new NotificationChannel(CH_CALLS, "Incoming calls", NotificationManager.IMPORTANCE_HIGH);
        calls.setSound(null, null); // the service plays the ringtone itself
        calls.enableVibration(false);
        calls.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(calls);
        nm.createNotificationChannel(new NotificationChannel(CH_MESSAGES, "Messages", NotificationManager.IMPORTANCE_DEFAULT));
    }
}
