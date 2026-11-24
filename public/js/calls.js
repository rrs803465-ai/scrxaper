// Calls: 1:1 audio/video (calling tune for the caller, ringtone + visualizer for the callee only), voice channels and
// group calls (mesh WebRTC, up to 8), synced Jukebox playback, installed-app push and service worker wiring.
import { $, state, bus, actions, h, clear, icon, sq, avatarEl, api, toast, fail, ask, ripple, audioCtx, TONE_NOTES, playSound, fileUrl, fmtDur } from './core.js';

export const VIZ_STYLES = [['none', 'Plain'], ['ring', 'Spectrum ring'], ['cd', 'Spinning CD'], ['bars', 'Equaliser'], ['wave', 'Waveform'], ['pulse', 'Pulse'], ['orbit', 'Orbit']];
const reduced = () => document.documentElement.dataset.motion === 'reduced';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ audio graph for the ringtone (so the visualizer follows the real beat) */
function ringGraph(value, volume) {
  const ctx = audioCtx();
  if (!ctx) return { analyser: null, stop() {} };
  const analyser = ctx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.72;
  const out = ctx.createGain(); out.gain.value = Math.min(Math.max(volume / 100, 0), 1);
  out.connect(analyser); analyser.connect(ctx.destination);
  let stopSrc = () => {};
  if (String(value).startsWith('custom:')) {
    const a = new Audio(fileUrl(value.slice(7))); a.loop = true; a.crossOrigin = 'anonymous';
    try { const src = ctx.createMediaElementSource(a); src.connect(out); stopSrc = () => { a.pause(); try { src.disconnect(); } catch { /* gone */ } }; } catch { a.volume = out.gain.value; stopSrc = () => a.pause(); }
    a.play().catch(() => {});
  } else if (value && value !== 'none' && TONE_NOTES[value]) {
    const fire = () => { for (const [freq, at, len = 0.28] of TONE_NOTES[value]) { const o = ctx.createOscillator(); const g = ctx.createGain(); const t = ctx.currentTime + at; o.frequency.value = freq; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.35, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.02); o.connect(g).connect(out); o.start(t); o.stop(t + len + 0.05); } };
    fire(); const timer = setInterval(fire, 2000); stopSrc = () => clearInterval(timer);
  }
  return { analyser, stop() { stopSrc(); try { analyser.disconnect(); out.disconnect(); } catch { /* gone */ } } };
}

