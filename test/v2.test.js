import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(28)]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrx-v2-'));
const H = { 'X-Requested-With': 'scrxaper' };
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const boot = async (options = {}) => {
  const app = createApp({ dbPath: ':memory:', authLimit: 1000, uploadDir: dir, ownerUsername: 'boss', ownerPassword: 'a-long-owner-pass', allowPrivateWebhooks: true, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body, cookie) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...H, ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
  };
  const join = async (n) => (await fetch(base + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: n, password: 'correct horse' }) })).headers.get('set-cookie').split(';')[0];
  const login = async (n, password) => (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H }, body: JSON.stringify({ username: n, password }) })).headers.get('set-cookie').split(';')[0];
  const up = async (qs, bytes, cookie) => { const r = await fetch(`${base}/api/upload?${qs}`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: bytes }); return { status: r.status, data: await r.json() }; };
  const stream = async (cookie) => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { Cookie: cookie }, signal: ctrl.signal });
    const events = [];
    (async () => {
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString();
          for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
            const raw = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = /event: (.+)/.exec(raw)?.[1]; const data = /data: (.+)/.exec(raw)?.[1];
            if (ev) events.push({ ev, data: JSON.parse(data) });
          }
        }
      } catch { /* closed */ }
    })();
    after(() => ctrl.abort());
    const wait = async (pred) => { for (let i = 0; i < 80; i++) { const f = events.find(pred); if (f) return f; await new Promise((r) => setTimeout(r, 25)); } throw new Error('event not received'); };
    return { events, wait };
  };
  return { call, join, login, up, stream, app, base };
};
const boss = async (t) => t.login('boss', 'a-long-owner-pass');

test('site roles: owner makes admins and staff, staff are limited, admins cannot touch each other or the owner', async () => {
  const t = await boot();
  const b = await boss(t);
  const [adm, stf, bad, victim] = [await t.join('adam'), await t.join('stella'), await t.join('badger'), await t.join('vic')];
  assert.equal((await t.call('POST', '/api/owner/role', { username: 'adam', role: 'admin' }, adm)).status, 404);
  assert.equal((await t.call('POST', '/api/owner/role', { username: 'adam', role: 'admin' }, b)).data.role, 'admin');
  assert.equal((await t.call('POST', '/api/owner/role', { username: 'stella', role: 'staff' }, adm)).data.role, 'staff');
  assert.equal((await t.call('POST', '/api/owner/role', { username: 'badger', role: 'admin' }, adm)).status, 404, 'admins cannot make admins');
  const me = (await t.call('GET', '/api/me', null, stf)).data;
  assert.equal(me.role, 'staff');
  assert.deepEqual(me.perms, ['warn', 'users']);
  assert.equal((await t.call('POST', '/api/owner/warn', { username: 'vic', reason: 'be nice' }, stf)).status, 200);
  assert.equal((await t.call('POST', '/api/owner/ban', { username: 'vic', reason: 'x' }, stf)).status, 404);
  assert.equal((await t.call('POST', '/api/owner/sparks', { username: 'vic', amount: 5 }, stf)).status, 404);
  assert.equal((await t.call('POST', '/api/owner/sparks', { username: 'vic', amount: 25, reason: 'welcome' }, adm)).data.balance, 25);
  assert.equal((await t.call('POST', '/api/owner/ban', { username: 'adam', reason: 'x' }, adm)).status, 403);
  assert.equal((await t.call('POST', '/api/owner/ban', { username: 'boss', reason: 'x' }, adm)).status, 403);
  assert.equal((await t.call('POST', '/api/owner/ban', { username: 'stella', reason: 'abuse of power' }, adm)).status, 200);
  assert.equal((await t.call('GET', '/api/profile?user=adam', null, bad)).data.tag, 'admin');
  assert.ok((await t.call('GET', '/api/profile?user=adam', null, bad)).data.badges.some((x) => x.id === 'admin'));
  assert.equal((await t.call('GET', '/api/profile?user=boss', null, bad)).data.tag, 'owner');
  await t.call('POST', '/api/owner/role', { username: 'adam', role: 'user' }, b);
  assert.equal((await t.call('GET', '/api/profile?user=adam', null, bad)).data.tag, null);
  assert.equal((await t.call('POST', '/api/owner/sparks', { username: 'vic', amount: 5 }, victim)).status, 404);
});

