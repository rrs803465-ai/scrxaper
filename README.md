# Scrxaper

Messaging, friends, communities, voice and video calls, feed, reels and stories in one zero-dependency Node 22 app (`node:http`, `node:sqlite`, SSE, vanilla JS). No build step, no npm packages.

```
npm start            # http://localhost:3000   (visitors see the landing page; the app lives at /app)
npm test             # server tests
```

Copy `.env.example` for configuration. Set `OWNER_USERNAME` and `OWNER_PASSWORD` to create the owner account, and `AI_KEY_SECRET` (32+ chars) to let people store a Groq key for Buddy.

## What is in it

| Area | Notes |
| --- | --- |
| Accounts, onboarding | Sign up, then a short wizard asks who you are (name, interests, status, bio). Nothing is pre-selected for you. |
| Friends | Discord-style: send, accept, ignore, cancel. Friends can send each other Sparks. |
| Messages | DMs, groups, community text channels; any file type up to 25 MB; polls; shared posts; per-chat tones and mutes. |
| Who can DM me | Studio, Privacy: everyone, friends, shared groups or nobody. |
| Communities | A separate server bar (not a popup), drag to reorder communities and channels, text and voice channels, roles, moderation log, invites, discover. |
| Premade bots | No tokens. Pick Sentinel (security), Jukebox (upload your own music), Greeter or Funbot when creating a group or community, or later under Bots. |
| Feed, reels, stories | Photo editor, video trim/filters/speed, music on posts, stories and reels, likes, comments, hashtags, explore, share into chats. |
| Private accounts | People ask to follow; only followers see posts and stories. |
| Notifications | Likes, comments, follows, follow requests, friend requests, Sparks. |
| Calls | 1:1 voice and video; group calls and voice channels (mesh, up to 8 people); screen share. The caller hears a calling tune, the callee hears their ringtone. |
| Ringtones | Upload songs up to 10 MB of any length; set a default and a different ringtone per person. |
| Call screen | Callee-only visual while ringing: spectrum ring, spinning disc and four more, with your colour. The caller never sees it. |
| Customisation | Theme, accent, bubble style and colour, roundness, wallpaper (your own image), text size, glass blur, density, motion, contrast. |
| Site roles | Owner badge. The owner can make admins (full site power) and staff (minimal). Owner and admins can give Sparks. |
| Bans | A suspended person gets a popup with the reason; login shows it too. |
| Secret chats | Opt-in end-to-end encrypted text (ECDH P-256 + AES-GCM). |
| Installable | Web app manifest and service worker. Landing page and Studio link to the Android app (`/download/android`, set `APK_URL`) and the Windows app (`/download/windows`, set `EXE_URL`). |
| Continue with Google | Sign up and log in with Google through Supabase (`SUPABASE_URL`, `SUPABASE_ANON_KEY`). New Google accounts pick their own username in onboarding. |
| Setup wizard | First run with no owner: a 4-step wizard asks for the setup code printed in the server log, creates the owner and names the site. |
| Video | Posts and reels up to 3 minutes (trim, speed, filters, music). Edited clips are re-encoded up to 1080p. |
| Animated wallpaper | Studio, Look: use an MP4 or WebM (up to 40 MB) as a looping wallpaper behind the whole app. |
| Server tags | Admins give a community a tag: a small symbol and up to four letters in a colour. Members can wear it next to their name in chats and on their profile. |
| Delete messages | Delete your own DMs and group messages (group admins can delete any); community channels already had delete. Everyone in the chat sees it vanish. |
| Image download | Download button on chat images, in the image viewer and on every post. |
| Reactions, replies, edits | React with 12 emoji, reply with a quoted message you can jump back to, and edit your own text messages (shown as "edited"). Works in DMs, groups and community channels, live for everyone. |
| Saved messages | Star any message to keep a copy in Studio, Saved messages, even if the original is deleted. Up to 500. |
| Your data | Studio, Account, Download my data: one JSON file with your account, messages, posts and saved messages. Google accounts can delete themselves by typing their username. |
| Bots | Eight premade bots: Sentinel, Jukebox, Greeter, Funbot, plus Levels (XP and leaderboard), Toolkit (calculator, reminders, timers), Arcade (guess, hangman, scramble, tic-tac-toe) and Quotebook. |

## Calls when the screen is off

