package app.scrxaper.mobile;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Full-screen "incoming call" shown over the lock screen. The sound is played by CallService. */
public class IncomingCallActivity extends Activity {
    private final BroadcastReceiver ended = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { finish(); }
    };
    private int callId;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true); }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_ALLOW_LOCK_WHILE_SCREEN_ON);
        callId = getIntent().getIntExtra("call", 0);
        String name = getIntent().getStringExtra("name");
        boolean video = getIntent().getBooleanExtra("video", false);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#0b0d10"));
        int pad = dp(28);
        root.setPadding(pad, dp(96), pad, dp(72));

        TextView who = text(name == null ? "Someone" : name, 32, Color.WHITE);
        TextView sub = text(video ? "Incoming video call" : "Incoming voice call", 16, Color.parseColor("#9aa7b8"));
        View spacer = new View(this);
        LinearLayout.LayoutParams grow = new LinearLayout.LayoutParams(0, 0, 1f);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.addView(button("Decline", "#e5605f", v -> decline()), btnParams());
        row.addView(button("Answer", "#3ec38a", v -> answer()), btnParams());

        root.addView(who);
        root.addView(sub);
        root.addView(spacer, grow);
        root.addView(row);
        setContentView(root);

        IntentFilter f = new IntentFilter(CallService.ACTION_CALL_ENDED);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(ended, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(ended, f);
    }

    private void answer() {
        Intent i = new Intent(this, MainActivity.class).putExtra("call", callId).putExtra("act", "answer")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        KeyguardManager km = (KeyguardManager) getSystemService(KEYGUARD_SERVICE);
        if (km != null && Build.VERSION.SDK_INT >= 26) km.requestDismissKeyguard(this, null);
        startActivity(i);
        finish();
    }

    private void decline() {
        startService(new Intent(this, CallService.class).setAction(CallService.A_DECLINE).putExtra("call", callId));
        finish();
    }

    private TextView text(String s, int sp, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(sp);
        t.setTextColor(color);
        t.setGravity(Gravity.CENTER);
        t.setPadding(0, dp(6), 0, dp(6));
        return t;
    }

    private TextView button(String label, String color, View.OnClickListener l) {
        TextView t = new TextView(this);
        t.setText(label);
        t.setTextColor(Color.WHITE);
        t.setTextSize(18);
        t.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(color));
        bg.setCornerRadius(dp(22));
        t.setBackground(bg);
        t.setOnClickListener(l);
        t.setContentDescription(label + " call");
        return t;
    }

    private LinearLayout.LayoutParams btnParams() {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(0, dp(64), 1f);
        p.setMargins(dp(8), 0, dp(8), 0);
        return p;
    }

    private int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(ended); } catch (Exception ignored) { /* already gone */ }
        super.onDestroy();
    }
}
