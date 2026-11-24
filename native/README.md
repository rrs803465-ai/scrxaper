# Desktop app (scaffold, not built)

The Android app lives in `../android` and is built by `.github/workflows/android.yml`.

`electron/` is a minimal desktop window around the hosted site. It has not been compiled or run. Set `SCRXAPER_URL`, then `npm i electron && npx electron .` inside this folder.
