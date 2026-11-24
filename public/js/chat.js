// Conversation pane: header, message log, bubbles, composer, uploads, secret (end-to-end) chats.
import { $, state, bus, actions, h, clear, icon, sq, avatarEl, roleTag, api, upload, toast, fail, ask, openSheet, closeSheets, timeOf, dayOf, fmtBytes, fileUrl, linkify, ping, playSound, BUILTIN_TONES, toggle, select, form, field, section, hint, row, empty, debounce } from './core.js';
import * as e2ee from '../e2ee.js';

const main = () => $('main');
const view = { kind: null, id: null, data: null, msgs: [], last: null, canPost: true, canModerate: false, secret: false, peerKey: null, name: '', more: false };
const pending = [];
const DEC = new Map(); // message id -> decrypted text
let els = {};
let e2eeReady = null;

export const viewKey = () => (view.kind ? `${view.kind}:${view.id}` : null);
const muteKey = () => (view.kind === 'dm' ? `dm:${view.id}` : view.kind ? `${view.kind}:${view.id}` : null);

/* ------------------------------------------------------------------ e2ee */
function ensureE2ee() {
  e2eeReady ??= (async () => {
    const mine = await e2ee.init(state.user);
    await api('/api/e2ee/key', { body: { jwk: mine.publicJwk } });
    return mine;
  })().catch((e) => { e2eeReady = null; throw e; });
  return e2eeReady;
}
const peerKeys = new Map();
async function peerKey(username, force = false) {
  if (!force && peerKeys.has(username)) return peerKeys.get(username);
  const k = await api(`/api/e2ee/key?user=${encodeURIComponent(username)}`);
  if (k.id) peerKeys.set(username, k);
  return k.id ? k : null;
}
const secretOn = (peer) => { try { return localStorage.getItem(`scrx-secret:${state.user}:${peer}`) === '1'; } catch { return false; } };
const setSecret = (peer, on) => { try { on ? localStorage.setItem(`scrx-secret:${state.user}:${peer}`, '1') : localStorage.removeItem(`scrx-secret:${state.user}:${peer}`); } catch { /* storage blocked */ } };

async function toggleSecret() {
  if (view.kind !== 'dm') return;
  if (view.secret) { view.secret = false; setSecret(view.id, false); paintHeader(); toast('Secret mode off. New messages are sent normally.'); return; }
  try {
    await ensureE2ee();
    const k = await peerKey(view.id, true);
    if (!k) return ask.alert(`${view.name} has not opened Scrxaper on a device that supports secret chats yet. Ask them to open Scrxaper once, then try again.`, 'Secret chat unavailable');
    view.secret = true; view.peerKey = k; setSecret(view.id, true); paintHeader();
    toast('Secret mode on. New text messages are end-to-end encrypted.', { kind: 'ok' });
  } catch (e) { fail(e); }
}
async function showSafety() {
  try {
    const mine = await ensureE2ee(); const k = await peerKey(view.id, true);
    if (!k) return toast('This person has no secret-chat key yet.');
    const num = await e2ee.safetyNumber(mine.publicJwk, k.jwk);
    openSheet('Safety number', h('div', { class: 'stack' }, hint(`Compare these numbers with ${view.name} in person or on a call. If they match, nobody swapped the keys.`), h('div', { class: 'code safety' }, num),
      hint('Secret chats use a fixed key pair per browser (ECDH P-256 + AES-GCM). They hide message text from the server, but there is no forward secrecy and the keys live in this browser only. Files and metadata are not hidden.')));
  } catch (e) { fail(e); }
}

