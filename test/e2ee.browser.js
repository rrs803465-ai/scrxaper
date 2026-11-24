// Standalone browser test for public/e2ee.js. Run: node test/e2ee.browser.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, '..', 'public');
const results = [];
const check = (name, ok, extra) => { results.push({ name, ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (!ok && extra ? '  -> ' + extra : '')); };

const server = http.createServer((req, res) => {
  if (req.url === '/test.html') {
    res.setHeader('content-type', 'text/html');
    return res.end('<!doctype html><meta charset=utf-8><script type="module">import * as m from "/e2ee.js"; window.E = m; window.ready = true;</script>');
  }
  if (req.url === '/e2ee.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(fs.readFileSync(path.join(PUB, 'e2ee.js')));
  }
  res.statusCode = 404; res.end();
});

async function newPage(browser, origin) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(origin + '/test.html');
  await page.waitForFunction('window.ready === true');
  return { ctx, page };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  try {
    const A = await newPage(browser, origin), B = await newPage(browser, origin), C = await newPage(browser, origin);
    const a = A.page, b = B.page, c = C.page;
    const alice = await a.evaluate(() => E.init('alice'));
    const bob = await b.evaluate(() => E.init('bob'));
    const carol = await c.evaluate(() => E.init('carol'));
    check('init returns 16-hex id + P-256 public jwk', /^[0-9a-f]{16}$/.test(alice.id) && alice.publicJwk.crv === 'P-256' && !alice.publicJwk.d);
    check('init idempotent (same key on re-init)', (await a.evaluate(() => E.init('alice'))).id === alice.id);

    // roundtrip both directions
    const lookupFor = (peer) => `async (id) => id === ${JSON.stringify(peer.id)} ? ${JSON.stringify(peer.publicJwk)} : null`;
    const msg1 = await a.evaluate(([p, t]) => E.encryptText(p.publicJwk, p.id, t), [bob, 'hello bob \u{1F512} ünï']);
    const env = JSON.parse(msg1);
    check('envelope shape', env.v === 1 && env.s === alice.id && env.r === bob.id && env.i && env.c && !msg1.includes('hello'));
    const dec1 = await b.evaluate(([m, aj]) => E.decryptText(m, async (id) => id === aj.id ? aj.publicJwk : null), [msg1, alice]);
    check('alice -> bob roundtrip', dec1 === 'hello bob \u{1F512} ünï', dec1);
    const dec1s = await a.evaluate(([m, bj]) => E.decryptText(m, async (id) => id === bj.id ? bj.publicJwk : null), [msg1, bob]);
    check('sender can re-read own message', dec1s === 'hello bob \u{1F512} ünï', dec1s);
    const msg2 = await b.evaluate(([p, t]) => E.encryptText(p.publicJwk, p.id, t), [alice, 'hi alice']);
    const dec2 = await a.evaluate(([m, bj]) => E.decryptText(m, async (id) => id === bj.id ? bj.publicJwk : null), [msg2, bob]);
    check('bob -> alice roundtrip', dec2 === 'hi alice', dec2);

    // tampering
    const tryDec = (page, m, peer) => page.evaluate(async ([m, p]) => {
      try { await E.decryptText(m, async (id) => id === p.id ? p.publicJwk : null); return 'OK'; } catch (e) { return e.message; }
    }, [m, peer]);
    const flip = (s, field) => { const o = JSON.parse(s); const u = Buffer.from(o[field], 'base64'); u[0] ^= 1; o[field] = u.toString('base64'); return JSON.stringify(o); };
    check('tampered ciphertext fails', (await tryDec(b, flip(msg1, 'c'), alice)) === 'cannot decrypt');
    check('tampered iv fails', (await tryDec(b, flip(msg1, 'i'), alice)) === 'cannot decrypt');
    const swapped = JSON.stringify({ ...env, s: env.r, r: env.s });
    check('tampered AAD (s/r swapped) fails', (await tryDec(b, swapped, alice)) === 'cannot decrypt');
    check('garbage envelope fails', (await tryDec(b, 'not json', alice)) === 'cannot decrypt');
    check('third party cannot decrypt', (await tryDec(c, msg1, alice)) === 'cannot decrypt');
    check('lookup returning wrong key fails', (await tryDec(b, msg1, carol)) === 'cannot decrypt');
    check('lookup returning null fails', (await b.evaluate(async (m) => { try { await E.decryptText(m, async () => null); return 'OK'; } catch (e) { return e.message; } }, msg1)) === 'cannot decrypt');

    // safety numbers
    const sn = (page, x, y) => page.evaluate(([x, y]) => E.safetyNumber(x, y), [x.publicJwk, y.publicJwk]);
    const snA = await sn(a, alice, bob), snB = await sn(b, bob, alice), snAC = await sn(a, alice, carol);
    check('safety number format (12 x 5 digits)', /^(\d{5} ){11}\d{5}$/.test(snA), snA);
    check('safety number equal across parties', snA === snB);
    check('safety number differs with different peer', snA !== snAC);
    const fp = await a.evaluate((j) => E.fingerprint(j), alice.publicJwk);
    check('fingerprint format', /^([0-9a-f]{4} ){3}[0-9a-f]{4}$/.test(fp), fp);

    // rotation
    const rot = await a.evaluate(() => E.rotate());
    check('rotate gives new current key', rot.id !== alice.id && (await a.evaluate(() => E.currentPublic())).id === rot.id);
    const old = await a.evaluate(([m, bj]) => E.decryptText(m, async (id) => id === bj.id ? bj.publicJwk : null), [msg1, bob]);
    check('after rotation old sent message still readable', old === 'hello bob \u{1F512} ünï', old);
    const old2 = await a.evaluate(([m, bj]) => E.decryptText(m, async (id) => id === bj.id ? bj.publicJwk : null), [msg2, bob]);
    check('after rotation old received message still readable', old2 === 'hi alice', old2);
    const msg3 = await b.evaluate(([p, t]) => E.encryptText(p.publicJwk, p.id, t), [rot, 'to new key']);
    const dec3 = await a.evaluate(([m, bj]) => E.decryptText(m, async (id) => id === bj.id ? bj.publicJwk : null), [msg3, bob]);
    check('message to rotated key readable', dec3 === 'to new key', dec3);
    const msg4 = await a.evaluate(([p, t]) => E.encryptText(p.publicJwk, p.id, t), [bob, 'from new key']);
    const dec4 = await b.evaluate(([m, aj]) => E.decryptText(m, async (id) => id === aj.id ? aj.publicJwk : null), [msg4, rot]);
    check('message from rotated key readable by peer', dec4 === 'from new key', dec4);
    check('rotation survives reload (persisted)', await (async () => {
      await a.reload(); await a.waitForFunction('window.ready === true');
      const cur = await a.evaluate(() => E.init('alice'));
      return cur.id === rot.id;
    })());

    // files
    const fileOk = await a.evaluate(async () => {
      const src = new Uint8Array(100000).map((_, i) => (i * 7) & 255);
      const { blob, key } = await E.encryptFile(src.buffer);
      const back = new Uint8Array(await E.decryptFile(blob, key));
      let same = back.length === src.length && back.every((v, i) => v === src[i]);
      const bad = new Uint8Array(blob); bad[40] ^= 1;
      let tamperFails = false; try { await E.decryptFile(bad.buffer, key); } catch (e) { tamperFails = e.message === 'cannot decrypt'; }
      let wrongKeyFails = false; try { await E.decryptFile(blob, (await E.encryptFile(new ArrayBuffer(1))).key); } catch { wrongKeyFails = true; }
      return { same, tamperFails, wrongKeyFails, overhead: blob.byteLength - src.length };
    });
    check('file roundtrip', fileOk.same);
    check('file blob = 12B iv + 16B tag overhead', fileOk.overhead === 28, String(fileOk.overhead));
    check('tampered file fails', fileOk.tamperFails);
    check('wrong file key fails', fileOk.wrongKeyFails);

    // backup
    const backup = await a.evaluate(() => E.exportBackup('correct horse'));
    const bo = JSON.parse(backup);
    check('backup is encrypted (no key material in clear)', bo.iter === 250000 && !backup.includes('"d"') && !backup.includes(alice.publicJwk.x));
    const A2 = await newPage(browser, origin);
    const fresh = await A2.page.evaluate(() => E.init('alice'));
    check('fresh context has a different key', fresh.id !== alice.id && fresh.id !== rot.id);
    const unreadable = await tryDec(A2.page, msg1, bob);
    check('fresh context cannot read before import', unreadable === 'cannot decrypt');
    const wrong = await A2.page.evaluate(async (bk) => { try { await E.importBackup('wrong', bk); return 'OK'; } catch (e) { return e.message; } }, backup);
    check('wrong passphrase throws', wrong !== 'OK', wrong);
    const tamperedBackup = (() => { const o = JSON.parse(backup); const u = Buffer.from(o.ct, 'base64'); u[3] ^= 1; o.ct = u.toString('base64'); return JSON.stringify(o); })();
    check('tampered backup throws', (await A2.page.evaluate(async (bk) => { try { await E.importBackup('correct horse', bk); return 'OK'; } catch (e) { return e.message; } }, tamperedBackup)) !== 'OK');
    const count = await A2.page.evaluate((bk) => E.importBackup('correct horse', bk), backup);
    check('import returns key count (2)', count === 2, String(count));
    const r1 = await A2.page.evaluate(([m, bj]) => E.decryptText(m, async (id) => id === bj.id ? bj.publicJwk : null), [msg1, bob]);
    const r4 = await A2.page.evaluate(([m, aj]) => E.decryptText(m, async (id) => id === aj.id ? aj.publicJwk : null), [msg3, bob]);
    check('restored context reads old messages (original + rotated key)', r1 === 'hello bob \u{1F512} ünï' && r4 === 'to new key');
    check('import keeps fresh current key', (await A2.page.evaluate(() => E.currentPublic())).id === fresh.id);
  } catch (e) {
    check('test harness ran without exception', false, e && e.stack || String(e));
  } finally {
    await browser.close();
    server.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed` + (failed ? `, ${failed} FAILED` : ''));
  process.exit(failed ? 1 : 0);
})();
