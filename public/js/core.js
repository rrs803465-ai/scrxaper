// Shared client core: DOM helpers, icons, sheets, dialogs, toasts, API, sounds, theming.
// Every feature module imports from here and registers its entry points on `actions`.
export const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ state + bus */
export const state = {
  me: null, // full /api/me payload
  user: null, // my username
  // what the main pane shows: { kind: 'dm'|'group'|'channel'|null, id }
  view: { kind: null, id: null },
  community: null, // selected community id (null = home)
  mutes: new Set(), ignored: new Set(), sound: null, privacy: null, prefs: null,
};
const listeners = new Map();
export const bus = {
  on(name, fn) { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(fn); return () => listeners.get(name)?.delete(fn); },
  emit(name, data) { for (const fn of listeners.get(name) ?? []) { try { fn(data); } catch (e) { console.error(name, e); } } },
};
// Entry points other modules can call. Modules assign their own: actions.openProfile = ...
export const actions = {};

/* ------------------------------------------------------------------ DOM */
export const h = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') { if (typeof v === 'string') node.style.cssText = v; else for (const [p, val] of Object.entries(v)) p.startsWith('--') ? node.style.setProperty(p, val) : (node.style[p] = val); }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role') node.setAttribute(k, v === true ? '' : v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  append(node, kids);
  return node;
};
export const append = (node, kids) => {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    node.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return node;
};
export const clear = (node, ...kids) => { node.replaceChildren(); return append(node, kids); };