/* ------------------------------------------------------------------ opening threads */
async function open(kind, id) {
  const token = Symbol();
  open.token = token;
  els.err && (els.err.textContent = '');
  try {
    let data;
    if (kind === 'dm') data = await api(`/api/messages?with=${encodeURIComponent(id)}`);
    else if (kind === 'group') data = await api(`/api/group-messages?group=${id}`);
    else data = await api(`/api/channel-messages?channel=${id}`);
    if (open.token !== token) return;
    Object.assign(view, { kind, id: kind === 'dm' ? data.peer.username : Number(id), data, msgs: [], last: null, secret: false, peerKey: null });
    view.canPost = kind === 'channel' ? data.canPost : kind === 'dm' ? data.peer.username !== 'scrxaper' && !data.peer.is_system : true;
    view.canModerate = !!data.canModerate;
    view.name = kind === 'dm' ? data.peer.display_name : kind === 'group' ? data.group.name : `#${data.channel.name}`;
    state.view = { kind, id: view.id };
    if (kind === 'dm' && secretOn(view.id)) { try { await ensureE2ee(); const k = await peerKey(view.id); if (k) { view.secret = true; view.peerKey = k; } } catch { /* stays off */ } }
    if (kind === 'channel') { state.community = data.channel.communityId; actions.selectSpace?.(data.channel.communityId, { keepView: true }); state.unreadCh?.delete(Number(id)); }
    buildPane();
    data.messages.forEach((m) => addMessage(m, { silent: true }));
    view.more = data.messages.length >= 50;
    paintMore();
    scrollEnd(true);
    $('app').classList.add('reading');
    if (!matchMedia('(max-width: 760px)').matches && view.canPost) els.input?.focus();
    actions.refreshLists?.();
    bus.emit('view', state.view);
  } catch (e) {
    if (kind === 'dm' && e.status === 404) toast(`No user called "${id}".`, { kind: 'error' }); else fail(e);
  }
}

function closeThread() {
  open.token = Symbol();
  Object.assign(view, { kind: null, id: null, data: null, msgs: [] });
  state.view = { kind: null, id: null };
  $('app').classList.remove('reading');
  buildIdle();
  actions.refreshLists?.();
}

/* ------------------------------------------------------------------ pane */
function buildIdle() {
  els = {};
  clear(main(), h('div', { class: 'idle' }, h('img', { src: '/brand/butterfly.png', alt: '', width: 150, height: 160 }), h('p', {}, 'Pick a conversation, or search for someone to say hello.')));
}

