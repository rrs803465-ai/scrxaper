// Scrxaper client entry: auth, boot, the single event stream, and module wiring.
import { $, state, bus, actions, h, api, toast, fail, applyPrefs, ask } from './js/core.js';
import { initChat } from './js/chat.js';
import { initSpaces, paintServers, paintTabbar, refreshLists } from './js/spaces.js';
import { init as initCalls } from './js/calls.js';
import { init as initSocial } from './js/social.js';
import { init as initStudio } from './js/studio.js';

const EVENTS = ['message', 'channel-message', 'channel-delete', 'community', 'group', 'friend', 'notification', 'call', 'room', 'room-ring', 'room-signal', 'music', 'poll', 'banned'];
let es = null;
const LAUNCH = new URLSearchParams(location.search); // read before the URL is cleaned

function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  for (const name of EVENTS) es.addEventListener(name, (e) => { let d = {}; try { d = JSON.parse(e.data); } catch { /* empty */ } bus.emit(`sse:${name}`, d); });
  es.addEventListener('open', () => { bus.emit('sse:open', {}); refreshLists().catch(() => {}); });
}

async function enterApp(me, { fresh = false } = {}) {
  Object.assign(state, { me, user: me.username, prefs: me.prefs, privacy: me.privacy, sound: me.sound, ignored: new Set(me.ignored ?? []), mutes: new Set((me.mutes ?? []).map((x) => `${x.kind}:${x.target}`)) });
  applyPrefs(me.prefs);
  $('auth').hidden = true; $('app').hidden = false;
  history.replaceState(null, '', '/app');
  initChat(); initSpaces();
  for (const init of [initCalls, initSocial, initStudio]) { try { await init(); } catch (e) { console.error('module init failed', e); } }
  paintTabbar();
  await refreshLists().catch(() => {});
  connectEvents();
  if (!me.prefs.onboarded || fresh) { try { await actions.runOnboarding?.(); } catch (e) { console.error(e); } const r = await api('/api/me').catch(() => null); if (r) { state.me = r; state.prefs = r.prefs; applyPrefs(r.prefs); } refreshLists(); }
  const go = LAUNCH.get('go');
  if (go === 'friends') actions.openFriends?.(); else if (go === 'feed') actions.openFeed?.('feed');
  if (LAUNCH.get('call')) { const [id, act] = [LAUNCH.get('call'), LAUNCH.get('act')]; LAUNCH.delete('call'); setTimeout(() => window.scrxCallIntent?.(id, act), 900); }
  bus.emit('ready', me);
}

function authScreen(mode) {
  $('auth').hidden = false;
  const signup = mode === 'signup';
  $('tab-login').classList.toggle('on', !signup); $('tab-signup').classList.toggle('on', signup);
  $('tab-login').setAttribute('aria-selected', String(!signup)); $('tab-signup').setAttribute('aria-selected', String(signup));
  $('display-field').hidden = !signup;
  $('auth-form').querySelector('button[type=submit]').textContent = signup ? 'Create account' : 'Log in';
  $('auth-form').elements.password.autocomplete = signup ? 'new-password' : 'current-password';
  authScreen.mode = mode;
}
$('tab-login').addEventListener('click', () => authScreen('login'));
$('tab-signup').addEventListener('click', () => authScreen('signup'));
$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  $('auth-error').textContent = '';
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  try {
    const signup = authScreen.mode === 'signup';
    await api(signup ? '/api/register' : '/api/login', { body: f });
    await enterApp(await api('/api/me'), { fresh: signup });
  } catch (err) {
    if (err.data?.banned) { $('auth').hidden = true; actions.showBanned ? actions.showBanned({ reason: err.data.reason }) : ask.alert(err.data.reason || 'This account is suspended.', 'Account suspended'); }
    else $('auth-error').textContent = err.message;
  } finally { btn.disabled = false; }
});

const hide = () => { const b = $('boot'); b.classList.add('gone'); setTimeout(() => b.remove(), 600); };
api('/api/me').then(enterApp).catch((err) => {
  authScreen(location.hash === '#signup' ? 'signup' : 'login');
  if (err.status && err.status !== 401) toast(err.message, { kind: 'error' });
}).finally(hide);
window.addEventListener('hashchange', () => { if (!$('auth').hidden) authScreen(location.hash === '#signup' ? 'signup' : 'login'); });
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.status) { e.preventDefault(); fail(e.reason); } });