/* ------------------------------------------------------------------ icons (minimal line symbols, no emoji) */
const P = {
  chat: 'M4 5h16v11H9l-5 4z', users: 'M9 11a3 3 0 100-6 3 3 0 000 6zM3 19c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 010 6M18 14c2 .5 3 2 3 5',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z', feed: 'M4 5h16v6H4zM4 14h16v5H4z', reels: 'M5 4h14v16H5zM10 9l5 3-5 3z',
  explore: 'M12 3a9 9 0 100 18 9 9 0 000-18zM15.5 8.5l-2 5-5 2 2-5z', bell: 'M6 16V11a6 6 0 0112 0v5l2 2H4zM10 20a2 2 0 004 0',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  bot: 'M6 8h12v10H6zM12 4v4M9 13h.01M15 13h.01M3 12v3M21 12v3', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18', back: 'M15 5l-7 7 7 7', send: 'M4 12l16-8-6 16-3-7z', attach: 'M20 11l-8 8a5 5 0 01-7-7l9-9a3.5 3.5 0 015 5l-9 9a2 2 0 01-3-3l8-8',
  call: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z', video: 'M3 7h12v10H3zM15 11l6-3v8l-6-3z',
  mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM6 11a6 6 0 0012 0M12 17v4', micoff: 'M4 4l16 16M9 6a3 3 0 016 0v5M15 14a3 3 0 01-6-2M6 11a6 6 0 009 5M12 17v4',
  camoff: 'M4 4l16 16M3 7h9M15 11l6-3v8M15 10v7H5', screen: 'M3 5h18v11H3zM8 20h8M12 16v4', endcall: 'M3 14c5-5 13-5 18 0l-3 3-3-2v-2c-2-.7-4-.7-6 0v2l-3 2z',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16', speaker: 'M4 10v4h4l5 4V6l-5 4zM17 9a4 4 0 010 6M19.5 6.5a8 8 0 010 11', lock: 'M6 11h12v9H6zM8 11V8a4 4 0 018 0v3',
  settings: 'M12 9a3 3 0 100 6 3 3 0 000-6zM4 12l2-.5.8-1.8-1.2-1.7L7 6.2l1.7 1.2L10.500 6.600 11 4h2l.5 2.500 1.800.8 1.700-1.200 1.400 1.400-1.200 1.700.8 1.800L20 12v0l-2 .5-.8 1.800 1.200 1.700-1.400 1.400-1.700-1.200-1.800.8L13 20h-2l-.5-2.500-1.800-.8-1.700 1.200-1.400-1.400 1.200-1.700-.8-1.800z',
  search: 'M11 4a7 7 0 100 14 7 7 0 000-14zM16 16l4 4', more: 'M5 12h.01M12 12h.01M19 12h.01', heart: 'M12 20S4 15 4 9.500A4.500 4.500 0 0112 7a4.500 4.500 0 018 2.500C20 15 12 20 12 20z',
  comment: 'M4 5h16v11H11l-4 4v-4H4z', share: 'M13 4l7 7-7 7v-4c-6 0-9 2-9 5 0-6 3-10 9-11z', music: 'M9 18V6l10-2v12M9 18a3 3 0 11-3-3 3 3 0 013 3zM19 16a3 3 0 11-3-3 3 3 0 013 3z',
  play: 'M7 5l12 7-12 7z', pause: 'M7 5h3v14H7zM14 5h3v14h-3z', skip: 'M6 5l9 7-9 7zM18 5v14', check: 'M5 12l5 5 9-10', trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  reply: 'M9 8L4 13l5 5M4 13h10a6 6 0 016 6', edit: 'M4 20l1-4L16 5l3 3L8 19z', link: 'M10 14a4 4 0 005.500 0l3-3a4 4 0 00-5.500-5.500L12 7M14 10a4 4 0 00-5.500 0l-3 3a4 4 0 005.500 5.500L12 17', image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4', download: 'M12 4v11M7 11l5 5 5-5M5 20h14', star: 'M12 4l2.400 5 5.600.7-4 4 1 5.600L12 16.500 7 19.300l1-5.600-4-4 5.600-.7z', crown: 'M4 8l4 4 4-6 4 6 4-4-2 11H6z',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 20c0-4 3-6 7-6s7 2 7 6', userplus: 'M10 12a4 4 0 100-8 4 4 0 000 8zM3 20c0-4 3-6 7-6s5 1 6 2M19 8v6M16 11h6', ban: 'M12 3a9 9 0 100 18 9 9 0 000-18zM6 6l12 12',
  key: 'M8 14a4 4 0 110-8 4 4 0 010 8zM11 11l9 9M16 16l2-2', moon: 'M20 14A8 8 0 0110 4a8 8 0 1010 10z', drag: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  home: 'M4 11l8-7 8 7M6 10v10h12V10', smile: 'M12 3a9 9 0 100 18 9 9 0 000-18zM8 14c1 2 2 3 4 3s3-1 4-3M9 9h.01M15 9h.01', wave: 'M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0',
  dice: 'M4 4h16v16H4zM9 9h.01M15 9h.01M12 12h.01M9 15h.01M15 15h.01', logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9', eye: 'M2 12c3-5 6-7 10-7s7 2 10 7c-3 5-6 7-10 7S5 17 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7', chevron: 'M9 6l6 6-6 6', chevdown: 'M6 9l6 6 6-6', trophy: 'M7 4h10v5a5 5 0 01-10 0zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3M12 14v4M8 20h8',
  cut: 'M6 6l12 12M6 18L18 6M5 5a2 2 0 100 .01M5 19a2 2 0 100 .01', scissors: 'M6 6l12 12M6 18L18 6', clock: 'M12 4a8 8 0 100 16 8 8 0 000-16zM12 8v4l3 2', globe: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  disc: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 10a2 2 0 100 4 2 2 0 000-4z', gift: 'M4 9h16v4H4zM6 13v7h12v-7M12 9v11M12 9c-3 0-4-4-1-4 2 0 1 4 1 4zM12 9c3 0 4-4 1-4-2 0-1 4-1 4z',
  flame: 'M12 3c1 4 5 5 5 10a5 5 0 01-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-9z', phoneoff: 'M4 4l16 16M5 4h4l2 5-2.500 1.500', refresh: 'M20 5v5h-5M4 19v-5h5M18 10a7 7 0 00-12-2M6 14a7 7 0 0012 2',
  mail: 'M3 6h18v12H3zM3 7l9 7 9-7', info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 8h.01', folder: 'M3 6h6l2 2h10v11H3z', upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  wallet: 'M3 7h16v12H3zM3 7l12-3v3M15 13h.01', palette: 'M12 3a9 9 0 000 18c1.500 0 2-1 2-2s-1-1.500 0-2.500 3 0 5-1A9 9 0 0012 3zM8 10h.01M12 7h.01M16 10h.01', square: 'M5 5h14v14H5z', circle: 'M12 4a8 8 0 100 16 8 8 0 000-16z', triangle: 'M12 4l9 16H3z', diamond: 'M12 3l9 9-9 9-9-9z', hex: 'M12 3l8 4.500v9L12 21l-8-4.500v-9z',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z', leaf: 'M5 19C5 10 10 5 19 5c0 9-5 14-14 14zM5 19l8-8', drop: 'M12 3s6 6 6 11a6 6 0 01-12 0c0-5 6-11 6-11z', skull: 'M5 12a7 7 0 1114 0v3h-2v3H7v-3H5zM9.500 12h.01M14.500 12h.01',
  cross: 'M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z', tool: 'M14 6a4 4 0 00-5 5l-5 5 3 3 5-5a4 4 0 005-5l-3 2-2-2z', game: 'M6 8h12a3 3 0 013 3v3a3 3 0 01-5 2l-1-1H9l-1 1a3 3 0 01-5-2v-3a3 3 0 013-3zM8 11v3M6.500 12.500h3M16 11.500h.01M18 13.500h.01',
  quote: 'M5 17c0-4 1-7 4-8M5 17h4v-4H5M14 17c0-4 1-7 4-8M14 17h4v-4h-4', google: 'M19.500 12H12M19 12a7 7 0 11-2-5', wand: 'M5 19L15 9M14 4v3M12.500 5.500h3M19 10v3M17.500 11.500h3',
  deaf: 'M4 14v-2a8 8 0 0116 0v2M4 14h3v5H4zM17 14h3v5h-3zM4 4l16 16',
};
export const icon = (name, size = 20) => {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${P[name] ?? P.info}"/></svg>`;
  return t.content.firstChild;
};
export const ICON_NAMES = Object.keys(P);
// Square symbol button: the app's navigation and action unit.
export const sq = (name, label, props = {}) => {
  const { class: cls, onclick, badge, size = 20, ...rest } = props;
  const b = h('button', { type: 'button', class: `sq${cls ? ` ${cls}` : ''}`, 'aria-label': label, title: label, onclick, ...rest }, icon(name, size));
  if (badge) b.append(h('span', { class: 'sq-badge' }, String(badge)));
  b.addEventListener('pointerdown', (e) => ripple(b, e));
  return b;
};
export const ripple = (node, e) => {
  if (document.documentElement.dataset.motion === 'reduced') return;
  const r = node.getBoundingClientRect();
  const dot = h('i', { class: 'ripple', style: { left: `${e.clientX - r.left}px`, top: `${e.clientY - r.top}px` } });
  node.append(dot);
  setTimeout(() => dot.remove(), 600);
};
export const setBadge = (btn, n) => {
  btn.querySelector('.sq-badge')?.remove();
  if (n) btn.append(h('span', { class: 'sq-badge' }, n > 99 ? '99+' : String(n)));
};

