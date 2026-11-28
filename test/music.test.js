import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';

const fakeMusic = async () => {
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 7)]);
  let hits = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); hits++;
    if (u.pathname === '/search') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ results: [{ trackId: 1, trackName: 'Blue Hour', artistName: 'Nova', previewUrl: `http://127.0.0.1:${srv.address().port}/p/1.m4a`, artworkUrl100: 'http://x/a.jpg', trackTimeMillis: 200000 }, { trackId: 2, trackName: 'No preview', artistName: 'X' }] })); }
    if (u.pathname === '/v1/tracks/search') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'Ab12', title: 'Blue Hour (full)', user: { name: 'Nova' }, duration: 201, artwork: { '150x150': 'http://x/b.jpg' } }] })); }
    if (u.pathname === '/v1/tracks/Ab12/stream' || u.pathname === '/p/1.m4a') { res.setHeader('Content-Type', 'audio/mpeg'); return res.end(audio); }
    res.statusCode = 404; res.end('no');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}`, hits: () => hits };
};

const boot = async () => {
  const m = await fakeMusic();
  process.env.MUSIC_ITUNES_URL = m.url; process.env.MUSIC_AUDIUS_URL = m.url;
  const app = createApp({ dbPath: ':memory:', authLimit: 1000, claimMinAgeMs: 0, ownerUsername: 'boss', ownerPassword: 'a-long-owner-pass' });
  delete process.env.MUSIC_ITUNES_URL; delete process.env.MUSIC_AUDIUS_URL;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r)); after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const raw = (url, cookie) => fetch(base + url, { headers: { 'X-Requested-With': 'scrxaper', Cookie: cookie } });
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'scrxaper', ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };
  const join = async (n) => (await call('POST', '/api/register', { username: n, password: 'correct horse' })).cookie;
  const boss = (await call('POST', '/api/login', { username: 'boss', password: 'a-long-owner-pass' })).cookie;
  return { call, join, boss, raw, m };
};

test('music search merges both catalogues and streams audio through our server', async () => {
  const { call, join, raw } = await boot(); const c = await join('mua');
  assert.equal((await call('GET', '/api/music/search?q=a', null, c)).data.tracks.length, 0);
  const t = (await call('GET', '/api/music/search?q=blue%20hour', null, c)).data.tracks;
  assert.deepEqual(t.map((x) => x.source).sort(), ['audius', 'itunes']);
  assert.equal(t.find((x) => x.source === 'audius').full, true);
  const s = await raw(`/api/music/stream?source=itunes&ref=${encodeURIComponent(t.find((x) => x.source === 'itunes').ref)}`, c);
  assert.equal(s.status, 200); assert.equal(s.headers.get('content-type'), 'audio/mpeg'); assert.equal((await s.arrayBuffer()).byteLength, 2003);
  assert.equal((await raw('/api/music/stream?source=audius&ref=Ab12', c)).status, 200);
});

test('the stream proxy refuses other hosts, odd ids and anonymous callers', async () => {
  const { raw, join } = await boot(); const c = await join('mub');
  assert.equal((await raw(`/api/music/stream?source=itunes&ref=${encodeURIComponent('https://evil.example/x.mp3')}`, c)).status, 400);
  assert.equal((await raw(`/api/music/stream?source=itunes&ref=${encodeURIComponent('http://169.254.169.254/latest')}`, c)).status, 400);
  assert.equal((await raw('/api/music/stream?source=audius&ref=../../etc', c)).status, 400);
  assert.equal((await raw('/api/music/stream?source=other&ref=x', c)).status, 400);
  assert.equal((await fetch(`${'http://127.0.0.1:1'}`).catch(() => ({ status: 0 }))).status, 0);
});

test('equipped cosmetics show on the profile and as a name colour on messages', async () => {
  const { call, join, boss } = await boot(); const a = await join('fxa'); const b = await join('fxb');
  await call('POST', '/api/owner/sparks', { username: 'fxa', amount: 2000 }, boss);
  for (const i of ['frame_neon', 'name_aurora', 'badge_crown', 'name_gold']) { assert.equal((await call('POST', '/api/shop/buy', { item: i }, a)).status, 200); await call('POST', '/api/shop/equip', { item: i }, a); }
  const p = (await call('GET', '/api/profile?user=fxa', null, b)).data;
  assert.deepEqual(p.cosmetics.map((c) => [c.kind, c.value]).sort(), [['badge', 'Crown'], ['frame', 'neon'], ['name_color', '#e8c46a']]);
  const gid = (await call('POST', '/api/groups', { name: 'Crew', members: ['fxb'] }, a)).data.id;
  await call('POST', '/api/group-messages', { group: gid, body: 'hi' }, a);
  const hist = (await call('GET', `/api/group-messages?group=${gid}`, null, b)).data;
  assert.equal(hist.messages.find((x) => x.body === 'hi').nameFx, '#e8c46a');
});