test('a suspended person gets a live banned event, and the login error carries the reason', async () => {
  const t = await boot();
  const b = await boss(t);
  const kai = await t.join('kai');
  const s = await t.stream(kai);
  await t.call('POST', '/api/owner/ban', { username: 'kai', reason: 'spamming' }, b);
  assert.equal((await s.wait((e) => e.ev === 'banned')).data.reason, 'spamming');
  const res = await t.call('POST', '/api/login', { username: 'kai', password: 'correct horse' });
  assert.equal(res.status, 403);
  assert.equal(res.data.banned, true);
  assert.equal(res.data.reason, 'spamming');
});

test('friends: request, accept, notifications, privacy by friends, remove', async () => {
  const t = await boot();
  const [a, b, c] = [await t.join('ana'), await t.join('ben'), await t.join('cyd')];
  const sb = await t.stream(b);
  assert.equal((await t.call('POST', '/api/friends/request', { username: 'ana' }, a)).status, 404);
  assert.equal((await t.call('POST', '/api/friends/request', { username: 'ben' }, a)).status, 201);
  await sb.wait((e) => e.ev === 'friend');
  assert.equal((await t.call('POST', '/api/friends/request', { username: 'ben' }, a)).status, 409);
  const incoming = (await t.call('GET', '/api/friends', null, b)).data.incoming;
  assert.equal(incoming[0].username, 'ana');
  assert.equal((await t.call('GET', '/api/notifications', null, b)).data.items[0].kind, 'friend_request');
  assert.equal((await t.call('GET', '/api/me', null, b)).data.friendRequests, 1);
  await t.call('POST', '/api/privacy', { whoCanMessage: 'friends', previews: true, dnd: false }, b);
  assert.equal((await t.call('POST', '/api/messages', { to: 'ben', body: 'hi' }, a)).status, 403);
  assert.equal((await t.call('POST', '/api/friends/respond', { username: 'ana', accept: true }, c)).status, 404);
  assert.equal((await t.call('POST', '/api/friends/respond', { username: 'ana', accept: true }, b)).data.status, 'friends');
  assert.equal((await t.call('GET', '/api/notifications', null, a)).data.items[0].kind, 'friend_accept');
  assert.equal((await t.call('POST', '/api/messages', { to: 'ben', body: 'hi friend' }, a)).status, 201);
  assert.equal((await t.call('POST', '/api/messages', { to: 'ben', body: 'stranger' }, c)).status, 403);
  assert.equal((await t.call('GET', '/api/profile?user=ben', null, a)).data.friend, 'friends');
  assert.equal((await t.call('POST', '/api/sparks/send', { username: 'ben', amount: 5 }, a)).status, 402);
  await t.call('POST', '/api/friends/remove', { username: 'ana' }, b);
  assert.equal((await t.call('GET', '/api/friends', null, a)).data.friends.length, 0);
  await t.call('POST', '/api/block', { username: 'cyd', blocked: true }, a);
  assert.equal((await t.call('POST', '/api/friends/request', { username: 'ana' }, c)).status, 403);
});

