// Studio (settings), onboarding, site panel, ban notice, premade bots, buddy, shop.
import { $, state, bus, actions, h, clear, icon, sq, avatarEl, roleTag, api, upload, toast, fail, safe, ask, openSheet, closeSheets, section, hint, row, empty, field, form, toggle, select, segmented, chip, pickFile, audioLength, fmtBytes, fileUrl, playSound, BUILTIN_TONES, CALLING_TUNES, applyPrefs, confetti, debounce, ago } from './core.js';

/* ------------------------------------------------------------------ Android app bridge (present only inside the native app) */
const native = () => (typeof window !== 'undefined' && window.ScrxNative ? window.ScrxNative : null);
const nativeStatus = () => { try { return JSON.parse(native().status()); } catch { return {}; } };

/* ------------------------------------------------------------------ helpers */
const savePrefs = async (patch) => {
  const p = state.prefs;
  const body = { theme: p.theme, accent: p.accent, density: p.density, reduceMotion: p.reduceMotion, plain: p.plain, custom: p.custom, vizStyle: p.vizStyle, vizColor: p.vizColor, ...patch };
  const next = await api('/api/prefs', { body }); state.prefs = next; state.me.prefs = next; applyPrefs(next); return next;
};
const saveCustom = (patch) => savePrefs({ custom: { ...(state.prefs.custom ?? {}), ...patch } });
const saveSound = async (patch) => { const s = state.sound; state.sound = await api('/api/sound', { body: { tone: s.tone, ringtone: s.ringtone, callingTune: s.callingTune, volume: s.volume, ...patch } }); native()?.refresh?.(); return state.sound; };
const colorInput = (value, onchange, label) => { const i = h('input', { type: 'color', value: value || '#b7c9e6', 'aria-label': label, class: 'colorpick' }); i.addEventListener('change', () => onchange(i.value)); return i; };
const rawPost = (path, file, host) => new Promise((resolve, reject) => {
  const bar = h('i', {}); const wrap = h('div', { class: 'bar-big' }, bar); host.append(wrap); const x = new XMLHttpRequest();
  x.open('POST', path); x.setRequestHeader('X-Requested-With', 'scrxaper'); x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  x.upload.onprogress = (e) => e.lengthComputable && (bar.style.width = `${Math.round((e.loaded / e.total) * 100)}%`);
  x.onload = () => { wrap.remove(); let d = {}; try { d = JSON.parse(x.responseText); } catch { /* empty */ } x.status < 300 ? resolve(d) : reject(new Error(d.error || 'Upload failed')); };
  x.onerror = () => { wrap.remove(); reject(new Error('Upload failed. Check your connection.')); }; x.send(file);
});
const uploadWithBar = async (query, file, host) => { const bar = h('i', {}); const wrap = h('div', { class: 'bar-big' }, bar); host.append(wrap); try { return await upload(query, file, (x) => { bar.style.width = `${Math.round(x * 100)}%`; }); } finally { wrap.remove(); } };

/* ------------------------------------------------------------------ Studio */
const TILES = [['profile', 'user', 'Profile'], ['look', 'palette', 'Appearance'], ['sounds', 'music', 'Sounds'], ['calls', 'disc', 'Call screen'], ['privacy', 'lock', 'Privacy'], ['alerts', 'bell', 'Alerts and app'], ['sparks', 'sparkle', 'Sparks and shop'], ['buddy', 'smile', 'Buddy'], ['account', 'key', 'Account']];
let studioSheet = null;
export function openStudio(sec) {
  const body = h('div', { class: 'stack' });
  studioSheet = openSheet('Studio', body, { key: 'studio', wide: true, onClose: () => { studioSheet = null; } });
  const go = (id) => {
    if (!id) { studioSheet.title('Studio'); return clear(body, h('div', { class: 'tiles studio-tiles' }, ...TILES.map(([k, ic, l], i) => h('button', { type: 'button', class: 'tile', style: { '--i': i }, onclick: () => go(k) }, h('span', { class: 'sqicon' }, icon(ic, 26)), l))), ...(state.me.perms?.length ? [h('button', { class: 'item', type: 'button', onclick: () => { closeSheets(); openOwner(); } }, icon('shield', 18), h('span', { class: 't' }, 'Site panel'))] : [])); }
    const [, , label] = TILES.find((t) => t[0] === id);
    if (id === 'buddy') { closeSheets(); return openBuddy(); }
    studioSheet.title(label);
    const back = h('button', { type: 'button', class: 'ghost mini back', onclick: () => go(null) }, icon('back', 16), 'Studio');
    const view = h('div', { class: 'stack' }); clear(body, back, view);
    SECTIONS[id](view, go);
  };
  go(sec && SECTIONS[sec] ? sec : null);
}

