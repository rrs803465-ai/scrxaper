// Social: feed, reels, stories, posts, explore, tags, profiles, sharing, notifications, friends.
import { $, state, bus, actions, h, clear, icon, sq, avatarEl, roleTag, api, upload, toast, fail, safe, ask, openSheet, closeSheets, section, hint, empty, field, form, linkify, ago, confetti, fileUrl, debounce, fmtBytes, setBadge, segmented, select } from './core.js';
import { musicPicker, editImage, editVideo, newPost, newStory, newReel } from './media.js';

const motionOK = () => document.documentElement.dataset.motion !== 'reduced';
const player = { audio: null };
function playMusic(id, start = 0, volume = 0.6) { stopMusic(); if (!id) return; const a = new Audio(fileUrl(id)); a.loop = true; a.volume = volume; a.addEventListener('loadedmetadata', () => { try { a.currentTime = Math.min(start, Math.max(a.duration - 1, 0)); } catch { /* ignore */ } }, { once: true }); a.play().catch(() => {}); player.audio = a; }
function stopMusic() { player.audio?.pause(); player.audio = null; }

/* ------------------------------------------------------------------ full-screen overlay shell */
function fullView(title, ...kids) {
  const x = sq('close', 'Close', { class: 'ghost', onclick: () => close() });
  const body = h('div', { class: 'fv-body' }, ...kids);
  const el = h('div', { class: 'fullview', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, h('header', { class: 'fv-head' }, h('h2', {}, title), h('span', { class: 'grow' }), x), body);
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('#layer .scrim, .storyview, .editor')) close(); };
  document.addEventListener('keydown', onKey);
  function close() { document.removeEventListener('keydown', onKey); stopMusic(); el.classList.remove('in'); setTimeout(() => el.remove(), 220); }
  $('overlays').append(el); requestAnimationFrame(() => el.classList.add('in'));
  return { el, body, close, head: el.querySelector('.fv-head') };
}
let feedView = null;

/* ------------------------------------------------------------------ media + post cards */
const mediaOf = (p, { controls = true, autoplay = false } = {}) => (p.kind === 'reel'
  ? h('video', { src: fileUrl(p.media), class: 'post-media', playsInline: true, loop: true, controls, preload: 'metadata', muted: !!p.musicId || autoplay })
  : h('img', { src: fileUrl(p.media), class: 'post-media', alt: p.caption || `Post by ${p.name}`, loading: 'lazy', draggable: false }));

function postCard(p, { onGone } = {}) {
  let lastTap = 0;
  const likeBtn = h('button', { type: 'button', class: `act like${p.liked ? ' on' : ''}`, 'aria-pressed': String(!!p.liked), 'aria-label': 'Like' });
  const count = h('span', {}, String(p.likes)); likeBtn.append(icon('heart', 20), count);
  const setLike = async (want) => {
    if (want === p.liked) return;
    p.liked = want; p.likes += want ? 1 : -1; likeBtn.classList.toggle('on', want); likeBtn.setAttribute('aria-pressed', String(want)); count.textContent = String(p.likes);
    if (want && motionOK()) { likeBtn.classList.remove('pop'); void likeBtn.offsetWidth; likeBtn.classList.add('pop'); }
    try { const r = await api('/api/posts/like', { body: { post: p.id, liked: want } }); p.likes = r.likes; count.textContent = String(r.likes); } catch (e) { p.liked = !want; p.likes += want ? -1 : 1; likeBtn.classList.toggle('on', !want); count.textContent = String(p.likes); fail(e); }
  };
  likeBtn.addEventListener('click', () => setLike(!p.liked));
  const media = mediaOf(p, { controls: p.kind === 'reel' });
  const wrap = h('div', { class: 'media-wrap' }, media);
  wrap.addEventListener('click', (e) => { if (e.target.closest('button')) return; const now = Date.now(); if (now - lastTap < 320) { setLike(true); const b = h('i', { class: 'big-heart' }, icon('heart', 72)); wrap.append(b); setTimeout(() => b.remove(), 800); } else if (p.kind !== 'reel') setTimeout(() => { if (Date.now() - lastTap >= 300) openPost(p.id); }, 320); lastTap = now; });
  const music = p.musicId ? h('button', { type: 'button', class: 'music-chip', onclick: (e) => { const b = e.currentTarget; if (b.classList.toggle('on')) { playMusic(p.musicId, p.musicStart); if (media.tagName === 'VIDEO') { media.muted = !!p.musicMute; media.play().catch(() => {}); } } else stopMusic(); } }, icon('music', 14), h('span', {}, p.musicTitle || 'Music')) : null;
  const more = p.username === state.user ? sq('more', 'More', { class: 'sm', onclick: () => postMenu(p, card, onGone) }) : null;
  const card = h('article', { class: 'post', dataset: { id: p.id } },
    h('header', { class: 'post-head' }, h('button', { type: 'button', class: 'who', onclick: () => actions.openProfile(p.username) }, avatarEl(p.avatar, p.name, 36), h('span', { class: 'nm' }, p.name), h('small', {}, `@${p.username} · ${ago(p.at)}`)), more),
    wrap, music,
    h('div', { class: 'post-acts' }, likeBtn, h('button', { type: 'button', class: 'act', 'aria-label': 'Comments', onclick: () => openPost(p.id) }, icon('comment', 20), h('span', {}, String(p.comments))), h('button', { type: 'button', class: 'act', 'aria-label': 'Share', onclick: () => sharePost(p) }, icon('share', 20))),
    p.caption ? h('p', { class: 'post-cap' }, h('b', {}, p.username), ' ', ...linkify(p.caption), p.editedAt ? h('small', {}, ' (edited)') : null) : null);
  return card;
}
function postMenu(p, card, onGone) {
  const sh = openSheet('Your post', h('div', { class: 'stack' },
    h('button', { class: 'item', type: 'button', onclick: async () => { sh.close(); const v = await ask.prompt('Edit the caption', p.caption, { title: 'Edit caption', max: 1000 }); if (v === null) return; await safe(async () => { await api('/api/posts/edit', { body: { post: p.id, caption: v } }); p.caption = v; toast('Updated', { kind: 'ok' }); refreshFeed(); })(); } }, icon('edit', 18), h('span', { class: 't' }, 'Edit caption')),
    h('button', { class: 'item danger', type: 'button', onclick: async () => { sh.close(); if (!(await ask.confirm('This removes the post and its comments.', { title: 'Delete post?', yes: 'Delete', danger: true }))) return; await safe(async () => { await api('/api/posts/delete', { body: { post: p.id } }); card.classList.add('gone'); setTimeout(() => { card.remove(); onGone?.(); }, 250); })(); } }, icon('trash', 18), h('span', { class: 't' }, 'Delete post'))));
}

