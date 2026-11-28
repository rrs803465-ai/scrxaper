import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, mp4Seconds } from '../server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrx-v3-'));
const H = { 'X-Requested-With': 'scrxaper' };
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const boot = async (options = {}) => {
  const app = createApp({ dbPath: ':memory:', authLimit: 1000, uploadDir: dir, ownerUsername: 'boss', ownerPassword: 'a-long-owner-pass', ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...H, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
  };
  const join = async (n) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: n, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
  const up = async (qs, bytes, cookie) => { const r = await fetch(`${base}/api/upload?${qs}`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: bytes }); return { status: r.status, data: await r.json() }; };
  return { app, base, call, join, up };
};

const mp4 = (seconds) => {
  const b = Buffer.alloc(64);
  b.write('ftyp', 4, 'latin1'); b.write('isom', 8, 'latin1');
  b.write('mvhd', 24, 'latin1'); b.writeUInt32BE(1000, 24 + 16); b.writeUInt32BE(seconds * 1000, 24 + 20);
  return b;
};

test('mp4Seconds reads the movie header, and the server rejects a reel over 3 minutes', async () => {
  assert.equal(mp4Seconds(mp4(90)), 90);
  assert.equal(mp4Seconds(Buffer.from('not a video at all, no header here.')), 0);
  const { join, up } = await boot();
  const c = await join('vidu');
  assert.equal((await up('kind=reel', mp4(120), c)).status, 201);
  assert.equal((await up('kind=reel', mp4(179), c)).status, 201);
  const long = await up('kind=reel', mp4(400), c);
  assert.equal(long.status, 400);
  assert.match(long.data.error, /3 minutes/);
});

test('video wallpaper upload is saved to custom prefs and is private to its owner', async () => {
  const { base, call, join, up } = await boot();
  const c = await join('wallu'); const o = await join('wallo');
  const v = await up('kind=wallvideo', mp4(10), c);
  assert.equal(v.status, 201);
  const prefs = await call('POST', '/api/prefs', { theme: 'dark', density: 'comfortable', custom: { wallpaperVideoId: v.data.id } }, c);
  assert.equal(prefs.status, 200);
  assert.equal((await call('GET', '/api/me', null, c)).data.prefs.custom.wallpaperVideoId, v.data.id);
  assert.equal((await fetch(`${base}/files/${v.data.id}`, { headers: { Cookie: c } })).status, 200);
  assert.equal((await fetch(`${base}/files/${v.data.id}`, { headers: { Cookie: o } })).status, 404);
});

test('delete a DM: only the sender can, and both sides are told', async () => {
  const { call, join } = await boot();
  const a = await join('delaa'); const b = await join('delbb');
  const sent = (await call('POST', '/api/messages', { to: 'delbb', body: 'oops' }, a)).data;
  assert.equal((await call('POST', '/api/message-delete', { with: 'delaa', id: sent.id }, b)).status, 404);
  assert.equal((await call('POST', '/api/message-delete', { with: 'delbb', id: sent.id }, a)).status, 200);
  assert.equal((await call('GET', '/api/messages?with=delbb', null, a)).data.messages.length, 0);
  assert.equal((await call('GET', '/api/messages?with=delaa', null, b)).data.messages.length, 0);
});

test('group messages: sender or admin may delete, others may not', async () => {
  const { call, join } = await boot();
  const own = await join('gown'); const mem = await join('gmem'); const oth = await join('goth');
  const gid = (await call('POST', '/api/groups', { name: 'Crew', members: ['gmem', 'goth'] }, own)).data.id;
  const m1 = (await call('POST', '/api/group-messages', { group: gid, body: 'hi' }, mem)).data.id;
  const m2 = (await call('POST', '/api/group-messages', { group: gid, body: 'yo' }, mem)).data.id;
  assert.equal((await call('POST', '/api/group-message-delete', { group: gid, id: m1 }, oth)).status, 403);
  assert.equal((await call('POST', '/api/group-message-delete', { group: gid, id: m1 }, mem)).status, 200);
  assert.equal((await call('POST', '/api/group-message-delete', { group: gid, id: m2 }, own)).status, 200);
});