const SECTIONS = {
  /* ---------------- profile */
  async profile(view) {
    const p = await api(`/api/profile?user=${state.user}`);
    const av = h('div', { class: 'avatar-edit' }); const paintAv = () => clear(av, avatarEl(p.avatar, state.me.displayName, 84));
    paintAv();
    const picker = (kind) => pickFile('image/png,image/jpeg,image/webp,image/gif', async (f) => { try { const raw = kind === 'avatar' ? await actions.editImage(f, { aspect: '1:1' }) : await actions.editImage(f, { aspect: '3:1' }); if (!raw) return; const d = await uploadWithBar(`kind=${kind}`, raw, view); p[kind] = d.id; if (kind === 'avatar') { state.me.avatar = d.id; paintAv(); actions.refreshLists?.(); } toast('Updated', { kind: 'ok' }); } catch (e) { fail(e); } });
    const bd = state.me.birthday ? state.me.birthday.split('-') : ['', ''];
    clear(view, h('div', { class: 'inline' }, av, h('div', { class: 'stack grow' }, h('button', { class: 'ghost', type: 'button', onclick: () => picker('avatar') }, icon('image', 16), 'Change picture'), h('button', { class: 'ghost', type: 'button', onclick: () => picker('banner') }, icon('image', 16), 'Change banner'), p.avatar ? h('button', { class: 'ghost', type: 'button', onclick: safe(async () => { await api('/api/upload/delete', { body: { kind: 'avatar' } }); p.avatar = null; state.me.avatar = null; paintAv(); actions.refreshLists?.(); }) }, 'Remove picture') : null)),
      form(async (v) => { await api('/api/profile', { body: { displayName: v.displayName, status: v.status, bio: v.bio, interests: v.interests.split(',') } }); state.me.displayName = v.displayName.trim() || state.me.displayName; actions.refreshLists?.(); toast('Profile saved', { kind: 'ok' }); },
        h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Display name', field('displayName', 'Display name', { value: p.displayName, maxLength: 40 })), h('label', { class: 'field' }, 'Status', field('status', 'What are you up to?', { value: p.status ?? '', maxLength: 60 })),
          h('label', { class: 'field' }, 'Bio', h('textarea', { name: 'bio', maxLength: 200, rows: 3, 'aria-label': 'Bio' }, p.bio ?? '')), h('label', { class: 'field' }, 'Interests (comma separated)', field('interests', 'music, gaming, art', { value: (p.interests ?? []).join(', ') })), h('button', { class: 'primary', type: 'submit' }, 'Save profile'))),
      section('Birthday', hint('Optional. Shows a small celebration on the day.'), form(async (v) => { await api('/api/birthday', { body: { month: Number(v.month), day: Number(v.day) } }); state.me.birthday = `${String(v.month).padStart(2, '0')}-${String(v.day).padStart(2, '0')}`; toast('Saved', { kind: 'ok' }); }, h('div', { class: 'inline' }, field('month', 'Month (1-12)', { type: 'number', min: 1, max: 12, value: bd[0] ? Number(bd[0]) : '' }), field('day', 'Day', { type: 'number', min: 1, max: 31, value: bd[1] ? Number(bd[1]) : '' }), h('button', { class: 'ghost', type: 'submit' }, 'Save')))),
      h('button', { class: 'ghost', type: 'button', onclick: () => { closeSheets(); actions.openProfile(state.user); } }, icon('eye', 16), 'View my profile'));
  },

  /* ---------------- appearance */
  look(view) {
    const p = state.prefs; const c = p.custom ?? {};
    const slider = (label, key, min, max, step, val, fmt = (x) => x) => { const out = h('small', {}, fmt(val)); const i = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }); i.addEventListener('input', () => { out.textContent = fmt(i.value); document.documentElement.style.setProperty(key === 'radius' ? '--bubble-r' : key === 'fontScale' ? '--font-scale' : '--blur', key === 'fontScale' ? i.value : `${i.value}px`); }); i.addEventListener('change', safe(() => saveCustom({ [key]: Number(i.value) }))); return h('label', { class: 'field' }, h('span', {}, label, ' ', out), i); };
    const wall = h('div', { class: 'swatches' }, ...['default', 'aurora', 'dusk', 'forest', 'mono', 'plain'].map((w) => h('button', { type: 'button', class: `swatch wall-${w}${(c.wallpaper ?? 'default') === w && !c.wallpaperId ? ' on' : ''}`, 'aria-label': w, title: w, onclick: async (e) => { await saveCustom({ wallpaper: w, wallpaperId: undefined }); wall.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); } })));
    clear(view,
      section('Theme', segmented([['dark', 'Dark', 'moon'], ['light', 'Light', 'eye'], ['system', 'Auto', 'settings']], p.theme, safe((v) => savePrefs({ theme: v })))),
      section('Accent colour', h('div', { class: 'inline wrap' }, ...['#b7c9e6', '#f0b4c8', '#a8e6cf', '#ffd88a', '#c3b1ff', '#ff9e7a'].map((a) => h('button', { type: 'button', class: `swatch dot${p.accent === a ? ' on' : ''}`, style: { background: a }, 'aria-label': a, onclick: safe(async (e) => { await savePrefs({ accent: a }); view.querySelectorAll('.swatch.dot').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); }) })), colorInput(p.accent, safe((v) => savePrefs({ accent: v })), 'Custom accent'))),
      section('Chat bubbles', segmented([['glass', 'Glass'], ['solid', 'Solid'], ['outline', 'Outline'], ['minimal', 'Minimal']], c.bubble ?? 'glass', safe((v) => saveCustom({ bubble: v }))),
        h('div', { class: 'inline' }, h('span', { class: 'grow' }, 'My bubble colour'), colorInput(c.bubbleColor, safe((v) => saveCustom({ bubbleColor: v })), 'Bubble colour'), h('button', { class: 'ghost mini', type: 'button', onclick: safe(() => saveCustom({ bubbleColor: undefined })) }, 'Reset')),
        slider('Roundness', 'radius', 4, 28, 1, c.radius ?? 16, (x) => `${x}px`), segmented([['right', 'My messages on the right'], ['left', 'On the left']], c.mineSide ?? 'right', safe((v) => saveCustom({ mineSide: v })))),
      section('Wallpaper', wall, h('button', { class: 'ghost', type: 'button', onclick: () => pickFile('image/*', async (f) => { try { const d = await uploadWithBar('kind=wallpaper', f, view); await saveCustom({ wallpaperId: d.id, wallpaper: 'custom' }); toast('Wallpaper set', { kind: 'ok' }); } catch (e) { fail(e); } }) }, icon('image', 16), 'Use my own image (up to 4 MB)')),
      section('Text and glass', slider('Text size', 'fontScale', 0.85, 1.4, 0.05, c.fontScale ?? 1, (x) => `${Math.round(x * 100)}%`), slider('Glass blur', 'blur', 0, 40, 1, c.blur ?? 22, (x) => `${x}px`)),
      section('Comfort', segmented([['comfortable', 'Comfortable'], ['compact', 'Compact']], p.density, safe((v) => savePrefs({ density: v }))),
        toggle('plain', 'Plain surfaces (no glass)', p.plain, safe((v) => savePrefs({ plain: v }))), toggle('motion', 'Reduce motion', p.reduceMotion, safe((v) => savePrefs({ reduceMotion: v }))),
        toggle('contrast', 'High contrast', !!c.contrast, safe((v) => saveCustom({ contrast: v }))), toggle('avatars', 'Show avatars in chat', c.showAvatars !== false, safe((v) => saveCustom({ showAvatars: v }))), toggle('confetti', 'Celebration effects', c.confetti !== false, safe((v) => saveCustom({ confetti: v })))));
  },

  /* ---------------- sounds */
  async sounds(view) {
    const paint = async () => {
      const mine = await api('/api/sounds').catch(() => []); const s = state.sound;
      const opts = (base) => [...base, ...mine.map((m) => [`custom:${m.id}`, `Mine: ${(m.label || 'sound').replace(/\.[a-z0-9]+$/i, '')}`])];
      const pick = (label, key, base, loop) => h('label', { class: 'field' }, label, h('div', { class: 'inline' }, select(key, s[key], opts(base), safe(async (v) => { await saveSound({ [key]: v }); })), sq('play', 'Preview', { class: 'sm', onclick: () => { const stop = playSound(state.sound[key], state.sound.volume, false); setTimeout(stop, loop ? 6000 : 3000); } })));
      const vol = h('input', { type: 'range', min: 0, max: 100, value: s.volume, 'aria-label': 'Volume' }); vol.addEventListener('change', safe(() => saveSound({ volume: Number(vol.value) })));
      const up = h('div', { class: 'stack' });
      clear(view, pick('Message tone', 'tone', BUILTIN_TONES.filter((t) => t[0] !== 'ring' && t[0] !== 'soft' || true)), pick('Ringtone (when someone calls you)', 'ringtone', BUILTIN_TONES, true), pick('Calling tune (what you hear while calling)', 'callingTune', CALLING_TUNES, true), h('label', { class: 'field' }, 'Volume', vol),
        section('My sounds', hint('Upload any song up to 10 MB, any length. Use it as a ringtone, calling tune or message tone, or attach it to posts and stories.'), up, ...(mine.length ? mine.map((m) => row(icon('music', 18), h('span', { class: 'grow' }, (m.label || 'sound').replace(/\.[a-z0-9]+$/i, ''), h('small', {}, ` ${fmtBytes(m.size)}`)), sq('play', 'Play', { class: 'sm', onclick: () => { const a = new Audio(fileUrl(m.id)); a.volume = s.volume / 100; a.play().catch(() => {}); setTimeout(() => a.pause(), 8000); } }), sq('trash', 'Delete', { class: 'sm', onclick: safe(async () => { await api('/api/sounds/delete', { body: { id: m.id } }); state.sound = (await api('/api/me')).sound; await paint(); }) }))) : [hint('Nothing uploaded yet.')]), h('button', { class: 'primary', type: 'button', onclick: () => pickFile('audio/*', async (f) => { if (f.size > 10 * 1048576) return toast('That file is over 10 MB.', { kind: 'error' }); try { await uploadWithBar(`kind=sound&name=${encodeURIComponent(f.name)}`, f, up); toast('Uploaded', { kind: 'ok' }); await paint(); } catch (e) { fail(e); } }) }, icon('upload', 16), 'Upload a sound')),
        section('Per person', hint('Open someone’s profile and choose Ringtone for this person to give them their own ring.')));
    };
    await paint();
  },

  /* ---------------- call screen */
  calls(view) {
    const p = state.prefs; const styles = actions.VIZ_STYLES ?? [['ring', 'Spectrum ring']];
    const label = { none: 'Plain', ring: 'Ring', cd: 'Disc', bars: 'Bars', wave: 'Wave', pulse: 'Pulse', orbit: 'Orbit' };
    let style = p.vizStyle ?? 'ring'; let color = p.vizColor || '#b7c9e6';
    const tiles = h('div', { class: 'tiles viz-tiles' }, ...styles.map(([k]) => h('button', { type: 'button', class: `tile${k === style ? ' on' : ''}`, dataset: { k }, onclick: async (e) => { style = k; tiles.querySelectorAll('.tile').forEach((t) => t.classList.toggle('on', t.dataset.k === k)); await safe(() => savePrefs({ vizStyle: k }))(); } }, h('span', { class: 'sqicon' }, icon(k === 'cd' ? 'disc' : k === 'none' ? 'phoneoff' : k === 'wave' ? 'wave' : k === 'bars' ? 'speaker' : k === 'orbit' ? 'globe' : k === 'pulse' ? 'flame' : 'sparkle', 24)), label[k] ?? k)));
    clear(view, hint('When someone calls you, their picture shows with this visual moving to your ringtone. Only you see it. The person calling never sees it.'), tiles,
      h('div', { class: 'inline' }, h('span', { class: 'grow' }, 'Colour'), colorInput(color, safe(async (v) => { color = v; await savePrefs({ vizColor: v }); }), 'Visual colour'), h('button', { class: 'ghost mini', type: 'button', onclick: safe(async () => { await savePrefs({ vizColor: '' }); color = '#b7c9e6'; toast('Using your accent colour', { kind: 'ok' }); }) }, 'Use accent')),
      h('button', { class: 'primary', type: 'button', onclick: () => { closeSheets(); actions.previewCallScreen({ vizStyle: style, vizColor: color }); } }, icon('play', 16), 'Preview with my ringtone'));
  },

  /* ---------------- privacy */
  async privacy(view) {
    const pr = state.privacy; const isPrivate = !!state.prefs.private;
    const save = (patch) => safe(async () => { state.privacy = await api('/api/privacy', { body: { whoCanMessage: state.privacy.whoCanMessage, previews: state.privacy.previews, dnd: state.privacy.dnd, private: !!state.prefs.private, ...patch } }); if ('private' in patch) { state.prefs.private = patch.private; } });
    clear(view,
      section('Who can message and call me', hint('People who are not allowed see that you are not accepting messages. Existing chats stay.'), segmented([['everyone', 'Everyone', 'globe'], ['friends', 'Friends', 'users'], ['groups', 'Shared groups', 'chat'], ['nobody', 'Nobody', 'ban']], pr.whoCanMessage, (v) => save({ whoCanMessage: v })())),
      section('Account', toggle('private', 'Private account: people ask to follow, and only followers see posts and stories', isPrivate, (v) => save({ private: v })()), toggle('previews', 'Show message previews in notifications', pr.previews, (v) => save({ previews: v })()), toggle('dnd', 'Do not disturb: no sounds, no pushes, no ringing', pr.dnd, (v) => save({ dnd: v })())),
      section('Secret chats', hint('Open a chat and press the lock to start an end-to-end encrypted text conversation. Text only: files and call details are not hidden, and keys live in this browser, so a new browser cannot read old secret messages.')));
  },

  /* ---------------- alerts + install */
  async alerts(view) {
    const paint = async () => {
      if (native()) {
        const n = nativeStatus(); const yes = (v) => (v ? 'On' : 'Needs attention');
        return clear(view, section('Calls with the screen off', hint('The app keeps a small connection open so a call rings with your ringtone, vibrates and lights the lock screen, even when the app is closed.'),
          row(h('span', { class: 'grow' }, 'Notifications'), h('b', {}, yes(n.notifications))), row(h('span', { class: 'grow' }, 'Show calls over the lock screen'), h('b', {}, yes(n.fullScreen))), row(h('span', { class: 'grow' }, 'Unrestricted battery use'), h('b', {}, yes(n.battery))), row(h('span', { class: 'grow' }, 'Background service'), h('b', {}, n.running ? 'Running' : 'Stopped')),
          h('div', { class: 'inline wrap' }, h('button', { class: 'primary', type: 'button', onclick: () => { native().requestPermissions(); setTimeout(paint, 1500); } }, icon('bell', 16), 'Allow notifications and lock screen'), h('button', { class: 'ghost', type: 'button', onclick: () => { native().requestBattery(); setTimeout(paint, 1500); } }, icon('flame', 16), 'Allow background use'), h('button', { class: 'ghost', type: 'button', onclick: () => { native().start(); setTimeout(paint, 800); } }, 'Restart service')),
          hint('Phones from Xiaomi, Oppo, Vivo, Realme, Huawei and Samsung may also need Scrxaper set to Autostart or No restrictions in system battery settings, or they stop the service.')));
      }
      const st = await actions.pushStatus(); const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
      const status = !st.supported ? 'This browser cannot receive push notifications.' : st.subscribed ? 'On. Calls and messages reach this device when the app is closed.' : st.permission === 'denied' ? 'Blocked in browser settings. Allow notifications for this site, then come back.' : 'Off.';
      const install = deferredInstall ? h('button', { class: 'primary', type: 'button', onclick: async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; paint(); } }, icon('download', 16), 'Install Scrxaper') : h('p', { class: 'hint' }, standalone ? 'Installed on this device.' : 'To install: use your browser menu, Install app or Add to Home screen.');
      clear(view, section('Calls and messages when the app is closed', h('p', {}, status),
        h('div', { class: 'inline wrap' }, ...(st.supported && !st.subscribed ? [h('button', { class: 'primary', type: 'button', onclick: safe(async () => { const r = await actions.enablePush(); if (r !== 'granted') toast(r === 'denied' ? 'Notifications are blocked.' : 'Not enabled.', { kind: 'error' }); else toast('Enabled', { kind: 'ok' }); paint(); }) }, icon('bell', 16), 'Turn on notifications')] : []),
          ...(st.subscribed ? [h('button', { class: 'ghost', type: 'button', onclick: safe(async () => { await actions.disablePush(); paint(); }) }, 'Turn off')] : [])),
        hint('Incoming calls show a persistent Calling notification with Answer and Decline, and repeat every few seconds while it rings so your phone keeps playing its notification sound and vibration, even with the screen off. Browsers cannot play your custom ringtone from a closed app: it plays as soon as the app is open. Set your phone’s notification sound for Scrxaper to a loud ringing tone in system settings.')),
        section('Install the app', install, hint('Installed, Scrxaper opens like an app and can ring from the background.')),
        section('Sounds in the app', toggle('x', 'Do not disturb', state.privacy.dnd, safe(async (v) => { state.privacy = await api('/api/privacy', { body: { whoCanMessage: state.privacy.whoCanMessage, previews: state.privacy.previews, dnd: v, private: !!state.prefs.private } }); }))));
    };
    await paint();
  },

  /* ---------------- sparks + shop */
  async sparks(view) {
    const paint = async () => {
      const d = await api('/api/shop');
      clear(view, h('div', { class: 'wallet' }, icon('sparkle', 26), h('div', {}, h('b', {}, String(d.balance)), h('small', {}, ` ${d.currency}`)), h('button', { class: 'primary mini', type: 'button', onclick: safe(async () => { const r = await api('/api/sparks/daily', { body: {} }); confetti(); toast(`Daily reward claimed. Balance ${r.balance}`, { kind: 'ok' }); paint(); }) }, 'Daily check-in')),
        hint(`Earn ${d.currency} with daily check-ins. Friends can send them to each other from a profile.`),
        section('Shop', h('div', { class: 'shop' }, ...d.items.map((it) => h('div', { class: `shopitem${it.equipped ? ' on' : ''}` }, h('span', { class: `sqicon prev ${it.kind}-${it.id}` }, icon(it.kind === 'frame' ? 'user' : it.kind === 'title' ? 'crown' : 'star', 22)), h('div', { class: 'grow' }, h('b', {}, it.name), h('small', {}, it.description)),
          it.owned ? h('button', { class: it.equipped ? 'ghost mini' : 'primary mini', type: 'button', onclick: safe(async () => { await api(it.equipped ? '/api/shop/unequip' : '/api/shop/equip', { body: it.equipped ? { kind: it.kind } : { item: it.id } }); paint(); }) }, it.equipped ? 'Unequip' : 'Equip')
            : h('button', { class: 'primary mini', type: 'button', onclick: safe(async () => { await api('/api/shop/buy', { body: { item: it.id } }); confetti(); paint(); }) }, `${it.price}`))))),
        ...(d.history.length ? [section('Recent', ...d.history.map((x) => row(h('span', { class: 'grow' }, x.reason), h('b', { class: x.delta < 0 ? 'neg' : 'pos' }, `${x.delta > 0 ? '+' : ''}${x.delta}`))))] : []));
    };
    await paint();
  },

  /* ---------------- account */
  account(view) {
    clear(view, h('div', { class: 'inline' }, avatarEl(state.me.avatar, state.me.displayName, 52), h('div', {}, h('b', {}, state.me.displayName), ' ', roleTag(state.me.role !== 'user' ? state.me.role : null), h('br'), h('small', {}, `@${state.user}`))),
      h('button', { class: 'ghost', type: 'button', onclick: safe(async () => { native()?.stop?.(); await api('/api/logout', { body: {} }); location.href = '/app'; }) }, icon('logout', 16), 'Log out'),
      section('Delete account', hint('Removes your account, posts, messages and files. This cannot be undone. Communities you own must be deleted first.'),
        h('button', { class: 'danger', type: 'button', onclick: async () => { const pw = await ask.prompt('Enter your password to confirm.', '', { title: 'Delete account', type: 'password' }); if (!pw) return; await safe(async () => { await api('/api/account/delete', { body: { password: pw } }); location.href = '/'; })(); } }, icon('trash', 16), 'Delete my account')));
  },
};
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