export async function openPost(id) {
  try {
    const p = await api(`/api/post?id=${id}`);
    const list = h('div', { class: 'stack-gap comments' });
    const paint = () => clear(list, ...(p.comments.length ? p.comments.map((c) => h('div', { class: 'comment' }, h('button', { type: 'button', class: 'pfp-btn', onclick: () => actions.openProfile(c.username) }, avatarEl(c.avatar, c.name, 32)), h('div', { class: 'grow' }, h('b', {}, c.name), ' ', ...linkify(c.body), h('small', {}, ` ${ago(c.at)}`)),
      (c.username === state.user || p.username === state.user) ? sq('trash', 'Delete comment', { class: 'sm', onclick: safe(async () => { await api('/api/posts/comment-delete', { body: { comment: c.id } }); p.comments = p.comments.filter((x) => x.id !== c.id); paint(); }) }) : null)) : [empty('No comments yet. Say something kind.', 'comment')]));
    paint();
    const input = field('body', 'Add a comment', { maxLength: 500, autocomplete: 'off' });
    const f = form(async (v) => { if (!v.body.trim()) return; const r = await api('/api/posts/comment', { body: { post: p.id, body: v.body } }); p.comments.push({ id: r.id, body: v.body.trim(), at: Date.now(), username: state.user, name: state.me.displayName, avatar: state.me.avatar }); input.value = ''; paint(); list.scrollTop = list.scrollHeight; }, h('div', { class: 'inline' }, input, h('button', { class: 'primary', type: 'submit' }, 'Post')));
    openSheet(p.kind === 'reel' ? 'Reel' : 'Post', h('div', { class: 'stack' }, postCard(p, { onGone: () => closeSheets() }), list, f), { wide: true, key: `post:${id}` });
  } catch (e) { fail(e); }
}
actions.openPost = openPost;

/* ------------------------------------------------------------------ share a post */
export async function sharePost(p) {
  const body = h('div', { class: 'stack' });
  const sh = openSheet('Share post', body, { key: 'share' });
  const note = field('note', 'Add a note (optional)', { maxLength: 300 });
  const [convs, groups] = await Promise.all([api('/api/conversations').catch(() => []), api('/api/groups').catch(() => [])]);
  const send = (kind, target) => safe(async () => { await api('/api/posts/share', { body: { post: p.id, kind, target, note: note.value } }); toast('Shared', { kind: 'ok' }); sh.close(); })();
  const link = h('button', { class: 'item', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(`${location.origin}/app#post/${p.id}`); toast('Link copied', { kind: 'ok' }); } catch { toast('Copy failed', { kind: 'error' }); } } }, icon('link', 18), h('span', { class: 't' }, 'Copy link'));
  clear(body, note, section('People', ...(convs.length ? convs.slice(0, 20).map((c) => h('button', { class: 'item', type: 'button', onclick: () => send('dm', c.username) }, avatarEl(c.avatar, c.displayName, 36), h('span', { class: 't' }, c.displayName), h('span', { class: 'chip' }, 'Send'))) : [hint('Start a conversation first.')])),
    ...(groups.length ? [section('Groups', ...groups.map((g) => h('button', { class: 'item', type: 'button', onclick: () => send('group', g.id) }, avatarEl(g.icon, g.name, 36, true), h('span', { class: 't' }, g.name), h('span', { class: 'chip' }, 'Send'))))] : []), link);
}