test('private accounts need approval; likes, comments and follows create notifications', async () => {
  const t = await boot();
  const [own, fan, out] = [await t.join('pia'), await t.join('fay'), await t.join('gus')];
  const media = (await t.up('kind=post', PNG, own)).data.id;
  const post = (await t.call('POST', '/api/posts', { media, caption: 'secret #garden' }, own)).data.id;
  await t.call('POST', '/api/privacy', { whoCanMessage: 'everyone', previews: true, dnd: false, private: true }, own);
  assert.equal((await t.call('GET', '/api/user-posts?user=pia', null, fan)).data.length, 0);
  assert.equal((await t.call('GET', '/api/post?id=' + post, null, fan)).status, 404);
  assert.equal((await t.call('GET', '/api/profile?user=pia', null, fan)).data.canSee, false);
  assert.equal((await fetch(`${t.base}/files/${media}`, { headers: { Cookie: fan } })).status, 404);
  assert.deepEqual((await t.call('GET', '/api/explore', null, fan)).data.tags, []);
  const f = (await t.call('POST', '/api/follow', { username: 'pia', follow: true }, fan)).data;
  assert.equal(f.requested, true);
  assert.equal((await t.call('GET', '/api/profile?user=pia', null, fan)).data.requested, true);
  assert.equal((await t.call('GET', '/api/follow-requests', null, own)).data[0].username, 'fay');
  assert.equal((await t.call('GET', '/api/notifications', null, own)).data.items[0].kind, 'follow_request');
  await t.call('POST', '/api/follow-requests/respond', { username: 'fay', accept: true }, own);
  assert.equal((await t.call('GET', '/api/user-posts?user=pia', null, fan)).data.length, 1);
  assert.equal((await fetch(`${t.base}/files/${media}`, { headers: { Cookie: fan } })).status, 200);
  assert.equal((await fetch(`${t.base}/files/${media}`, { headers: { Cookie: out } })).status, 404);
  await t.call('POST', '/api/posts/like', { post, liked: true }, fan);
  await t.call('POST', '/api/posts/comment', { post, body: 'nice' }, fan);
  const kinds = (await t.call('GET', '/api/notifications', null, own)).data.items.map((n) => n.kind);
  assert.ok(kinds.includes('like') && kinds.includes('comment'));
  assert.equal((await t.call('POST', '/api/notifications/read', {}, own)).data.unread, 0);
  await t.call('POST', '/api/follow', { username: 'pia', follow: true }, out);
  await t.call('POST', '/api/privacy', { whoCanMessage: 'everyone', previews: true, dnd: false, private: false }, own);
  assert.equal((await t.call('GET', '/api/user-posts?user=pia', null, out)).data.length, 1, 'going public approves waiting requests');
  assert.equal((await t.call('GET', '/api/profile?user=pia', null, out)).data.isFollowing, true);
});

test('hashtags, explore and sharing a post into a DM, group and channel', async () => {
  const t = await boot();
  const [a, b] = [await t.join('hana'), await t.join('ivo')];
  const m1 = (await t.up('kind=post', PNG, a)).data.id;
  const p1 = (await t.call('POST', '/api/posts', { media: m1, caption: 'Sunrise #Hike and #hike again #trail' }, a)).data.id;
  const tag = (await t.call('GET', '/api/tag?tag=%23HIKE', null, b)).data;
  assert.equal(tag.tag, 'hike');
  assert.equal(tag.posts[0].id, p1);
  const ex = (await t.call('GET', '/api/explore', null, b)).data;
  assert.deepEqual(ex.tags.map((x) => x.tag).sort(), ['hike', 'trail']);
  assert.equal(ex.posts[0].id, p1);
  assert.equal(ex.people[0].username, 'hana');
  assert.equal((await t.call('GET', '/api/search?q=hik', null, b)).data.tags[0].tag, 'hike');
  await t.call('POST', '/api/posts/edit', { post: p1, caption: 'no tags now' }, a);
  assert.equal((await t.call('GET', '/api/tag?tag=hike', null, b)).data.posts.length, 0);
  await t.call('POST', '/api/posts/edit', { post: p1, caption: 'back #again' }, a);
  assert.equal((await t.call('POST', '/api/posts/share', { post: p1, kind: 'dm', target: 'ivo', note: 'look' }, a)).status, 200);
  const dm = (await t.call('GET', '/api/messages?with=hana', null, b)).data.messages.at(-1);
  assert.equal(dm.kind, 'post');
  assert.equal(dm.meta.post, p1);
  assert.equal(dm.body, 'look');
  const gid = (await t.call('POST', '/api/groups', { name: 'Hikers', members: ['ivo'] }, a)).data.id;
  assert.equal((await t.call('POST', '/api/posts/share', { post: p1, kind: 'group', target: gid }, a)).status, 200);
  assert.equal((await t.call('GET', `/api/group-messages?group=${gid}`, null, b)).data.messages.at(-1).kind, 'post');
  const cid = (await t.call('POST', '/api/communities', { name: 'Trails' }, a)).data.id;
  const ch = (await t.call('GET', `/api/community?id=${cid}`, null, a)).data.channels[0].id;
  assert.equal((await t.call('POST', '/api/posts/share', { post: p1, kind: 'channel', target: ch }, a)).status, 200);
  assert.equal((await t.call('POST', '/api/posts/share', { post: p1, kind: 'channel', target: ch }, b)).status, 404);
});