/* ------------------------------------------------------------------ onboarding: asks about the person */
export function runOnboarding() {
  return new Promise((resolve) => {
    const answers = { displayName: state.me.displayName, interests: [], status: '', bio: '' }; let step = 0; let sh; let ended = false;
    const finish = async () => { if (ended) return; ended = true; try { await api('/api/profile', { body: { displayName: answers.displayName, status: answers.status, bio: answers.bio, interests: answers.interests } }); await api('/api/onboarding/done', { body: {} }); } catch { /* keep going */ } sh?.close(); resolve(); };
    const q = [
      { title: 'What should we call you?', note: 'This is the name people see. You can change it anytime.', render: () => field('displayName', 'Your name', { value: answers.displayName, maxLength: 40, autofocus: true }), take: (el) => { answers.displayName = el.value.trim() || answers.displayName; } },
      { title: 'What are you into?', note: 'Type anything: games, music, art, coding, football. Separate with commas. We use it to suggest people and tags.', render: () => field('interests', 'music, gaming, design', { value: answers.interests.join(', '), autofocus: true }), take: (el) => { answers.interests = el.value.split(',').map((x) => x.trim()).filter(Boolean); } },
      { title: 'What are you up to right now?', note: 'A short status on your profile. Skip if you like.', render: () => field('status', 'Building something cool', { value: answers.status, maxLength: 60, autofocus: true }), take: (el) => { answers.status = el.value.trim(); } },
      { title: 'Tell people about yourself', note: 'One or two lines for your bio. Skip if you like.', render: () => h('textarea', { name: 'bio', rows: 3, maxLength: 200, placeholder: 'I make beats and break builds.', 'aria-label': 'Bio', autofocus: true }, answers.bio), take: (el) => { answers.bio = el.value.trim(); } },
    ];
    const paint = () => {
      const s = q[step]; const input = s.render();
      const next = h('button', { class: 'primary', type: 'button', onclick: async () => { s.take(input); if (step < q.length - 1) { step++; paint(); } else { await finish(); } } }, step < q.length - 1 ? 'Next' : 'Finish');
      input.addEventListener?.('keydown', (e) => { if (e.key === 'Enter' && input.tagName !== 'TEXTAREA') next.click(); });
      const dots = h('div', { class: 'dots' }, ...q.map((_, i) => h('i', { class: i === step ? 'on' : i < step ? 'done' : '' })));
      const view = h('div', { class: 'stack onb', key: step }, dots, h('h3', {}, s.title), h('p', { class: 'hint' }, s.note), input, h('div', { class: 'dlg-actions' }, step ? h('button', { class: 'ghost', type: 'button', onclick: () => { s.take(input); step--; paint(); } }, 'Back') : h('button', { class: 'ghost', type: 'button', onclick: finish }, 'Skip all'), next));
      if (sh) { sh.title('Welcome to Scrxaper'); clear(sh.body, view); } else sh = openSheet('Welcome to Scrxaper', view, { key: 'onboarding', onClose: finish });
      setTimeout(() => input.focus?.(), 80);
    };
    paint();
  });
}