/* ------------------------------------------------------------------ stories */
function openStories(groups, startAt = 0) {
  let gi = startAt; let si = 0; let timer = 0; let t0 = 0; let paused = false; let left = 5000;
  const bars = h('div', { class: 'st-bars' }); const stage = h('div', { class: 'st-stage' }); const who = h('button', { type: 'button', class: 'who' });
  const x = sq('close', 'Close', { class: 'ghost', onclick: () => done() });
  const el = h('div', { class: 'storyview', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Story' }, bars, h('div', { class: 'st-top' }, who, h('span', { class: 'grow' }), x), stage,
    h('button', { type: 'button', class: 'st-nav prev', 'aria-label': 'Previous', onclick: () => step(-1) }), h('button', { type: 'button', class: 'st-nav next', 'aria-label': 'Next', onclick: () => step(1) }));
  const done = () => { clearTimeout(timer); stopMusic(); document.removeEventListener('keydown', key); el.classList.remove('in'); setTimeout(() => el.remove(), 220); feedView && loadTray(); };
  const key = (e) => { if (e.key === 'Escape') done(); else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1); };
  document.addEventListener('keydown', key);
  const hold = (on) => { paused = on; const fill = bars.querySelector('.cur i'); if (on) { clearTimeout(timer); left = Math.max(left - (Date.now() - t0), 200); fill?.style.setProperty('animation-play-state', 'paused'); player.audio?.pause(); } else { t0 = Date.now(); timer = setTimeout(() => step(1), left); fill?.style.setProperty('animation-play-state', 'running'); player.audio?.play().catch(() => {}); } };
  el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) hold(true); }); el.addEventListener('pointerup', () => paused && hold(false)); el.addEventListener('pointercancel', () => paused && hold(false));
  function step(d) { si += d; const g = groups[gi]; if (si >= g.stories.length) { gi++; si = 0; } else if (si < 0) { gi = Math.max(gi - 1, 0); si = gi === startAt && d < 0 ? 0 : Math.max((groups[gi]?.stories.length ?? 1) - 1, 0); si = Math.max(si, 0); } if (gi >= groups.length) return done(); show(); }
  function show() {
    clearTimeout(timer); const g = groups[gi]; const s = g.stories[si];
    clear(who, avatarEl(g.avatar, g.name, 34), h('span', { class: 'nm' }, g.mine ? 'Your story' : g.name), h('small', {}, ago(s.at))); who.onclick = () => { done(); actions.openProfile(g.username); };
    clear(bars, ...g.stories.map((_, i) => h('span', { class: `st-bar${i < si ? ' full' : ''}${i === si ? ' cur' : ''}` }, h('i', {}))));
    clear(stage, h('img', { src: fileUrl(s.media), alt: `Story by ${g.name}`, draggable: false }), s.musicTitle ? h('div', { class: 'music-chip on static' }, icon('music', 14), h('span', {}, s.musicTitle)) : null,
      g.mine ? h('button', { type: 'button', class: 'st-viewers', onclick: async () => { hold(true); const v = await api(`/api/stories/viewers?story=${s.id}`).catch(() => []); const sh = openSheet(`Seen by ${v.length}`, h('div', { class: 'stack-gap' }, ...(v.length ? v.map((u) => h('button', { type: 'button', class: 'item', onclick: () => { sh.close(); done(); actions.openProfile(u.username); } }, h('span', { class: 't' }, u.name), h('small', {}, ago(u.at)))) : [empty('No views yet.', 'eye')])), { onClose: () => hold(false) }); } }, icon('eye', 16), ' Viewers') : null,
      g.mine ? sq('trash', 'Delete story', { class: 'st-trash', onclick: async () => { hold(true); if (await ask.confirm('Remove this story?', { title: 'Delete story', yes: 'Delete', danger: true })) { await safe(async () => { await api('/api/stories/delete', { body: { story: s.id } }); g.stories.splice(si, 1); if (!g.stories.length) { groups.splice(gi, 1); si = 0; } else si = Math.min(si, g.stories.length - 1); if (!groups.length) return done(); gi = Math.min(gi, groups.length - 1); show(); })(); } else hold(false); } }) : null);
    s.musicId ? playMusic(s.musicId, s.musicStart ?? 0, 0.7) : stopMusic();
    if (!g.mine) api('/api/stories/view', { body: { story: s.id } }).catch(() => {}); s.seen = true;
    left = 5000; t0 = Date.now(); const fill = bars.querySelector('.cur i'); fill.style.animationDuration = '5s'; timer = setTimeout(() => step(1), left);
  }
  $('overlays').append(el); requestAnimationFrame(() => el.classList.add('in')); show();
}

