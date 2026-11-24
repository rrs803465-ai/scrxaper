// Spaces: the Discord-style server bar, the side pane (DMs + groups, or a community's channels), create/join/discover, community + group management.
import { $, state, bus, actions, h, clear, icon, sq, setBadge, avatarEl, roleTag, api, toast, fail, ask, openSheet, closeSheets, ago, toggle, select, segmented, form, field, section, hint, row, empty, chip, debounce, pickFile, upload, fileUrl, ICON_NAMES } from './core.js';
import { botPicker } from './studio.js';

const S = { spaces: [], groups: [], convos: [], cdata: null, rooms: new Map(), tab: 'chats', q: '' };
const badgeFor = { notifications: 0, friendRequests: 0 };
const isMobile = () => matchMedia('(max-width: 760px)').matches;

/* ------------------------------------------------------------------ drag to reorder (pointer based, works for mouse and touch) */
export function sortable(container, { selector, axis = 'y', onDone, handle }) {
  container.addEventListener('pointerdown', (down) => {
    const el = down.target.closest(selector);
    if (!el || down.button > 0 || (handle && !down.target.closest(handle))) return;
    const items = () => [...container.querySelectorAll(selector)];
    const startX = down.clientX; const startY = down.clientY;
    const touch = down.pointerType === 'touch';
    let active = false; let timer;
    const begin = () => {
      active = true; el.classList.add('dragging'); el.setPointerCapture?.(down.pointerId);
      if (navigator.vibrate) navigator.vibrate(8);
    };
    if (touch) timer = setTimeout(begin, 280);
    const move = (e) => {
      const dx = e.clientX - startX; const dy = e.clientY - startY;
      if (!active) { if (!touch && Math.hypot(dx, dy) > 6) begin(); else if (touch && Math.hypot(dx, dy) > 8) { clearTimeout(timer); cleanup(); } else return; }
      e.preventDefault();
      el.style.transform = axis === 'y' ? `translateY(${dy}px)` : `translateX(${dx}px)`;
      el.style.zIndex = 5;
      items().forEach((o) => o.classList.remove('drop-before', 'drop-after'));
      const t = target(e); if (t) t.el.classList.add(t.before ? 'drop-before' : 'drop-after');
    };
    const target = (e) => {
      const others = items().filter((o) => o !== el);
      for (const o of others) { const r = o.getBoundingClientRect(); const mid = axis === 'y' ? r.top + r.height / 2 : r.left + r.width / 2; const p = axis === 'y' ? e.clientY : e.clientX; if (p < mid) return { el: o, before: true }; }
      return others.length ? { el: others.at(-1), before: false } : null;
    };
    const cleanup = () => { clearTimeout(timer); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    const up = (e) => {
      cleanup();
      if (!active) return;
      const t = target(e);
      items().forEach((o) => o.classList.remove('drop-before', 'drop-after'));
      el.classList.remove('dragging'); el.style.transform = ''; el.style.zIndex = '';
      if (t) { t.before ? t.el.before(el) : t.el.after(el); onDone(items().map((o) => o.dataset.id)); }
      el.addEventListener('click', (c) => c.stopImmediatePropagation(), { once: true, capture: true });
    };
    window.addEventListener('pointermove', move, { passive: false }); window.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}

/* ------------------------------------------------------------------ data */
export async function refreshLists() {
  const [spaces, groups, convos] = await Promise.all([api('/api/communities'), api('/api/groups'), api('/api/conversations')]).catch((e) => { fail(e); return [S.spaces, S.groups, S.convos]; });
  Object.assign(S, { spaces, groups, convos });
  paintServers();
  if (state.community) await loadCommunity(state.community, true); else paintSide();
  const unread = convos.reduce((n, c) => n + (c.unread || 0), 0);
  bus.emit('unread', unread);
  paintTabbar();
}
const loadCommunity = async (id, quiet) => {
  try { S.cdata = await api(`/api/community?id=${id}`); } catch (e) { if (!quiet) fail(e); state.community = null; S.cdata = null; if (e.status === 404 || e.status === 403) paintServers(); }
  paintSide();
};

/* ------------------------------------------------------------------ server bar */
function spaceBtn(c) {
  const b = h('button', { type: 'button', class: 'srv', dataset: { id: c.id }, 'aria-label': c.name, title: c.name, 'aria-current': String(state.community === c.id), onclick: () => selectSpace(c.id) }, avatarEl(c.icon, c.name, 48, true));
  return b;
}
export function paintServers() {
  const bar = $('servers');
  const home = h('button', { type: 'button', class: 'srv', 'aria-label': 'Home', title: 'Home', 'aria-current': String(state.community === null), onclick: () => selectSpace(null) }, sq('home', 'Home', { class: `lg${state.community === null ? ' on' : ''}`, tabindex: -1, onclick: (e) => { e.stopPropagation(); selectSpace(null); } }));
  setBadge(home, S.convos.reduce((n, c) => n + (c.unread || 0), 0));
  const list = h('div', { class: 'srv-list', style: { display: 'contents' } }, ...S.spaces.map(spaceBtn));
  const tail = h('div', { class: 'tail' },
    sq('explore', 'Explore', { onclick: () => actions.openExplore?.() }), sq('reels', 'Feed and reels', { onclick: () => actions.openFeed?.('feed') }),
    ...(isMobile() ? [] : [sq('users', 'Friends', { class: 'fr', onclick: () => actions.openFriends?.() }), sq('bell', 'Notifications', { class: 'nt', onclick: () => actions.openNotifications?.() }), sq('bot', 'Buddy', { onclick: () => actions.openBuddy?.() })]),
    ...(['owner', 'admin', 'staff'].includes(state.me.role) ? [sq('shield', 'Site panel', { onclick: () => actions.openOwner?.() })] : []),
    ...(isMobile() ? [] : [sq('sparkle', 'Studio', { onclick: () => actions.openStudio?.() })]));
  clear(bar, home, h('span', { class: 'sep' }), list, sq('plus', 'Create, join or discover', { class: 'lg add', onclick: () => createSheet() }), tail);
  setBadge(tail.querySelector('.fr') ?? h('i'), badgeFor.friendRequests); setBadge(tail.querySelector('.nt') ?? h('i'), badgeFor.notifications);
  sortable(list, { selector: '.srv', axis: isMobile() ? 'x' : 'y', onDone: (ids) => { S.spaces.sort((a, b) => ids.indexOf(String(a.id)) - ids.indexOf(String(b.id))); api('/api/communities/reorder', { body: { order: ids.map(Number) } }).catch(fail); } });
}
export async function selectSpace(id, { keepView = false } = {}) {
  state.community = id ?? null;
  S.cdata = null; S.tab = 'chats';
  paintServers();
  if (id) await loadCommunity(id); else paintSide();
  if (!keepView && !isMobile()) { /* keep the open conversation visible beside the new list */ }
  paintTabbar();
}

/* ------------------------------------------------------------------ side pane */
const paintSide = () => { const side = $('side'); clear(side, state.community && S.cdata ? communitySide() : homeSide(), meBar()); };

function homeSide() {
  const q = S.q.trim().toLowerCase();
  const search = h('input', { type: 'search', placeholder: 'Search people, messages, tags', 'aria-label': 'Search', value: S.q, autocomplete: 'off' });
  search.addEventListener('input', () => { S.q = search.value; paintList(); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && search.value.trim().length >= 2) globalSearch(search.value.trim()); });
  const list = h('div', { class: 'side-scroll', id: 'side-list' });
  const head = h('div', { class: 'side-head' }, h('h2', {}, 'Messages'), sq('users', 'Friends', { class: 'sm', badge: badgeFor.friendRequests, onclick: () => actions.openFriends?.() }), sq('plus', 'New message, group or invite', { class: 'sm', onclick: () => createSheet('message') }));
  const frag = h('div', { class: 'side-frag', style: { display: 'contents' } }, head, h('div', { class: 'side-search' }, search), list);
  queueMicrotask(paintList);
  return frag;
}
function paintList() {
  const list = $('side-list'); if (!list) return;
  const q = S.q.trim().toLowerCase();
  const convos = S.convos.filter((c) => !q || c.displayName.toLowerCase().includes(q) || c.username.includes(q));
  const groups = S.groups.filter((g) => !q || g.name.toLowerCase().includes(q));
  const cur = state.view;
  const dm = (c) => { const b = h('button', { type: 'button', class: 'item', 'aria-current': String(cur.kind === 'dm' && cur.id === c.username), onclick: () => actions.openDM(c.username) }, avatarEl(c.avatar, c.displayName, 40), h('span', { class: 't' }, c.displayName, roleTag(c.tag)), h('span', { class: 's' }, `${c.mine ? 'You: ' : ''}${c.body}`)); if (c.unread) b.append(h('span', { class: 'badge' }, c.unread > 99 ? '99+' : c.unread)); return b; };
  const grp = (g) => { const inRoom = S.rooms.get(`gc:${g.id}`)?.people?.length; const b = h('button', { type: 'button', class: 'item', 'aria-current': String(cur.kind === 'group' && cur.id === g.id), onclick: () => actions.openGroup(g.id) }, avatarEl(g.icon, g.name, 40, true), h('span', { class: 't' }, g.name), h('span', { class: 's' }, inRoom ? `${inRoom} in a call` : `${g.members} members${g.body ? ` · ${g.body}` : ''}`)); if (inRoom) b.append(h('span', { class: 'badge' }, icon('call', 12))); return b; };
  clear(list, ...(groups.length ? [h('div', { class: 'side-label' }, 'Groups'), ...groups.map(grp)] : []), ...(convos.length ? [h('div', { class: 'side-label' }, 'Direct messages'), ...convos.map(dm)] : []),
    ...(!groups.length && !convos.length ? [empty(q ? 'Nothing matches that.' : 'No conversations yet. Press + to say hello.', 'chat')] : []));
}

function communitySide() {
  const d = S.cdata; const rank = { member: 0, moderator: 1, admin: 2, owner: 3 }[d.role] ?? 0;
  const mine = rank >= 2 || d.myPerms.includes('channels');
  const head = h('div', { class: 'side-head' }, h('h2', {}, d.community.name), mine ? sq('plus', 'New channel', { class: 'sm', onclick: () => newChannel(d) }) : null, sq('more', 'Community settings', { class: 'sm', onclick: () => actions.openCommunitySettings(d.community.id) }));
  const list = h('div', { class: 'side-scroll' });
  const cur = state.view;
  const chans = d.channels;
  const text = chans.filter((c) => c.kind !== 'voice'); const voice = chans.filter((c) => c.kind === 'voice');
  const textItem = (c) => h('button', { type: 'button', class: `item ch${state.unreadCh?.has(c.id) ? ' unread' : ''}`, dataset: { id: c.id }, 'aria-current': String(cur.kind === 'channel' && cur.id === c.id), onclick: () => actions.openChannel(c.id) }, icon(c.kind === 'announcement' ? 'bell' : c.private ? 'lock' : 'hash', 17), h('span', { class: 't' }, c.name), c.readOnly ? h('span', { class: 'hint' }, icon('lock', 12)) : null);
  const voiceItem = (c) => {
    const key = `vc:${c.id}`; const r = S.rooms.get(key); const here = actions.currentRoom?.() === key;
    const wrap = h('div', { class: 'voice-item', dataset: { id: c.id } }, h('button', { type: 'button', class: 'item ch', 'aria-current': String(here), onclick: () => actions.joinRoom?.(key, { video: false }) }, icon('speaker', 17), h('span', { class: 't' }, c.name), r?.people?.length ? h('span', { class: 'hint' }, String(r.people.length)) : null));
    if (r?.people?.length) wrap.append(h('div', { class: 'voice-people' }, ...r.people.map((p) => h('div', { class: 'vp' }, avatarEl(p.avatar, p.name, 22), h('span', {}, p.name), p.muted ? icon('micoff', 13) : null))));
    return wrap;
  };
  const tl = h('div', { class: 'chan-list' }, ...text.map(textItem)); const vl = h('div', { class: 'chan-list' }, ...voice.map(voiceItem));
  clear(list, h('div', { class: 'side-label' }, 'Text channels'), tl, ...(voice.length ? [h('div', { class: 'side-label' }, 'Voice channels'), vl] : []),
    ...(d.bots?.length ? [h('div', { class: 'side-label' }, 'Bots'), h('div', { class: 'inline' }, ...d.bots.map((b) => chip(b)))] : []));
  if (mine) { sortable(tl, { selector: '.item', onDone: (ids) => saveChannelOrder(d, ids, 'text') }); sortable(vl, { selector: '.voice-item', onDone: (ids) => saveChannelOrder(d, ids, 'voice') }); }
  return h('div', { class: 'side-frag', style: { display: 'contents' } }, head, list);
}
const saveChannelOrder = (d, ids, which) => {
  const text = d.channels.filter((c) => c.kind !== 'voice').map((c) => String(c.id)); const voice = d.channels.filter((c) => c.kind === 'voice').map((c) => String(c.id));
  const order = which === 'text' ? [...ids, ...voice] : [...text, ...ids];
  api('/api/channels/reorder', { body: { community: d.community.id, order: order.map(Number) } }).catch(fail);
};
function newChannel(d) {
  let kind = 'text';
  const sh = openSheet('New channel', form(async (v) => { await api('/api/channels', { body: { community: d.community.id, name: v.name, kind, private: !!v.private, readOnly: !!v.readOnly, topic: v.topic } }); sh.close(); refreshLists(); },
    h('div', { class: 'stack' }, segmented([['text', 'Text', 'hash'], ['announcement', 'Announcements', 'bell'], ['voice', 'Voice', 'speaker']], 'text', (v) => { kind = v; }), field('name', 'channel-name', { required: true, maxLength: 30, autofocus: true }), field('topic', 'Topic (optional)', { maxLength: 200 }),
      toggle('private', 'Staff only'), toggle('readOnly', 'Read-only for members'), h('button', { class: 'primary', type: 'submit' }, 'Create channel'))));
}

function meBar() {
  const me = state.me;
  const bar = h('div', { class: 'me-bar' }, h('button', { type: 'button', class: 'who', onclick: () => actions.openProfile?.(state.user) }, avatarEl(me.avatar, me.displayName, 36), h('span', { class: 'grow' }, h('b', {}, me.displayName), h('small', {}, `@${me.username}`))), sq('sparkle', 'Studio', { class: 'sm', onclick: () => actions.openStudio?.() }));
  const key = actions.currentRoom?.();
  if (key) {
    const r = S.rooms.get(key);
    return h('div', { style: { display: 'contents' } }, h('div', { class: 'voice-bar' }, icon('speaker', 16), h('button', { type: 'button', class: 'link grow', onclick: () => actions.showRoom?.() }, `Connected${r ? ` · ${r.people.length}` : ''}`), sq('endcall', 'Leave call', { class: 'sm red', onclick: () => actions.leaveRoom?.() })), bar);
  }
  return bar;
}

/* ------------------------------------------------------------------ mobile tab bar */
export function paintTabbar() {
  const tab = (id, ic, label, fn, badge) => { const b = h('button', { type: 'button', class: 'tb', 'aria-current': String(S.tab === id), onclick: () => { S.tab = 'chats'; fn(); paintTabbar(); } }, sq(ic, label, { tabindex: -1, badge, 'aria-hidden': 'true' }), h('span', {}, label)); return b; };
  const unread = S.convos.reduce((n, c) => n + (c.unread || 0), 0);
  clear($('tabbar'), tab('chats', 'chat', 'Chats', () => { closeSheets(); actions.closeThread?.(); selectSpace(state.community); }, unread), tab('feed', 'reels', 'Feed', () => actions.openFeed?.('feed')), tab('explore', 'explore', 'Explore', () => actions.openExplore?.()),
    tab('alerts', 'bell', 'Alerts', () => actions.openNotifications?.(), badgeFor.notifications + badgeFor.friendRequests), tab('me', 'sparkle', 'Studio', () => actions.openStudio?.()));
}

/* ------------------------------------------------------------------ create / join / discover */
const installBots = async (scope, id, picked) => { for (const b of picked) await api('/api/bots/install', { body: { scope, id, bot: b.bot, config: b.config } }).catch((e) => toast(`${b.bot}: ${e.message}`, { kind: 'error' })); };
export function createSheet(start = 'community') {
  const sh = openSheet('Create or join', null, { key: 'create' });
  const paint = (tab) => {
    const body = h('div', { class: 'stack' });
    const seg = segmented([['message', 'Message', 'chat'], ['group', 'Group', 'users'], ['community', 'Community', 'grid'], ['join', 'Join', 'link'], ['discover', 'Discover', 'globe']], tab, paint);
    if (tab === 'message') {
      const results = h('div', { class: 'stack-gap' });
      const input = field('to', 'Username or name', { autofocus: true, autocapitalize: 'none' });
      const find = debounce(async () => { const v = input.value.trim(); if (v.length < 2) return clear(results); try { const r = await api(`/api/search?q=${encodeURIComponent(v)}`); clear(results, ...r.people.map((p) => h('button', { type: 'button', class: 'item', onclick: () => { sh.close(); actions.openDM(p.username); } }, avatarEl(p.avatar, p.name, 40), h('span', { class: 't' }, p.name), h('span', { class: 's' }, `@${p.username}`)))); } catch { /* ignore */ } }, 250);
      input.addEventListener('input', find);
      append2(body, form(async (v) => { const u = v.to.trim().toLowerCase().replace(/^@/, ''); if (u) { sh.close(); actions.openDM(u); } }, h('div', { class: 'inline' }, input, h('button', { class: 'primary', type: 'submit' }, 'Open'))), results, hint('Type a username to start a conversation. You can also add friends from their profile.'));
    } else if (tab === 'group') {
      const picker = botPicker();
      append2(body, form(async (v) => { const members = v.members.split(/[,\s]+/).map((s) => s.replace(/^@/, '')).filter(Boolean); const g = await api('/api/groups', { body: { name: v.name, members } }); await installBots('group', g.id, picker.value()); sh.close(); await refreshLists(); actions.openGroup(g.id); },
        h('div', { class: 'stack' }, field('name', 'Group name', { required: true, maxLength: 60, autofocus: true }), field('members', 'Add people (usernames, comma separated)'), section('Premade bots', hint('Optional. Admins can add or remove bots later.'), picker.el), h('button', { class: 'primary', type: 'submit' }, 'Create group'))));
    } else if (tab === 'community') {
      const picker = botPicker();
      append2(body, form(async (v) => { const c = await api('/api/communities', { body: { name: v.name, description: v.description } }); await installBots('community', c.id, picker.value()); sh.close(); await refreshLists(); selectSpace(c.id); toast('Community created', { kind: 'ok' }); },
        h('div', { class: 'stack' }, field('name', 'Community name', { required: true, maxLength: 60, autofocus: true }), field('description', 'What is it about? (optional)', { maxLength: 300 }), section('Premade bots', hint('Security, music and more. Pick any now; they run inside Scrxaper with no tokens.'), picker.el), h('button', { class: 'primary', type: 'submit' }, 'Create community'))));
    } else if (tab === 'join') {
      append2(body, form(async (v) => { const code = v.code.trim(); try { const { id } = await api('/api/group-join', { body: { code } }); sh.close(); await refreshLists(); actions.openGroup(id); } catch { const { id } = await api('/api/community-join', { body: { code } }); sh.close(); await refreshLists(); selectSpace(id); } },
        h('div', { class: 'stack' }, field('code', 'Invite code', { required: true, autofocus: true }), h('button', { class: 'primary', type: 'submit' }, 'Join'))), hint('Paste an invite code for a group or a community.'));
    } else discover(body, sh);
    clear(sh.body, h('div', { class: 'stack' }, h('div', { class: 'scroll-x' }, seg), body));
  };
  paint(start);
}
const append2 = (node, ...kids) => { kids.forEach((k) => node.append(k)); return node; };
async function discover(body, sh, q = '') {
  const r = await api(`/api/discover?q=${encodeURIComponent(q)}`).catch((e) => { fail(e); return { communities: [], groups: [] }; });
  const card = (kind, it) => row(avatarEl(it.icon, it.name, 42, true), h('span', { class: 'grow' }, h('strong', {}, it.name), h('br'), h('small', {}, `${it.members} members${it.description ? ` · ${it.description}` : ''}`)),
    h('button', { class: it.joined ? 'ghost mini' : 'primary mini', type: 'button', onclick: async () => { try { if (!it.joined) await api('/api/discover/join', { body: { kind, id: it.id } }); sh.close(); await refreshLists(); kind === 'community' ? selectSpace(it.id) : actions.openGroup(it.id); } catch (e) { fail(e); } } }, it.joined ? 'Open' : 'Join'));
  clear(body, form(async (v) => { await discover(body, sh, v.q); }, h('div', { class: 'inline' }, field('q', 'Search public spaces', { value: q }), h('button', { class: 'ghost', type: 'submit' }, 'Search'))),
    section('Communities', ...(r.communities.length ? r.communities.map((c) => card('community', c)) : [hint('No public communities match.')])), section('Groups', ...(r.groups.length ? r.groups.map((g) => card('group', g)) : [hint('No public groups match.')])));
}

/* ------------------------------------------------------------------ search */
async function globalSearch(q) {
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const go = (fn) => () => { closeSheets(); fn(); };
    const line = (title, sub, fn, av) => h('button', { type: 'button', class: 'item', onclick: go(fn) }, av ?? h('span', { class: 'pfp icon', style: { '--s': '40px' } }, icon('hash', 16)), h('span', { class: 't' }, title), h('span', { class: 's' }, sub));
    const sec = (t, rows) => (rows.length ? [section(t, ...rows)] : []);
    const opener = { dm: (m) => actions.openDM(m.target), group: (m) => actions.openGroup(Number(m.target)), channel: (m) => actions.openChannel(Number(m.target)) };
    const all = [...sec('People', r.people.map((p) => line(p.name, `@${p.username}`, () => actions.openProfile?.(p.username), avatarEl(p.avatar, p.name, 40)))),
      ...sec('Tags', (r.tags ?? []).map((t) => line(`#${t.tag}`, `${t.n ?? t.count ?? ''} posts`, () => actions.openTag?.(t.tag)))),
      ...sec('Groups', r.groups.map((g) => line(g.name, 'Group', () => actions.openGroup(g.id)))),
      ...sec('Communities', r.communities.map((c) => line(c.name, 'Community', () => selectSpace(c.id)))),
      ...sec('Channels', r.channels.map((c) => line(`#${c.name}`, c.community, () => actions.openChannel(c.id)))),
      ...sec('Messages', r.messages.map((m) => line(m.body.slice(0, 90), `${m.where_} · ${new Date(m.at).toLocaleDateString()}`, () => opener[m.kind]?.(m))))];
    openSheet(`Results for "${q}"`, all.length ? all : empty('Nothing found in the places you can see.', 'search'), { key: 'search' });
  } catch (e) { fail(e); }
}

/* ------------------------------------------------------------------ community settings */
const RANKS = { member: 0, moderator: 1, admin: 2, owner: 3 };
const PERMS = ['channels', 'invites', 'kick', 'timeout', 'delete_messages', 'log'];
async function communitySettings(id) {
  const d = await api(`/api/community?id=${id}`).catch((e) => { fail(e); return null; });
  if (!d) return;
  const mine = Math.max(RANKS[d.role], d.myPerms.length ? 1 : 0);
  const sh = openSheet(d.community.name, null, { key: 'community', wide: true });
  const redo = () => communitySettings(id);
  const act = (path, extra) => api(path, { body: { community: id, ...extra } }).then(redo).catch(fail);
  const tools = (m) => {
    if (m.username === state.user || RANKS[m.role] >= mine || mine < 1) return [];
    const t = [sq('clock', 'Timeout', { class: 'sm', onclick: async () => { const v = await ask.prompt('Minutes (0 clears)', '10', { title: `Timeout @${m.username}`, type: 'number' }); if (v !== null) act('/api/community-timeout', { username: m.username, minutes: v }); } }),
      sq('logout', 'Kick', { class: 'sm', onclick: async () => { if (await ask.confirm(`Remove @${m.username}?`, { yes: 'Kick', danger: true })) act('/api/community-kick', { username: m.username, reason: (await ask.prompt('Reason (logged)', '', { title: 'Reason' })) ?? '' }); } })];
    if (mine >= 2) t.push(sq('crown', 'Change role', { class: 'sm', onclick: async () => { const r = await ask.prompt('member, moderator or admin', m.role, { title: `Role for @${m.username}` }); if (r) act('/api/community-role', { username: m.username, role: r.trim().toLowerCase() }); } }),
      sq('ban', 'Ban', { class: 'sm red', onclick: async () => { if (await ask.confirm(`Ban @${m.username}?`, { yes: 'Ban', danger: true })) act('/api/community-ban', { username: m.username, reason: (await ask.prompt('Reason (logged)', '', { title: 'Reason' })) ?? '' }); } }));
    if (RANKS[d.role] >= 2 && d.roles.length) t.push(sq('star', 'Custom role', { class: 'sm', onclick: async () => { const n = await ask.prompt(`Role (${d.roles.map((r) => r.name).join(', ')}). Empty clears.`, m.customRole ?? '', { title: 'Custom role' }); if (n === null) return; const r = d.roles.find((x) => x.name.toLowerCase() === n.trim().toLowerCase()); if (n.trim() && !r) return toast('No such role', { kind: 'error' }); act('/api/community-custom-role', { username: m.username, role: r ? r.id : null }); } }));
    return t;
  };
  const admin = RANKS[d.role] >= 2;
  clear(sh.body, h('div', { class: 'profile-card' }, h('div', { class: 'pc-info' }, h('div', { class: 'inline' }, avatarEl(d.community.icon, d.community.name, 52, true), h('span', { class: 'grow' }, h('strong', {}, d.community.name), h('br'), h('small', { class: 'hint' }, d.community.description || 'No description yet.')))), h('div', { class: 'inline pc-info' },
    ...(mine >= 2 || d.myPerms.includes('invites') ? [h('button', { class: 'ghost', type: 'button', onclick: async () => { const r = await api('/api/community-invite', { body: { community: id } }); try { await navigator.clipboard.writeText(r.code); toast('Invite code copied (valid 7 days)', { kind: 'ok' }); } catch { ask.prompt('Invite code (valid 7 days)', r.code, { title: 'Invite' }); } } }, icon('link', 16), ' Invite')] : []),
    ...(admin ? [h('button', { class: 'ghost', type: 'button', onclick: () => actions.openBots?.('community', id) }, icon('bot', 16), ' Bots')] : []),
    ...(mine >= 1 || d.myPerms.includes('log') ? [h('button', { class: 'ghost', type: 'button', onclick: async () => { const log = await api(`/api/community-log?id=${id}`); openSheet('Moderation log', log.length ? log.map((l) => row(h('span', { class: 'grow' }, `${l.actor}: ${l.action} ${l.target ?? ''}`, h('br'), h('small', {}, l.detail ?? '')), h('small', {}, new Date(l.at).toLocaleString()))) : empty('Nothing has been logged yet.', 'shield')); } }, icon('shield', 16), ' Log')] : []))),
    section('Channels', ...d.channels.map((c) => row(icon(c.kind === 'voice' ? 'speaker' : c.kind === 'announcement' ? 'bell' : 'hash', 17), h('span', { class: 'grow' }, c.name, h('br'), h('small', {}, [c.kind === 'announcement' && 'announcements', c.readOnly && 'read-only', c.private && 'staff only', c.topic].filter(Boolean).join(' · '))),
      ...(c.kind === 'voice' ? [] : [sq('chat', 'Open', { class: 'sm', onclick: () => { sh.close(); actions.openChannel(c.id); } })]),
      ...(mine >= 2 || d.myPerms.includes('channels') ? [sq('edit', 'Rename', { class: 'sm', onclick: async () => { const n = await ask.prompt('Channel name', c.name, { title: 'Rename channel' }); if (n) api('/api/channel-edit', { body: { channel: c.id, name: n, topic: c.topic } }).then(redo).catch(fail); } }), sq('trash', 'Delete', { class: 'sm', onclick: async () => { if (await ask.confirm(`Delete #${c.name} and its messages?`, { yes: 'Delete', danger: true })) api('/api/channel-delete', { body: { channel: c.id } }).then(redo).catch(fail); } })] : [])))),
    section(`Members (${d.members.length})`, ...d.members.map((m) => row(Object.assign(avatarEl(m.avatar, m.name, 32), { onclick: () => actions.openProfile?.(m.username) }), h('span', { class: 'grow' }, m.name, roleTag(m.tag), h('br'), h('small', {}, `@${m.username} · ${m.role}${m.customRole ? ` · ${m.customRole}` : ''}${m.timedOut ? ' · timed out' : ''}`)), ...tools(m)))),
    ...(admin ? [section('Custom roles', ...d.roles.map((r) => row(h('span', { class: 'grow' }, r.name, h('br'), h('small', {}, r.perms.join(', '))), sq('trash', 'Delete role', { class: 'sm', onclick: () => act('/api/community-role-delete', { role: r.id }) }))),
      form((v) => act('/api/community-roles', { name: v.name, perms: PERMS.filter((p) => v[p]) }), h('div', { class: 'stack' }, field('name', 'New role name', { required: true }), h('div', { class: 'inline' }, ...PERMS.map((p) => h('label', { class: 'chip' }, h('input', { type: 'checkbox', name: p }), p.replace('_', ' ')))), h('button', { class: 'ghost', type: 'submit' }, 'Create role')))),
      section('Community profile', form((v) => act('/api/community-settings', { description: v.description, public: !!v.public }), h('div', { class: 'stack' }, field('description', 'Short description', { value: d.community.description ?? '' }), toggle('public', 'Show in Discover', !!d.community.public), h('button', { class: 'primary', type: 'submit' }, 'Save'))),
        h('div', { class: 'inline' }, h('span', { class: 'hint' }, 'Icon'), iconInput(`community-icon&id=${id}`, async () => { await refreshLists(); redo(); })))] : []),
    section('Manage', h('div', { class: 'inline' }, mine === 3 ? h('button', { class: 'danger', type: 'button', onclick: async () => { if (await ask.confirm('Delete this community and all its messages? This cannot be undone.', { yes: 'Delete', danger: true })) { await api('/api/community-delete', { body: { community: id } }).catch(fail); sh.close(); selectSpace(null); refreshLists(); } } }, 'Delete community')
      : h('button', { class: 'ghost', type: 'button', onclick: async () => { if (await ask.confirm('Leave this community?', { yes: 'Leave', danger: true })) { await api('/api/community-leave', { body: { community: id } }).catch(fail); sh.close(); selectSpace(null); refreshLists(); } } }, 'Leave community'))));
}
function iconInput(query, done) {
  return h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', 'aria-label': 'Upload icon', onchange: async (e) => { const f = e.target.files[0]; if (!f) return; try { await upload(`kind=${query}`, f); await done(); } catch (err) { fail(err); } } });
}

/* ------------------------------------------------------------------ group info */
async function groupInfo(id) {
  const d = await api(`/api/group-messages?group=${id}`).catch((e) => { fail(e); return null; });
  if (!d) return;
  const admin = d.role === 'admin'; const sh = openSheet(d.group.name, null, { key: 'group' });
  const redo = () => groupInfo(id); const act = (path, extra) => api(path, { body: { group: id, ...extra } }).then(redo).catch(fail);
  clear(sh.body, h('div', { class: 'inline' }, avatarEl(d.group.icon, d.group.name, 52, true), h('span', { class: 'grow hint' }, d.group.description || 'No description yet.')),
    h('div', { class: 'inline' }, ...(admin ? [h('button', { class: 'ghost', type: 'button', onclick: async () => { const r = await api('/api/group-invite', { body: { group: id } }); try { await navigator.clipboard.writeText(r.code); toast('Invite code copied (valid 7 days)', { kind: 'ok' }); } catch { ask.prompt('Invite code', r.code, { title: 'Invite' }); } } }, icon('link', 16), ' Invite'),
      h('button', { class: 'ghost', type: 'button', onclick: async () => { const u = await ask.prompt('Username to add', '', { title: 'Add member' }); if (u) act('/api/group-members', { username: u.trim().replace(/^@/, '') }); } }, icon('userplus', 16), ' Add'),
      h('button', { class: 'ghost', type: 'button', onclick: () => actions.openBots?.('group', id) }, icon('bot', 16), ' Bots')] : []),
      h('button', { class: 'ghost', type: 'button', onclick: async () => { if (await ask.confirm('Leave this group?', { yes: 'Leave', danger: true })) { await api('/api/group-leave', { body: { group: id } }).catch(fail); sh.close(); actions.closeThread(); refreshLists(); } } }, icon('logout', 16), ' Leave')),
    ...(admin ? [section('Settings', form((v) => act('/api/group-settings', { description: v.description, public: !!v.public }), h('div', { class: 'stack' }, field('description', 'Short description', { value: d.group.description ?? '' }), toggle('public', 'Show in Discover', !!d.group.public), h('button', { class: 'primary', type: 'submit' }, 'Save'))),
      h('div', { class: 'inline' }, h('span', { class: 'hint' }, 'Icon'), iconInput(`group-icon&id=${id}`, async () => { await refreshLists(); redo(); })))] : []),
    section(`Members (${d.members.length})`, ...d.members.map((m) => row(avatarEl(m.avatar, m.name, 32), h('span', { class: 'grow' }, m.name, roleTag(m.tag), h('br'), h('small', {}, `@${m.username} · ${m.role}`)), sq('user', 'Profile', { class: 'sm', onclick: () => actions.openProfile?.(m.username) }),
      ...(admin && m.username !== state.user ? [sq('logout', 'Remove', { class: 'sm red', onclick: async () => { if (await ask.confirm(`Remove @${m.username}?`, { yes: 'Remove', danger: true })) act('/api/group-remove', { username: m.username }); } })] : [])))));
}

/* ------------------------------------------------------------------ rooms bookkeeping (voice participants shown in the side pane) */
function trackRooms() {
  bus.on('sse:room', (e) => { if (e.type === 'closed' || !e.people?.length) S.rooms.delete(e.room); else S.rooms.set(e.room, e); paintSideSoft(); });
  bus.on('room:state', () => paintSideSoft());
  api('/api/rooms').then((list) => { list.forEach((r) => S.rooms.set(r.room, r)); paintSideSoft(); }).catch(() => {});
}
const paintSideSoft = debounce(() => { paintSide(); }, 60);

export function initSpaces() {
  actions.selectSpace = selectSpace; actions.refreshLists = refreshLists; actions.refreshAll = refreshLists; actions.openCommunitySettings = communitySettings; actions.openGroupInfo = groupInfo; actions.goHome = () => selectSpace(null); actions.createSheet = createSheet;
  bus.on('badges', (b) => { Object.assign(badgeFor, b); paintServers(); paintTabbar(); paintSideSoft(); });
  bus.on('view', () => { paintList(); });
  bus.on('sse:community', () => refreshLists());
  matchMedia('(max-width: 760px)').addEventListener?.('change', () => { paintServers(); paintTabbar(); });
  trackRooms();
}
