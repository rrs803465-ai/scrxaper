// Voice channels and group calls. Small rooms are a WebRTC mesh: every participant connects to every
// other one, so audio/video never touches the server. The server only tracks who is in a room and
// relays the setup messages. Rooms hold up to MAX_ROOM people; a media server (SFU) would be needed for more.
export const MAX_ROOM = 8;

export default function makeRooms(ctx) {
  const { db, push, HttpError, readJson, sendJson, channelAccess, needMember, avatarOf, limited, needHuman, pushPresence, postGroupSystem } = ctx;
  const rooms = new Map(); // key -> { key, kind, scope, started, people: Map(uid -> info) }
  const byUser = new Map(); // uid -> key

  const audience = (room) => {
    if (room.kind === 'vc') {
      const ch = db.prepare('SELECT community_id, private FROM channels WHERE id = ?').get(room.scope);
      if (!ch) return [];
      return db.prepare('SELECT user_id, role FROM community_members WHERE community_id = ?').all(ch.community_id)
        .filter((r) => !ch.private || r.role !== 'member').map((r) => r.user_id);
    }
    return db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(room.scope).map((r) => r.user_id);
  };
  const shape = (room) => ({ room: room.key, kind: room.kind, scope: room.scope, started: room.started, people: [...room.people.values()] });
  const broadcast = (room, type, extra = {}) => {
    const payload = { type, ...shape(room), ...extra };
    const targets = new Set([...audience(room), ...room.people.keys()]);
    for (const uid of targets) push(uid, 'room', payload);
  };

  const leave = (uid, reason = 'left') => {
    const key = byUser.get(uid);
    if (!key) return;
    byUser.delete(uid);
    const room = rooms.get(key);
    if (!room) return;
    const gone = room.people.get(uid);
    room.people.delete(uid);
    if (!room.people.size) {
      rooms.delete(key);
      if (room.kind === 'gc' && postGroupSystem) {
        const secs = Math.round((Date.now() - room.started) / 1000);
        postGroupSystem(room.scope, gone?.username, `Group call ended · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
      }
      for (const target of audience(room)) push(target, 'room', { type: 'closed', room: key, kind: room.kind, scope: room.scope, people: [] });
      push(uid, 'room', { type: 'closed', room: key, kind: room.kind, scope: room.scope, people: [], reason });
    } else {
      broadcast(room, 'update', { left: gone?.username });
      push(uid, 'room', { type: 'closed', room: key, kind: room.kind, scope: room.scope, people: [], reason });
    }
  };

  const open = (me, key) => {
    const m = /^(vc|gc):(\d+)$/.exec(String(key ?? ''));
    if (!m) throw new HttpError(400, 'Unknown room.');
    const scope = Number(m[2]);
    if (m[1] === 'vc') {
      const { ch, m: mem } = channelAccess(me, scope);
      if (ch.kind !== 'voice') throw new HttpError(400, 'That is not a voice channel.');
      if (mem.timeoutUntil > Date.now()) throw new HttpError(403, 'You are timed out and cannot join voice.');
    } else needMember(me, scope);
    return { kind: m[1], scope, key: `${m[1]}:${scope}` };
  };

  const routes = {
    'POST /api/room/join': async (req, res, me) => {
      needHuman(me);
      const { room: key, video } = await readJson(req);
      const { kind, scope, key: k } = open(me, key);
      if (limited(`room:${me.id}`, 30, 60000)) throw new HttpError(429, 'Slow down.');
      if (byUser.get(me.id) && byUser.get(me.id) !== k) leave(me.id, 'moved');
      let room = rooms.get(k);
      const fresh = !room;
      if (!room) { room = { key: k, kind, scope, started: Date.now(), people: new Map() }; rooms.set(k, room); }
      if (!room.people.has(me.id) && room.people.size >= MAX_ROOM) throw new HttpError(409, `This room is full (${MAX_ROOM} people).`);
      room.people.set(me.id, { username: me.username, name: me.display_name, avatar: avatarOf(me.id), muted: false, deaf: false, video: !!video, sharing: false, at: Date.now() });
      byUser.set(me.id, k);
      broadcast(room, 'update', { joined: me.username });
      if (fresh && kind === 'gc') {
        const g = db.prepare('SELECT name FROM groups WHERE id = ?').get(scope);
        for (const uid of audience(room)) if (uid !== me.id) {
          push(uid, 'room-ring', { room: k, group: scope, groupName: g?.name, from: me.username, name: me.display_name, avatar: avatarOf(me.id) });
          pushPresence?.(uid, { t: 'room', room: k, group: scope, name: me.display_name, groupName: g?.name });
        }
      }
      sendJson(res, 200, { ...shape(room), me: me.username, max: MAX_ROOM });
    },

    'POST /api/room/leave': async (req, res, me) => { leave(me.id); sendJson(res, 200, { ok: true }); },

    'POST /api/room/state': async (req, res, me) => {
      const b = await readJson(req);
      const room = rooms.get(byUser.get(me.id));
      if (!room) throw new HttpError(404, 'You are not in a room.');
      const p = room.people.get(me.id);
      for (const k of ['muted', 'deaf', 'video', 'sharing']) if (k in b) p[k] = !!b[k];
      broadcast(room, 'update');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/room/signal': async (req, res, me) => {
      const { room: key, to, data } = await readJson(req);
      const room = rooms.get(byUser.get(me.id));
      if (!room || room.key !== key) throw new HttpError(404, 'You are not in that room.');
      const target = [...room.people.entries()].find(([, p]) => p.username === String(to));
      if (!target) throw new HttpError(404, 'That person is not in the room.');
      if (JSON.stringify(data ?? null).length > 20000) throw new HttpError(413, 'Signal too large.');
      if (limited(`rsig:${me.id}`, 1500, 60000)) throw new HttpError(429, 'Slow down.');
      push(target[0], 'room-signal', { room: key, from: me.username, data });
      sendJson(res, 200, { ok: true });
    },

    'GET /api/rooms': (req, res, me) => {
      const out = [];
      for (const room of rooms.values()) {
        try {
          if (room.kind === 'vc') channelAccess(me, room.scope); else needMember(me, room.scope);
          out.push(shape(room));
        } catch { /* not visible to this person */ }
      }
      sendJson(res, 200, out);
    },
  };

  return { routes, leave, roomOf: (uid) => rooms.get(byUser.get(uid)) ?? null, shape };
}
