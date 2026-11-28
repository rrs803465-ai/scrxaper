// Media tooling: music picker, photo editor, video editor, and the post/story/reel composer.
import { musicSearch } from './music.js';
import { $, state, actions, h, clear, icon, sq, api, upload, toast, fail, ask, openSheet, pickFile, audioLength, fmtDur, fmtBytes, fileUrl, segmented, toggle } from './core.js';

/* ------------------------------------------------------------------ music picker */
export function musicPicker({ current = null, reel = false } = {}) {
  return new Promise((resolve) => {
    let chosen = current ? { ...current } : null; let audio = null; let done = false;
    const finish = (v) => { if (done) return; done = true; audio?.pause(); sh.close(); resolve(v); };
    const body = h('div', { class: 'stack' });
    const sh = openSheet('Add music', body, { key: 'music', onClose: () => { audio?.pause(); if (!done) { done = true; resolve(null); } } });
    const list = h('div', { class: 'stack-gap' }); const detail = h('div', { class: 'stack', hidden: true });
    const preview = (id, start = 0) => { audio?.pause(); audio = new Audio(fileUrl(id)); audio.currentTime = start; audio.volume = 0.7; audio.play().catch(() => {}); return audio; };
    const select = async (t) => {
      chosen = { id: t.id, title: t.title, start: 0, mute: false };
      const a = preview(t.id); const len = await new Promise((r) => { a.onloadedmetadata = () => r(a.duration); setTimeout(() => r(NaN), 3000); });
      const range = h('input', { type: 'range', min: 0, max: Number.isFinite(len) ? Math.max(Math.floor(len) - 1, 0) : 0, value: 0, 'aria-label': 'Start second' });
      const lab = h('small', { class: 'hint' }, 'Starts at 0:00');
      range.addEventListener('input', () => { chosen.start = Number(range.value); lab.textContent = `Starts at ${fmtDur(chosen.start)}`; });
      range.addEventListener('change', () => preview(t.id, chosen.start));
      clear(detail, h('div', { class: 'row' }, icon('music', 18), h('strong', { class: 'grow' }, t.title), sq('close', 'Remove music', { class: 'sm', onclick: () => { chosen = null; audio?.pause(); detail.hidden = true; } })), h('label', { class: 'field' }, 'Start at', range), lab,
        ...(reel ? [toggle('mute', 'Mute original sound', false, (v) => { chosen.mute = v; })] : []), h('button', { class: 'primary', type: 'button', onclick: () => finish(chosen) }, 'Use this track'));
      detail.hidden = false;
    };
    const rowFor = (t, sub) => h('div', { class: 'row' }, sq('play', 'Preview', { class: 'sm', onclick: () => preview(t.id) }), h('span', { class: 'grow' }, t.title, sub ? h('br') : null, sub ? h('small', {}, sub) : null), h('button', { class: 'ghost mini', type: 'button', onclick: () => select(t) }, 'Choose'));
    const refresh = async () => {
      const [mine, lib] = await Promise.all([api('/api/sounds').catch(() => []), api('/api/music/library').catch(() => [])]);
      clear(list, h('div', { class: 'side-label' }, 'Your sounds'), ...(mine.length ? mine.map((m) => rowFor({ id: m.id, title: (m.label || 'My sound').replace(/\.[a-z0-9]+$/i, '') }, null)) : [h('p', { class: 'hint' }, 'Nothing uploaded yet.')]),
        h('div', { class: 'side-label' }, 'Used by people you can see'), ...(lib.length ? lib.map((m) => rowFor({ id: m.id, title: m.title }, `by ${m.by}`)) : [h('p', { class: 'hint' }, 'Nothing here yet.')]));
    };
    const bar = h('i', {});
    const up = h('div', { class: 'row' }, sq('upload', 'Upload', { class: 'sm' }), h('span', { class: 'grow' }, 'Upload music (any length, up to 10 MB)'), h('span', { class: 'pend', hidden: true }, h('span', { class: 'bar' }, bar)));
    up.addEventListener('click', () => pickFile('audio/*', async (file) => {
      if (file.size > 10 * 1048576) return toast('That file is over 10 MB.', { kind: 'error' });
      const pend = up.querySelector('.pend'); pend.hidden = false;
      try { const d = await upload(`kind=sound&name=${encodeURIComponent(file.name)}`, file, (x) => { bar.style.width = `${Math.round(x * 100)}%`; }); await refresh(); toast('Uploaded', { kind: 'ok' }); select({ id: d.id, title: file.name.replace(/\.[a-z0-9]+$/i, '') }); } catch (e) { fail(e); } finally { pend.hidden = true; }
    }));
    const find = h('button', { class: 'primary', type: 'button', onclick: async () => { const t = await musicSearch({ maxSec: 60 }); if (t) { await refresh(); select({ id: t.id, title: t.artist ? `${t.title} - ${t.artist}` : t.title }); } } }, icon('search', 18), ' Search for a song');
    append(body, [find, up, detail, list]);
    if (current) detail.hidden = true;
    refresh();
  });
}
const append = (n, kids) => { kids.forEach((k) => n.append(k)); return n; };