test('server tags: admin sets a tag, members wear it, it shows next to their messages and profile', async () => {
  const { call, join } = await boot();
  const own = await join('town'); const mem = await join('tmem'); const out = await join('tout');
  const cid = (await call('POST', '/api/communities', { name: 'Forge' }, own)).data.id;
  const { code } = (await call('POST', '/api/community-invite', { community: cid }, own)).data;
  await call('POST', '/api/community-join', { code }, mem);
  assert.equal((await call('POST', '/api/community-tag', { community: cid, tag: 'x!', icon: 'bolt' }, own)).status, 400);
  assert.equal((await call('POST', '/api/community-tag', { community: cid, tag: 'frg', icon: 'nope' }, own)).status, 400);
  assert.equal((await call('POST', '/api/community-tag', { community: cid, tag: 'frg', icon: 'bolt', color: '#ff8800' }, mem)).status, 403);
  const set = await call('POST', '/api/community-tag', { community: cid, tag: 'frg', icon: 'bolt', color: '#ff8800' }, own);
  assert.deepEqual(set.data, { tag: 'FRG', icon: 'bolt', color: '#ff8800' });
  assert.equal((await call('POST', '/api/wear-tag', { community: cid }, out)).status, 404);
  assert.equal((await call('POST', '/api/wear-tag', { community: cid }, mem)).data.clan.tag, 'FRG');
  assert.equal((await call('GET', '/api/profile?user=tmem', null, own)).data.clan.icon, 'bolt');
  const ch = (await call('GET', `/api/community?id=${cid}`, null, own)).data.channels[0].id;
  await call('POST', '/api/channel-messages', { channel: ch, body: 'hello' }, mem);
  const msgs = (await call('GET', `/api/channel-messages?channel=${ch}`, null, own)).data.messages;
  assert.equal(msgs.find((m) => m.from === 'tmem').clan.tag, 'FRG');
  await call('POST', '/api/wear-tag', { community: null }, mem);
  assert.equal((await call('GET', '/api/profile?user=tmem', null, own)).data.clan, null);
});

const installBot = (call, c, gid, bot) => call('POST', '/api/bots/install', { scope: 'group', id: gid, bot, config: {} }, c);
const lastFrom = async (call, c, gid, from) => (await call('GET', `/api/group-messages?group=${gid}`, null, c)).data.messages.filter((m) => m.from === from).at(-1)?.body;

test('new bots answer: Toolkit, Arcade, Quotebook and Levels', async () => {
  const { call, join } = await boot();
  const own = await join('botown');
  const gid = (await call('POST', '/api/groups', { name: 'Bots', members: [] }, own)).data.id;
  for (const b of ['toolkit', 'arcade', 'quotebook', 'levels']) assert.equal((await installBot(call, own, gid, b)).status, 200);
  const say = (t) => call('POST', '/api/group-messages', { group: gid, body: t }, own);
  await say('!calc 2*(3+4)');
  assert.equal(await lastFrom(call, own, gid, 'toolkit'), '2*(3+4) = 14');
  await say('!calc process.exit()');
  assert.match(await lastFrom(call, own, gid, 'toolkit'), /only understand/);
  await say('!guess');
  assert.match(await lastFrom(call, own, gid, 'arcade'), /number from 1 to 100/);
  await say('!quote add Ship it');
  assert.match(await lastFrom(call, own, gid, 'quotebook'), /Saved as #\d+/);
  await say('!quote');
  assert.match(await lastFrom(call, own, gid, 'quotebook'), /Ship it/);
  await say('just chatting');
  await say('!rank');
  assert.match(await lastFrom(call, own, gid, 'levels'), /level 0, 10 XP, rank #1/);
  await say('!top');
  assert.match(await lastFrom(call, own, gid, 'levels'), /Leaderboard/);
  assert.equal((await call('GET', `/api/bots/catalog?scope=group&id=${gid}`, null, own)).data.bots.length, 8);
});

const fakeSupabase = async () => {
  const users = { good: { id: 'u-1', email: 'Ada.Lovelace@gmail.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'google' }, user_metadata: { full_name: 'Ada Lovelace' } },
    mail: { id: 'u-2', email: 'x@y.com', email_confirmed_at: '2026-01-01', app_metadata: { provider: 'email' }, user_metadata: {} },
    unconfirmed: { id: 'u-3', email: 'z@y.com', app_metadata: { provider: 'google' }, user_metadata: {} } };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, apikey: req.headers.apikey });
    const t = /^Bearer (\S+)/.exec(req.headers.authorization ?? '')?.[1]?.replace(/_+$/, '');
    const u = users[t];
    res.writeHead(u ? 200 : 401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(u ?? { msg: 'bad jwt' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
};

test('Continue with Google: verifies the token with Supabase, creates the account once, then signs back in', async () => {
  const sb = await fakeSupabase();
  const { call, base } = await boot({ supabaseUrl: sb.url, supabaseKey: 'anon-key' });
  const cfg = (await call('GET', '/api/auth/config')).data;
  assert.equal(cfg.google, true); assert.match(cfg.authorizeUrl, /\/auth\/v1\/authorize\?provider=google$/);
  const tok = (t) => `${t}`.padEnd(24, '_');
  assert.equal((await call('POST', '/api/auth/google', { accessToken: tok('bad') })).status, 401);
  assert.equal((await call('POST', '/api/auth/google', { accessToken: tok('mail') })).status, 401);
  assert.equal((await call('POST', '/api/auth/google', { accessToken: tok('unconfirmed') })).status, 401);
  const first = await call('POST', '/api/auth/google', { accessToken: tok('good') });
  assert.equal(first.status, 200);
  assert.equal(first.data.created, true); assert.equal(first.data.username, 'ada_lovelace'); assert.equal(first.data.displayName, 'Ada Lovelace');
  const cookie = first.headers.get('set-cookie').split(';')[0];
  assert.equal(sb.seen.at(-1).apikey, 'anon-key');
  const me = (await call('GET', '/api/me', null, cookie)).data;
  assert.equal(me.username, 'ada_lovelace'); assert.equal(me.canPickUsername, true);
  assert.equal((await call('POST', '/api/username', { username: 'ada' }, cookie)).data.username, 'ada');
  assert.equal((await call('POST', '/api/username', { username: 'ada2' }, cookie)).status, 403);
  const again = await call('POST', '/api/auth/google', { accessToken: tok('good') });
  assert.equal(again.data.created, false); assert.equal(again.data.username, 'ada');
  // a Google account has no password, so password login is closed to it
  const pw = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: 'ada', password: '!' }) });
  assert.equal(pw.status, 401);
});

