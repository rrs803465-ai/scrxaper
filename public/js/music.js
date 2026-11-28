// Music search and clip trimmer. Search iTunes + Audius through our own server, cut the part you like,
// and keep it as one of your sounds. Works for ringtones, call tones, posts, stories and reels.
import { state, h, clear, icon, sq, api, upload, toast, fail, openSheet, pickFile, fmtDur, fileUrl } from './core.js';

const streamUrl = (t) => `/api/music/stream?source=${encodeURIComponent(t.source)}&ref=${encodeURIComponent(t.ref)}`;
let ctx = null;
const audioCtx = () => (ctx ??= new (window.AudioContext || window.webkitAudioContext)());

/* ---- WAV encoder: mono, 16-bit, so a minute is about 5 MB and fits the sound limit. */
export function encodeWav(buffer, start, length, { fade = true, rate = 44100 } = {}) {
  const sr = buffer.sampleRate; const from = Math.floor(start * sr); const n = Math.max(1, Math.min(buffer.length - from, Math.floor(length * sr)));
  const chans = []; for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const outN = Math.floor(n * rate / sr); const pcm = new Int16Array(outN);
  const fadeN = fade ? Math.min(Math.floor(rate * 0.35), Math.floor(outN / 3)) : 0;
  for (let i = 0; i < outN; i++) {
    const src = from + Math.min(n - 1, Math.floor(i * sr / rate)); let v = 0;
    for (const ch of chans) v += ch[src]; v /= chans.length;
    if (fadeN) { if (i < fadeN) v *= i / fadeN; else if (i > outN - fadeN) v *= (outN - i) / fadeN; }
    pcm[i] = Math.max(-1, Math.min(1, v)) * 32767;
  }
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, pcm[i], true);
  return new Blob([out.buffer], { type: 'audio/wav' });
}

const peaksOf = (buffer, bars) => {
  const data = buffer.getChannelData(0); const step = Math.max(1, Math.floor(data.length / bars)); const out = [];
  for (let i = 0; i < bars; i++) { let m = 0; for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += Math.max(1, Math.floor(step / 24))) m = Math.max(m, Math.abs(data[j])); out.push(m); }
  const top = Math.max(0.05, ...out); return out.map((p) => p / top);
};

