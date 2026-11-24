package app.scrxaper.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** Hosts the Scrxaper web app in a WebView and exposes a small bridge so the page can start the background call service. */
public class MainActivity extends Activity {
    static volatile boolean visible = false;
    private static final int REQ_PERMS = 11, REQ_FILE = 12, REQ_WEB = 13;

    private WebView web;
    private boolean loaded = false;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest webRequest;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Util.server(this).isEmpty()) askServer(); else boot();
    }

    private void askServer() {
        final EditText input = new EditText(this);
        input.setHint("https://your-scrxaper.example.com");
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        FrameLayout box = new FrameLayout(this);
        int m = Math.round(20 * getResources().getDisplayMetrics().density);
        box.setPadding(m, m / 2, m, 0);
        box.addView(input);
        new AlertDialog.Builder(this).setTitle("Your Scrxaper address").setMessage("Enter the address of your Scrxaper server.")
                .setView(box).setCancelable(false)
                .setPositiveButton("Continue", (d, w) -> {
                    String s = Util.normalize(input.getText().toString());
                    if (s.isEmpty()) { askServer(); return; }
                    Util.prefs(this).edit().putString("server", s).apply();
                    boot();
                }).show();
    }

    private void boot() {
        web = new WebView(this);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " ScrxaperAndroid/1");
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, false);
        web.addJavascriptInterface(new Bridge(), "ScrxNative");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if ("scrx".equals(u.getScheme())) { askServer(); return true; }
                String server = Util.server(MainActivity.this);
                if (u.toString().startsWith(server)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { /* no browser */ }
                return true;
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) {
                    String html = "<body style='background:#0b0d10;color:#e8edf5;font-family:sans-serif;text-align:center;padding:12vh 24px'>"
                            + "<h2>Can't reach Scrxaper</h2><p>Check your connection, then try again.</p>"
                            + "<p><a style='color:#b7c9e6;font-size:1.2em' href='" + Util.server(MainActivity.this) + "/app'>Try again</a></p>"
                            + "<p style='opacity:.6'><a style='color:#b7c9e6' href='scrx://server'>Change server address</a></p></body>";
                    v.loadDataWithBaseURL(Util.server(MainActivity.this), html, "text/html", "utf-8", null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    List<String> need = new ArrayList<>();
                    for (String r : request.getResources()) {
                        if (r.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) need.add(Manifest.permission.RECORD_AUDIO);
                        if (r.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) need.add(Manifest.permission.CAMERA);
                    }
                    List<String> missing = new ArrayList<>();
                    for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
                    if (missing.isEmpty()) { request.grant(request.getResources()); return; }
                    webRequest = request;
                    requestPermissions(missing.toArray(new String[0]), REQ_WEB);
                });
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                try { startActivityForResult(params.createIntent(), REQ_FILE); }
                catch (Exception e) { fileCallback = null; return false; }
                return true;
            }
        });
        handleIntent(getIntent(), true);
    }

    private void handleIntent(Intent i, boolean first) {
        int call = i == null ? 0 : i.getIntExtra("call", 0);
        String act = i == null ? null : i.getStringExtra("act");
        if (call != 0 && "answer".equals(act)) {
            if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            startService(new Intent(this, CallService.class).setAction(CallService.A_STOP_RING));
        }
        if (web == null) return;
        if (!loaded || first) {
            loaded = true;
            String url = Util.server(this) + "/app" + (call != 0 ? "?call=" + call + "&act=" + (act == null ? "answer" : act) : "");
            web.loadUrl(url);
        } else if (call != 0) {
            web.evaluateJavascript("window.scrxCallIntent&&window.scrxCallIntent(" + call + ",'" + (act == null ? "answer" : act.replaceAll("[^a-z]", "")) + "')", null);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent, false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        visible = true;
        // The page shows its own call screen once the app is on screen, so the service stops ringing.
        if (CallService.running) startService(new Intent(this, CallService.class).setAction(CallService.A_STOP_RING));
    }

    @Override
    protected void onPause() {
        visible = false; // the WebView is not paused on purpose, so a call in progress keeps its audio in the background
        try { CookieManager.getInstance().flush(); } catch (Throwable ignored) { /* nothing to flush */ }
        Util.cookie(this); // keep a copy for the background service
        super.onPause();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else moveTaskToBack(true);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && fileCallback != null) {
            Uri[] out = null;
            if (res == RESULT_OK && data != null) out = WebChromeClient.FileChooserParams.parseResult(res, data);
            fileCallback.onReceiveValue(out);
            fileCallback = null;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == REQ_WEB && webRequest != null) {
            boolean ok = results.length > 0;
            for (int r : results) if (r != PackageManager.PERMISSION_GRANTED) ok = false;
            if (ok) webRequest.grant(webRequest.getResources()); else webRequest.deny();
            webRequest = null;
        }
        super.onRequestPermissionsResult(req, perms, results);
    }

    /** Methods the page can call as window.ScrxNative.*  (only our own site is ever loaded in this WebView). */
    private class Bridge {
        @JavascriptInterface public void start() {
            runOnUiThread(() -> {
                Util.cookie(MainActivity.this);
                Util.prefs(MainActivity.this).edit().putBoolean("enabled", true).apply();
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                        && !Util.prefs(MainActivity.this).getBoolean("askedNotif", false)) {
                    Util.prefs(MainActivity.this).edit().putBoolean("askedNotif", true).apply();
                    MainActivity.this.requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_PERMS);
                }
                try { startForegroundService(new Intent(MainActivity.this, CallService.class)); } catch (Exception ignored) { /* retried on next launch */ }
            });
        }

        @JavascriptInterface public void stop() {
            runOnUiThread(() -> {
                Util.prefs(MainActivity.this).edit().putBoolean("enabled", false).remove("cookie").apply();
                stopService(new Intent(MainActivity.this, CallService.class));
            });
        }

        @JavascriptInterface public void refresh() {
            runOnUiThread(() -> { if (CallService.running) startService(new Intent(MainActivity.this, CallService.class).setAction(CallService.A_REFRESH)); });
        }

        @JavascriptInterface public String status() {
            try {
                JSONObject j = new JSONObject();
                boolean notif = Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                boolean full = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent();
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                j.put("notifications", notif && nm.areNotificationsEnabled());
                j.put("fullScreen", full);
                j.put("battery", pm.isIgnoringBatteryOptimizations(getPackageName()));
                j.put("running", CallService.running);
                return j.toString();
            } catch (Exception e) {
                return "{}";
            }
        }

        @JavascriptInterface public void requestPermissions() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    MainActivity.this.requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, REQ_PERMS);
                    return;
                }
                if (Build.VERSION.SDK_INT >= 34) {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (!nm.canUseFullScreenIntent()) {
                        try { startActivity(new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getPackageName()))); return; } catch (Exception ignored) { /* fall through */ }
                    }
                }
                try { startActivity(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName())); } catch (Exception ignored) { /* none */ }
            });
        }

        @JavascriptInterface public void requestBattery() {
            runOnUiThread(() -> {
                try { startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()))); }
                catch (Exception e) { try { startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)); } catch (Exception ignored) { /* none */ } }
            });
        }
    }
}
