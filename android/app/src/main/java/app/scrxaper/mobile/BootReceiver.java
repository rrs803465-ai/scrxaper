package app.scrxaper.mobile;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restarts the call service after the phone boots or the app is updated, if the person is signed in. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        if (!Util.prefs(ctx).getBoolean("enabled", false)) return;
        try {
            ctx.startForegroundService(new Intent(ctx, CallService.class));
        } catch (Exception ignored) { /* the system refused a background start; the next app launch restarts it */ }
    }
}