/* ------------------------------------------------------------------ visualizer */
function startViz(canvas, pfp, analyser, style, color) {
  const g = canvas.getContext('2d'); const W = (canvas.width = 440); const H = (canvas.height = 440); const cx = W / 2; const cy = H / 2;
  const freq = new Uint8Array(analyser ? analyser.frequencyBinCount : 128); const wave = new Uint8Array(analyser ? analyser.fftSize : 256);
  const parts = Array.from({ length: 56 }, (_, i) => ({ a: (i / 56) * Math.PI * 2, r: 0.9 + Math.random() * 0.5, v: 0.4 + Math.random() }));
  let pulses = []; let angle = 0; let last = 0; let raf = 0; let beatAt = 0; let idle = 0;
  const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += freq[i] ?? 0; return s / Math.max(b - a, 1) / 255; };
  const draw = (now) => {
    raf = requestAnimationFrame(draw);
    if (document.hidden) return;
    const dt = Math.min((now - last) / 16.7 || 1, 3); last = now; idle += 0.03 * dt;
    if (analyser) { analyser.getByteFrequencyData(freq); analyser.getByteTimeDomainData(wave); }
    const bass = analyser ? avg(1, 7) : 0; const mid = analyser ? avg(7, 40) : 0; const lvl = Math.max(bass, mid * 0.8, 0.04 + Math.sin(idle) * 0.02);
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round'; g.strokeStyle = color; g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 12;
    if (style === 'ring') {
      const n = 72;
      for (let i = 0; i < n; i++) { const v = (freq[Math.floor((i / n) * 60)] ?? 0) / 255; const a = (i / n) * Math.PI * 2 - Math.PI / 2; const r0 = 84; const r1 = r0 + 6 + v * 92; g.lineWidth = 3.4; g.globalAlpha = 0.45 + v * 0.55; g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke(); }
    } else if (style === 'cd') {
      angle += (0.6 + bass * 7) * dt;
      pfp.style.transform = `rotate(${angle}deg)`;
      const grad = g.createRadialGradient(cx, cy, 20, cx, cy, 160); grad.addColorStop(0, '#1b1f27'); grad.addColorStop(1, '#07090c');
      g.shadowBlur = 0; g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, 160, 0, 7); g.fill();
      g.globalAlpha = 0.18; g.lineWidth = 1; g.strokeStyle = '#fff'; for (let r = 80; r < 158; r += 5) { g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke(); }
      if (g.createConicGradient) { const cg = g.createConicGradient((angle * Math.PI) / 180, cx, cy); cg.addColorStop(0, 'rgba(255,255,255,.0)'); cg.addColorStop(0.12, 'rgba(255,255,255,.16)'); cg.addColorStop(0.25, 'rgba(255,255,255,0)'); cg.addColorStop(0.62, 'rgba(255,255,255,.12)'); cg.addColorStop(0.75, 'rgba(255,255,255,0)'); g.globalAlpha = 1; g.fillStyle = cg; g.beginPath(); g.arc(cx, cy, 160, 0, 7); g.fill(); }
      g.globalAlpha = 0.5 + bass * 0.5; g.strokeStyle = color; g.shadowBlur = 10 + bass * 30; g.lineWidth = 3 + bass * 4; g.beginPath(); g.arc(cx, cy, 163 + bass * 8, 0, 7); g.stroke();
    } else if (style === 'bars') {
      const n = 32; const bw = (W - 80) / n;
      for (let i = 0; i < n; i++) { const v = (freq[Math.floor((i / n) * 64)] ?? 0) / 255; const bh = 6 + v * 120; g.globalAlpha = 0.5 + v * 0.5; g.beginPath(); g.roundRect?.(40 + i * bw + 1, H - 36 - bh, bw - 3, bh, 3); if (!g.roundRect) g.rect(40 + i * bw + 1, H - 36 - bh, bw - 3, bh); g.fill(); }
    } else if (style === 'wave') {
      g.lineWidth = 3; g.globalAlpha = 0.9; g.beginPath();
      for (let i = 0; i < wave.length; i++) { const x = (i / (wave.length - 1)) * W; const y = cy + ((wave[i] - 128) / 128) * 120 * (analyser ? 1 : 0.05); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.stroke();
    } else if (style === 'pulse') {
      if (bass > 0.55 && now - beatAt > 260) { beatAt = now; pulses.push({ r: 70, a: 0.8 }); }
      if (!analyser && now - beatAt > 1400) { beatAt = now; pulses.push({ r: 70, a: 0.6 }); }
      pulses = pulses.filter((p) => p.a > 0.02);
      for (const p of pulses) { p.r += 2.2 * dt; p.a *= 0.965; g.globalAlpha = p.a; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, p.r, 0, 7); g.stroke(); }
    } else if (style === 'orbit') {
      angle += (0.4 + bass * 2.4) * dt * 0.02;
      for (const p of parts) { const rr = 96 + (p.r - 0.9) * 70 + bass * 46 * p.v; const a = p.a + angle * p.v; g.globalAlpha = 0.5 + mid * 0.5; g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, 2 + p.v * 2 + bass * 3, 0, 7); g.fill(); }
    }
    g.globalAlpha = 1;
    if (style !== 'cd') pfp.style.transform = `scale(${1 + lvl * 0.06})`;
  };
  if (reduced()) { requestAnimationFrame((t) => { draw(t); cancelAnimationFrame(raf); }); return () => {}; }
  raf = requestAnimationFrame(draw);
  return () => { cancelAnimationFrame(raf); };
}

/* ------------------------------------------------------------------ bottom pill (never floats mid-screen) */
let pillTimer;
function showPill(text, ic = 'phoneoff') {
  const pill = $('pill'); clearTimeout(pillTimer);
  pill.classList.remove('out'); clear(pill, icon(ic, 17), h('b', {}, text)); pill.hidden = false;
  pill.style.animation = 'none'; void pill.offsetWidth; pill.style.animation = '';
  pillTimer = setTimeout(() => { pill.classList.add('out'); pillTimer = setTimeout(() => { pill.hidden = true; pill.classList.remove('out'); }, 380); }, 3200);
}

/* ------------------------------------------------------------------ 1:1 calls */
const call = { id: null, peer: null, name: '', avatar: null, pc: null, local: null, screen: null, queue: [], incoming: false, video: false, videoSender: null, tune: null, ring: null, viz: null, connectedAt: 0, ui: null, timer: 0, wake: null, accepted: false };
let pendingAnswer = null;
const sendSignal = (data) => api('/api/call/signal', { body: { call: call.id, data } }).catch(() => {});

function ringtoneFor(username) {
  const s = state.sound ?? {};
  return s.overrides?.find((o) => o.kind === 'ring' && o.target === username)?.tone ?? s.ringtone ?? 'ring';
}
function stopAudio() { call.tune?.(); call.tune = null; call.ring?.stop(); call.ring = null; call.viz?.(); call.viz = null; }