test('music on posts and stories: shared library, private sounds stay private, deleting a sound detaches it', async () => {
  const t = await boot();
  const [a, b] = [await t.join('joe'), await t.join('kit')];
  const song = (await t.up('kind=sound&name=beat.wav', Buffer.concat([WAV, Buffer.alloc(3 * 1024 * 1024)]), a)).data.id;
  assert.equal((await fetch(`${t.base}/files/${song}`, { headers: { Cookie: b } })).status, 404);
  const media = (await t.up('kind=post', PNG, a)).data.id;
  assert.equal((await t.call('POST', '/api/posts', { media, caption: 'x', music: { id: 'f'.repeat(32) } }, a)).status, 400);
  const pid = (await t.call('POST', '/api/posts', { media, caption: 'x', music: { id: song, title: 'Beat', start: 12, mute: true } }, a)).data.id;
  const post = (await t.call('GET', '/api/post?id=' + pid, null, b)).data;
  assert.equal(post.musicId, song);
  assert.equal(post.musicStart, 12);
  assert.equal((await fetch(`${t.base}/files/${song}`, { headers: { Cookie: b } })).status, 200);
  assert.equal((await t.call('GET', '/api/music/library', null, b)).data[0].id, song);
  const sm = (await t.up('kind=story', PNG, b)).data.id;
  assert.equal((await t.call('POST', '/api/stories', { media: sm, music: { id: song, title: 'Beat' } }, b)).status, 201);
  await t.call('POST', '/api/sounds/delete', { id: song }, a);
  assert.equal((await t.call('GET', '/api/post?id=' + pid, null, b)).data.musicId, null);
});