/* ------------------------------------------------------------------ banned */
export function showBanned({ reason } = {}) {
  document.querySelector('.banned')?.remove();
  const el = h('div', { class: 'banned', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'Account suspended' }, h('div', { class: 'banned-box' }, h('span', { class: 'sqicon big' }, icon('ban', 34)), h('h2', {}, 'Your account is suspended'), h('p', {}, reason || 'This account has been suspended by the Scrxaper team.'), h('p', { class: 'hint' }, 'You cannot use Scrxaper while suspended. If you think this is a mistake, contact the site team.'), h('button', { class: 'primary', type: 'button', onclick: () => location.replace('/') }, 'Okay')));
  document.body.append(el); requestAnimationFrame(() => el.classList.add('in'));
}

/* ------------------------------------------------------------------ site panel (owner, admin, staff) */
export async function openOwner() {
  const perms = state.me.perms ?? []; const body = h('div', { class: 'stack' }); const sh = openSheet('Site panel', body, { key: 'owner', wide: true });
  const roleName = { owner: 'Owner', admin: 'Admin', staff: 'Staff' }[state.me.role] ?? 'Staff';
  let tab = 'overview';
  const paint = async () => {
    const tabs = segmented([['overview', 'Overview', 'grid'], ['users', 'People', 'users'], ...(perms.includes('announce') ? [['announce', 'Announce', 'bell']] : [])], tab, (v) => { tab = v; paint(); });
    const head = h('div', { class: 'inline' }, roleTag(state.me.role), h('small', {}, `${roleName} access`));
    if (tab === 'overview') { const s = await api('/api/owner/stats').catch((e) => { fail(e); return null; }); if (!s) return; clear(body, head, tabs, h('div', { class: 'stats-grid' }, ...[['Members', s.users], ['New in 7 days', s.newUsers7d], ['Online now', s.online], ['Messages in 24h', s.messages24h], ['Communities', s.communities], ['Groups', s.groups], ['Bots installed', s.bots], ['Suspended', s.banned]].map(([l, n]) => h('div', { class: 'stat' }, h('b', {}, String(n)), h('small', {}, l)))), section('Recent actions', ...(s.audit.length ? s.audit.map((a) => row(h('span', { class: 'grow' }, `${a.actor} ${a.action} ${a.target ?? ''}`, h('small', {}, ` ${a.detail ?? ''}`)), h('small', {}, ago(a.at)))) : [hint('Nothing yet.')]))); }
    else if (tab === 'users') {
      const list = h('div', { class: 'stack-gap' }); const input = field('q', 'Search username or name', { type: 'search', autofocus: true });
      const load = async () => { const us = await api(`/api/owner/users?q=${encodeURIComponent(input.value.trim().toLowerCase())}`).catch(() => []); clear(list, ...(us.length ? us.map((u) => h('div', { class: 'item static' }, h('button', { type: 'button', class: 'pfp-btn', onclick: () => actions.openProfile(u.username) }, avatarEl(null, u.displayName, 38)), h('span', { class: 't' }, u.displayName, ' ', roleTag(u.role !== 'user' ? u.role : null), u.bannedAt ? chip('Suspended') : null, h('small', {}, ` @${u.username}`)),
        perms.includes('staff') && !u.bannedAt ? select('role', u.role, [['user', 'Member'], ['staff', 'Staff'], ...(perms.includes('admin') ? [['admin', 'Admin']] : [])], safe(async (v) => { await api('/api/owner/role', { body: { username: u.username, role: v } }); toast('Role updated', { kind: 'ok' }); load(); })) : null,
        u.bannedAt && perms.includes('ban') ? h('button', { class: 'ghost mini', type: 'button', onclick: safe(async () => { await api('/api/owner/unban', { body: { username: u.username } }); load(); }) }, 'Restore') : null)) : [empty('No one found.', 'users')])); };
      input.addEventListener('input', debounce(load, 250)); clear(body, head, tabs, input, list); load();
    } else { clear(body, head, tabs, form(async (v) => { const r = await api('/api/owner/announce', { body: { text: v.text } }); toast(`Sent to ${r.sent} people`, { kind: 'ok' }); }, h('div', { class: 'stack' }, h('textarea', { name: 'text', rows: 4, maxLength: 1000, placeholder: 'Write an announcement for everyone', 'aria-label': 'Announcement' }), h('button', { class: 'primary', type: 'submit' }, 'Send to everyone')))); }
  };
  paint().catch(fail);
}

