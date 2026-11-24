// Dependency-free Web Push (RFC 8030 + RFC 8291 aes128gcm + RFC 8292 VAPID).
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';

export const MAX_PAYLOAD = 3993; // 4096 record size - 86 header - 16 tag - 1 delimiter

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => Buffer.from(String(s), 'base64url');
const toBuf = (v) => (typeof v === 'string' ? fromB64u(v) : Buffer.from(v));

export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: b64u(ecdh.getPublicKey(null, 'uncompressed')),
    privateKey: b64u(ecdh.getPrivateKey()),
  };
}

function vapidPrivateKeyObject(publicKey, privateKey) {
  const pub = fromB64u(publicKey);
  const d = fromB64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be 65-byte uncompressed P-256 point');
  if (d.length !== 32) throw new Error('VAPID private key must be 32 bytes');
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: b64u(d) },
    format: 'jwk',
  });
}

export function vapidHeaders(endpoint, { publicKey, privateKey, subject, now = Date.now(), ttlSeconds = 12 * 3600 } = {}) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(now / 1000) + Math.min(ttlSeconds, 12 * 3600);
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = { aud, exp };
  if (subject) claims.sub = subject;
  const input = `${header}.${b64u(JSON.stringify(claims))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), {
    key: vapidPrivateKeyObject(publicKey, privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return { Authorization: `vapid t=${input}.${b64u(sig)}, k=${publicKey}` };
}

function hkdf(ikm, salt, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

// asKeyPair: { publicKey, privateKey } raw 65/32 bytes (Buffer or base64url string)
export function encryptPayload(subscription, payload, { asKeyPair, salt } = {}) {
  const uaPublic = fromB64u(subscription?.keys?.p256dh);
  const authSecret = fromB64u(subscription?.keys?.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('invalid p256dh');
  if (authSecret.length < 1) throw new Error('invalid auth');
  const plaintext = Buffer.from(payload);
  if (plaintext.length > MAX_PAYLOAD) throw new RangeError(`payload exceeds ${MAX_PAYLOAD} bytes`);

  const ecdh = crypto.createECDH('prime256v1');
  if (asKeyPair) ecdh.setPrivateKey(toBuf(asKeyPair.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(null, 'uncompressed');
  if (asKeyPair?.publicKey && !asPublic.equals(toBuf(asKeyPair.publicKey))) throw new Error('asKeyPair mismatch');

  const saltBuf = salt ? toBuf(salt) : crypto.randomBytes(16);
  if (saltBuf.length !== 16) throw new Error('salt must be 16 bytes');

  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = hkdf(ikm, saltBuf, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, saltBuf, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([saltBuf, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export function sendWebPush(subscription, payload, opts = {}) {
  const { vapid, ttl = 60, urgency = 'normal', topic, timeoutMs = 8000, lookup, allowHttp = false } = opts;
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(subscription?.endpoint);
      if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) throw new Error('endpoint must be https');
      let data;
      if (Buffer.isBuffer(payload)) data = payload;
      else if (typeof payload === 'string') data = Buffer.from(payload);
      else data = Buffer.from(JSON.stringify(payload ?? {}));
      if (data.length > MAX_PAYLOAD) throw new RangeError(`payload exceeds ${MAX_PAYLOAD} bytes`);
      const body = encryptPayload(subscription, data);
      const headers = {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': body.length,
        TTL: String(ttl),
        Urgency: urgency,
      };
      if (topic) headers.Topic = topic;
      if (vapid) Object.assign(headers, vapidHeaders(subscription.endpoint, vapid));
      const mod = url.protocol === 'https:' ? https : http;
      const reqOpts = { method: 'POST', hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, headers };
      if (lookup) reqOpts.lookup = lookup;
      const req = mod.request(reqOpts, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, gone: res.statusCode === 404 || res.statusCode === 410 }));
        res.on('error', reject);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`web push timeout after ${timeoutMs}ms`)));
      req.on('error', reject);
      req.end(body);
    } catch (e) {
      reject(e);
    }
  });
}