/* ---- The trimmer. Resolves with { id, title } after the clip is saved, or null. */
export function trimmer({ bytes, title, maxSec = 60, hintText = '' }) {
  return new Promise(async (resolve) => {
    let done = false; let src = null; let raf = 0;
    const finish = (v) => { if (done) return; done = true; stop(); sh.close(); resolve(v); };
    const body = h('div', { class: 'stack trim' }, h('div', { class: 'skeleton trim-skel' }));
    const sh = openSheet('Trim your clip', body, { key: 'trim', onClose: () => { stop(); if (!done) { done = true; resolve(null); } } });
    const stop = () => { try { src?.stop(); } catch { /* already stopped */ } src = null; cancelAnimationFrame(raf); };
    let buffer;
    try { buffer = await audioCtx().decodeAudioData(bytes.slice(0)); } catch { toast('That audio could not be read here.', { kind: 'error' }); finish(null); return; }
    const total = buffer.duration; const maxLen = Math.min(maxSec, Math.floor(total));
    const st = { start: 0, len: Math.min(maxLen, 20), fade: true };
    const canvas = h('canvas', { class: 'wave', width: 640, height: 120, role: 'img', 'aria-label': 'Waveform. Drag to move the clip.' });
    const g = canvas.getContext('2d'); const peaks = peaksOf(buffer, 160); let playhead = -1;
    const lab = h('div', { class: 'trim-lab' }); const lenLab = h('small', { class: 'hint' });
    const draw = () => {
      const css = getComputedStyle(canvas); const accent = css.getPropertyValue('--accent').trim() || '#a8b8e8'; const muted = css.getPropertyValue('--muted').trim() || '#888';
      const W = canvas.width; const H = canvas.height; g.clearRect(0, 0, W, H);
      const x0 = st.start / total * W; const x1 = (st.start + st.len) / total * W;
      g.globalAlpha = 0.14; g.fillStyle = accent; g.fillRect(x0, 0, x1 - x0, H); g.globalAlpha = 1;
      peaks.forEach((p, i) => { const x = i / peaks.length * W; const hh = Math.max(3, p * (H - 14)); g.fillStyle = x >= x0 && x <= x1 ? accent : muted; g.globalAlpha = x >= x0 && x <= x1 ? 1 : 0.4; g.fillRect(x, (H - hh) / 2, Math.max(1.5, W / peaks.length - 2), hh); });
      g.globalAlpha = 1; g.fillStyle = accent; g.fillRect(x0 - 1.5, 0, 3, H); g.fillRect(x1 - 1.5, 0, 3, H);
      if (playhead >= 0) { g.fillStyle = '#fff'; g.fillRect(playhead / total * W - 1, 0, 2, H); }
      lab.textContent = `${fmtDur(st.start)} to ${fmtDur(st.start + st.len)}`; lenLab.textContent = `${Math.round(st.len)} seconds${st.len > 30 ? '. Phones may cut long ringtones.' : ''}`;
    };
    const clampStart = () => { st.start = Math.max(0, Math.min(total - st.len, st.start)); };
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); const r = canvas.getBoundingClientRect(); drag = { x: e.clientX, s: st.start, w: r.width }; });
    canvas.addEventListener('pointermove', (e) => { if (!drag) return; st.start = drag.s + (e.clientX - drag.x) / drag.w * total; clampStart(); draw(); });
    canvas.addEventListener('pointerup', () => { if (drag) { drag = null; play(); } });
    canvas.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { st.start += e.key === 'ArrowLeft' ? -1 : 1; clampStart(); draw(); e.preventDefault(); } });
    canvas.tabIndex = 0;
    const len = h('input', { type: 'range', min: 3, max: Math.max(3, maxLen), value: st.len, 'aria-label': 'Clip length' });
    len.addEventListener('input', () => { st.len = Math.min(Number(len.value), total); clampStart(); draw(); });
    len.addEventListener('change', () => play());
    const play = () => {
      stop(); const s = audioCtx(); if (s.state === 'suspended') s.resume();
      const node = s.createBufferSource(); node.buffer = buffer; const gain = s.createGain(); node.connect(gain).connect(s.destination);
      const t0 = s.currentTime; gain.gain.setValueAtTime(st.fade ? 0 : 0.9, t0); if (st.fade) gain.gain.linearRampToValueAtTime(0.9, t0 + 0.3);
      if (st.fade) { gain.gain.setValueAtTime(0.9, t0 + st.len - 0.35); gain.gain.linearRampToValueAtTime(0, t0 + st.len); }
      node.start(0, st.start, st.len); src = node; node.onended = () => { playhead = -1; draw(); };
      const tick = () => { if (!src) return; playhead = st.start + Math.min(st.len, s.currentTime - t0); draw(); raf = requestAnimationFrame(tick); }; tick();
    };
    const fade = h('input', { type: 'checkbox', checked: true }); fade.addEventListener('change', () => { st.fade = fade.checked; });
    const name = h('input', { type: 'text', maxlength: 40, value: String(title ?? 'Clip').slice(0, 40), 'aria-label': 'Name' });
    const save = h('button', { class: 'primary', type: 'button' }, icon('check', 18), ' Save this clip');
    save.addEventListener('click', async () => {
      save.disabled = true; stop();
      try {
        const blob = encodeWav(buffer, st.start, st.len, { fade: st.fade });
        if (blob.size > 9.5 * 1048576) throw new Error('That clip is too long. Make it shorter.');
        const label = `${name.value.trim() || 'Clip'}.wav`;
        const d = await upload(`kind=sound&name=${encodeURIComponent(label)}`, blob);
        toast('Saved to your sounds', { kind: 'ok' }); finish({ id: d.id, title: label.replace(/\.wav$/, '') });
      } catch (e) { fail(e); save.disabled = false; }
    });
    clear(body, hintText ? h('p', { class: 'hint' }, hintText) : null, canvas, h('div', { class: 'row spread' }, lab, sq('play', 'Play the clip', { class: 'sm accent', onclick: play })),
      h('label', { class: 'field' }, 'Length', len), lenLab, h('label', { class: 'row' }, fade, h('span', { class: 'grow' }, 'Fade in and out')), h('label', { class: 'field' }, 'Name', name), save);
    draw(); play();
  });
}