/* ------------------------------------------------------------------ premade bots */
const installBots = async (scope, id, picks) => { for (const b of picks) await api('/api/bots/install', { body: { scope, id, bot: b.id, config: b.config } }).catch(fail); };
function botFields(bot, cfg, onChange) {
  return bot.fields.map((f) => {
    if (f.type === 'bool') return toggle(f.key, f.label, !!cfg[f.key], (v) => { cfg[f.key] = v; onChange?.(); });
    const i = h('input', { type: f.type === 'number' ? 'number' : 'text', value: f.type === 'list' ? (cfg[f.key] ?? []).join(', ') : cfg[f.key] ?? '', min: f.min, max: f.type === 'number' ? f.max : undefined, maxLength: f.max, 'aria-label': f.label });
    i.addEventListener('change', () => { cfg[f.key] = f.type === 'number' ? Number(i.value) : f.type === 'list' ? i.value.split(',').map((x) => x.trim()).filter(Boolean) : i.value; onChange?.(); });
    return h('label', { class: 'field' }, f.label, i);
  });
}
// Picker used while creating a group or community. Jukebox music is uploaded afterwards from Bots.
export function botPicker() {
  const picks = new Map(); const el = h('div', { class: 'tiles bot-tiles' });
  const BOTS = [['sentinel', 'shield', 'Sentinel', 'Security and moderation'], ['jukebox', 'music', 'Jukebox', 'Music you upload'], ['greeter', 'wave', 'Greeter', 'Welcomes new people'], ['funbot', 'dice', 'Funbot', 'Games and small talk']];
  const defaults = { sentinel: { links: false, caps: true, spam: true, mentions: 6, words: [] }, jukebox: { announce: true }, greeter: { welcome: 'Welcome {user} to {name}.', farewell: '' }, funbot: {} };
  for (const [id, ic, name, tag] of BOTS) {
    const t = h('button', { type: 'button', class: 'tile bot', 'aria-pressed': 'false', onclick: () => { const on = !picks.has(id); on ? picks.set(id, { bot: id, config: defaults[id] }) : picks.delete(id); t.classList.toggle('on', on); t.setAttribute('aria-pressed', String(on)); } }, h('span', { class: 'sqicon' }, icon(ic, 24)), h('b', {}, name), h('small', {}, tag), h('i', { class: 'tick' }, icon('check', 14)));
    el.append(t);
  }
  return { el, value: () => [...picks.values()] };
}
export async function openBots(scope, id) {
  const body = h('div', { class: 'stack' }); const sh = openSheet('Bots', body, { key: `bots:${scope}:${id}`, wide: true });
  const load = async () => {
    const { bots } = await api(`/api/bots/catalog?scope=${scope}&id=${id}`);
    clear(body, hint('Bots run inside Scrxaper. No tokens, no setup. Turn on what you need.'), ...bots.map((b) => {
      const cfg = { ...b.config }; const box = h('div', { class: `botcard${b.installed ? ' on' : ''}` });
      const save = debounce(safe(async () => { await api('/api/bots/install', { body: { scope, id, bot: b.id, config: cfg } }); toast('Saved', { kind: 'ok' }); }), 500);
      const extra = [];
      if (b.id === 'jukebox' && b.installed) {
        const tracks = h('div', { class: 'stack-gap' }, ...(b.tracks?.length ? b.tracks.map((t) => row(icon('music', 16), h('span', { class: 'grow' }, t.title), sq('trash', 'Remove track', { class: 'sm', onclick: safe(async () => { await api('/api/bots/music/delete', { body: { scope, id, track: t.id } }); load(); }) }))) : [hint('No tracks yet. Upload music below, then type !play in chat or start a voice call.')]));
        extra.push(tracks, h('button', { class: 'primary', type: 'button', onclick: () => pickFile('audio/*', async (f) => { if (f.size > 10 * 1048576) return toast('Up to 10 MB per track.', { kind: 'error' }); try { await rawPost(`/api/bots/music/upload?scope=${scope}&id=${id}&name=${encodeURIComponent(f.name)}`, f, body); toast('Track added', { kind: 'ok' }); load(); } catch (e) { fail(e); } }) }, icon('upload', 16), 'Upload track (up to 10 MB)'));
      }
      clear(box, h('div', { class: 'inline' }, h('span', { class: 'sqicon' }, icon(b.icon, 22)), h('div', { class: 'grow' }, h('b', {}, b.name), h('small', {}, b.tagline)), b.installed ? h('button', { class: 'ghost mini', type: 'button', onclick: safe(async () => { await api('/api/bots/remove', { body: { scope, id, bot: b.id } }); load(); }) }, 'Remove') : h('button', { class: 'primary mini', type: 'button', onclick: safe(async () => { await api('/api/bots/install', { body: { scope, id, bot: b.id, config: cfg } }); load(); }) }, 'Add')),
        h('p', { class: 'hint' }, b.description), ...(b.installed ? [...botFields(b, cfg, save), ...extra] : []));
      return box;
    }));
  };
  load().catch(fail);
}
Object.assign(actions, { openBots });