test('Google sign-in is off without Supabase settings', async () => {
  const { call } = await boot();
  assert.equal((await call('GET', '/api/auth/config')).data.google, false);
  assert.equal((await call('POST', '/api/auth/google', { accessToken: 'x'.repeat(30) })).status, 404);
});

test('setup wizard: first run needs the setup code, creates the owner once, then closes', async () => {
  const { call } = await boot({ ownerUsername: undefined, ownerPassword: undefined, setupCodeEnv: 'abc12345' });
  assert.equal((await call('GET', '/api/auth/config')).data.setupNeeded, true);
  const body = { code: 'abc12345', username: 'founder', displayName: 'The Founder', password: 'a-very-long-pass', siteName: 'Nova' };
  assert.equal((await call('POST', '/api/setup', { ...body, code: 'wrong123' })).status, 403);
  assert.equal((await call('POST', '/api/setup', { ...body, password: 'short' })).status, 400);
  const ok = await call('POST', '/api/setup', body);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  const me = (await call('GET', '/api/me', null, cookie)).data;
  assert.equal(me.isOwner, true); assert.equal(me.role, 'owner');
  const cfg = (await call('GET', '/api/auth/config')).data;
  assert.equal(cfg.setupNeeded, false); assert.equal(cfg.siteName, 'Nova');
  assert.equal((await call('POST', '/api/setup', body)).status, 404);
});

test('setup wizard stays closed when the owner comes from the environment', async () => {
  const { call } = await boot();
  assert.equal((await call('GET', '/api/auth/config')).data.setupNeeded, false);
});

test('download links redirect to APK_URL / EXE_URL and 404 when unset', async () => {
  const off = await boot();
  for (const p of ['android', 'windows']) assert.equal((await fetch(`${off.base}/download/${p}`, { redirect: 'manual' })).status, 404);
  const on = await boot({ apkUrl: 'https://github.com/o/r/releases/download/android-latest/scrxaper.apk', exeUrl: 'https://github.com/o/r/releases/download/windows-latest/Scrxaper-Setup.exe' });
  assert.match((await fetch(`${on.base}/download/android`, { redirect: 'manual' })).headers.get('location'), /scrxaper\.apk$/);
  assert.match((await fetch(`${on.base}/download/windows`, { redirect: 'manual' })).headers.get('location'), /Scrxaper-Setup\.exe$/);
  assert.equal((await fetch(`${on.base}/download/windows`, { redirect: 'manual' })).status, 302);
});