Two ways, depending on how the app is installed:

- **Android app (recommended):** download it from the landing page (set `APK_URL`, see below); `android/` is a native shell built by GitHub Actions (`.github/workflows/android.yml`, instructions in `android/README.md`). A background service rings your own ringtone on the ringer volume, vibrates and lights the lock screen with Answer and Decline, with the app closed.
- **Installed web app (PWA):** Web Push shows a persistent "calling" notification that the server repeats every 4 seconds while it rings, so the phone keeps playing its notification sound and vibrating. Browsers cannot play your own audio from a closed web app, so this uses the phone's notification sound.

### Offering the APK on the website

The workflow publishes `scrxaper.apk` to a GitHub Release (tag `android-latest` for manual runs, the tag name for `v*` pushes). The repo must be public for visitors to download it. Set on the server:

```
APK_URL=https://github.com/<owner>/<repo>/releases/download/android-latest/scrxaper.apk
```

`/download/android` then redirects there; without `APK_URL` it answers 404 and the buttons just show that message.

### Windows app

`native/electron/` is a desktop app (installer and portable `.exe`) built by `.github/workflows/windows.yml`: Actions tab, Windows app, Run workflow, optionally with your site address. It keeps running in the tray so calls and messages arrive with the window closed, supports microphone, camera and screen share, and can start with Windows. The build is unsigned, so Windows SmartScreen shows "More info, Run anyway" the first time. Publish the link with `EXE_URL=https://github.com/<owner>/<repo>/releases/download/windows-latest/Scrxaper-Setup.exe`.

### Continue with Google (Supabase)

1. Create a Supabase project. Authentication, Providers: turn on Google (it needs a Google Cloud OAuth client; Supabase shows the callback URL to paste there).
2. Authentication, URL Configuration: add `https://your-site/app` to Redirect URLs.
3. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the server environment (the anon key is the public one) and restart. The button appears on the sign-in page.

The server checks every token with Supabase before it creates a session, and Google accounts have no password.

## Verification status

- Server: 14 test files (the newest, `test/v3.test.js`, covers Google, setup, tags, bots, reactions, replies, edits, saved messages and export), all passing (`node --test test/<file>`), including a real encrypted Web Push delivery and the ring-pulse behaviour.
- Client: exercised in headless Chromium against the real server: sign-up and onboarding, chat, communities with premade bots and Jukebox upload, feed, posts, likes, comments, hashtags, explore, stories with music, reels, share-to-chat, friend requests, notifications, every Studio section, ban popup, owner panel, landing page, a real two-browser WebRTC call with the callee-only visual and the bottom call-ended pill, a three-person voice channel. Desktop 1280x800 and mobile 390x844, no console errors, no horizontal overflow.
- Service worker: registration checked in Chromium; the push handler's notification options were checked against a mock, not a real push service.

## Not verified, and honest limits

- No real phone, no real push service (FCM/APNs/Mozilla) and no locked-screen test were run.
- Group calls are a mesh: they work up to 8 people; more needs an SFU.
- Calls behind strict NATs need a TURN server (`TURN_URL`).
- Secret chats: keys are static per browser (no forward secrecy), text only; files and metadata are not hidden.
- The video editor re-encodes in the browser with MediaRecorder; browsers without it keep the original file.
- The Android app (`android/`) compiles on GitHub Actions but has not been run on a real phone. The Windows app (`native/electron/`) has not been built or run: its code is syntax-checked only, and the first real build happens in Actions.
- Google sign-in is tested against a stand-in Supabase server, not a live Supabase project.
- Buddy needs each person's own Groq key.

## Music search and ringtones

Search for a song (Studio, Sounds, Search for a song; also in the music picker for posts, stories and reels, and under Ringtone for this person), drag the waveform to pick the part you like, and save it as one of your sounds. Importing a file from your device still works and opens the same trimmer.

Sources are free and need no key: iTunes Search (30 second previews) and Audius (full tracks). The server proxies both, so nothing extra is needed in the browser. Clips are cut in the browser and stored as small mono WAV files, kept for the owner's personal use (ringtones, posts). Optional overrides: `MUSIC_ITUNES_URL`, `MUSIC_AUDIUS_URL`.

## Profile effects

Frames, name colours and badges from the shop now render on the profile, and name colours also show on chat messages in groups and channels.