/* ------------------------------------------------------------------ Buddy (AI, bring your own Groq key) */
export async function openBuddy() {
  const body = h('div', { class: 'buddy' }); const sh = openSheet('Buddy', body, { key: 'buddy', wide: true, full: true });
  let conv = null; const log = h('div', { class: 'buddy-log' }); const input = h('textarea', { rows: 1, placeholder: 'Ask Buddy anything', 'aria-label': 'Message Buddy', maxLength: 4000 });
  const bubble = (role, text) => { const b = h('div', { class: `bb ${role}` }, text); log.append(b); log.scrollTop = log.scrollHeight; return b; };
  const settings = async () => {
    const s = await api('/api/ai/settings').catch(() => ({ available: false }));
    const f = form(async (v) => { await api('/api/ai/settings', { body: { apiKey: v.apiKey, model: v.model, personality: v.personality } }); toast('Saved', { kind: 'ok' }); sh.close(); openBuddy(); },
      h('div', { class: 'stack' }, h('label', { class: 'field' }, 'Groq API key', field('apiKey', s.hasKey ? 'Saved. Type a new one to replace it' : 'gsk_...', { type: 'password', autocomplete: 'off' })), h('label', { class: 'field' }, 'Model', field('model', 'openai/gpt-oss-120b', { value: s.model ?? 'openai/gpt-oss-120b' })), h('label', { class: 'field' }, 'Personality (optional)', field('personality', 'Dry and encouraging', { value: s.personality ?? '', maxLength: 300 })), h('button', { class: 'primary', type: 'submit' }, 'Save'), hint(s.available ? 'Your key is stored encrypted on the server and never sent to other people.' : 'AI key storage is not configured on this server (set AI_KEY_SECRET).')));
    return { s, f };
  };
  const { s, f } = await settings();
  if (!s.hasKey) return clear(body, h('div', { class: 'stack' }, h('p', {}, 'Buddy is a small AI friend. Add a free Groq API key to wake it up.'), f));
  const send = safe(async () => { const text = input.value.trim(); if (!text) return; input.value = ''; bubble('me', text); const wait = bubble('bot', '...'); wait.classList.add('typing'); try { const r = await api('/api/ai/chat', { body: { conversation: conv, text, localTime: new Date().toString() } }); conv = r.conversation; wait.classList.remove('typing'); wait.textContent = r.reply; } catch (e) { wait.remove(); input.value = text; throw e; } log.scrollTop = log.scrollHeight; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(hover: none)').matches) { e.preventDefault(); send(); } });
  const history = sq('clock', 'Past chats', { class: 'sm', onclick: safe(async () => { const list = await api('/api/ai/conversations'); const hs = openSheet('Past chats', h('div', { class: 'stack-gap' }, ...(list.length ? list.map((c) => row(h('button', { type: 'button', class: 'item grow', onclick: safe(async () => { const d = await api(`/api/ai/messages?conversation=${c.id}`); conv = c.id; clear(log); d.messages.forEach((m) => bubble(m.role === 'user' ? 'me' : 'bot', m.content)); hs.close(); }) }, h('span', { class: 't' }, c.title)), sq('trash', 'Delete', { class: 'sm', onclick: safe(async () => { await api('/api/ai/delete', { body: { conversation: c.id } }); hs.close(); }) }))) : [empty('No past chats.', 'chat')]))); }) });
  clear(body, h('div', { class: 'inline' }, h('span', { class: 'grow side-label' }, 'Buddy'), history, sq('plus', 'New chat', { class: 'sm', onclick: () => { conv = null; clear(log); bubble('bot', 'Hey. What are we making?'); } }), sq('settings', 'Settings', { class: 'sm', onclick: () => { sh.close(); const s2 = openSheet('Buddy settings', f); } })), log, h('div', { class: 'composer buddy-in' }, input, sq('send', 'Send', { class: 'primary', onclick: send })));
  bubble('bot', 'Hey. What are we making?');
}

/* ------------------------------------------------------------------ init */
export function init() {
  Object.assign(actions, { openStudio, runOnboarding, showBanned, openOwner, openBots, openBuddy });
  bus.on('sse:banned', (e) => { native()?.stop?.(); showBanned(e); });
  if (native()) { try { native().start(); } catch { /* old app build */ } }
}