/* ------------------------------------------------------------------ feed + reels */
let trayHost = null; let feedHost = null; let reelHost = null; let feedCursor = null; let feedBusy = false;
async function loadTray() {
  if (!trayHost) return;
  const groups = await api('/api/stories').catch(() => []);
  const mine = groups.find((g) => g.mine);
  clear(trayHost, h('div', { class: 'story-item add' }, h('button', { type: 'button', class: 'ring add', 'aria-label': 'Add story', onclick: () => newStory() }, avatarEl(state.me.avatar, state.me.displayName, 56), h('i', { class: 'plus' }, icon('plus', 14))), h('span', {}, 'Your story')),
    ...groups.map((g, i) => (g.mine && !g.stories.length ? null : h('div', { class: 'story-item' }, h('button', { type: 'button', class: `ring${g.allSeen ? ' seen' : ''}`, 'aria-label': `${g.name}'s story`, onclick: () => openStories(groups, i) }, avatarEl(g.avatar, g.name, 56)), h('span', {}, g.mine ? 'You' : g.name.split(' ')[0])))));
  void mine;
  let down = false; let x0 = 0; let s0 = 0;
  trayHost.onpointerdown = (e) => { if (e.pointerType !== 'mouse') return; down = true; x0 = e.clientX; s0 = trayHost.scrollLeft; }; trayHost.onpointermove = (e) => { if (down) trayHost.scrollLeft = s0 - (e.clientX - x0); }; trayHost.onpointerup = trayHost.onpointerleave = () => { down = false; };
}
async function loadFeed(reset = false) {
  if (feedBusy || !feedHost) return; feedBusy = true;
  try {
    if (reset) { feedCursor = null; clear(feedHost); }
    const list = await api(`/api/feed${feedCursor ? `?before=${feedCursor}` : ''}`);
    if (!list.length && !feedCursor) clear(feedHost, empty('Your feed is empty. Follow people from Explore, or share your first post.', 'feed'), h('div', { class: 'inline center' }, h('button', { class: 'primary', type: 'button', onclick: () => actions.openExplore() }, 'Explore people'), h('button', { class: 'ghost', type: 'button', onclick: () => newPost() }, 'New post')));
    list.forEach((p) => feedHost.append(postCard(p))); feedCursor = list.length ? list.at(-1).id : feedCursor;
    feedHost.querySelector('.more')?.remove(); if (list.length >= 20) feedHost.append(h('button', { class: 'ghost more', type: 'button', onclick: () => loadFeed() }, 'Load more'));
  } catch (e) { fail(e); } finally { feedBusy = false; }
}
const refreshFeed = () => { if (feedHost?.isConnected) loadFeed(true); };

async function loadReels(host) {
  clear(host);
  const list = await api('/api/reels').catch(() => []);
  if (!list.length) return clear(host, empty('No reels yet. Be the first.', 'reels'), h('div', { class: 'inline center' }, h('button', { class: 'primary', type: 'button', onclick: () => newReel() }, 'New reel')));
  let muted = false;
  const io = new IntersectionObserver((entries) => { for (const en of entries) { const v = en.target.querySelector('video'); const p = en.target.__post; if (!v) continue; if (en.isIntersecting && en.intersectionRatio > 0.6) { v.muted = muted || !!p.musicMute; v.play().catch(() => {}); p.musicId && !muted ? playMusic(p.musicId, p.musicStart) : stopMusic(); } else v.pause(); } }, { threshold: [0.6] });
  for (const p of list) {
    const card = postCard(p); card.classList.add('reel'); card.__post = p; const v = card.querySelector('video'); if (v) { v.controls = false; v.muted = true; v.addEventListener('click', () => { v.paused ? v.play() : v.pause(); }); }
    const mute = sq('speaker', 'Mute or unmute', { class: 'reel-mute', onclick: (e) => { muted = !muted; e.currentTarget.classList.toggle('on', muted); if (v) v.muted = muted || !!p.musicMute; muted ? player.audio?.pause() : (p.musicId ? playMusic(p.musicId, p.musicStart) : null); } });
    card.querySelector('.media-wrap').append(mute); host.append(card); io.observe(card);
  }
  host.addEventListener('scroll', debounce(() => {}, 100));
}