/* ------------------------------------------------------------------ formatting */
export const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const ago = (at) => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
export const dayOf = (at) => { const d = new Date(at); const t = new Date(); const y = new Date(Date.now() - 864e5); return d.toDateString() === t.toDateString() ? 'Today' : d.toDateString() === y.toDateString() ? 'Yesterday' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' }); };
export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const fileUrl = (id) => `/files/${id}`;

/* ------------------------------------------------------------------ avatars */
export const avatarEl = (id, name, size = 36, square = false) => {
  const node = id
    ? h('img', { src: fileUrl(id), alt: '', loading: 'lazy', draggable: false })
    : h('span', {}, String(name ?? '?').replace(/^#\s*/, '').slice(0, 1).toUpperCase());
  node.classList.add('pfp');
  if (square) node.classList.add('icon');
  node.style.setProperty('--s', `${size}px`);
  return node;
};
export const nameEl = (p) => { const n = h('span', { class: 'nm' }, p.name ?? p.displayName ?? p.username); return n; };
// Cosmetics: a name colour is a hex (solid) or a keyword (animated gradient); a frame is a keyword.
export const fxName = (node, value) => { if (!value) return node; node.classList.add('fxn'); if (String(value).startsWith('#')) node.style.setProperty('--fxn', value); else node.classList.add(`fxn-${String(value).replace(/[^a-z]/g, '')}`); return node; };
export const BADGE_ICONS = { Butterfly: 'wave', Star: 'star', Flame: 'flame', Crown: 'crown' };
export const badgeChip = (value) => (value ? h('span', { class: 'fxbadge', title: `${value} badge (cosmetic)` }, icon(BADGE_ICONS[value] ?? 'sparkle', 12), value) : null);
export const framed = (node, frame) => { node.classList.add('fxframe'); if (frame) node.classList.add(`fx-${String(frame).replace(/[^a-z]/g, '')}`); return node; };
export const TAG_ICONS = ['square', 'circle', 'triangle', 'diamond', 'hex', 'bolt', 'star', 'moon', 'leaf', 'flame', 'drop', 'shield', 'crown', 'skull', 'heart', 'eye', 'wave', 'cross'];
// Server tag, like Discord's: a small symbol and up to four letters, in the server's colour.
export const clanChip = (clan) => (clan?.tag ? h('span', { class: 'clan', title: `Member of ${clan.name}`, style: clan.color ? { '--clan': clan.color } : {} }, icon(TAG_ICONS.includes(clan.icon) ? clan.icon : 'square', 11), clan.tag) : null);
export const downloadFile = (url, name = 'download') => { const a = h('a', { href: url, download: name, rel: 'noopener' }); document.body.append(a); a.click(); a.remove(); };
export const viewImage = (url, name = 'Image') => {
  const sh = openSheet(name, h('div', { class: 'stack' }, h('img', { src: url, alt: name, class: 'viewer-img' }),
    h('div', { class: 'dlg-actions' }, h('button', { class: 'primary', type: 'button', onclick: () => downloadFile(url, /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.png`) }, icon('download', 16), ' Download'))), { wide: true });
  return sh;
};
export const roleTag = (tag) => (tag ? h('span', { class: `rtag rtag-${tag}` }, tag === 'bot' ? 'BOT' : tag.toUpperCase()) : null);

/* ------------------------------------------------------------------ API */
export async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.body !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper' },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}
// Raw upload with progress. Resolves with the JSON body ({ id, kind, ... }).
export function upload(query, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/upload?${query}`);
    x.setRequestHeader('X-Requested-With', 'scrxaper');
    x.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    if (onProgress) x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch { /* empty */ } x.status < 300 ? resolve(d) : reject(Object.assign(new Error(d.error || 'Upload failed'), { status: x.status })); };
    x.onerror = () => reject(new Error('Upload failed. Check your connection.'));
    x.send(blob);
  });
}
export const fail = (err) => toast(err?.message || 'Something went wrong', { kind: 'error' });
export const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { fail(e); } };

/* ------------------------------------------------------------------ toasts, sheets, dialogs */
export function toast(text, { kind = 'info', ms = 3600, action } = {}) {
  const host = $('toasts');
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, h('span', {}, text));
  if (action) t.append(h('button', { type: 'button', class: 'toast-act', onclick: () => { action.run(); t.remove(); } }, action.label));
  host.append(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

const sheets = [];
// Opens a modal sheet with an X in the header. Returns { el, body, close, title(text) }.
// opts: { key, wide, full, onClose, side }. A sheet opened with an existing key is updated in place.
export function openSheet(title, content, opts = {}) {
  const existing = opts.key && sheets.find((s) => s.key === opts.key);
  if (existing) { existing.title(title); clear(existing.body, content); return existing; }
  const body = h('div', { class: 'sheet-body' });
  const titleEl = h('h2', { class: 'sheet-title' }, title);
  const closeBtn = sq('close', 'Close', { class: 'sheet-x', onclick: () => api_.close() });
  const head = h('header', { class: 'sheet-head' }, h('span', { class: 'sheet-grab', 'aria-hidden': 'true' }), titleEl, closeBtn);
  const el = h('section', { class: `sheet${opts.wide ? ' wide' : ''}${opts.full ? ' full' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': String(title) }, head, body);
  const scrim = h('div', { class: 'scrim', onclick: () => api_.close() }, el);
  el.addEventListener('click', (e) => e.stopPropagation());
  const opener = document.activeElement;
  const api_ = {
    key: opts.key, el, body,
    title(t) { titleEl.textContent = t; el.setAttribute('aria-label', String(t)); },
    close() {
      if (!scrim.isConnected) return;
      const i = sheets.indexOf(api_); if (i >= 0) sheets.splice(i, 1);
      scrim.classList.remove('in'); scrim.classList.add('out');
      setTimeout(() => scrim.remove(), document.documentElement.dataset.motion === 'reduced' ? 0 : 220);
      opts.onClose?.();
      opener?.isConnected && opener.focus?.({ preventScroll: true });
    },
  };
  append(body, [content]);
  $('layer').append(scrim);
  sheets.push(api_);
  requestAnimationFrame(() => scrim.classList.add('in'));
  enableSheetDrag(el, head, api_);
  queueMicrotask(() => (body.querySelector('[autofocus]') ?? closeBtn).focus?.({ preventScroll: true }));
  return api_;
}
export const closeSheets = () => [...sheets].reverse().forEach((s) => s.close());
export const topSheet = () => sheets.at(-1);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheets.length) { e.preventDefault(); sheets.at(-1).close(); } });

function enableSheetDrag(el, head, s) {
  let y0 = null; let dy = 0;
  head.addEventListener('pointerdown', (e) => { if (!matchMedia('(max-width: 760px)').matches || e.target.closest('button')) return; y0 = e.clientY; dy = 0; head.setPointerCapture(e.pointerId); el.classList.add('dragging'); });
  head.addEventListener('pointermove', (e) => { if (y0 === null) return; dy = Math.max(0, e.clientY - y0); el.style.transform = `translateY(${dy}px)`; });
  const end = () => { if (y0 === null) return; y0 = null; el.classList.remove('dragging'); el.style.transform = ''; if (dy > 110) s.close(); };
  head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
}

// In-app replacements for alert / confirm / prompt (all return promises).
const dialog = (title, body, buttons, { input } = {}) => new Promise((resolve) => {
  let done = false;
  const finish = (v) => { if (!done) { done = true; sh.close(); resolve(v); } };
  const row = h('div', { class: 'dlg-actions' }, ...buttons.map((b) => h('button', { type: 'button', class: b.primary ? 'primary' : b.danger ? 'danger' : 'ghost', onclick: () => finish(b.value === 'input' ? input.value : b.value) }, b.label)));
  const sh = openSheet(title, h('div', { class: 'dlg' }, ...(body ? [h('p', { class: 'dlg-text' }, body)] : []), input ?? '', row), { onClose: () => finish(buttons.find((b) => b.cancel)?.value ?? null) });
  if (input) { input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); }); setTimeout(() => input.focus(), 60); }
});
export const ask = {
  alert: (text, title = 'Notice') => dialog(title, text, [{ label: 'OK', value: true, primary: true, cancel: true }]),
  confirm: (text, { title = 'Are you sure?', yes = 'Confirm', danger = false } = {}) => dialog(title, text, [{ label: 'Cancel', value: false, cancel: true }, { label: yes, value: true, primary: !danger, danger }]),
  prompt: (text, value = '', { title = 'Enter a value', placeholder = '', type = 'text', max = 300 } = {}) => dialog(title, text, [{ label: 'Cancel', value: null, cancel: true }, { label: 'OK', value: 'input', primary: true }], { input: h('input', { class: 'dlg-input', value, placeholder, type, maxLength: max, 'aria-label': title }) }),
};

/* ------------------------------------------------------------------ forms */
export const field = (name, placeholder, extra = {}) => h('input', { name, placeholder, 'aria-label': placeholder, autocomplete: 'off', ...extra });
export const form = (onSubmit, ...kids) => {
  const f = h('form', {}, ...kids);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = f.querySelector('[type=submit]'); btn && (btn.disabled = true);
    try { await onSubmit(Object.fromEntries(new FormData(f)), f); } catch (err) { fail(err); } finally { btn && (btn.disabled = false); }
  });
  return f;
};
export const toggle = (name, label, checked = false, onchange) => {
  const input = h('input', { type: 'checkbox', name, checked: !!checked, class: 'sw-input' });
  if (onchange) input.addEventListener('change', () => onchange(input.checked));
  return h('label', { class: 'sw' }, h('span', { class: 'sw-label' }, label), input, h('span', { class: 'sw-track', 'aria-hidden': 'true' }, h('i', {})));
};
export const select = (name, value, options, onchange) => {
  const s = h('select', { name, 'aria-label': name }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  if (onchange) s.addEventListener('change', () => onchange(s.value));
  return s;
};
export const segmented = (options, value, onchange) => {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  const paint = (v) => wrap.querySelectorAll('button').forEach((b) => { b.classList.toggle('on', b.dataset.v === v); b.setAttribute('aria-checked', String(b.dataset.v === v)); });
  for (const [v, l, ic] of options) wrap.append(h('button', { type: 'button', role: 'radio', class: 'seg-b', dataset: { v }, onclick: () => { paint(v); onchange(v); } }, ic ? icon(ic, 16) : null, l));
  paint(value);
  return wrap;
};
export const section = (title, ...kids) => h('section', { class: 'sec' }, h('h3', {}, title), ...kids);
export const hint = (text) => h('p', { class: 'hint' }, text);
export const row = (...kids) => h('div', { class: 'row' }, ...kids);
export const empty = (text, ic = 'info') => h('div', { class: 'empty-state' }, icon(ic, 26), h('p', {}, text));
export const chip = (label, props = {}) => h('span', { class: 'chip', ...props }, label);

/* ------------------------------------------------------------------ files */
export function pickFile(accept, onPick, { multiple = false } = {}) {
  const input = h('input', { type: 'file', accept, multiple });
  input.addEventListener('change', () => { const f = [...input.files]; if (f.length) onPick(multiple ? f : f[0]); });
  input.click();
}
export async function audioLength(file) {
  return new Promise((resolve) => { const a = new Audio(URL.createObjectURL(file)); a.onloadedmetadata = () => resolve(a.duration); a.onerror = () => resolve(NaN); });
}

/* ------------------------------------------------------------------ sounds */
export const BUILTIN_TONES = [['chime', 'Chime'], ['drop', 'Drop'], ['pluck', 'Pluck'], ['ring', 'Classic ring'], ['soft', 'Soft ring'], ['pulse', 'Pulse'], ['none', 'Silent']];
export const CALLING_TUNES = [['ringback', 'Classic ringback'], ['ringback_melody', 'Gentle melody'], ['ringback_soft', 'Soft pulse'], ['none', 'Silent']];
const NOTES = { chime: [[880, 0], [1318, 0.13]], drop: [[660, 0], [440, 0.11]], pluck: [[523, 0], [659, 0.09], [784, 0.18]],
  ring: [[880, 0], [660, 0.2], [880, 0.6], [660, 0.8]], soft: [[523, 0], [392, 0.25]], pulse: [[740, 0], [740, 0.18], [740, 0.36]],
  // ringback: what the CALLER hears while waiting (a long two-tone pause pattern, distinct from any ringtone)
  ringback: [[440, 0, 1.0], [480, 0, 1.0]], ringback_melody: [[523, 0], [659, 0.3], [784, 0.6], [659, 0.9]], ringback_soft: [[392, 0, 0.5], [392, 0.7, 0.5]] };
export const TONE_NOTES = NOTES;
export const audioCtx = () => { try { audioCtx.c ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.c.resume?.(); return audioCtx.c; } catch { return null; } };
export function playTone(name, volume = 60) {
  const notes = NOTES[name];
  const ctx = notes && volume ? audioCtx() : null;
  if (!ctx) return;
  for (const [freq, at, len = 0.28] of notes) {
    const osc = ctx.createOscillator(); const gain = ctx.createGain(); const t = ctx.currentTime + at;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max((volume / 100) * 0.22, 0.0002), t + 0.03);
    gain.gain.setValueAtTime(Math.max((volume / 100) * 0.22, 0.0002), t + Math.max(len - 0.1, 0.05));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.02);
    osc.connect(gain).connect(ctx.destination); osc.start(t); osc.stop(t + len + 0.05);
  }
}
// value: builtin name or "custom:<uploadId>". Returns stop(). loop repeats (ringtone / calling tune).
export function playSound(value, volume = 60, loop = false) {
  if (!value || value === 'none') return () => {};
  if (String(value).startsWith('custom:')) {
    const audio = new Audio(fileUrl(value.slice(7)));
    audio.volume = Math.min(Math.max(volume / 100, 0), 1); audio.loop = loop;
    audio.play().catch(() => {});
    return () => { audio.pause(); audio.src = ''; };
  }
  playTone(value, volume);
  if (!loop) return () => {};
  const period = value.startsWith('ringback') ? 4000 : 2000;
  const timer = setInterval(() => playTone(value, volume), period);
  return () => clearInterval(timer);
}
export function ping(kind, target) {
  const s = state.sound;
  if (!s || state.privacy?.dnd || state.mutes.has(`${kind}:${target}`)) return;
  const own = s.overrides?.find((o) => o.kind === kind && String(o.target) === String(target));
  playSound(own?.tone ?? s.tone, s.volume);
}

/* ------------------------------------------------------------------ theming */
const resolveTheme = (t) => (t === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : t);
export function applyPrefs(p) {
  if (!p) return;
  const root = document.documentElement;
  const c = p.custom ?? {};
  root.dataset.theme = resolveTheme(p.theme);
  root.dataset.density = p.density;
  root.dataset.motion = p.reduceMotion ? 'reduced' : 'full';
  root.dataset.glass = p.plain ? 'off' : 'on';
  root.dataset.bubble = c.bubble ?? 'glass';
  root.dataset.wall = c.wallpaperVideoId ? 'video' : c.wallpaperId ? 'custom' : (c.wallpaper ?? 'default');
  paintVideoWall(c.wallpaperVideoId);
  root.dataset.side = c.mineSide ?? 'right';
  root.dataset.avatars = c.showAvatars === false ? 'off' : 'on';
  root.dataset.contrast = c.contrast ? 'high' : 'normal';
  const set = (k, v) => (v === undefined || v === null ? root.style.removeProperty(k) : root.style.setProperty(k, v));
  set('--accent', p.accent || null);
  set('--bubble-color', c.bubbleColor ?? null);
  set('--bubble-r', c.radius !== undefined ? `${c.radius}px` : null);
  set('--font-scale', c.fontScale ?? null);
  set('--blur', c.blur !== undefined ? `${c.blur}px` : null);
  set('--wall-img', c.wallpaperId ? `url(${fileUrl(c.wallpaperId)})` : null);
  const meta = document.querySelector('meta[name=theme-color]'); if (meta) meta.content = root.dataset.theme === 'light' ? '#eef4fc' : '#0b0d10';
}
// Animated wallpaper: a muted looping video behind the whole app. Paused when the tab is hidden or motion is reduced.
let wallEl = null;
function paintVideoWall(id) {
  if (!id) { wallEl?.remove(); wallEl = null; return; }
  const src = fileUrl(id);
  if (wallEl && wallEl.dataset.src === src) return;
  wallEl?.remove();
  wallEl = h('video', { class: 'wall-video', src, muted: true, loop: true, autoplay: true, playsInline: true, 'aria-hidden': 'true', tabindex: -1, dataset: { src } });
  wallEl.muted = true;
  document.body.prepend(wallEl);
  wallEl.play?.().catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!wallEl) return; if (document.hidden || document.documentElement.dataset.motion === 'reduced') wallEl.pause(); else wallEl.play?.().catch(() => {}); });
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => state.prefs?.theme === 'system' && applyPrefs(state.prefs));
document.addEventListener('visibilitychange', () => { document.documentElement.dataset.paused = String(document.hidden); });

/* ------------------------------------------------------------------ misc */
export const confetti = (origin) => {
  if (document.documentElement.dataset.motion === 'reduced' || state.prefs?.custom?.confetti === false) return;
  const host = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  const colors = ['#b7c9e6', '#e8f1ff', '#f0b4c8', '#a8e6cf', '#ffd88a'];
  const rect = origin?.getBoundingClientRect?.() ?? { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
  for (let i = 0; i < 26; i++) {
    const p = h('i', { style: { left: `${rect.left + rect.width / 2}px`, top: `${rect.top + rect.height / 2}px`, background: colors[i % colors.length], '--dx': `${(Math.random() - 0.5) * 320}px`, '--dy': `${-80 - Math.random() * 220}px`, '--rot': `${Math.random() * 720}deg` } });
    host.append(p);
  }
  document.body.append(host); setTimeout(() => host.remove(), 1400);
};
export const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const linkify = (text) => {
  const out = [];
  for (const part of String(text).split(/(https?:\/\/[^\s<]+|#[\p{L}\p{N}_]{2,40}|@[a-z0-9_]{3,24})/giu)) {
    if (/^https?:\/\//i.test(part)) out.push(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer nofollow' }, part));
    else if (/^#/.test(part)) out.push(h('a', { class: 'tag', href: `#tag/${part.slice(1).toLowerCase()}`, onclick: (e) => { e.preventDefault(); actions.openTag?.(part.slice(1).toLowerCase()); } }, part));
    else if (/^@/.test(part)) out.push(h('a', { class: 'mention', href: `#u/${part.slice(1)}`, onclick: (e) => { e.preventDefault(); actions.openProfile?.(part.slice(1)); } }, part));
    else out.push(part);
  }
  return out;
};