test('any file can be attached; messages carry file details', async () => {
  const t = await boot();
  const [a, b] = [await t.join('lue'), await t.join('max')];
  const zip = await t.up('kind=attachment&name=notes.zip', Buffer.from('PK\u0003\u0004 pretend archive'), a);
  assert.equal(zip.data.kind, 'file');
  const png = await t.up('kind=attachment&name=pic.png', PNG, a);
  assert.equal(png.data.kind, 'image');
  await t.call('POST', '/api/messages', { to: 'max', body: 'here', attachment: zip.data.id }, a);
  const m = (await t.call('GET', '/api/messages?with=lue', null, b)).data.messages.at(-1);
  assert.deepEqual(m.file, { name: 'notes.zip', mime: 'application/octet-stream', size: zip.data.size, kind: 'file' });
  assert.equal((await fetch(`${t.base}/files/${zip.data.id}`, { headers: { Cookie: b } })).status, 200);
  const c = await t.join('nell');
  assert.equal((await fetch(`${t.base}/files/${zip.data.id}`, { headers: { Cookie: c } })).status, 404);
  const range = await fetch(`${t.base}/files/${png.data.id}`, { headers: { Cookie: a, Range: 'bytes=0-7' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 8);
});

test('Sentinel blocks links, words, shouting and floods; Funbot answers commands; Greeter welcomes; admins only', async () => {
  const t = await boot();
  const [own, mem, mem2] = [await t.join('olga'), await t.join('pete'), await t.join('perry')];
  const cid = (await t.call('POST', '/api/communities', { name: 'Hall' }, own)).data.id;
  const code = (await t.call('POST', '/api/community-invite', { community: cid }, own)).data.code;
  const ch = (await t.call('GET', `/api/community?id=${cid}`, null, own)).data.channels[0].id;
  assert.equal((await t.call('POST', '/api/bots/install', { scope: 'community', id: cid, bot: 'sentinel' }, mem)).status, 404);
  assert.equal((await t.call('GET', '/api/bots/catalog?scope=community&id=' + cid, null, own)).data.bots.length, 4);
  await t.call('POST', '/api/bots/install', { scope: 'community', id: cid, bot: 'sentinel', config: { links: true, words: ['Darn', 'heck'], mentions: 2 } }, own);
  await t.call('POST', '/api/bots/install', { scope: 'community', id: cid, bot: 'funbot' }, own);
  await t.call('POST', '/api/bots/install', { scope: 'community', id: cid, bot: 'greeter', config: { welcome: 'Hello {user}, welcome to {name}!' } }, own);
  await t.call('POST', '/api/community-join', { code }, mem);
  await t.call('POST', '/api/community-join', { code }, mem2);
  const say = (body, who = mem) => t.call('POST', '/api/channel-messages', { channel: ch, body }, who);
  assert.equal((await say('look https://spam.example')).status, 422);
  assert.match((await say('what the heck')).data.error, /Sentinel/);
  assert.equal((await say('@a @b @c hi', mem2)).status, 422);
  assert.equal((await say('THIS IS ABSOLUTELY SHOUTING NOW', mem2)).status, 422);
  assert.equal((await say('look https://fine.example', own)).status, 201, 'owners are exempt');
  assert.equal((await say('hello there')).status, 201);
  await say('!roll 20');
  await say('!poll Best snack? | chips | fruit');
  const msgs = (await t.call('GET', `/api/channel-messages?channel=${ch}`, null, own)).data.messages;
  assert.ok(msgs.some((m) => m.from === 'greeter' && m.body === 'Hello pete, welcome to Hall!'));
  assert.ok(msgs.some((m) => m.from === 'funbot' && /rolled \d+ \(d20\)/.test(m.body)));
  const poll = msgs.find((m) => m.kind === 'poll');
  assert.equal(poll.tag, 'bot');
  assert.deepEqual(poll.meta.options, ['chips', 'fruit']);
  assert.equal((await t.call('POST', '/api/poll/vote', { scope: 'channel', id: poll.id, choice: 1 }, mem)).data.counts[1], 1);
  assert.equal((await t.call('POST', '/api/poll/vote', { scope: 'channel', id: poll.id, choice: 9 }, mem)).status, 400);
  const log = (await t.call('GET', `/api/community-log?id=${cid}`, null, own)).data;
  assert.ok(log.some((l) => l.action === 'sentinel-block'));
  for (let i = 0; i < 4; i++) await say('more https://x.example');
  assert.match((await say('hi')).data.error, /timed out/);
  assert.equal((await t.call('POST', '/api/messages', { to: 'funbot', body: 'hi' }, mem)).status, 403);
  assert.equal((await t.call('GET', '/api/search?q=funbot', null, mem)).data.people.length, 0);
  await t.call('POST', '/api/bots/remove', { scope: 'community', id: cid, bot: 'sentinel' }, own);
  assert.equal((await t.call('GET', `/api/community?id=${cid}`, null, own)).data.bots.includes('sentinel'), false);
});

test('Jukebox: upload tracks, queue and skip with commands, synced state, tracks only visible to members', async () => {
  const t = await boot();
  const [own, mem, out] = [await t.join('quincy'), await t.join('rae'), await t.join('sol')];
  const gid = (await t.call('POST', '/api/groups', { name: 'Tunes', members: ['rae'] }, own)).data.id;
  assert.equal((await t.up(`kind=sound`, WAV, own)).status, 201);
  const noBot = await fetch(`${t.base}/api/bots/music/upload?scope=group&id=${gid}&name=a.wav`, { method: 'POST', headers: { ...H, Cookie: own }, body: WAV });
  assert.equal(noBot.status, 400);
  await t.call('POST', '/api/bots/install', { scope: 'group', id: gid, bot: 'jukebox' }, own);
  const up = async (name, cookie = own, bytes = WAV) => fetch(`${t.base}/api/bots/music/upload?scope=group&id=${gid}&name=${name}`, { method: 'POST', headers: { ...H, Cookie: cookie }, body: bytes });
  assert.equal((await up('x.wav', mem)).status, 403);
  assert.equal((await up('bad.wav', own, Buffer.from('not audio, definitely not audio'))).status, 400);
  const first = await (await up('First Song.wav')).json();
  await up('Second Song.wav');
  const s = await t.stream(mem);
  const say = (body) => t.call('POST', '/api/group-messages', { group: gid, body }, mem);
  await say('!tracks');
  await say('!play 1');
  const now = await s.wait((e) => e.ev === 'music' && e.data.now);
  assert.equal(now.data.now.title, 'First Song');
  const upload = now.data.now.upload;
  assert.equal((await fetch(`${t.base}/files/${upload}`, { headers: { Cookie: mem } })).status, 200);
  assert.equal((await fetch(`${t.base}/files/${upload}`, { headers: { Cookie: out } })).status, 404);
  await say('!play second');
  await say('!queue');
  await say('!pause');
  assert.equal((await t.call('GET', `/api/music/state?scope=group&id=${gid}`, null, mem)).data.now.paused, true);
  await say('!resume');
  await say('!skip');
  assert.equal((await t.call('GET', `/api/music/state?scope=group&id=${gid}`, null, mem)).data.now.title, 'Second Song');
  const bodies = (await t.call('GET', `/api/group-messages?group=${gid}`, null, own)).data.messages.filter((m) => m.from === 'jukebox');
  assert.ok(bodies.some((m) => m.kind === 'track' && m.meta.title === 'First Song'));
  assert.ok(bodies.some((m) => /Queued: Second Song/.test(m.body)));
  await t.call('POST', '/api/music/ended', { scope: 'group', id: gid, upload: 'nope' }, mem);
  assert.equal((await t.call('GET', `/api/music/state?scope=group&id=${gid}`, null, mem)).data.now.title, 'Second Song');
  await t.call('POST', '/api/bots/music/delete', { scope: 'group', id: gid, track: first.id }, own);
  assert.equal((await fetch(`${t.base}/files/${upload}`, { headers: { Cookie: mem } })).status, 404);
});

test('voice channels and group calls: join, signalling relays only to people in the room, leave and disconnect', async () => {
  const t = await boot();
  const [a, b, c] = [await t.join('tess'), await t.join('uri'), await t.join('wren')];
  const cid = (await t.call('POST', '/api/communities', { name: 'Voice' }, a)).data.id;
  const code = (await t.call('POST', '/api/community-invite', { community: cid }, a)).data.code;
  await t.call('POST', '/api/community-join', { code }, b);
  const vc = (await t.call('POST', '/api/channels', { community: cid, name: 'lounge', kind: 'voice' }, a)).data.id;
  assert.equal((await t.call('POST', '/api/channel-messages', { channel: vc, body: 'hi' }, a)).status, 400);
  const sa = await t.stream(a); const sb = await t.stream(b);
  const ja = (await t.call('POST', '/api/room/join', { room: `vc:${vc}` }, a)).data;
  assert.equal(ja.people.length, 1);
  assert.equal((await t.call('POST', '/api/room/join', { room: `vc:${vc}` }, c)).status, 404, 'non-members cannot join');
  const jb = (await t.call('POST', '/api/room/join', { room: `vc:${vc}`, video: true }, b)).data;
  assert.deepEqual(jb.people.map((p) => p.username).sort(), ['tess', 'uri']);
  await sa.wait((e) => e.ev === 'room' && e.data.people?.length === 2);
  assert.equal((await t.call('POST', '/api/room/signal', { room: `vc:${vc}`, to: 'tess', data: { hello: 1 } }, b)).status, 200);
  assert.deepEqual((await sa.wait((e) => e.ev === 'room-signal')).data, { room: `vc:${vc}`, from: 'uri', data: { hello: 1 } });
  assert.equal((await t.call('POST', '/api/room/signal', { room: `vc:${vc}`, to: 'wren', data: {} }, b)).status, 404);
  await t.call('POST', '/api/room/state', { muted: true }, b);
  await sa.wait((e) => e.ev === 'room' && e.data.people?.find((p) => p.username === 'uri')?.muted);
  assert.equal((await t.call('GET', '/api/rooms', null, a)).data.length, 1);
  assert.equal((await t.call('GET', '/api/rooms', null, c)).data.length, 0);
  await t.call('POST', '/api/room/leave', {}, b);
  await sa.wait((e) => e.ev === 'room' && e.data.people?.length === 1 && e.data.left === 'uri');
  // group call: ringing and a call summary
  const gid = (await t.call('POST', '/api/groups', { name: 'Crew', members: ['uri'] }, a)).data.id;
  await t.call('POST', '/api/room/join', { room: `gc:${gid}` }, a);
  assert.equal((await sb.wait((e) => e.ev === 'room-ring')).data.groupName, 'Crew');
  await t.call('POST', '/api/room/leave', {}, a);
  const last = (await t.call('GET', `/api/group-messages?group=${gid}`, null, b)).data.messages.at(-1);
  assert.equal(last.kind, 'call');
  assert.match(last.body, /^Group call ended/);
});

test('web push: subscriptions are validated and an incoming call is delivered encrypted to the subscribed device', async () => {
  const t = await boot();
  const [a, b] = [await t.join('xan'), await t.join('yui')];
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  const received = new Promise((resolve) => {
    const sink = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => { res.statusCode = 201; res.end(); resolve({ headers: req.headers, body: Buffer.concat(chunks) }); sink.close(); });
    }).listen(0, '127.0.0.1');
    sink.on('listening', () => { received.port = sink.address().port; });
  });
  await new Promise((r) => setTimeout(r, 50));
  const key = (await t.call('GET', '/api/push/key', null, b)).data.publicKey;
  assert.equal(Buffer.from(key, 'base64url').length, 65);
  assert.equal((await t.call('POST', '/api/push/subscribe', { subscription: { endpoint: 'ftp://x', keys: { p256dh: 'a', auth: 'b' } } }, b)).status, 400);
  const sub = { endpoint: `http://127.0.0.1:${received.port}/push/1`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  assert.equal((await t.call('POST', '/api/push/subscribe', { subscription: sub }, b)).status, 201);
  assert.equal((await t.call('GET', '/api/push/status', null, b)).data.subscriptions, 1);
  assert.equal((await t.call('POST', '/api/call/start', { to: 'yui', video: false }, a)).status, 201);
  const { headers, body } = await received;
  assert.match(headers.authorization, /^vapid t=.+, k=/);
  assert.equal(headers.urgency, 'high');
  assert.equal(headers['content-encoding'], 'aes128gcm');
  // receiver-side decrypt (RFC 8291)
  const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const ct = body.subarray(21 + idlen);
  const secret = ua.computeSecret(asPub);
  const hkdf = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  const payload = JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
  assert.equal(payload.t, 'call');
  assert.equal(payload.name, 'xan');
  assert.equal(payload.from, 'xan');
  assert.equal((await t.call('POST', '/api/push/unsubscribe', {}, b)).status, 200);
  assert.equal((await t.call('GET', '/api/push/status', null, b)).data.subscriptions, 0);
});

