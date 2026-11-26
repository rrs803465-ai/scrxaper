# Desktop app

The Windows app (installer and portable .exe) is `native/electron/`, built by `.github/workflows/windows.yml`. It has not been built or run yet.

Build it: GitHub, Actions, **Windows app (.exe)**, Run workflow, optionally type your site address. When it finishes, the files are on the release named `windows-latest` and in the run's artifacts.

Run it locally: inside `native/electron`, `npm install`, set `SCRXAPER_URL=https://your-site`, `npm start`.

The Android app lives in `../android` and is built by `.github/workflows/android.yml`.