/* ---- Search sheet. Returns { id, title } (already saved as one of your sounds) or null. */
export function musicSearch({ maxSec = 60, purpose = 'music' } = {}) {
  return new Promise((resolve) => {
    let done = false; let player = null; let timer = 0; let token = 0;
    const finish = (v) => { if (done) return; done = true; player?.pause(); sh.close(); resolve(v); };
    const input = h('input', { type: 'search', placeholder: 'Search songs or artists', 'aria-label': 'Search music', autocomplete: 'off', enterkeyhint: 'search' });
    const results = h('div', { class: 'stack-gap music-results' });
    const body = h('div', { class: 'stack' }, h('label', { class: 'searchbar' }, icon('search', 18), input), results,
      h('button', { class: 'ghost', type: 'button', onclick: () => pickFile('audio/*', async (file) => { const t = await trimmer({ bytes: await file.arrayBuffer(), title: file.name.replace(/\.[a-z0-9]+$/i, ''), maxSec }); if (t) finish(t); }) }, icon('upload', 18), ' Import from this device'),
      h('small', { class: 'hint' }, 'Results come from iTunes (30 second previews) and Audius (full songs). Clips are kept for your own use.'));
    const sh = openSheet(purpose === 'ring' ? 'Find a ringtone' : 'Find music', body, { key: 'music-search', onClose: () => { player?.pause(); if (!done) { done = true; resolve(null); } } });
    const msg = (text, cls = 'hint') => clear(results, h('p', { class: `${cls} center` }, text));
    msg('Type a song or an artist.');
    let playing = null;
    const row = (t) => {
      const playBtn = sq('play', 'Preview', { class: 'sm' });
      const r = h('div', { class: 'track' }, t.art ? h('img', { src: t.art, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : h('span', { class: 'art' }, icon('music', 18)), h('span', { class: 'grow' }, h('b', {}, t.title), h('small', {}, `${t.artist}${t.seconds ? ` · ${fmtDur(t.seconds)}` : ''}`)),
        h('span', { class: `chip ${t.full ? 'ok' : ''}` }, t.full ? 'Full' : '30 s'), playBtn, h('button', { class: 'primary mini', type: 'button' }, 'Use'));
      playBtn.addEventListener('click', () => {
        if (playing?.t === t && !player.paused) { player.pause(); return; }
        player?.pause(); player = new Audio(streamUrl(t)); player.volume = 0.8; playing = { t }; r.classList.add('on'); player.play().catch(() => toast('Could not play that one.', { kind: 'error' }));
        player.onended = player.onpause = () => r.classList.remove('on');
      });
      r.querySelector('.primary').addEventListener('click', async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Loading'; player?.pause();
        try {
          const res = await fetch(streamUrl(t), { headers: { 'X-Requested-With': 'scrxaper' }, credentials: 'same-origin' });
          if (!res.ok) throw new Error('That track is not available right now.');
          const out = await trimmer({ bytes: await res.arrayBuffer(), title: `${t.title}`, maxSec: Math.min(maxSec, t.full ? maxSec : 30), hintText: t.full ? '' : 'This source gives a 30 second preview.' });
          if (out) finish({ ...out, artist: t.artist });
        } catch (er) { fail(er); } finally { b.disabled = false; b.textContent = 'Use'; }
      });
      return r;
    };
    const run = async (q) => {
      const my = ++token; msg('Searching');
      try {
        const d = await api(`/api/music/search?q=${encodeURIComponent(q)}`);
        if (my !== token) return;
        if (!d.tracks.length) return msg('Nothing found. Try another spelling.');
        clear(results, ...d.tracks.map(row));
      } catch (e) { if (my === token) msg(e.message || 'Search is not available right now. You can still import from this device.'); }
    };
    input.addEventListener('input', () => { clearTimeout(timer); const q = input.value.trim(); if (q.length < 2) { token++; return msg('Type a song or an artist.'); } timer = setTimeout(() => run(q), 350); });
    setTimeout(() => input.focus(), 250);
  });
}
