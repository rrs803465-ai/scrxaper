import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { generateVapidKeys, vapidHeaders, encryptPayload, sendWebPush } from '../lib/webpush.js';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');

// Independent receiver-side decrypt written from RFC 8291 / RFC 8188.
function decrypt(body, uaPrivate, uaPublic, authSecret) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivate);
  const secret = ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  let i = plain.length - 1;
  while (i >= 0 && plain[i] === 0) i--;
  assert.equal(plain[i], 2, 'padding delimiter');
  return plain.subarray(0, i);
}

function newUa() {
  const e = crypto.createECDH('prime256v1');
  e.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    priv: e.getPrivateKey(), pub: e.getPublicKey(null, 'uncompressed'), auth,
    sub: (endpoint) => ({ endpoint, keys: { p256dh: b64u(e.getPublicKey(null, 'uncompressed')), auth: b64u(auth) } }),
  };
}

test('RFC 8291 Appendix A test vector', () => {
  const uaPublic = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const sub = { keys: { p256dh: uaPublic, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
  const body = encryptPayload(sub, Buffer.from('When I grow up, I want to be a watermelon'), {
    asKeyPair: {
      privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
      publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    },
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  });
  const expected =
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';
  assert.equal(b64u(body), expected);
  // and our independent decrypt recovers the plaintext with the RFC's UA private key
  const out = decrypt(body, unb64u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), unb64u(uaPublic), unb64u('BTBZMqHH6r4Tts7J_aSIgg'));
  assert.equal(out.toString(), 'When I grow up, I want to be a watermelon');
});

test('random roundtrip with independent receiver', () => {
  const ua = newUa();
  for (const len of [0, 1, 100, 3993]) {
    const msg = crypto.randomBytes(len);
    const body = encryptPayload(ua.sub('https://x'), msg);
    assert.deepEqual(decrypt(body, ua.priv, ua.pub, ua.auth), msg);
    assert.equal(body.length, 86 + len + 1 + 16);
  }
  assert.throws(() => encryptPayload(ua.sub('https://x'), Buffer.alloc(3994)), RangeError);
});

test('VAPID JWT verifies and has correct claims', () => {
  const keys = generateVapidKeys();
  assert.equal(unb64u(keys.publicKey).length, 65);
  assert.equal(unb64u(keys.privateKey).length, 32);
  const { Authorization } = vapidHeaders('https://push.example.com:8443/send/abc', { ...keys, subject: 'mailto:a@b.co' });
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(Authorization);
  assert.ok(m, Authorization);
  assert.equal(m[4], keys.publicKey);
  const header = JSON.parse(unb64u(m[1]));
  const claims = JSON.parse(unb64u(m[2]));
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
  assert.equal(claims.aud, 'https://push.example.com:8443');
  assert.equal(claims.sub, 'mailto:a@b.co');
  const now = Math.floor(Date.now() / 1000);
  assert.ok(claims.exp > now && claims.exp <= now + 12 * 3600);
  const pub = unb64u(keys.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  const sig = unb64u(m[3]);
  assert.equal(sig.length, 64);
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, sig));
  assert.ok(!crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}x`), { key, dsaEncoding: 'ieee-p1363' }, sig));
});

test('sendWebPush against local server', async () => {
  const ua = newUa();
  const vapid = { ...generateVapidKeys(), subject: 'mailto:t@example.com' };
  let status = 201, hang = false, last;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      last = { headers: req.headers, body: Buffer.concat(chunks), method: req.method, url: req.url };
      if (hang) return;
      res.writeHead(status).end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const sub = ua.sub(`http://127.0.0.1:${srv.address().port}/push/xyz`);
  try {
    let r = await sendWebPush(sub, { hello: 'world' }, { vapid, allowHttp: true, topic: 'tp', ttl: 120, urgency: 'high' });
    assert.deepEqual(r, { status: 201, gone: false });
    assert.equal(last.method, 'POST');
    assert.equal(last.url, '/push/xyz');
    assert.equal(last.headers['content-encoding'], 'aes128gcm');
    assert.equal(last.headers['content-type'], 'application/octet-stream');
    assert.equal(last.headers.ttl, '120');
    assert.equal(last.headers.urgency, 'high');
    assert.equal(last.headers.topic, 'tp');
    assert.match(last.headers.authorization, /^vapid t=.+, k=.+$/);
    assert.deepEqual(JSON.parse(decrypt(last.body, ua.priv, ua.pub, ua.auth)), { hello: 'world' });

    status = 410;
    assert.deepEqual(await sendWebPush(sub, 'x', { vapid, allowHttp: true }), { status: 410, gone: true });
    status = 404;
    assert.equal((await sendWebPush(sub, 'x', { allowHttp: true })).gone, true);
    status = 500;
    assert.deepEqual(await sendWebPush(sub, 'x', { allowHttp: true }), { status: 500, gone: false });

    // http refused without allowHttp
    await assert.rejects(sendWebPush(sub, 'x', {}), /https/);
    await assert.rejects(sendWebPush(sub, Buffer.alloc(3994), { allowHttp: true }), RangeError);

    hang = true;
    await assert.rejects(sendWebPush(sub, 'x', { allowHttp: true, timeoutMs: 150 }), /timeout/);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});