function buildPane() {
  const back = sq('back', 'Back', { class: 'only-mobile ghost', onclick: closeThread });
  els.who = h('button', { type: 'button', class: 'who', onclick: headerClick });
  els.acts = h('div', { class: 'acts' });
  els.lock = h('div', { class: 'locked-bar', hidden: true });
  els.log = h('div', { class: 'log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
  els.log.addEventListener('scroll', onScroll);
  els.jump = sq('chevdown', 'Jump to latest', { class: 'jump', hidden: true, onclick: () => scrollEnd(true) });
  els.input = h('textarea', { rows: 1, placeholder: 'Message', 'aria-label': 'Message', maxLength: 4000, autocomplete: 'off', enterKeyHint: 'send' });
  els.send = sq('send', 'Send', { class: 'send on', type: 'submit', disabled: true });
  els.attach = sq('attach', 'Attach files', { class: 'ghost', onclick: () => { const i = h('input', { type: 'file', multiple: true }); i.addEventListener('change', () => addFiles([...i.files])); i.click(); } });
  els.pend = h('div', { class: 'pending', hidden: true });
  els.err = h('p', { class: 'error thread-error', role: 'alert' });
  els.composer = h('form', { class: 'composer', novalidate: true }, els.attach, els.input, els.send);
  els.wrap = h('div', { class: 'composer-wrap' }, els.pend, els.composer);
  els.drop = h('div', { class: 'dropzone', 'aria-hidden': 'true' }, icon('upload', 28), h('span', {}, 'Drop files to send'));
  els.composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
  els.input.addEventListener('input', () => { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`; sync(); });
  els.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); send(); } });
  els.input.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files ?? [])]; if (f.length) { e.preventDefault(); addFiles(f); } });
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  let depth = 0;
  main().ondragenter = (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { stop(e); depth++; main().classList.add('dragover'); } };
  main().ondragover = (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) stop(e); };
  main().ondragleave = (e) => { if (--depth <= 0) { depth = 0; main().classList.remove('dragover'); } };
  main().ondrop = (e) => { if (e.dataTransfer?.files?.length) { stop(e); depth = 0; main().classList.remove('dragover'); addFiles([...e.dataTransfer.files]); } };
  const head = h('header', { class: 'thead' }, back, els.who, els.acts);
  clear(main(), head, els.lock, els.log, els.jump, els.err, els.wrap, els.drop);
  paintHeader();
  sync();
}

function paintHeader() {
  const d = view.data;
  if (!d) return;
  let av; let sub = '';
  if (view.kind === 'dm') { av = avatarEl(d.peer.avatar, d.peer.display_name, 38); sub = d.peer.status || `@${d.peer.username}`; }
  else if (view.kind === 'group') { av = avatarEl(d.group.icon, d.group.name, 38, true); sub = `${d.members.length} members${d.bots?.length ? ` · ${d.bots.length} bots` : ''}`; }
  else { av = h('span', { class: 'pfp icon', style: { '--s': '38px' } }, icon('hash', 18)); sub = d.channel.topic || (d.channel.kind === 'announcement' ? 'Announcements' : 'Text channel'); }
  clear(els.who, av, h('span', { class: 'grow' }, h('strong', {}, view.kind === 'channel' ? view.name.slice(1) : view.name, view.kind === 'dm' ? roleTag(d.peer.tag) : null), h('small', {}, sub)));
  const acts = [];
  const online = (k) => actions.currentRoom?.() === k;
  if (view.kind === 'dm' && view.canPost) {
    acts.push(sq('call', 'Voice call', { onclick: () => actions.startCall?.(view.id, false) }), sq('video', 'Video call', { onclick: () => actions.startCall?.(view.id, true) }),
      sq('lock', view.secret ? 'Secret chat is on' : 'Start a secret chat', { class: view.secret ? 'on' : '', onclick: toggleSecret }));
  }
  if (view.kind === 'group') {
    acts.push(sq('call', online(`gc:${view.id}`) ? 'In call' : 'Start group call', { class: online(`gc:${view.id}`) ? 'on' : '', onclick: () => actions.joinRoom?.(`gc:${view.id}`, { video: false }) }),
      sq('video', 'Group video call', { onclick: () => actions.joinRoom?.(`gc:${view.id}`, { video: true }) }));
  }
  acts.push(sq('more', 'Conversation options', { onclick: optionsSheet }));
  clear(els.acts, acts);
  els.lock.hidden = !view.secret;
  clear(els.lock, icon('lock', 15), h('span', { class: 'grow' }, 'Secret chat. Text messages are end-to-end encrypted.'), h('button', { class: 'link', type: 'button', onclick: showSafety }, 'Safety number'));
  els.composer.hidden = !view.canPost;
  els.input.placeholder = view.canPost ? (view.secret ? 'Secret message' : `Message ${view.kind === 'channel' ? view.name : view.name}`) : (view.kind === 'channel' ? 'You cannot post in this channel' : 'You cannot reply here');
  els.input.disabled = !view.canPost; els.attach.disabled = !view.canPost;
}

const headerClick = () => {
  if (view.kind === 'dm') actions.openProfile?.(view.id);
  else if (view.kind === 'group') actions.openGroupInfo?.(view.id);
  else actions.openCommunitySettings?.(view.data.channel.communityId);
};

function optionsSheet() {
  const k = muteKey();
  const [kind, target] = k.split(':');
  const sheet = openSheet(view.name, null, { key: 'thread-options' });
  const paint = () => {
    const ov = state.sound?.overrides?.find((o) => o.kind === kind && String(o.target) === String(target))?.tone ?? 'default';
    const tones = [['default', 'Default sound'], ...BUILTIN_TONES.map(([v, l]) => [v, l === 'Silent' ? 'Silent' : l])];
    clear(sheet.body, h('div', { class: 'stack' },
      toggle('mute', 'Mute notifications', state.mutes.has(k), async (muted) => { await api('/api/mute', { body: { kind, target, muted } }).catch(fail); muted ? state.mutes.add(k) : state.mutes.delete(k); actions.refreshLists?.(); }),
      h('label', { class: 'field' }, 'Alert sound', select('tone', ov, tones, async (v) => { try { state.sound = await api('/api/sound/override', { body: { kind, target, tone: v } }); playSound(v === 'default' ? state.sound.tone : v, state.sound.volume); } catch (e) { fail(e); } })),
      ...(view.kind === 'dm' ? [
        h('div', { class: 'inline' }, h('button', { class: 'ghost', type: 'button', onclick: () => { sheet.close(); actions.openProfile?.(view.id); } }, 'View profile'),
          h('button', { class: 'ghost', type: 'button', onclick: async () => { const blocked = !!view.data.peer.blocked; await api('/api/block', { body: { username: view.id, blocked: !blocked } }).catch(fail); view.data.peer.blocked = !blocked; toast(blocked ? 'Unblocked' : 'Blocked'); sheet.close(); actions.refreshLists?.(); } }, 'Block / unblock')),
        h('button', { class: 'ghost', type: 'button', onclick: () => { sheet.close(); showSafety(); } }, 'Safety number for secret chat')] : []),
      ...(view.kind === 'group' ? [h('div', { class: 'inline' }, h('button', { class: 'ghost', type: 'button', onclick: () => { sheet.close(); actions.openGroupInfo?.(view.id); } }, 'Members and settings'))] : []),
      ...(view.kind === 'channel' ? [h('div', { class: 'inline' }, h('button', { class: 'ghost', type: 'button', onclick: () => { sheet.close(); actions.openCommunitySettings?.(view.data.channel.communityId); } }, 'Community settings'))] : [])));
  };
  paint();
}

/* ------------------------------------------------------------------ messages */
const near = () => els.log && els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 140;
function scrollEnd(force) { if (!els.log) return; if (force || near()) { els.log.scrollTop = els.log.scrollHeight; els.jump.hidden = true; } else els.jump.hidden = false; }
function onScroll() { if (near()) els.jump.hidden = true; if (els.log.scrollTop < 40 && view.more && !onScroll.busy) loadOlder(); }
function paintMore() { els.log.querySelector('.more')?.remove(); if (view.more) els.log.prepend(h('button', { class: 'ghost mini more', type: 'button', onclick: loadOlder }, 'Load earlier messages')); }
async function loadOlder() {
  if (onScroll.busy || !view.msgs.length) return;
  onScroll.busy = true;
  const before = view.msgs[0].id; const [kind, id] = [view.kind, view.id];
  try {
    const q = kind === 'dm' ? `/api/messages?with=${encodeURIComponent(id)}&before=${before}` : kind === 'group' ? `/api/group-messages?group=${id}&before=${before}` : `/api/channel-messages?channel=${id}&before=${before}`;
    const d = await api(q);
    if (view.kind !== kind || view.id !== id) return;
    const h0 = els.log.scrollHeight;
    const older = d.messages;
    view.more = older.length >= 50;
    view.msgs = [...older, ...view.msgs];
    rebuild();
    els.log.scrollTop = els.log.scrollHeight - h0;
  } catch (e) { fail(e); } finally { onScroll.busy = false; }
}
function rebuild() {
  els.log.replaceChildren(); view.last = null;
  const all = view.msgs; view.msgs = [];
  all.forEach((m) => addMessage(m, { silent: true, keep: true }));
  paintMore();
}

export function addMessage(m, { silent = false, keep = false } = {}) {
  if (!els.log) return;
  if (els.log.querySelector(`[data-id="${m.id}"]`)) return;
  const prev = view.msgs.at(-1);
  if (!keep || !view.msgs.includes(m)) view.msgs.push(m);
  const dayChange = !prev || dayOf(prev.at) !== dayOf(m.at);
  if (dayChange) els.log.append(h('div', { class: 'day' }, dayOf(m.at)));
  els.log.append(renderMessage(m, dayChange ? null : prev));
  if (!silent) scrollEnd(m.mine);
}

const SYSTEM = new Set(['call']);
function renderMessage(m, prev) {
  if (SYSTEM.has(m.kind)) return h('div', { class: 'sysmsg', dataset: { id: m.id } }, icon('call', 14), h('span', {}, m.body), h('small', {}, timeOf(m.at)));
  const cont = prev && !SYSTEM.has(prev.kind) && prev.from === m.from && !!prev.mine === !!m.mine && m.at - prev.at < 300000 && m.kind !== 'card';
  const mine = !!m.mine;
  const open = () => actions.openProfile?.(m.from ?? view.id);
  const name = m.name ?? view.data?.peer?.display_name ?? m.from;
  const kindCls = m.kind === 'announcement' ? ' card-announce' : m.kind === 'card' || m.kind === 'birthday' ? ' birthday' : '';
  const body = h('div', { class: `bub${kindCls}` });
  if (!mine && view.kind !== 'dm') body.append(h('span', { class: 'who', onclick: open }, name, roleTag(m.tag ?? (m.is_bot ? 'bot' : null))));
  if (m.file) body.append(fileBlock(m));
  else if (m.attachment) body.append(fileBlock({ attachment: m.attachment, file: { kind: 'image', name: 'Attachment', mime: 'image/png', size: 0 } }));
  if (m.kind === 'post' && m.meta) body.append(postCard(m.meta));
  if (m.kind === 'track' && m.meta) body.append(trackCard(m.meta));
  if (m.kind === 'poll' && m.meta) body.append(pollBlock(m));
  if (m.kind === 'e2ee') body.append(secretText(m));
  else if (m.body && m.kind !== 'poll') body.append(h('span', { class: 'txt' }, linkify(m.body)));
  body.append(h('time', { datetime: new Date(m.at).toISOString() }, m.kind === 'e2ee' ? icon('lock', 11) : null, timeOf(m.at)));
  const acts = h('div', { class: 'm-acts' });
  if (m.body && m.kind !== 'e2ee') acts.append(sq('file', 'Copy text', { class: 'ghost', onclick: () => navigator.clipboard?.writeText(m.body).then(() => toast('Copied')) }));
  if (view.kind === 'channel' && (mine || view.canModerate)) acts.append(sq('trash', 'Delete message', { class: 'ghost', onclick: async () => { if (await ask.confirm('Delete this message?', { yes: 'Delete', danger: true })) api('/api/channel-message-delete', { body: { channel: view.id, id: m.id } }).catch(fail); } }));
  const slot = mine || view.kind === 'dm' && !cont ? null : null;
  const avatar = !mine ? (cont ? h('span', { class: 'pfp-slot' }) : Object.assign(avatarEl(m.avatar ?? view.data?.peer?.avatar, name, 34), { onclick: open })) : null;
  if (avatar && !cont) avatar.classList.add('clickable');
  const rowEl = h('div', { class: `mrow${mine ? ' mine' : ''}${cont ? ' cont' : ''}`, dataset: { id: m.id, from: m.from ?? '' } }, avatar, body, acts, slot);
  body.addEventListener('click', (e) => { if (!e.target.closest('a,button,img,video,audio')) rowEl.classList.toggle('show-acts'); });
  return rowEl;
}

function fileBlock(m) {
  const f = m.file; const url = fileUrl(m.attachment);
  if (f.kind === 'image') { const img = h('img', { class: 'shot', src: url, alt: f.name, loading: 'lazy' }); img.addEventListener('load', () => scrollEnd()); img.addEventListener('click', () => lightbox(url, f.name)); return img; }
  if (f.kind === 'video') return h('video', { class: 'shot', src: url, controls: true, preload: 'metadata', playsInline: true });
  if (f.kind === 'audio') return h('audio', { src: url, controls: true, preload: 'none', style: { width: '240px', maxWidth: '100%' } });
  return h('a', { class: 'fcard', href: url, download: f.name, rel: 'noopener' }, h('span', { class: 'fi' }, icon('file', 20)), h('span', { class: 'grow' }, h('span', { class: 'fn' }, f.name), h('small', {}, fmtBytes(f.size))), icon('download', 18));
}
function lightbox(url, name) { openSheet(name, h('img', { src: url, alt: name, style: { width: '100%', borderRadius: '14px' } }), { wide: true }); }
function postCard(meta) {
  const media = meta.mk === 'reel' ? h('video', { src: fileUrl(meta.media), muted: true, preload: 'metadata', playsInline: true }) : h('img', { src: fileUrl(meta.media), alt: '', loading: 'lazy' });
  return h('button', { type: 'button', class: 'pcard', onclick: () => actions.openPost?.(meta.post) }, media, h('div', { class: 'pc-b' }, h('b', {}, meta.name ?? meta.by), h('span', {}, meta.cap || 'Shared a post')));
}
function trackCard(meta) {
  return h('div', { class: 'tcard' }, h('span', { class: 'sq' }, icon('music', 18)), h('span', { class: 'tt' }, meta.title ?? 'Track'), h('audio', { src: fileUrl(meta.upload), controls: true, preload: 'none' }));
}
function pollBlock(m) {
  const meta = m.meta; const total = (meta.counts ?? []).reduce((a, b) => a + b, 0);
  const scope = view.kind === 'channel' ? 'channel' : view.kind === 'group' ? 'group' : null;
  return h('div', { class: 'poll' }, h('b', {}, m.body), ...meta.options.map((o, i) => {
    const pct = total ? Math.round(((meta.counts?.[i] ?? 0) / total) * 100) : 0;
    const b = h('button', { type: 'button', class: `opt${meta.mine === i ? ' mine' : ''}`, onclick: async () => { if (!scope) return; try { const r = await api('/api/poll/vote', { body: { scope, id: m.id, choice: i } }); m.meta.counts = r.counts; m.meta.mine = i; replace(m); } catch (e) { fail(e); } } }, h('i', { style: { width: `${pct}%` } }), h('span', {}, o), h('span', {}, `${meta.counts?.[i] ?? 0}`));
    return b;
  }), h('small', { class: 'hint' }, `${total} vote${total === 1 ? '' : 's'}`));
}
function replace(m) {
  const old = els.log?.querySelector(`[data-id="${m.id}"]`);
  if (!old) return;
  const i = view.msgs.findIndex((x) => x.id === m.id);
  old.replaceWith(renderMessage(m, i > 0 ? view.msgs[i - 1] : null));
}
function secretText(m) {
  const span = h('span', { class: 'txt' }, h('em', { class: 'hint' }, 'Decrypting...'));
  (async () => {
    try {
      if (DEC.has(m.id)) return span.replaceChildren(...linkify(DEC.get(m.id)));
      await ensureE2ee();
      const text = await e2ee.decryptText(m.body, async (id) => { const peerName = m.mine ? view.id : m.from; const k = await peerKey(peerName); if (k?.id === id) return k.jwk; const k2 = await peerKey(peerName, true); return k2?.id === id ? k2.jwk : null; });
      DEC.set(m.id, text); span.replaceChildren(...linkify(text));
    } catch { span.replaceChildren(h('em', { class: 'hint' }, 'Cannot decrypt this message on this device.')); }
  })();
  return span;
}

/* ------------------------------------------------------------------ composing */
function sync() { if (els.send) els.send.disabled = !(els.input.value.trim() || pending.some((p) => p.id)) || pending.some((p) => p.busy); }
async function addFiles(files) {
  if (!view.kind || !view.canPost) return;
  if (view.secret) return toast('Files are not end-to-end encrypted. Turn secret mode off to send files.', { kind: 'error' });
  for (const file of files.slice(0, 10)) {
    if (file.size > 25 * 1048576) { toast(`${file.name} is over 25 MB.`, { kind: 'error' }); continue; }
    const p = { file, id: null, busy: true, bar: h('i', {}) };
    p.el = h('span', { class: 'pend' }, h('span', {}, file.name.length > 22 ? `${file.name.slice(0, 20)}...` : file.name), h('span', { class: 'bar' }, p.bar), sq('close', 'Remove', { class: 'sm ghost', onclick: () => { pending.splice(pending.indexOf(p), 1); p.el.remove(); els.pend.hidden = !pending.length; sync(); } }));
    pending.push(p); els.pend.hidden = false; els.pend.append(p.el); sync();
    upload(`kind=attachment&name=${encodeURIComponent(file.name)}`, file, (x) => { p.bar.style.width = `${Math.round(x * 100)}%`; })
      .then((d) => { p.id = d.id; p.busy = false; p.bar.style.width = '100%'; sync(); })
      .catch((e) => { toast(e.message, { kind: 'error' }); pending.splice(pending.indexOf(p), 1); p.el.remove(); els.pend.hidden = !pending.length; sync(); });
  }
}

async function post(body, attachment, kind) {
  if (view.kind === 'dm') return api('/api/messages', { body: { to: view.id, body, attachment, ...(kind ? { kind } : {}) } });
  if (view.kind === 'group') return api('/api/group-messages', { body: { group: view.id, body, attachment } });
  return api('/api/channel-messages', { body: { channel: view.id, body, attachment } });
}
async function send() {
  if (!view.kind || els.send.disabled) return;
  const text = els.input.value.trim();
  const files = pending.filter((p) => p.id);
  els.send.disabled = true; els.err.textContent = '';
  try {
    if (view.secret && text) {
      await ensureE2ee();
      const k = await peerKey(view.id, true);
      if (!k) throw new Error('This person has no secret-chat key.');
      view.peerKey = k;
      await post(await e2ee.encryptText(k.jwk, k.id, text), null, 'e2ee');
    } else {
      let first = true;
      if (!files.length) await post(text, null);
      for (const f of files) { await post(first ? text : '', f.id); first = false; }
    }
    els.input.value = ''; els.input.style.height = 'auto';
    pending.splice(0).forEach((p) => p.el.remove()); els.pend.hidden = true;
  } catch (e) { els.err.textContent = e.message; }
  sync();
  if (!matchMedia('(pointer: coarse)').matches) els.input.focus();
}

/* ------------------------------------------------------------------ live events */
const notifyBrowser = (title, body, tag) => {
  const p = state.privacy;
  if (typeof Notification === 'undefined' || !p || p.dnd || !document.hidden || Notification.permission !== 'granted') return;
  try { new Notification(title, { body: p.previews ? String(body).slice(0, 120) : 'New message', tag }); } catch { /* unsupported */ }
};
const refresh = debounce(() => actions.refreshLists?.(), 150);

function incoming(kind, id, m, label) {
  const k = `${kind}:${id}`;
  const here = view.kind === kind && String(view.id) === String(id);
  const muted = state.mutes.has(k);
  if (!m.mine && m.from !== state.user) {
    if (!muted) { ping(kind, id); notifyBrowser(label ?? m.name ?? m.from, m.kind === 'e2ee' ? 'New secret message' : m.body || 'Sent a file', k); }
    if (kind === 'channel' && !here) { state.unreadCh.add(Number(id)); }
  }
  if (here) {
    addMessage(m);
    if (kind === 'dm' && m.from !== state.user) api(`/api/messages?with=${encodeURIComponent(id)}`).then(() => refresh()).catch(() => {});
  }
  refresh();
}

export function initChat() {
  state.unreadCh = new Set();
  actions.openDM = (u) => { closeSheets(); actions.selectSpace?.(null, { keepView: true }); return open('dm', String(u).toLowerCase()); };
  actions.openGroup = (id) => { closeSheets(); actions.selectSpace?.(null, { keepView: true }); return open('group', id); };
  actions.openChannel = (id) => { closeSheets(); return open('channel', id); };
  actions.closeThread = closeThread;
  actions.currentView = () => ({ ...state.view });
  actions.refreshThread = () => view.kind && open(view.kind, view.id);
  actions.headerRepaint = paintHeader;
  buildIdle();
  bus.on('sse:message', (m) => {
    if (m.group) return incoming('group', m.group, { ...m, mine: m.from === state.user }, m.name);
    const peer = m.to ?? m.from;
    incoming('dm', peer, { ...m, mine: m.from === state.user, name: m.name }, m.name);
  });
  bus.on('sse:channel-message', (m) => incoming('channel', m.channel, { ...m, mine: m.from === state.user }, m.name));
  bus.on('sse:channel-delete', (m) => { if (view.kind === 'channel' && view.id === m.channel) { els.log?.querySelector(`[data-id="${m.id}"]`)?.remove(); view.msgs = view.msgs.filter((x) => x.id !== m.id); } });
  bus.on('sse:group', (g) => { if (view.kind === 'group' && view.id === g.id) actions.refreshThread?.(); refresh(); });
  bus.on('sse:community', (c) => { if (view.kind === 'channel' && view.data?.channel.communityId === c.id) open('channel', view.id).catch(() => {}); });
  bus.on('sse:poll', () => { if (view.kind === 'channel' || view.kind === 'group') actions.refreshThread?.(); });
  bus.on('room:state', () => paintHeader());
}