/* ------------------------------------------------------------------ photo editor */
const FILTERS = { Original: {}, Mono: { s: -100 }, Warm: { tint: [14, 4, -12] }, Cool: { tint: [-10, 2, 14] }, Fade: { c: -18, b: 12 }, Vivid: { s: 45, c: 12 } };
const ASPECTS = { free: 0, '1:1': 1, '4:5': 4 / 5, '16:9': 16 / 9, '9:16': 9 / 16, '3:1': 3 };
const overlay = (title, ...kids) => {
  const x = sq('close', 'Cancel', { class: 'ghost' });
  const box = h('div', { class: 'editor-box' }, h('header', { class: 'sheet-head' }, h('h2', { class: 'sheet-title' }, title), x), ...kids);
  const el = h('div', { class: 'editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, box);
  $('overlays').append(el); requestAnimationFrame(() => el.classList.add('in'));
  return { el, box, x, close: () => { el.classList.remove('in'); setTimeout(() => el.remove(), 220); } };
};

export function editImage(file, { aspect = 'free' } = {}) {
  return new Promise(async (resolve) => {
    if (file.type === 'image/gif') return resolve(file);
    const bitmap = await createImageBitmap(file).catch(() => null);
    if (!bitmap) { toast('That image could not be read.', { kind: 'error' }); return resolve(null); }
    const st = { rot: 0, flip: false, aspect, b: 0, c: 0, s: 0, filter: 'Original' };
    const preview = h('canvas', { class: 'editor-canvas' }); const stage = document.createElement('canvas');
    function adjust(ctx, w, hh) {
      const f = FILTERS[st.filter]; const bri = st.b + (f.b ?? 0); const con = st.c + (f.c ?? 0); const sat = st.s + (f.s ?? 0); const tint = f.tint ?? [0, 0, 0];
      if (!bri && !con && !sat && !f.tint) return;
      const img = ctx.getImageData(0, 0, w, hh); const d = img.data; const cf = (259 * (con + 255)) / (255 * (259 - con)); const sf = 1 + sat / 100;
      for (let i = 0; i < d.length; i += 4) { const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; for (let k = 0; k < 3; k++) { const v = lum + (d[i + k] - lum) * sf + bri * 2.55 + tint[k]; d[i + k] = cf * (v - 128) + 128; } }
      ctx.putImageData(img, 0, 0);
    }
    function render(canvas, maxSide) {
      const turned = st.rot % 2 === 1; const sw = turned ? bitmap.height : bitmap.width; const sh = turned ? bitmap.width : bitmap.height; let cw = sw; let ch = sh; const r = ASPECTS[st.aspect];
      if (r) { if (sw / sh > r) cw = Math.round(sh * r); else ch = Math.round(sw / r); }
      const k = Math.min(1, maxSide / Math.max(cw, ch)); canvas.width = Math.max(1, Math.round(cw * k)); canvas.height = Math.max(1, Math.round(ch * k));
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.scale(k, k); ctx.translate(-Math.round((sw - cw) / 2), -Math.round((sh - ch) / 2)); ctx.translate(sw / 2, sh / 2); ctx.rotate((st.rot * Math.PI) / 2); if (st.flip) ctx.scale(-1, 1);
      ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2); ctx.setTransform(1, 0, 0, 1, 0, 0); adjust(ctx, canvas.width, canvas.height);
    }
    let queued = false; const refresh = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; render(preview, 640); }); } };
    const slider = (label, key) => h('label', { class: 'field' }, label, h('input', { type: 'range', min: -100, max: 100, value: 0, 'aria-label': label, oninput: (e) => { st[key] = Number(e.target.value); refresh(); } }));
    const chips = Object.keys(FILTERS).map((name) => h('button', { type: 'button', class: `chip${name === st.filter ? ' on' : ''}`, onclick: (e) => { st.filter = name; chips.forEach((c) => c.classList.toggle('on', c === e.currentTarget)); refresh(); } }, name));
    const ov = overlay('Edit photo', preview,
      h('div', { class: 'editor-tools' }, sq('refresh', 'Rotate', { onclick: () => { st.rot = (st.rot + 1) % 4; refresh(); } }), sq('drag', 'Flip', { onclick: () => { st.flip = !st.flip; refresh(); } }),
        h('select', { 'aria-label': 'Crop', onchange: (e) => { st.aspect = e.target.value; refresh(); } }, ...Object.keys(ASPECTS).map((a) => h('option', { value: a, selected: a === st.aspect }, a === 'free' ? 'Original shape' : a))),
        slider('Brightness', 'b'), slider('Contrast', 'c'), slider('Saturation', 's')),
      h('div', { class: 'inline' }, ...chips), h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => { ov.close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'primary', type: 'button', onclick: () => { render(stage, 2048); stage.toBlob((blob) => { ov.close(); resolve(blob); }, 'image/jpeg', 0.9); } }, 'Done')));
    ov.x.onclick = () => { ov.close(); resolve(null); };
    render(preview, 640);
  });
}