function callUI({ name, avatar, status, incoming }) {
  closeCallUI();
  const stage = h('div', { class: 'cs-stage' });
  const pfp = Object.assign(avatarEl(avatar, name, 120), { className: `${avatar ? '' : ''}pfp cs-pfp` });
  const canvas = incoming ? h('canvas', { class: 'cs-viz', 'aria-hidden': 'true' }) : h('span', { hidden: true });   // only the person being called ever gets a visualizer
  const statusEl = h('span', { class: 'cs-status', role: 'status' }, status);
  const remote = h('video', { class: 'cs-remote', autoplay: true, playsInline: true, hidden: true });
  const local = h('video', { class: 'cs-local', autoplay: true, playsInline: true, muted: true, hidden: true });
  const mic = sq('mic', 'Mute microphone', { onclick: toggleMic }); const cam = sq('video', 'Camera', { onclick: toggleCam, hidden: true }); const share = sq('screen', 'Share screen', { onclick: toggleShare, hidden: !navigator.mediaDevices?.getDisplayMedia });
  const end = sq('endcall', incoming ? 'Decline' : 'End call', { class: 'red lg', onclick: () => (call.incoming && !call.accepted ? decline() : hangup()) });
  const accept = sq('call', 'Answer', { class: 'lg green', onclick: accepted, hidden: !incoming });
  const controls = h('div', { class: 'cs-controls' }, accept, mic, cam, share, end);
  if (incoming) [mic, share].forEach((b) => { b.hidden = true; });
  stage.append(canvas, pfp);
  const el = h('section', { class: `callscreen${incoming ? ' ringing' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': `Call with ${name}` }, remote, local,
    h('div', { class: 'cs-top' }, h('strong', { class: 'cs-name' }, name), statusEl), stage, controls);
  $('overlays').append(el);
  requestAnimationFrame(() => el.classList.add('in'));
  call.ui = { el, pfp, canvas, statusEl, remote, local, mic, cam, share, accept, controls, stage };
  return call.ui;
}
const setStatus = (t) => { if (call.ui) call.ui.statusEl.textContent = t; };
function closeCallUI() { call.ui?.el.remove(); call.ui = null; }
function tick() { clearInterval(call.timer); call.timer = setInterval(() => call.connectedAt && setStatus(fmtDur((Date.now() - call.connectedAt) / 1000)), 1000); }

function cleanup() {
  stopAudio(); clearInterval(call.timer);
  call.pc?.close();
  [call.local, call.screen].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  call.wake?.release?.().catch?.(() => {}); call.wake = null;
  closeCallUI();
  Object.assign(call, { id: null, peer: null, pc: null, local: null, screen: null, queue: [], incoming: false, accepted: false, videoSender: null, connectedAt: 0 });
}
function finish(text, ic) { const wasConnected = call.connectedAt; const dur = wasConnected ? Math.round((Date.now() - wasConnected) / 1000) : 0; cleanup(); showPill(text ?? (dur ? `Call ended · ${fmtDur(dur)}` : 'Call ended'), ic); }

async function prepare(video, attach = true) {
  const { iceServers } = await api('/api/ice');
  try { call.local = await navigator.mediaDevices.getUserMedia({ audio: true, video }); } catch (err) { if (!video) throw err; call.local = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  const ui = call.ui;
  if (ui) { ui.local.srcObject = call.local; ui.local.hidden = !call.local.getVideoTracks().length; ui.cam.hidden = !call.local.getVideoTracks().length; }
  const pc = new RTCPeerConnection({ iceServers }); call.pc = pc;
  const remote = new MediaStream(); if (ui) ui.remote.srcObject = remote;
  if (attach) { call.local.getAudioTracks().forEach((t) => pc.addTrack(t, call.local)); call.videoSender = pc.addTransceiver(call.local.getVideoTracks()[0] ?? 'video', { direction: 'sendrecv' }).sender; }
  pc.ontrack = (e) => { remote.addTrack(e.track); if (e.track.kind === 'video' && call.ui) { call.ui.remote.hidden = false; call.ui.el.classList.add('has-video'); } };
  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected' && !call.connectedAt) { call.connectedAt = Date.now(); call.ui?.el.classList.remove('ringing'); call.ui?.el.classList.add('live'); stopAudio(); tick(); setStatus('Connected'); }
    if (pc.connectionState === 'failed') setStatus('Connection failed. A TURN server may be needed on this network.');
  };
  try { call.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}

async function startCall(username, video) {
  if (call.id || currentRoom()) return toast('Finish your current call first.');
  const peer = await api(`/api/profile?user=${encodeURIComponent(username)}`).catch(() => null);
  const name = peer?.displayName ?? username;
  const ui = callUI({ name, avatar: peer?.avatar, status: 'Calling...', incoming: false });
  ui.pfp.classList.add('calling'); ui.accept.hidden = true; ui.mic.hidden = false;
  try {
    Object.assign(call, { peer: username, name, avatar: peer?.avatar, video, incoming: false });
    await prepare(video);
    const r = await api('/api/call/start', { body: { to: username, video } });
    call.id = r.id;
    const s = state.sound ?? {}; const tune = s.callingTune ?? 'ringback';
    if (!state.privacy?.dnd || true) call.tune = playSound(tune, s.volume ?? 60, true);   // the CALLER hears the calling tune, never the ringtone
  } catch (err) {
    cleanup();
    toast(err.name === 'NotAllowedError' || err.name === 'NotFoundError' ? 'Allow microphone access (and a camera for video) to call.' : err.message, { kind: 'error' });
  }
}

function incomingCall(m, { preview = false, prefs } = {}) {
  const p = prefs ?? state.me.prefs; const style = p.vizStyle ?? 'ring'; const color = p.vizColor || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#b7c9e6';
  const ui = callUI({ name: m.name, avatar: m.avatar, status: m.video ? 'Incoming video call' : 'Incoming call', incoming: true });
  ui.el.dataset.viz = style; ui.pfp.classList.add(`viz-${style}`);
  const s = state.sound ?? {};
  const tone = preview ? (s.ringtone ?? 'ring') : ringtoneFor(m.from);
  const muted = !preview && (state.privacy?.dnd || (window.ScrxNative && document.hidden)); // in the Android app the background service rings while the page is hidden
  call.ring = ringGraph(muted ? 'none' : tone, s.volume ?? 60);
  if (style === 'none') ui.canvas.hidden = true; else call.viz = startViz(ui.canvas, ui.pfp, call.ring.analyser, style, color);
  if (preview) { ui.accept.hidden = true; ui.controls.replaceChildren(sq('close', 'Close preview', { class: 'red lg', onclick: () => { stopAudio(); closeCallUI(); } })); ui.statusEl.textContent = 'Preview: only you see this'; }
}

function accepted() {
  stopAudio(); call.accepted = true;
  call.ui.accept.hidden = true; call.ui.el.classList.remove('ringing'); setStatus('Connecting...');
  call.ui.mic.hidden = false; call.ui.share.hidden = !navigator.mediaDevices?.getDisplayMedia; call.ui.canvas.hidden = true;
  prepare(call.video, false).then(() => api('/api/call/answer', { body: { call: call.id } })).catch(async () => { await api('/api/call/decline', { body: { call: call.id } }).catch(() => {}); cleanup(); toast('Allow microphone access to answer calls.', { kind: 'error' }); });
}
async function decline() { const id = call.id; await api('/api/call/decline', { body: { call: id } }).catch(() => {}); if (call.id === id) finish('Call declined', 'phoneoff'); }
async function hangup() { const id = call.id; await api('/api/call/end', { body: { call: id } }).catch(() => {}); if (call.id === id) finish(); }

async function onSignal(data) {
  if (!call.pc) return;
  if (data.description) {
    await call.pc.setRemoteDescription(data.description);
    for (const c of call.queue.splice(0)) await call.pc.addIceCandidate(c).catch(() => {});
    if (data.description.type === 'offer') {
      for (const t of call.pc.getTransceivers()) { const isAudio = t.receiver.track.kind === 'audio'; await t.sender.replaceTrack(isAudio ? call.local.getAudioTracks()[0] : call.local.getVideoTracks()[0] ?? null); t.direction = 'sendrecv'; if (!isAudio) call.videoSender = t.sender; }
      await call.pc.setLocalDescription(await call.pc.createAnswer());
      sendSignal({ description: call.pc.localDescription });
    }
  } else if (data.candidate) { call.pc.remoteDescription ? call.pc.addIceCandidate(data.candidate).catch(() => {}) : call.queue.push(data.candidate); }
}

function onCallEvent(m) {
  if (m.type === 'incoming') {
    if (call.id === m.id) return;
    if (call.id || currentRoom()) return api('/api/call/decline', { body: { call: m.id } }).catch(() => {});
    Object.assign(call, { id: m.id, peer: m.from, name: m.name, avatar: m.avatar, incoming: true, video: m.video });
    incomingCall(m);
    if (!state.privacy?.dnd && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) { try { new Notification(`${m.name} is calling`, { tag: 'call', requireInteraction: true }); } catch { /* sw handles it */ } }
    if (pendingAnswer === m.id) { pendingAnswer = null; accepted(); }
  } else if (m.id !== call.id) return;
  else if (m.type === 'answered') { stopAudio(); setStatus('Connecting...'); call.pc.createOffer().then(async (o) => { await call.pc.setLocalDescription(o); sendSignal({ description: call.pc.localDescription }); }); }
  else if (m.type === 'signal') onSignal(m.data).catch(() => {});
  else if (m.type === 'ended') {
    const r = m.reason;
    if (call.connectedAt) return finish();
    finish(r === 'missed' ? (call.incoming ? 'Missed call' : 'No answer') : r === 'declined' ? 'Call declined' : 'Call cancelled', 'phoneoff');
  }
}

function toggleMic() { const t = (call.local ?? room.local)?.getAudioTracks() ?? []; const on = !t[0]?.enabled; t.forEach((x) => { x.enabled = on; }); const b = call.ui?.mic; if (b) { b.classList.toggle('off', !on); clear(b, icon(on ? 'mic' : 'micoff')); } }
function toggleCam() { const t = call.local?.getVideoTracks() ?? []; const on = !t[0]?.enabled; t.forEach((x) => { x.enabled = on; }); call.ui?.cam.classList.toggle('off', !on); clear(call.ui.cam, icon(on ? 'video' : 'camoff')); }
async function stopShare() { if (!call.screen) return; call.screen.getTracks().forEach((t) => t.stop()); call.screen = null; await call.videoSender?.replaceTrack(call.local?.getVideoTracks()[0] ?? null); if (call.ui) { call.ui.local.srcObject = call.local; call.ui.share.classList.remove('on'); } }
async function toggleShare() {
  if (call.screen) return stopShare();
  try { call.screen = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch { return; }
  const track = call.screen.getVideoTracks()[0]; await call.videoSender?.replaceTrack(track); track.onended = stopShare; call.ui.local.srcObject = call.screen; call.ui.local.hidden = false; call.ui.share.classList.add('on');
}

/* ------------------------------------------------------------------ rooms: voice channels + group calls (mesh) */
const room = { key: null, local: null, screen: null, peers: new Map(), people: [], ui: null, deaf: false, muted: false, video: false, minimized: false, meter: null, community: null, started: 0 };
const currentRoom = () => room.key;

function levelWatcher(stream, onLevel) {
  const ctx = audioCtx(); if (!ctx || !stream.getAudioTracks().length) return () => {};
  const src = ctx.createMediaStreamSource(new MediaStream([stream.getAudioTracks()[0]])); const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
  const buf = new Uint8Array(an.fftSize); const t = setInterval(() => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) { const d = (v - 128) / 128; s += d * d; } onLevel(Math.sqrt(s / buf.length) > 0.035); }, 130);
  return () => { clearInterval(t); try { src.disconnect(); } catch { /* gone */ } };
}

async function joinRoom(key, { video = false } = {}) {
  if (room.key === key) return showRoom();
  if (call.id) return toast('Finish your current call first.');
  if (room.key) await leaveRoom();
  try {
    room.local = await navigator.mediaDevices.getUserMedia({ audio: true, video }).catch((e) => { if (!video) throw e; return navigator.mediaDevices.getUserMedia({ audio: true }); });
  } catch { return toast('Allow microphone access to join voice.', { kind: 'error' }); }
  try {
    const r = await api('/api/room/join', { body: { room: key, video } });
    Object.assign(room, { key, video: !!room.local.getVideoTracks().length, muted: false, deaf: false, started: Date.now(), community: key.startsWith('vc:') ? state.community : null, minimized: false });
    room.ice = (await api('/api/ice')).iceServers;
    buildRoomUI(); applyPeople(r.people);
    bus.emit('room:state', { key });
  } catch (e) { room.local?.getTracks().forEach((t) => t.stop()); room.local = null; fail(e); }
}
async function leaveRoom(quiet) {
  if (!room.key) return;
  const key = room.key; const secs = Math.round((Date.now() - room.started) / 1000);
  room.key = null;
  api('/api/room/leave', { body: {} }).catch(() => {});
  for (const p of room.peers.values()) closePeer(p);
  room.peers.clear();
  [room.local, room.screen].forEach((s) => s?.getTracks().forEach((t) => t.stop())); room.local = room.screen = null;
  room.meter?.(); room.ui?.el.remove(); room.ui = null; musicStop();
  bus.emit('room:state', { key: null });
  if (!quiet) showPill(`Left voice · ${fmtDur(secs)}`, 'speaker');
}

function closePeer(p) { p.pc.close(); p.audio.srcObject = null; p.audio.remove(); p.stopLevel?.(); }
function ensurePeer(person) {
  let p = room.peers.get(person.username);
  if (p) return p;
  const polite = state.user > person.username;
  const pc = new RTCPeerConnection({ iceServers: room.ice });
  const audio = h('audio', { autoplay: true, hidden: true }); audio.muted = room.deaf; document.body.append(audio);
  p = { user: person.username, pc, polite, making: false, ignore: false, queue: [], stream: new MediaStream(), audio, speaking: false };
  room.peers.set(person.username, p);
  room.local.getTracks().forEach((t) => pc.addTrack(t, room.local));
  if (room.screen) room.screen.getVideoTracks().forEach((t) => pc.addTrack(t, room.screen));
  pc.ontrack = (e) => { p.stream.addTrack(e.track); audio.srcObject = p.stream; if (e.track.kind === 'audio') p.stopLevel ??= levelWatcher(p.stream, (s) => { p.speaking = s; paintTile(p.user); }); e.track.onunmute = () => paintTile(p.user); e.track.onended = () => paintTile(p.user); paintTile(p.user); };
  pc.onicecandidate = (e) => { if (e.candidate) sig(p.user, { candidate: e.candidate }); };
  pc.onnegotiationneeded = async () => { try { p.making = true; await pc.setLocalDescription(); sig(p.user, { description: pc.localDescription }); } catch { /* retried on next change */ } finally { p.making = false; } };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce?.(); };
  return p;
}
const sig = (to, data) => api('/api/room/signal', { body: { room: room.key, to, data } }).catch(() => {});
async function onRoomSignal(m) {
  if (m.room !== room.key || !room.local) return;
  const person = room.people.find((x) => x.username === m.from) ?? { username: m.from }; const p = ensurePeer(person); const pc = p.pc; const d = m.data;
  try {
    if (d.description) {
      const collide = d.description.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collide;
      if (p.ignore) return;
      await pc.setRemoteDescription(d.description);
      for (const c of p.queue.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      if (d.description.type === 'offer') { await pc.setLocalDescription(); sig(p.user, { description: pc.localDescription }); }
    } else if (d.candidate) { pc.remoteDescription ? await pc.addIceCandidate(d.candidate).catch(() => { if (!p.ignore) throw 0; }) : p.queue.push(d.candidate); }
  } catch { /* ignore stale signals */ }
}
function applyPeople(people) {
  room.people = people;
  const names = new Set(people.map((x) => x.username));
  for (const person of people) if (person.username !== state.user) ensurePeer(person);
  for (const [u, p] of room.peers) if (!names.has(u)) { closePeer(p); room.peers.delete(u); }
  paintRoom();
}

/* room UI */
function buildRoomUI() {
  const grid = h('div', { class: 'rm-grid' }); const music = h('div', { class: 'rm-music', hidden: true });
  const mic = sq('mic', 'Mute', { onclick: () => { room.muted = !room.muted; room.local.getAudioTracks().forEach((t) => { t.enabled = !room.muted; }); api('/api/room/state', { body: { muted: room.muted } }).catch(() => {}); paintControls(); } });
  const deaf = sq('deaf', 'Deafen', { onclick: () => { room.deaf = !room.deaf; room.peers.forEach((p) => { p.audio.muted = room.deaf; }); api('/api/room/state', { body: { deaf: room.deaf } }).catch(() => {}); paintControls(); } });
  const cam = sq('video', 'Camera', { onclick: toggleRoomCam }); const share = sq('screen', 'Share screen', { onclick: toggleRoomShare, hidden: !navigator.mediaDevices?.getDisplayMedia });
  const leave = sq('endcall', 'Leave', { class: 'red lg', onclick: () => leaveRoom() });
  const title = h('strong', {}, 'Voice');
  const min = sq('chevdown', 'Minimize', { class: 'ghost', onclick: () => { room.minimized = true; room.ui.el.classList.remove('in'); setTimeout(() => room.ui && (room.ui.el.hidden = true), 250); } });
  const el = h('section', { class: 'callscreen room', role: 'dialog', 'aria-label': 'Voice room' }, h('div', { class: 'cs-top row-top' }, title, h('span', { class: 'grow' }), min), music, grid, h('div', { class: 'cs-controls' }, mic, deaf, cam, share, leave));
  $('overlays').append(el); requestAnimationFrame(() => el.classList.add('in'));
  room.ui = { el, grid, mic, deaf, cam, share, title, music };
  room.meter = levelWatcher(room.local, (s) => { room.selfSpeaking = s && !room.muted; paintTile(state.user); });
  paintControls();
}
function showRoom() { if (!room.ui) return; room.ui.el.hidden = false; requestAnimationFrame(() => room.ui.el.classList.add('in')); }
function paintControls() {
  const u = room.ui; if (!u) return;
  u.mic.classList.toggle('off', room.muted); clear(u.mic, icon(room.muted ? 'micoff' : 'mic')); u.mic.title = u.mic.ariaLabel = room.muted ? 'Unmute' : 'Mute';
  u.deaf.classList.toggle('off', room.deaf); u.cam.classList.toggle('on', room.video);
}
function paintRoom() {
  const u = room.ui; if (!u) return;
  const [kind] = room.key.split(':');
  u.title.textContent = `${kind === 'vc' ? 'Voice channel' : 'Group call'} · ${room.people.length}`;
  clear(u.grid, ...room.people.map((p) => tile(p)));
  u.grid.dataset.n = String(Math.min(room.people.length, 8));
  room.people.forEach((p) => paintTile(p.username));
}
function tile(p) {
  const me = p.username === state.user; const vid = h('video', { autoplay: true, playsInline: true, muted: me, hidden: true });
  const t = h('div', { class: 'rm-tile', dataset: { user: p.username } }, vid, h('div', { class: 'rm-av' }, avatarEl(p.avatar, p.name, 84)), h('div', { class: 'rm-name' }, p.muted ? icon('micoff', 14) : null, h('span', {}, me ? `${p.name} (you)` : p.name), p.sharing ? icon('screen', 14) : null));
  if (me) vid.srcObject = room.screen ?? room.local; else { const peer = room.peers.get(p.username); if (peer) vid.srcObject = peer.stream; }
  return t;
}
function paintTile(username) {
  const t = room.ui?.grid.querySelector(`[data-user="${username}"]`); if (!t) return;
  const me = username === state.user; const p = room.peers.get(username); const person = room.people.find((x) => x.username === username);
  const vid = t.querySelector('video'); const stream = me ? (room.screen ?? room.local) : p?.stream;
  const hasVideo = !!stream?.getVideoTracks().some((x) => x.readyState === 'live' && !x.muted && x.enabled) && (me ? room.video || !!room.screen : true);
  if (stream && vid.srcObject !== stream) vid.srcObject = stream;
  vid.hidden = !hasVideo; t.classList.toggle('has-video', hasVideo);
  t.classList.toggle('speaking', me ? !!room.selfSpeaking : !!p?.speaking && !person?.muted);
}
async function toggleRoomCam() {
  const has = room.local.getVideoTracks()[0];
  if (has) { has.stop(); room.local.removeTrack(has); room.peers.forEach((p) => p.pc.getSenders().filter((s) => s.track === has || s.track?.kind === 'video' && !room.screen).forEach((s) => { try { p.pc.removeTrack(s); } catch { /* gone */ } })); room.video = false; }
  else {
    try { const cam = (await navigator.mediaDevices.getUserMedia({ video: true })).getVideoTracks()[0]; room.local.addTrack(cam); room.peers.forEach((p) => p.pc.addTrack(cam, room.local)); room.video = true; } catch { return toast('Camera unavailable.', { kind: 'error' }); }
  }
  api('/api/room/state', { body: { video: room.video } }).catch(() => {}); paintControls(); paintTile(state.user);
}
async function toggleRoomShare() {
  if (room.screen) { const s = room.screen; room.screen = null; s.getTracks().forEach((t) => t.stop()); room.peers.forEach((p) => p.pc.getSenders().filter((x) => s.getTracks().includes(x.track)).forEach((x) => { try { p.pc.removeTrack(x); } catch { /* gone */ } })); room.ui.share.classList.remove('on'); api('/api/room/state', { body: { sharing: false } }).catch(() => {}); return paintTile(state.user); }
  try { room.screen = await navigator.mediaDevices.getDisplayMedia({ video: true }); } catch { return; }
  const track = room.screen.getVideoTracks()[0]; room.peers.forEach((p) => p.pc.addTrack(track, room.screen)); track.onended = () => room.screen && toggleRoomShare();
  room.ui.share.classList.add('on'); api('/api/room/state', { body: { sharing: true } }).catch(() => {}); paintTile(state.user);
}

/* ------------------------------------------------------------------ jukebox (synced playback for people in a room) */
const juke = { audio: null, key: null, upload: null };
const musicStop = () => { juke.audio?.pause(); juke.audio = null; juke.upload = null; juke.key = null; if (room.ui) room.ui.music.hidden = true; };
function musicApply(scope, id, now, serverNow) {
  if (!room.key) return;
  const [kind, rid] = room.key.split(':');
  const match = (kind === 'gc' && scope === 'group' && Number(rid) && id === Number(rid)) || (kind === 'vc' && scope === 'community' && id === room.community);
  if (!match) return;
  if (!now) { musicStop(); return; }
  const offset = (serverNow ?? Date.now()) - Date.now();
  const pos = now.paused ? now.pos : now.pos + (Date.now() + offset - now.startedAt) / 1000;
  if (juke.upload !== now.upload) { juke.audio?.pause(); juke.audio = new Audio(fileUrl(now.upload)); juke.upload = now.upload; juke.audio.volume = Math.min((state.sound?.volume ?? 60) / 100, 1); juke.audio.onended = () => api('/api/music/ended', { body: { scope, id, upload: now.upload } }).catch(() => {}); }
  const a = juke.audio; const seek = () => { if (Math.abs(a.currentTime - pos) > 0.6 && Number.isFinite(pos)) { try { a.currentTime = Math.max(pos, 0); } catch { /* not ready */ } } };
  if (a.readyState < 1) a.addEventListener('loadedmetadata', seek, { once: true }); else seek();
  now.paused ? a.pause() : a.play().catch(() => {});
  if (room.ui) { room.ui.music.hidden = false; clear(room.ui.music, icon(now.paused ? 'pause' : 'music', 16), h('span', {}, `${now.title}${now.paused ? ' (paused)' : ''}`), now.queue?.length ? h('small', {}, `${now.queue.length} queued`) : null); }
}
async function musicSync() {
  if (!room.key) return;
  const [kind, rid] = room.key.split(':'); const scope = kind === 'gc' ? 'group' : 'community'; const id = kind === 'gc' ? Number(rid) : room.community;
  if (!id) return;
  try { const r = await api(`/api/music/state?scope=${scope}&id=${id}`); musicApply(scope, id, r.now, r.serverNow); } catch { /* not a member of anything with music */ }
}

/* ------------------------------------------------------------------ push + service worker */
const b64u = (s) => { const pad = '='.repeat((4 - (s.length % 4)) % 4); const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
async function pushStatus() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
  if (!supported) return { supported: false, permission: 'unsupported', subscribed: false };
  const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
  return { supported, permission: Notification.permission, subscribed: !!sub };
}
async function enablePush() {
  const st = await pushStatus(); if (!st.supported) return 'unsupported';
  const perm = await Notification.requestPermission(); if (perm !== 'granted') return perm;
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/key');
  let sub = await reg.pushManager.getSubscription();
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(publicKey) });
  await api('/api/push/subscribe', { body: { subscription: sub.toJSON() } });
  return 'granted';
}
async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
  await api('/api/push/unsubscribe', { body: { endpoint: sub?.endpoint } }).catch(() => {}); await sub?.unsubscribe();
}
function wireServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    const d = e.data ?? {};
    if (d.type === 'call-answer') { if (call.id === d.id && call.incoming && !call.accepted) accepted(); else pendingAnswer = d.id; }
    else if (d.type === 'call-decline') { if (call.id === d.id && call.incoming) decline(); else api('/api/call/decline', { body: { call: d.id } }).catch(() => {}); }
    else if (d.type === 'open' && d.url) { const u = new URL(d.url, location.origin); const go = u.searchParams.get('go'); if (go === 'friends') actions.openFriends?.(); }
  });
}

/* ------------------------------------------------------------------ init */
// Called by the Android app when it is opened from the Answer or Decline button of a call notification.
async function scrxCallIntent(id, act) {
  id = Number(id); if (!id) return;
  if (act === 'decline') { await api('/api/call/decline', { body: { call: id } }).catch(() => {}); return; }
  if (call.id === id) { if (call.incoming && !call.accepted) accepted(); return; }
  try { const p = await api('/api/call/pending'); if (p && p.id === id) { pendingAnswer = id; onCallEvent({ type: 'incoming', ...p }); } else toast('That call has ended.'); } catch { /* offline */ }
}

export function init() {
  window.scrxCallIntent = scrxCallIntent;
  Object.assign(actions, { startCall, joinRoom, leaveRoom: () => leaveRoom(), currentRoom, showRoom, enablePush, pushStatus, disablePush, VIZ_STYLES,
    previewCallScreen: (prefs) => { if (call.id || room.key) return toast('Finish your current call first.'); incomingCall({ name: 'Preview', from: 'preview', avatar: null, video: false }, { preview: true, prefs: { ...state.me.prefs, ...(prefs ?? {}) } }); } });
  wireServiceWorker();
  bus.on('sse:call', onCallEvent);
  bus.on('sse:room', (e) => { if (e.room !== room.key) return; if (e.type === 'closed') { if (room.key) leaveRoom(true); return; } applyPeople(e.people ?? []); });
  bus.on('sse:room-signal', onRoomSignal);
  bus.on('sse:room-ring', (e) => { if (room.key || call.id || state.privacy?.dnd || state.mutes.has(`group:${e.group}`)) return; playSound('ring', state.sound?.volume ?? 60); toast(`${e.name} started a call in ${e.groupName ?? 'a group'}`, { ms: 12000, action: { label: 'Join', run: () => joinRoom(e.room, { video: false }) } }); });
  bus.on('sse:music', (e) => musicApply(e.scope, e.id, e.now, e.serverNow));
  bus.on('room:state', ({ key }) => { if (key) musicSync(); });
  bus.on('sse:open', () => { if (room.key) api('/api/rooms').then((l) => { const r = l.find((x) => x.room === room.key); if (!r) leaveRoom(true); }).catch(() => {}); });
}
