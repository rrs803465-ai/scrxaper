// e2ee.js - browser-side end-to-end encryption helper for 1:1 "secret chats".
//
// HONEST SECURITY NOTES (read before trusting this):
//  * This is STATIC-KEY ECDH (P-256), NOT the Signal protocol. There is NO forward
//    secrecy and NO post-compromise security: every message between two key pairs is
//    protected by the same long-term shared secret. If a private key is ever stolen
//    (malware, XSS, a leaked backup + weak passphrase), all past and future messages
//    for that key pair can be read.
//  * ONE identity key per browser (per username). Other browsers/devices of the same
//    user have different keys unless a backup is imported there.
//  * The server can still see metadata (who talks to whom, when, sizes, key ids).
//  * Public keys are only as trustworthy as whoever delivers them. A malicious server
//    could substitute keys (MITM). Compare safetyNumber() out of band to detect this.
//  * Private keys live in IndexedDB as extractable CryptoKeys (extractable only so that
//    exportBackup works). Any script running on this origin can use them, so this
//    does not protect against XSS; the site CSP is the defence there.
//  * All historical private keys are kept so old messages remain readable after rotate().
//
// Dependencies: none. WebCrypto + IndexedDB only. No eval, no inline script.

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => crypto.subtle;
const INFO = 'scrxaper-e2ee-v1';
const BACKUP_AAD = 'scrxaper-backup-v1';
const PBKDF2_ITER = 250000;

// ---------- small helpers ----------
function b64(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
function hex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256(data) {
  return subtle().digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
}

// Canonical public JWK string: exactly {crv,kty,x,y} in that order.
function canonicalPublic(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('invalid public key');
  }
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}
function cleanPublic(jwk) {
  canonicalPublic(jwk);
  return { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
}
async function keyIdOf(jwk) {
  return hex(await sha256(canonicalPublic(jwk))).slice(0, 16);
}

// ---------- IndexedDB ----------
const idbReq = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
function openDb(name) {
  return new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (mode, name = 'keys') => state.db.transaction(name, mode).objectStore(name);

// ---------- state ----------
// state.keys: Map id -> { id, publicJwk, priv: CryptoKey (ECDH private, extractable) }
const state = { db: null, keys: new Map(), current: null };

function needInit() {
  if (!state.db || !state.current) throw new Error('e2ee not initialised');
}

async function genKey() {
  const kp = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = cleanPublic(await subtle().exportKey('jwk', kp.publicKey));
  return { id: await keyIdOf(pub), publicJwk: pub, priv: kp.privateKey };
}
async function saveKey(k) {
  await idbReq(store('readwrite').put({ id: k.id, publicJwk: k.publicJwk, priv: k.priv, created: Date.now() }));
  state.keys.set(k.id, k);
}
async function setCurrent(id) {
  await idbReq(store('readwrite', 'meta').put(id, 'current'));
  state.current = id;
}
const view = (k) => ({ id: k.id, publicJwk: { ...k.publicJwk } });

/** init(userKey) -> { id, publicJwk }. Opens the per-user DB, creating a key pair if none exists. */
export async function init(userKey) {
  if (!userKey || typeof userKey !== 'string') throw new Error('userKey required');
  if (state.db) { try { state.db.close(); } catch {} }
  state.db = await openDb('scrx-e2ee:' + userKey);
  state.keys = new Map();
  state.current = null;
  const rows = await idbReq(store('readonly').getAll());
  for (const r of rows) state.keys.set(r.id, { id: r.id, publicJwk: r.publicJwk, priv: r.priv });
  let cur = await idbReq(store('readonly', 'meta').get('current'));
  if (!cur || !state.keys.has(cur)) {
    if (state.keys.size) {
      // Meta lost: fall back to the most recently created key.
      cur = rows.sort((a, b) => b.created - a.created)[0].id;
    } else {
      const k = await genKey();
      await saveKey(k);
      cur = k.id;
    }
    await setCurrent(cur);
  }
  state.current = cur;
  return view(state.keys.get(cur));
}

/** currentPublic() -> { id, publicJwk } */
export function currentPublic() {
  needInit();
  return view(state.keys.get(state.current));
}

/** rotate() -> new current { id, publicJwk }. Old private keys are retained for decrypting history. */
export async function rotate() {
  needInit();
  const k = await genKey();
  await saveKey(k);
  await setCurrent(k.id);
  return view(k);
}

// ---------- message crypto ----------
async function aesKeyFor(myPriv, myId, peerPublicJwk, peerId) {
  const peerPub = await subtle().importKey('jwk', cleanPublic(peerPublicJwk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await subtle().deriveBits({ name: 'ECDH', public: peerPub }, myPriv, 256);
  const hk = await subtle().importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const salt = enc.encode([myId, peerId].sort().join(':'));
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(INFO) },
    hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** encryptText(peerPublicJwk, peerKeyId, plaintext) -> envelope string (JSON). */
export async function encryptText(peerPublicJwk, peerKeyId, plaintext) {
  needInit();
  if (await keyIdOf(peerPublicJwk) !== peerKeyId) throw new Error('peer key id does not match public key');
  const me = state.keys.get(state.current);
  const key = await aesKeyFor(me.priv, me.id, peerPublicJwk, peerKeyId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(me.id + '|' + peerKeyId) }, key, enc.encode(String(plaintext)));
  return JSON.stringify({ v: 1, s: me.id, r: peerKeyId, i: b64(iv), c: b64(ct) });
}

/**
 * decryptText(envelopeString, lookupPublicJwk) -> plaintext.
 * lookupPublicJwk: async (keyId) => jwk|null, returns the PEER's public JWK for the OTHER
 * party's key id (the caller's own key ids are resolved locally). Works for both sender and
 * recipient. Throws Error('cannot decrypt') on any failure.
 */
export async function decryptText(envelopeString, lookupPublicJwk) {
  try {
    needInit();
    const e = JSON.parse(envelopeString);
    if (!e || e.v !== 1 || typeof e.s !== 'string' || typeof e.r !== 'string') throw 0;
    let mine, peerId;
    if (state.keys.has(e.s)) { mine = state.keys.get(e.s); peerId = e.r; }
    else if (state.keys.has(e.r)) { mine = state.keys.get(e.r); peerId = e.s; }
    else throw 0;
    const peerJwk = await lookupPublicJwk(peerId);
    if (!peerJwk || await keyIdOf(peerJwk) !== peerId) throw 0; // looked-up key must match claimed id
    const key = await aesKeyFor(mine.priv, mine.id, peerJwk, peerId);
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(e.i), additionalData: enc.encode(e.s + '|' + e.r) }, key, unb64(e.c));
    return dec.decode(pt);
  } catch {
    throw new Error('cannot decrypt');
  }
}

// ---------- files ----------
/** encryptFile(arrayBuffer) -> { blob: ArrayBuffer (iv|ciphertext), key: base64 file key }. */
export async function encryptFile(arrayBuffer) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0); out.set(ct, 12);
  return { blob: out.buffer, key: b64(raw) };
}

