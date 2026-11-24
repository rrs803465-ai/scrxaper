# Scrxaper for Android

A native Android shell around your Scrxaper site. It adds what a web app cannot do: **a call rings with your own ringtone, vibrates and lights the lock screen even when the app is closed and the screen is off.**

## How it works

- The app opens your site in a WebView (camera, microphone and file attachments work).
- After you sign in, a foreground service keeps one small connection to `/api/events`. When a call arrives and the app is not on screen, the service plays your ringtone on the ringer volume (your uploaded song, or the per-person ringtone you set), vibrates, holds a wake lock and shows a full-screen "Incoming call" screen over the lock screen with Answer and Decline.
- Answer opens the app and joins the call. Decline hangs up without opening the app.
- Messages show as normal notifications while the app is closed.
- Silent mode is respected (silent: nothing, vibrate: vibration only). Do not disturb in Studio, Privacy silences it.
- The built-in synthesised ringtones live in the web page, so with the app closed they are replaced by the phone's own ringtone. Uploaded ringtones play as they are.

## Build the APK with GitHub Actions

1. Push this project to a GitHub repository (the folder that contains `.github/` and `android/`).
2. Repository, Actions, **Android app**, **Run workflow**, enter your server address (`https://...`, https is required).
3. When it finishes, download `scrxaper-apk` from the run page, unzip, copy `scrxaper.apk` to the phone and install it (allow installs from your file manager or browser).

To publish a release instead, push a tag: `git tag v1.0.0 && git push --tags`. The APK is attached to the release.

### Updating the app in place (recommended)

Without signing secrets the workflow builds a *debug* APK. Debug keys change on every run, so Android will refuse to update over an older install and you must uninstall first. To avoid that, create a key once and store it as repository secrets:

```
keytool -genkeypair -v -keystore scrxaper.jks -alias scrxaper -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 scrxaper.jks      # paste into the KEYSTORE_BASE64 secret
```

Secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`. Keep the `.jks` file and its passwords safe; if you lose them you cannot update the app.

## First run on the phone

1. Open Scrxaper and sign in.
2. Studio, **Alerts and app**: tap *Allow notifications and lock screen*, then *Allow background use* (battery). All four rows should say On.
3. On Xiaomi, Oppo, Vivo, Realme, Huawei and some Samsung phones also set Scrxaper to *Autostart* and *No restrictions* in the system battery or app settings. Without it the phone may stop the service and calls will not ring.
4. Set a ringtone in Studio, Sounds. Ask a friend to call while the screen is off.

## Honest status

- **Nothing here has been compiled or run on a phone.** The code was written without an Android SDK; the first GitHub Actions run is its first real build. If the build reports an error, send me the log and I will fix it.
- The service holds a connection open, so you appear online while it runs, and it uses a little battery. Signing out stops it.
- Calls only ring while the phone has internet and the OS has not killed the service (see step 3). There is no Google push fallback in this version; adding Firebase push would wake the service after a hard kill, but needs a Firebase project.
- iOS is not covered: Apple does not allow this kind of background service without CallKit and PushKit and an Apple developer account.