export function openFeed(tab = 'feed') {
  if (feedView?.el.isConnected) feedView.close();
  const tabs = h('div', { class: 'sqtabs', role: 'tablist' });
  trayHost = h('div', { class: 'tray' }); feedHost = h('div', { class: 'feed' }); reelHost = h('div', { class: 'reels' });
  const pane = h('div', { class: 'fv-pane' });
  const fv = feedView = fullView('', pane);
  const mk = (id, ic, label) => h('button', { type: 'button', role: 'tab', class: 'sqtab', dataset: { tab: id }, 'aria-label': label, title: label, onclick: () => show(id) }, icon(ic, 20), h('span', {}, label));
  tabs.append(mk('feed', 'feed', 'Feed'), mk('reels', 'reels', 'Reels'), mk('explore', 'explore', 'Explore'));
  const plus = sq('plus', 'Create', { onclick: () => { const sh = openSheet('Create', h('div', { class: 'tiles' }, ...[['image', 'Post', newPost], ['clock', 'Story', newStory], ['video', 'Reel', newReel]].map(([ic, l, fn]) => h('button', { type: 'button', class: 'tile', onclick: () => { sh.close(); fn(); } }, h('span', { class: 'sqicon' }, icon(ic, 24)), l)))); } });
  fv.head.querySelector('h2').replaceWith(tabs); fv.head.insertBefore(plus, fv.head.querySelector('.grow').nextSibling);
  const show = (id) => {
    tabs.querySelectorAll('.sqtab').forEach((b) => { const on = b.dataset.tab === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    stopMusic(); fv.el.dataset.mode = id;
    if (id === 'feed') { clear(pane, trayHost, feedHost); loadTray(); loadFeed(true); } else if (id === 'reels') { clear(pane, reelHost); loadReels(reelHost); } else { clear(pane); exploreInto(pane); }
  };
  show(tab === 'tag' ? 'feed' : tab);
}
actions.openFeed = openFeed;

/* ------------------------------------------------------------------ explore + tags */
function grid(posts) { return posts.length ? h('div', { class: 'pgrid' }, ...posts.map((p) => h('button', { type: 'button', class: 'pcell', 'aria-label': p.caption || `Post by ${p.name}`, onclick: () => openPost(p.id) }, p.kind === 'reel' ? h('video', { src: fileUrl(p.media), muted: true, preload: 'metadata', playsInline: true }) : h('img', { src: fileUrl(p.media), alt: '', loading: 'lazy' }), p.kind === 'reel' ? h('i', { class: 'kind' }, icon('reels', 14)) : null, h('span', { class: 'pc-likes' }, icon('heart', 12), String(p.likes))))) : empty('Nothing here yet.', 'image'); }
async function exploreInto(host) {
  const input = field('q', 'Search people, tags, groups and messages', { type: 'search', autocomplete: 'off', 'aria-label': 'Search' });
  const results = h('div', { class: 'stack-gap' }); const main = h('div', { class: 'stack' });
  const find = debounce(async () => {
    const q = input.value.trim(); if (q.length < 2) { results.hidden = true; main.hidden = false; return; }
    try {
      const r = await api(`/api/search?q=${encodeURIComponent(q)}`); results.hidden = false; main.hidden = true;
      clear(results, ...(r.people.length ? [section('People', ...r.people.map((p) => h('button', { type: 'button', class: 'item', onclick: () => actions.openProfile(p.username) }, avatarEl(null, p.name, 38), h('span', { class: 't' }, p.name, h('small', {}, ` @${p.username}`)))))] : []),
        ...(r.tags.length ? [section('Tags', h('div', { class: 'inline wrap' }, ...r.tags.map((t) => h('button', { type: 'button', class: 'chip tagchip', onclick: () => openTag(t.tag) }, `#${t.tag}`, h('small', {}, ` ${t.n}`)))))] : []),
        ...(!r.people.length && !r.tags.length ? [empty('No people or tags match that.', 'search')] : []));
    } catch (e) { fail(e); }
  });
  input.addEventListener('input', find);
  clear(host, h('div', { class: 'explore' }, h('div', { class: 'searchbar' }, icon('search', 18), input), results, main));
  try {
    const d = await api('/api/explore');
    clear(main, d.tags.length ? section('Trending tags', h('div', { class: 'inline wrap' }, ...d.tags.map((t) => h('button', { type: 'button', class: 'chip tagchip', onclick: () => openTag(t.tag) }, icon('hash', 14), t.tag, h('small', {}, ` ${t.n}`))))) : null,
      d.people.length ? section('People to follow', h('div', { class: 'people-row' }, ...d.people.map((p) => { const btn = h('button', { class: 'primary mini', type: 'button' }, 'Follow'); btn.onclick = safe(async () => { const r = await api('/api/follow', { body: { username: p.username, follow: true } }); btn.textContent = r.requested ? 'Requested' : 'Following'; btn.disabled = true; }); return h('div', { class: 'person' }, h('button', { type: 'button', class: 'pfp-btn', onclick: () => actions.openProfile(p.username) }, avatarEl(p.avatar, p.name, 60)), h('b', {}, p.name), h('small', {}, `${p.followers} followers`), btn); }))) : null,
      section('Popular lately', grid(d.posts)));
  } catch (e) { fail(e); }
}
export const openExplore = () => { if (feedView?.el.isConnected) { feedView.el.querySelector('[data-tab=explore]')?.click(); } else openFeed('explore'); };
export async function openTag(tag) {
  try { const r = await api(`/api/tag?tag=${encodeURIComponent(tag)}`); openSheet(`#${r.tag}`, h('div', { class: 'stack' }, hint(`${r.posts.length}${r.posts.length >= 30 ? '+' : ''} posts`), grid(r.posts)), { wide: true, key: `tag:${tag}` }); } catch (e) { fail(e); }
}
Object.assign(actions, { openExplore, openTag });

/* ------------------------------------------------------------------ profile */
const ROLE_ORDER = ['user', 'staff', 'admin'];
export async function openProfile(username) {
  const name = String(username ?? '').replace(/^@/, '').toLowerCase();
  let p;
  try { p = await api(`/api/profile?user=${encodeURIComponent(name)}`); } catch (e) { return fail(e); }
  const self = p.username === state.user;
  const body = h('div', { class: 'profile' });
  const sh = openSheet(self ? 'Your profile' : p.displayName, body, { key: `profile:${name}`, wide: true });
  const paint = async () => {
    const cos = p.cosmetics?.find((c) => c.kind === 'frame');
    const banner = h('div', { class: 'p-banner' }, p.banner ? h('img', { src: fileUrl(p.banner), alt: '' }) : null);
    const stats = h('div', { class: 'p-stats' }, ...[['Posts', p.posts], ['Followers', p.followers], ['Following', p.following]].map(([l, n]) => h('div', {}, h('b', {}, String(n)), h('small', {}, l))));
    const actionsRow = h('div', { class: 'p-actions' });
    const rebuild = async () => { p = await api(`/api/profile?user=${encodeURIComponent(name)}`); await paint(); };
    if (self) actionsRow.append(h('button', { class: 'primary', type: 'button', onclick: () => { sh.close(); actions.openStudio('profile'); } }, icon('edit', 16), 'Edit profile'));
    else {
      const fbtn = { none: ['Add friend', 'userplus'], outgoing: ['Request sent', 'check'], incoming: ['Accept request', 'check'], friends: ['Friends', 'users'] }[p.friend];
      actionsRow.append(h('button', { class: p.friend === 'incoming' ? 'primary' : 'ghost', type: 'button', onclick: safe(async () => {
        if (p.friend === 'none') await api('/api/friends/request', { body: { username: p.username } });
        else if (p.friend === 'incoming') { await api('/api/friends/respond', { body: { username: p.username, accept: true } }); confetti(); }
        else if (p.friend === 'outgoing' || p.friend === 'friends') { if (!(await ask.confirm(p.friend === 'friends' ? `Remove ${p.displayName} from your friends?` : 'Cancel this friend request?', { yes: 'Remove', danger: true }))) return; await api('/api/friends/remove', { body: { username: p.username } }); }
        bus.emit('sse:friend', {}); await rebuild();
      }) }, icon(fbtn[1], 16), fbtn[0]),
      h('button', { class: p.isFollowing || p.requested ? 'ghost' : 'primary', type: 'button', onclick: safe(async () => { await api('/api/follow', { body: { username: p.username, follow: !(p.isFollowing || p.requested) } }); await rebuild(); }) }, p.isFollowing ? 'Following' : p.requested ? 'Requested' : p.followsYou ? 'Follow back' : 'Follow'),
      sq('chat', 'Message', { onclick: () => { sh.close(); closeSheets(); feedView?.close(); actions.openDM(p.username); } }),
      sq('call', 'Voice call', { onclick: () => { sh.close(); actions.startCall(p.username, false); } }), sq('video', 'Video call', { onclick: () => { sh.close(); actions.startCall(p.username, true); } }));
    }
    const lockd = !p.canSee ? h('div', { class: 'locked' }, icon('lock', 28), h('b', {}, 'This account is private'), h('small', {}, 'Follow to see their posts and stories.')) : null;
    const tools = [];
    if (!self) {
      tools.push(h('button', { class: 'item', type: 'button', onclick: () => ringPick(p) }, icon('music', 18), h('span', { class: 't' }, 'Ringtone for this person')));
      if (p.friend === 'friends') tools.push(h('button', { class: 'item', type: 'button', onclick: async () => { const n = await ask.prompt(`Send Sparks to ${p.displayName} (1 to 500)`, '10', { title: 'Send Sparks', type: 'number' }); if (!n) return; await safe(async () => { await api('/api/sparks/send', { body: { username: p.username, amount: Number(n) } }); confetti(); toast('Sparks sent', { kind: 'ok' }); })(); } }, icon('sparkle', 18), h('span', { class: 't' }, 'Send Sparks')));
      tools.push(h('button', { class: 'item danger', type: 'button', onclick: async () => { if (!(await ask.confirm(`${p.displayName} will not be able to message or call you.`, { title: 'Block?', yes: 'Block', danger: true }))) return; await safe(async () => { await api('/api/block', { body: { username: p.username, blocked: true } }); toast('Blocked', { kind: 'ok' }); sh.close(); })(); } }, icon('ban', 18), h('span', { class: 't' }, 'Block')));
      const perms = state.me.perms ?? [];
      if (perms.length) {
        const ot = [];
        if (perms.includes('sparks')) ot.push(h('button', { class: 'ghost mini', type: 'button', onclick: async () => { const n = await ask.prompt('Amount (negative removes)', '100', { title: `Sparks for ${p.displayName}`, type: 'number' }); if (!n) return; await safe(async () => { const r = await api('/api/owner/sparks', { body: { username: p.username, amount: Number(n) } }); toast(`Balance now ${r.balance}`, { kind: 'ok' }); })(); } }, icon('sparkle', 14), 'Give Sparks'));
        if (perms.includes('staff') && p.tag !== 'owner') ot.push(select('role', p.tag ?? 'user', ROLE_ORDER.filter((r) => r !== 'admin' || perms.includes('admin')).map((r) => [r, r === 'user' ? 'Member' : r[0].toUpperCase() + r.slice(1)]), safe(async (v) => { await api('/api/owner/role', { body: { username: p.username, role: v } }); toast(`Role set to ${v}`, { kind: 'ok' }); await rebuild(); })));
        if (perms.includes('warn')) ot.push(h('button', { class: 'ghost mini', type: 'button', onclick: async () => { const r = await ask.prompt('Reason', '', { title: 'Warn user' }); if (r) await safe(() => api('/api/owner/warn', { body: { username: p.username, reason: r } }).then(() => toast('Warning sent', { kind: 'ok' })))(); } }, 'Warn'));
        if (perms.includes('ban') && p.tag !== 'owner') ot.push(h('button', { class: 'danger mini', type: 'button', onclick: async () => { const r = await ask.prompt('The person sees this reason.', '', { title: `Suspend ${p.displayName}` }); if (r) await safe(() => api('/api/owner/ban', { body: { username: p.username, reason: r } }).then(() => { toast('Suspended', { kind: 'ok' }); sh.close(); }))(); } }, 'Suspend'));
        if (ot.length) tools.push(section('Site tools', h('div', { class: 'inline wrap' }, ...ot)));
      }
    }
    clear(body, banner, h('div', { class: 'p-head' }, h('span', { class: `p-av${cos ? ` frame-${cos.id}` : ''}` }, avatarEl(p.avatar, p.displayName, 92)), h('div', { class: 'grow' }, h('h3', {}, p.displayName, ' ', roleTag(p.tag), p.private ? h('span', { class: 'chip' }, icon('lock', 12), ' Private') : null), h('small', {}, `@${p.username}`), p.status ? h('p', { class: 'status' }, p.status) : null)),
      p.bio ? h('p', { class: 'bio' }, ...linkify(p.bio)) : null, p.interests?.length ? h('div', { class: 'inline wrap' }, ...p.interests.map((i) => h('span', { class: 'chip' }, i))) : null,
      p.badges?.length ? h('div', { class: 'inline wrap badges' }, ...p.badges.map((b) => h('span', { class: 'chip badge', title: b.description }, icon('star', 12), ` ${b.name}`))) : null, stats, actionsRow, ...tools,
      lockd ?? h('div', { class: 'stack' }, h('div', { class: 'side-label' }, 'Posts'), h('div', { class: 'ph' }, 'Loading')));
    if (!lockd) { const ph = body.querySelector('.ph'); try { const posts = await api(`/api/user-posts?user=${encodeURIComponent(p.username)}`); ph.replaceWith(grid(posts)); } catch { ph.replaceWith(empty('Posts could not be loaded.', 'image')); } }
  };
  await paint();
}
async function ringPick(p) {
  const s = state.sound; const mine = await api('/api/sounds').catch(() => []);
  const cur = s.overrides?.find((o) => o.kind === 'ring' && o.target === p.username)?.tone ?? 'default';
  const opts = [['default', 'Default ringtone'], ['ring', 'Classic ring'], ['soft', 'Soft ring'], ['pulse', 'Pulse'], ['chime', 'Chime'], ...mine.map((m) => [`custom:${m.id}`, m.label || 'My sound'])];
  const sh = openSheet(`Ringtone for ${p.displayName}`, h('div', { class: 'stack' }, hint('Plays when this person calls you. Upload longer songs in Studio, Sounds.'), select('tone', cur, opts, safe(async (v) => { state.sound = await api('/api/sound/override', { body: { kind: 'ring', target: p.username, tone: v } }); toast('Saved', { kind: 'ok' }); })), h('button', { class: 'ghost', type: 'button', onclick: () => sh.close() }, 'Done')));
}
actions.openProfile = openProfile;

/* ------------------------------------------------------------------ notifications + friends */
const NOTE = { like: ['heart', 'liked your post'], comment: ['comment', 'commented on your post'], follow: ['user', 'started following you'], follow_request: ['lock', 'wants to follow you'], follow_accept: ['check', 'accepted your follow request'],
  friend_request: ['userplus', 'sent you a friend request'], friend_accept: ['users', 'accepted your friend request'], tip: ['sparkle', 'sent you Sparks'], sparks: ['sparkle', 'gave you Sparks'] };
export async function openNotifications() {
  const body = h('div', { class: 'stack-gap' }); const sh = openSheet('Alerts', body, { key: 'alerts' });
  const load = async () => {
    const [d, reqs] = await Promise.all([api('/api/notifications'), api('/api/follow-requests').catch(() => [])]);
    const rows = d.items.map((n) => {
      const [ic, verb] = NOTE[n.kind] ?? ['bell', n.text ?? 'Notification']; const who = n.name ?? 'Scrxaper';
      const acts = n.kind === 'follow_request' && reqs.some((r) => r.username === n.username) ? h('span', { class: 'inline' }, h('button', { class: 'primary mini', type: 'button', onclick: safe(async (e) => { await api('/api/follow-requests/respond', { body: { username: n.username, accept: true } }); toast('Accepted', { kind: 'ok' }); load(); }) }, 'Accept'), h('button', { class: 'ghost mini', type: 'button', onclick: safe(async () => { await api('/api/follow-requests/respond', { body: { username: n.username, accept: false } }); load(); }) }, 'Decline')) : null;
      const text = ['like', 'comment', 'follow', 'follow_request', 'follow_accept', 'friend_request', 'friend_accept', 'tip', 'sparks'].includes(n.kind) ? `${verb}${n.kind === 'tip' || n.kind === 'sparks' ? ` (${n.text})` : n.kind === 'comment' && n.text ? `: ${n.text}` : ''}` : (n.text ?? verb);
      return h('div', { class: `note${n.seen ? '' : ' unread'}` }, h('span', { class: 'sqicon' }, icon(ic, 18)), h('button', { type: 'button', class: 'grow note-t', onclick: () => { if (n.kind === 'like' || n.kind === 'comment') openPost(String(n.ref).split(':')[0]); else if (n.kind === 'friend_request') { sh.close(); openFriends('requests'); } else if (n.username) openProfile(n.username); } }, h('b', {}, n.username ? who : ''), n.username ? ' ' : '', text, h('small', {}, ` · ${ago(n.at)}`)), acts);
    });
    clear(body, h('div', { class: 'inline' }, h('span', { class: 'grow side-label' }, d.unread ? `${d.unread} new` : 'All caught up'), h('button', { class: 'ghost mini', type: 'button', onclick: safe(async () => { await api('/api/notifications/read', { body: {} }); load(); bus.emit('badges', { notifications: 0 }); }) }, 'Mark all read')), ...(rows.length ? rows : [empty('Nothing yet. Likes, comments and follows land here.', 'bell')]));
    bus.emit('badges', { notifications: d.unread });
  };
  load().catch(fail);
}
export async function openFriends(tab = 'friends') {
  const body = h('div', { class: 'stack' }); const sh = openSheet('Friends', body, { key: 'friends', wide: true });
  let cur = tab;
  const load = async () => {
    const d = await api('/api/friends');
    const person = (u, ...acts) => h('div', { class: 'item static' }, h('button', { type: 'button', class: 'pfp-btn', onclick: () => openProfile(u.username) }, avatarEl(u.avatar, u.name, 40)), h('span', { class: 't' }, u.name, ' ', roleTag(u.tag), h('small', {}, ` @${u.username}`)), h('span', { class: 'inline' }, ...acts));
    const respond = (u, accept) => safe(async () => { await api('/api/friends/respond', { body: { username: u.username, accept } }); if (accept) confetti(); await load(); bus.emit('sse:friend', {}); });
    const tabs = segmented([['friends', `Friends ${d.friends.length}`], ['requests', `Requests ${d.incoming.length + d.outgoing.length}`], ['add', 'Add friend']], cur, (v) => { cur = v; load(); });
    let view;
    if (cur === 'friends') view = d.friends.length ? d.friends.map((u) => person(u, sq('chat', 'Message', { class: 'sm', onclick: () => { sh.close(); actions.openDM(u.username); } }), sq('call', 'Call', { class: 'sm', onclick: () => { sh.close(); actions.startCall(u.username, false); } }))) : [empty('No friends yet. Add someone by username.', 'users')];
    else if (cur === 'requests') view = [...(d.incoming.length ? [h('div', { class: 'side-label' }, 'Incoming'), ...d.incoming.map((u) => person(u, h('button', { class: 'primary mini', type: 'button', onclick: respond(u, true) }, 'Accept'), h('button', { class: 'ghost mini', type: 'button', onclick: respond(u, false) }, 'Ignore')))] : []),
      ...(d.outgoing.length ? [h('div', { class: 'side-label' }, 'Sent'), ...d.outgoing.map((u) => person(u, h('button', { class: 'ghost mini', type: 'button', onclick: safe(async () => { await api('/api/friends/remove', { body: { username: u.username } }); await load(); }) }, 'Cancel')))] : []), ...(!d.incoming.length && !d.outgoing.length ? [empty('No pending requests.', 'userplus')] : [])];
    else { const input = field('username', 'Username', { autocapitalize: 'none', autofocus: true, maxLength: 24 }); view = [form(async (v) => { const u = v.username.trim().toLowerCase().replace(/^@/, ''); if (!u) return; await api('/api/friends/request', { body: { username: u } }); toast(`Request sent to ${u}`, { kind: 'ok' }); input.value = ''; bus.emit('sse:friend', {}); }, h('div', { class: 'inline' }, input, h('button', { class: 'primary', type: 'submit' }, 'Send request'))), hint('Friends can send each other Sparks, and chat when direct messages are set to Friends only.')]; }
    clear(body, tabs, ...view);
    bus.emit('badges', { friendRequests: d.incoming.length });
  };
  load().catch(fail);
}
Object.assign(actions, { openNotifications, openFriends, sharePost, newPost, newStory, newReel, editImage, editVideo, musicPicker });

/* ------------------------------------------------------------------ badges + live updates */
export function init() {
  bus.emit('badges', { notifications: state.me.unread ?? 0, friendRequests: state.me.friendRequests ?? 0 });
  const refreshBadges = async () => { try { const [n, f] = await Promise.all([api('/api/notifications'), api('/api/friends')]); bus.emit('badges', { notifications: n.unread, friendRequests: f.incoming.length }); } catch { /* offline */ } };
  bus.on('sse:notification', (e) => { bus.emit('badges', { notifications: e.unread ?? 0 }); if (!state.privacy?.dnd) actions.notePing?.(); if (document.querySelector('#layer [role=dialog][aria-label=Alerts]')) openNotifications(); });
  bus.on('sse:friend', refreshBadges); bus.on('sse:open', refreshBadges);
  const m = /^#post\/(\d+)/.exec(location.hash); if (m) setTimeout(() => openPost(m[1]), 600);
}