/** decryptFile(arrayBuffer, keyB64) -> ArrayBuffer. Throws Error('cannot decrypt') on failure. */
export async function decryptFile(arrayBuffer, keyB64) {
  try {
    const u = new Uint8Array(arrayBuffer);
    if (u.length < 28) throw 0;
    const key = await subtle().importKey('raw', unb64(keyB64), 'AES-GCM', false, ['decrypt']);
    return await subtle().decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
  } catch {
    throw new Error('cannot decrypt');
  }
}

// ---------- fingerprints ----------
/** fingerprint(jwk) -> Promise<string> e.g. "a1b2 c3d4 e5f6 0718" (first 64 bits of SHA-256, hex groups). */
export async function fingerprint(jwk) {
  const h = hex(await sha256(canonicalPublic(jwk))).slice(0, 16);
  return h.match(/.{4}/g).join(' ');
}

/**
 * safetyNumber(myPublicJwk, peerPublicJwk) -> Promise<string>: 12 groups of 5 digits separated
 * by spaces. Order-independent: both parties compute the same value. Compare out of band.
 */
export async function safetyNumber(myPublicJwk, peerPublicJwk) {
  const parts = [canonicalPublic(myPublicJwk), canonicalPublic(peerPublicJwk)].sort();
  const input = enc.encode(parts.join('\n'));
  let h = new Uint8Array(0);
  for (let i = 0; i < 5200; i++) {
    const m = new Uint8Array(h.length + input.length);
    m.set(h, 0); m.set(input, h.length);
    h = new Uint8Array(await subtle().digest('SHA-512', m));
  }
  const groups = [];
  for (let g = 0; g < 12; g++) {
    const n = ((h[g * 4] << 24) | (h[g * 4 + 1] << 16) | (h[g * 4 + 2] << 8) | h[g * 4 + 3]) >>> 0;
    groups.push(String(n % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

// ---------- backup ----------
async function passKey(passphrase, salt, iter, usage) {
  const base = await subtle().importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, [usage]);
}

/** exportBackup(passphrase) -> JSON string with ALL private keys, encrypted (PBKDF2-SHA256 250k + AES-GCM). */
export async function exportBackup(passphrase) {
  needInit();
  if (!passphrase) throw new Error('passphrase required');
  const keys = [];
  for (const k of state.keys.values()) {
    const j = await subtle().exportKey('jwk', k.priv);
    keys.push({ crv: j.crv, kty: j.kty, x: j.x, y: j.y, d: j.d });
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passKey(passphrase, salt, PBKDF2_ITER, 'encrypt');
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(BACKUP_AAD) }, key,
    enc.encode(JSON.stringify({ keys, current: state.current })));
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

/**
 * importBackup(passphrase, json) -> number of keys imported. Adds keys to the current store;
 * the current (active) key is unchanged. Wrong passphrase / corrupt data throws.
 */
export async function importBackup(passphrase, json) {
  needInit();
  let plain;
  try {
    const b = JSON.parse(json);
    if (!b || b.v !== 1 || b.kdf !== 'PBKDF2-SHA256') throw new Error('unsupported backup');
    const iter = b.iter | 0;
    if (iter < 100000 || iter > 5000000) throw new Error('bad iterations');
    const key = await passKey(passphrase, unb64(b.salt), iter, 'decrypt');
    plain = JSON.parse(dec.decode(await subtle().decrypt(
      { name: 'AES-GCM', iv: unb64(b.iv), additionalData: enc.encode(BACKUP_AAD) }, key, unb64(b.ct))));
  } catch {
    throw new Error('wrong passphrase or corrupted backup');
  }
  let n = 0;
  for (const j of plain.keys || []) {
    const priv = await subtle().importKey('jwk', { kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d },
      { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const pub = cleanPublic(j);
    const id = await keyIdOf(pub);
    if (!state.keys.has(id)) await saveKey({ id, publicJwk: pub, priv });
    n++;
  }
  return n;
}