/* ------------------------------------------------------------------ video editor */
const CSS_FILTERS = { Original: 'none', Mono: 'grayscale(1)', Warm: 'sepia(.35) saturate(1.2)', Cool: 'hue-rotate(185deg) saturate(.9) brightness(1.05)', Fade: 'contrast(.85) brightness(1.1)', Vivid: 'saturate(1.6) contrast(1.1)' };
const pickMime = () => ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => window.MediaRecorder?.isTypeSupported?.(m));
export function editVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = h('video', { src: url, class: 'editor-canvas', controls: false, playsInline: true, preload: 'auto' });
    const st = { start: 0, end: 0, mute: false, speed: 1, filter: 'Original' };
    const info = h('small', { class: 'hint' }); const bar = h('div', { class: 'bar-big', hidden: true }, h('i', {})); let cancelled = false; let recorder = null;
    const done = (val) => { URL.revokeObjectURL(url); ov.close(); resolve(val); };
    const range = (key, label) => h('label', { class: 'field' }, label, h('input', { type: 'range', min: 0, max: 100, step: 0.1, value: 0, 'aria-label': label, oninput: (e) => { st[key] = Number(e.target.value); if (st.end < st.start + 0.5) { if (key === 'start') st.end = Math.min(st.start + 0.5, v.duration); else st.start = Math.max(st.end - 0.5, 0); sync(); } v.currentTime = key === 'start' ? st.start : Math.max(st.end - 0.3, 0); describe(); v.style.filter = CSS_FILTERS[st.filter]; } }));
    const sRange = range('start', 'Trim start'); const eRange = range('end', 'Trim end');
    const sync = () => { sRange.querySelector('input').value = st.start; eRange.querySelector('input').value = st.end; };
    const describe = () => { const len = (st.end - st.start) / st.speed; info.textContent = `Clip length ${fmtDur(Math.max(len, 0))}${len > MAX_SEC ? ` (over the ${MAX_SEC / 60} minute limit, trim more)` : ''}`; info.style.color = len > MAX_SEC ? 'var(--danger)' : ''; };
    const chips = Object.keys(CSS_FILTERS).map((n) => h('button', { type: 'button', class: `chip${n === st.filter ? ' on' : ''}`, onclick: (e) => { st.filter = n; chips.forEach((c) => c.classList.toggle('on', c === e.currentTarget)); v.style.filter = CSS_FILTERS[n]; } }, n));
    const exportBtn = h('button', { class: 'primary', type: 'button', onclick: exportClip }, 'Done');
    const ov = overlay('Edit video', v, sRange, eRange, info,
      h('div', { class: 'editor-tools' }, sq('play', 'Preview trimmed clip', { onclick: () => { v.currentTime = st.start; v.playbackRate = st.speed; v.muted = st.mute; v.play(); } }), toggle('mute', 'Mute audio', false, (x) => { st.mute = x; }),
        h('select', { 'aria-label': 'Speed', onchange: (e) => { st.speed = Number(e.target.value); describe(); } }, ...[0.5, 1, 1.5, 2].map((s) => h('option', { value: s, selected: s === 1 }, `${s}x`)))),
      h('div', { class: 'inline' }, ...chips), bar, h('div', { class: 'dlg-actions' }, h('button', { class: 'ghost', type: 'button', onclick: () => { cancelled = true; recorder?.state === 'recording' && recorder.stop(); done(null); } }, 'Cancel'), exportBtn));
    ov.x.onclick = () => { cancelled = true; recorder?.state === 'recording' && recorder.stop(); done(null); };
    v.addEventListener('loadedmetadata', async () => {
      if (v.duration === Infinity) { v.currentTime = 1e7; await new Promise((r) => v.addEventListener('timeupdate', r, { once: true })); v.currentTime = 0; }
      st.end = Math.min(v.duration, MAX_SEC); for (const r of [sRange, eRange]) r.querySelector('input').max = v.duration;
      eRange.querySelector('input').value = st.end; describe();
    });
    v.addEventListener('error', () => { toast('That video could not be read.', { kind: 'error' }); done(null); });
    v.addEventListener('timeupdate', () => { if (!v.paused && v.currentTime >= st.end) v.pause(); });
    async function exportClip() {
      const len = (st.end - st.start) / st.speed;
      if (len > MAX_SEC) return toast('Videos can be up to 3 minutes. Trim the clip.', { kind: 'error' });
      const untouched = file.size < 100 * 1048576 && st.start === 0 && st.end >= v.duration - 0.2 && st.speed === 1 && !st.mute && st.filter === 'Original';
      if (untouched) return done(file);
      const mime = pickMime();
      if (!mime || !HTMLCanvasElement.prototype.captureStream) return toast('This browser cannot re-encode video. Trim and filters are unavailable here; the original can still be posted.', { kind: 'error', ms: 6000 });
      exportBtn.disabled = true; bar.hidden = false; const fill = bar.firstChild;
      const scale = Math.min(1, 1080 / Math.max(v.videoWidth, v.videoHeight)); const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
      const g = c.getContext('2d'); g.filter = CSS_FILTERS[st.filter];
      const out = c.captureStream(30);
      let ctx; if (!st.mute) { try { ctx = new AudioContext(); const src = ctx.createMediaElementSource(v); const dest = ctx.createMediaStreamDestination(); src.connect(dest); dest.stream.getAudioTracks().forEach((t) => out.addTrack(t)); } catch { /* video only */ } }
      const chunks = []; recorder = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 3500000 });
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => { v.pause(); ctx?.close(); if (cancelled) return; done(new Blob(chunks, { type: mime.split(';')[0] })); };
      v.muted = st.mute; v.playbackRate = st.speed; v.currentTime = st.start; await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
      recorder.start(250); await v.play().catch(() => {});
      const frame = () => { if (cancelled || recorder.state !== 'recording') return; g.drawImage(v, 0, 0, c.width, c.height); fill.style.width = `${Math.min(100, ((v.currentTime - st.start) / (st.end - st.start)) * 100)}%`; if (v.currentTime >= st.end || v.ended) { recorder.stop(); return; } requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    }
  });
}