test('secret chats: public keys are published, ciphertext is validated, hidden from search and previews', async () => {
  const t = await boot();
  const [a, b] = [await t.join('zed'), await t.join('amy')];
  const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', k.publicKey);
  assert.equal((await t.call('POST', '/api/e2ee/key', { jwk: { kty: 'RSA' } }, b)).status, 400);
  const id = (await t.call('POST', '/api/e2ee/key', { jwk }, b)).data.id;
  const clean = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  assert.equal(id, crypto.createHash('sha256').update(clean).digest('hex').slice(0, 16));
  assert.deepEqual((await t.call('GET', '/api/e2ee/key?user=amy', null, a)).data, { id, jwk: JSON.parse(clean) });
  assert.equal((await t.call('GET', '/api/e2ee/key?user=zed', null, b)).data.id, null);
  assert.equal((await t.call('POST', '/api/messages', { to: 'amy', body: 'plain text', kind: 'e2ee' }, a)).status, 400);
  const env = JSON.stringify({ v: 1, s: 'aaaa', r: id, i: 'AAAA', c: 'SECRETWORD' });
  assert.equal((await t.call('POST', '/api/messages', { to: 'amy', body: env, kind: 'e2ee' }, a)).status, 201);
  assert.equal((await t.call('GET', '/api/messages?with=zed', null, b)).data.messages[0].kind, 'e2ee');
  assert.equal((await t.call('GET', '/api/conversations', null, b)).data[0].body, 'Encrypted message');
  assert.equal((await t.call('GET', '/api/search?q=SECRETWORD', null, b)).data.messages.length, 0);
});

