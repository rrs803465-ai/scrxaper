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
| Installable | Web app manifest and service worker. |

## Calls when the screen is off

Two ways, depending on how the app is installed:

- **Android app (recommended):** `android/` is a native shell built by GitHub Actions (`.github/workflows/android.yml`, instructions in `android/README.md`). A background service rings your own ringtone on the ringer volume, vibrates and lights the lock screen with Answer and Decline, with the app closed.
- **Installed web app (PWA):** Web Push shows a persistent "calling" notification that the server repeats every 4 seconds while it rings, so the phone keeps playing its notification sound and vibrating. Browsers cannot play your own audio from a closed web app, so this uses the phone's notification sound.

## Verification status

- Server: 13 test files, all passing (`node --test test/<file>`), including a real encrypted Web Push delivery and the ring-pulse behaviour.
- Client: exercised in headless Chromium against the real server: sign-up and onboarding, chat, communities with premade bots and Jukebox upload, feed, posts, likes, comments, hashtags, explore, stories with music, reels, share-to-chat, friend requests, notifications, every Studio section, ban popup, owner panel, landing page, a real two-browser WebRTC call with the callee-only visual and the bottom call-ended pill, a three-person voice channel. Desktop 1280x800 and mobile 390x844, no console errors, no horizontal overflow.
- Service worker: registration checked in Chromium; the push handler's notification options were checked against a mock, not a real push service.

## Not verified, and honest limits

- No real phone, no real push service (FCM/APNs/Mozilla) and no locked-screen test were run.
- Group calls are a mesh: they work up to 8 people; more needs an SFU.
- Calls behind strict NATs need a TURN server (`TURN_URL`).
- Secret chats: keys are static per browser (no forward secrecy), text only; files and metadata are not hidden.
- The video editor re-encodes in the browser with MediaRecorder; browsers without it keep the original file.
- The Android app (`android/`) and the Electron scaffold (`native/`) have not been compiled or run. See `android/README.md`.
- Buddy needs each person's own Groq key.