const MAX_SEC = 180; // posts and reels: up to 3 minutes

/* ------------------------------------------------------------------ composer: post, story, reel */
async function compose(kind, blob, after) {
  const url = URL.createObjectURL(blob); const isVideo = blob.type.startsWith('video');
  let music = null;
  const media = isVideo ? h('video', { src: url, controls: true, muted: true, playsInline: true, class: 'post-media' }) : h('img', { src: url, alt: 'Preview', class: 'post-media' });
  const caption = h('textarea', { name: 'caption', placeholder: kind === 'story' ? 'Stories disappear after 24 hours' : 'Write a caption. Use #tags and @mentions', 'aria-label': 'Caption', maxLength: 1000, hidden: kind === 'story' });
  const musicBtn = h('button', { class: 'ghost', type: 'button', onclick: async () => { const m = await musicPicker({ current: music, reel: kind === 'reel' }); if (m) { music = m; paint(); } } });
  const paint = () => clear(musicBtn, icon('music', 16), ` ${music ? music.title : 'Add music'}`);
  paint();
  const prog = h('div', { class: 'bar-big', hidden: true }, h('i', {})); const go = h('button', { class: 'primary', type: 'button' }, 'Share');
  const sh = openSheet(kind === 'story' ? 'New story' : kind === 'reel' ? 'New reel' : 'New post', h('div', { class: 'stack' }, media, caption, h('div', { class: 'inline' }, musicBtn, music?.title ? '' : ''), prog, go), { onClose: () => URL.revokeObjectURL(url) });
  go.addEventListener('click', async () => {
    go.disabled = true; prog.hidden = false;
    try {
      const d = await upload(`kind=${kind}`, blob, (x) => { prog.firstChild.style.width = `${Math.round(x * 100)}%`; });
      await api(kind === 'story' ? '/api/stories' : '/api/posts', { body: { media: d.id, caption: caption.value, ...(music ? { music: { id: music.id, title: music.title, start: music.start, mute: !!music.mute } } : {}) } });
      sh.close(); toast(kind === 'story' ? 'Story shared' : 'Shared', { kind: 'ok' }); after?.();
    } catch (e) { fail(e); go.disabled = false; prog.hidden = true; }
  });
}
export const newPost = () => pickFile('image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime', async (file) => {
  if (file.type.startsWith('video/')) { const v = await editVideo(file); if (v) compose('reel', v, () => actions.openFeed?.('feed')); return; }
  const b = await editImage(file); if (b) compose('post', b, () => actions.openFeed?.('feed'));
});
export const newStory = () => pickFile('image/png,image/jpeg,image/webp', async (file) => { const b = await editImage(file, { aspect: '9:16' }); if (b) compose('story', b, () => actions.openFeed?.('feed')); });
export const newReel = () => pickFile('video/mp4,video/webm,video/quicktime', async (file) => { const b = await editVideo(file); if (b) compose('reel', b, () => actions.openFeed?.('reels')); });