test('landing page for visitors, the app shell for /app, and Studio customisation is validated', async () => {
  const t = await boot();
  const visitor = await fetch(t.base + '/');
  assert.match(await visitor.text(), /Connect freely/);
  assert.match(await (await fetch(t.base + '/app')).text(), /id="app"/);
  const c = await t.join('bea');
  assert.match(await (await fetch(t.base + '/', { headers: { Cookie: c } })).text(), /id="app"/);
  const base = { theme: 'dark', density: 'comfortable', accent: null };
  assert.equal((await t.call('POST', '/api/prefs', { ...base, vizStyle: 'laser' }, c)).status, 400);
  const out = (await t.call('POST', '/api/prefs', { ...base, vizStyle: 'cd', vizColor: '#ff8800', custom: { bubble: 'solid', radius: 99, fontScale: 5, wallpaper: 'aurora', junk: 1, wallpaperId: 'f'.repeat(32) } }, c)).data;
  assert.equal(out.vizStyle, 'cd');
  assert.equal(out.vizColor, '#ff8800');
  assert.deepEqual(out.custom, { bubble: 'solid', radius: 28, fontScale: 1.4, wallpaper: 'aurora' });
  assert.equal((await t.call('POST', '/api/onboarding/done', {}, c)).status, 200);
  assert.equal((await t.call('GET', '/api/me', null, c)).data.prefs.onboarded, true);
  assert.equal((await t.call('POST', '/api/profile', { displayName: 'Bea', interests: ['Music', 'music', 'Hiking'] }, c)).status, 200);
  assert.deepEqual((await t.call('GET', '/api/profile', null, c)).data.interests, ['music', 'hiking']);
});