test('reactions, replies and edits work in DMs, groups and channels, and strangers cannot touch them', async () => {
  const { call, join } = await boot();
  const a = await join('rxaa'); const b = await join('rxbb'); const x = await join('rxxx');
  const dm = (await call('POST', '/api/messages', { to: 'rxbb', body: 'first' }, a)).data;
  const rep = (await call('POST', '/api/messages', { to: 'rxaa', body: 'second', replyTo: dm.id }, b)).data;
  let log = (await call('GET', '/api/messages?with=rxbb', null, a)).data.messages;
  assert.equal(log.find((m) => m.id === rep.id).replyTo.body, 'first');
  assert.equal((await call('POST', '/api/react', { scope: 'dm', id: dm.id, emoji: '🔥' }, x)).status, 404);
  assert.equal((await call('POST', '/api/react', { scope: 'dm', id: dm.id, emoji: 'x' }, a)).status, 400);
  assert.deepEqual((await call('POST', '/api/react', { scope: 'dm', id: dm.id, emoji: '🔥' }, a)).data.n, 1);
  await call('POST', '/api/react', { scope: 'dm', id: dm.id, emoji: '🔥' }, b);
  log = (await call('GET', '/api/messages?with=rxbb', null, a)).data.messages;
  assert.deepEqual(log.find((m) => m.id === dm.id).reactions, [{ e: '🔥', n: 2, mine: true }]);
  assert.equal((await call('POST', '/api/react', { scope: 'dm', id: dm.id, emoji: '🔥' }, b)).data.on, false);
  assert.equal((await call('POST', '/api/message-edit', { scope: 'dm', id: dm.id, body: 'first!' }, b)).status, 403);
  assert.equal((await call('POST', '/api/message-edit', { scope: 'dm', id: dm.id, body: 'first!' }, a)).status, 200);
  assert.ok((await call('GET', '/api/messages?with=rxaa', null, b)).data.messages.find((m) => m.id === dm.id).editedAt);
  // a reply cannot point at another conversation
  const other = (await call('POST', '/api/messages', { to: 'rxxx', body: 'private', }, a)).data;
  const bad = (await call('POST', '/api/messages', { to: 'rxbb', body: 'sneaky', replyTo: other.id }, a)).data;
  assert.equal((await call('GET', '/api/messages?with=rxbb', null, a)).data.messages.find((m) => m.id === bad.id).replyTo, undefined);
  // groups
  const gid = (await call('POST', '/api/groups', { name: 'Rx', members: ['rxbb'] }, a)).data.id;
  const gm = (await call('POST', '/api/group-messages', { group: gid, body: 'hello group' }, a)).data;
  assert.equal((await call('POST', '/api/react', { scope: 'group', id: gm.id, emoji: '🎉' }, x)).status, 404);
  assert.equal((await call('POST', '/api/react', { scope: 'group', id: gm.id, emoji: '🎉' }, b)).status, 200);
  const gr = (await call('POST', '/api/group-messages', { group: gid, body: 'replying', replyTo: gm.id }, b)).data;
  const glog = (await call('GET', `/api/group-messages?group=${gid}`, null, a)).data.messages;
  assert.equal(glog.find((m) => m.id === gr.id).replyTo.name.length > 0, true);
  assert.equal(glog.find((m) => m.id === gm.id).reactions[0].e, '🎉');
});

test('saved messages keep a copy, even if the original is deleted; export lists them', async () => {
  const { call, join, base } = await boot();
  const a = await join('svaa'); const b = await join('svbb');
  const m = (await call('POST', '/api/messages', { to: 'svbb', body: 'remember this address' }, a)).data;
  assert.equal((await call('POST', '/api/saved', { scope: 'dm', id: m.id }, b)).data.saved, true);
  await call('POST', '/api/message-delete', { with: 'svbb', id: m.id }, a);
  const list = (await call('GET', '/api/saved', null, b)).data.saved;
  assert.equal(list.length, 1); assert.equal(list[0].body, 'remember this address'); assert.equal(list[0].username, 'svaa');
  const ex = await fetch(base + '/api/export', { headers: { Cookie: b } });
  assert.match(ex.headers.get('content-disposition'), /attachment; filename="scrxaper-svbb-export\.json"/);
  const dump = await ex.json();
  assert.equal(dump.saved[0].body, 'remember this address'); assert.equal(dump.account.username, 'svbb');
  assert.equal((await call('POST', '/api/saved/delete', { id: list[0].id }, b)).status, 200);
  assert.equal((await call('GET', '/api/saved', null, b)).data.saved.length, 0);
});

test('a Google account can delete itself by typing its username', async () => {
  const sbs = await fakeSupabase();
  const { call } = await boot({ supabaseUrl: sbs.url, supabaseKey: 'k' });
  const r = await call('POST', '/api/auth/google', { accessToken: 'good'.padEnd(24, '_') });
  const c = r.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('POST', '/api/account/delete', { password: 'nope' }, c)).status, 403);
  assert.equal((await call('POST', '/api/account/delete', { password: 'ada_lovelace' }, c)).status, 200);
});
