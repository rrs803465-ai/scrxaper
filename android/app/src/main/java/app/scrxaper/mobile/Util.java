package app.scrxaper.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.CookieManager;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class Util {
    private Util() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("scrx", Context.MODE_PRIVATE);
    }

    static String server(Context c) {
        String s = prefs(c).getString("server", "");
        if (s == null || s.isEmpty()) s = BuildConfig.SERVER_URL;
        return s == null ? "" : s;
    }

    /** Accepts "example.com" or "https://example.com/" and returns "https://example.com". */
    static String normalize(String in) {
        String s = in == null ? "" : in.trim();
        if (s.isEmpty()) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        if (s.endsWith("/app")) s = s.substring(0, s.length() - 4);
        return s;
    }

    /** The session cookie the website set. The WebView owns it; a copy is kept so the service can use it when the app is closed. */
    static String cookie(Context c) {
        String server = server(c);
        String fresh = null;
        try {
            fresh = CookieManager.getInstance().getCookie(server);
        } catch (Throwable ignored) { /* WebView unavailable in this process state */ }
        if (fresh != null && !fresh.isEmpty()) {
            prefs(c).edit().putString("cookie", fresh).apply();
            return fresh;
        }
        return prefs(c).getString("cookie", "");
    }

    static HttpURLConnection open(Context c, String path, String method, int readTimeoutMs) throws Exception {
        HttpURLConnection h = (HttpURLConnection) new URL(server(c) + path).openConnection();
        h.setRequestMethod(method);
        h.setConnectTimeout(15000);
        h.setReadTimeout(readTimeoutMs);
        h.setRequestProperty("Cookie", cookie(c));
        h.setRequestProperty("X-Requested-With", "scrxaper");
        h.setRequestProperty("User-Agent", "ScrxaperAndroid/1");
        return h;
    }

    static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    static String getText(Context c, String path) throws Exception {
        HttpURLConnection h = open(c, path, "GET", 20000);
        try {
            if (h.getResponseCode() >= 300) throw new Exception("HTTP " + h.getResponseCode());
            return readAll(h.getInputStream());
        } finally {
            h.disconnect();
        }
    }

    static int postJson(Context c, String path, String json) throws Exception {
        HttpURLConnection h = open(c, path, "POST", 20000);
        try {
            h.setDoOutput(true);
            h.setRequestProperty("Content-Type", "application/json");
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            try (OutputStream o = h.getOutputStream()) { o.write(body); }
            int code = h.getResponseCode();
            try { readAll(code < 400 ? h.getInputStream() : h.getErrorStream()); } catch (Exception ignored) { /* body not needed */ }
            return code;
        } finally {
            h.disconnect();
        }
    }

    static boolean download(Context c, String path, File dest) {
        HttpURLConnection h = null;
        try {
            h = open(c, path, "GET", 60000);
            if (h.getResponseCode() >= 300) return false;
            File tmp = new File(dest.getPath() + ".part");
            try (InputStream in = h.getInputStream(); FileOutputStream out = new FileOutputStream(tmp)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
            return tmp.renameTo(dest);
        } catch (Exception e) {
            return false;
        } finally {
            if (h != null) h.disconnect();
        }
    }
}