test('call history, ringback tune setting and sound validation', async () => {
  const t = await boot();
  const c = await t.join('cora');
  assert.equal((await t.call('POST', '/api/sound', { tone: 'chime', ringtone: 'ring', callingTune: 'ringback_melody', volume: 40 }, c)).data.callingTune, 'ringback_melody');
  assert.equal((await t.call('POST', '/api/sound', { tone: 'chime', ringtone: 'ring', callingTune: 'nope', volume: 40 }, c)).status, 400);
});

test('ring pulse: a ringing call re-pushes the notification until answered, then closes it', async () => {
  const t = await boot({ ringPulseMs: 60 });
  const [a, b] = [await t.join('pulsea'), await t.join('pulseb')];
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const hits = [];
  const sink = http.createServer((req, res) => { req.resume(); req.on('end', () => { hits.push(Date.now()); res.statusCode = 201; res.end(); }); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  await t.call('GET', '/api/push/key', null, b);
  await t.call('POST', '/api/push/subscribe', { subscription: { endpoint: `http://127.0.0.1:${sink.address().port}/p`, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } }, b);
  const { data } = await t.call('POST', '/api/call/start', { to: 'pulseb', video: false }, a);
  await new Promise((r) => setTimeout(r, 400));
  const ringing = hits.length;
  assert.ok(ringing >= 3, `expected repeated pushes while ringing, got ${ringing}`);
  assert.equal((await t.call('POST', '/api/call/answer', { call: data.id }, b)).status, 200);
  await new Promise((r) => setTimeout(r, 150));
  const after = hits.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hits.length, after, 'no more pushes once answered');
  sink.close();
});

test('call/pending returns the ringing call for the callee only, and nothing once answered', async () => {
  const t = await boot();
  const [a, b] = [await t.join('pendinga'), await t.join('pendingb')];
  assert.equal((await t.call('GET', '/api/call/pending', null, b)).data, null);
  const { data } = await t.call('POST', '/api/call/start', { to: 'pendingb', video: true }, a);
  const p = (await t.call('GET', '/api/call/pending', null, b)).data;
  assert.equal(p.id, data.id); assert.equal(p.from, 'pendinga'); assert.equal(p.video, true);
  assert.equal((await t.call('GET', '/api/call/pending', null, a)).data, null);
  await t.call('POST', '/api/call/answer', { call: data.id }, b);
  assert.equal((await t.call('GET', '/api/call/pending', null, b)).data, null);
});

test('download/android redirects to APK_URL, and 404s when it is not set', async () => {
  const off = await boot();
  assert.equal((await fetch(off.base + '/download/android', { redirect: 'manual' })).status, 404);
  const on = await boot({ apkUrl: 'https://github.com/o/r/releases/download/android-latest/scrxaper.apk' });
  const r = await fetch(on.base + '/download/android', { redirect: 'manual' });
  assert.equal(r.status, 302); assert.match(r.headers.get('location'), /scrxaper\.apk$/);
});
