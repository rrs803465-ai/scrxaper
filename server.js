import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, createReadStream, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generateVapidKeys, sendWebPush } from './lib/webpush.js';
import { BOT_CATALOG, BOT_USERS, automod, parseCommand, funCommand, applyConfig } from './lib/bots.js';
import makeRooms from './lib/rooms.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon' };
const SESSION_DAYS = 30;
const USERNAME = /^[a-z0-9_]{3,24}$/;
const RESERVED = new Set(['scrxaper', 'teams', 'admin', 'system', 'owner', 'support', 'staff', 'sentinel', 'jukebox', 'greeter', 'funbot']);
const TEAMS = 'scrxaper';
const isPrivateAddress = (ip) => /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd]|fe80|::ffff:)/i.test(ip);

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_pair ON messages (sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS messages_recipient ON messages (recipient_id, id);
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members (user_id);
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS group_messages_group ON group_messages (group_id, id);
CREATE TABLE IF NOT EXISTS group_invites (
  token_hash TEXT PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
);`;

const sniffImage = (b) => {
  if (b.length < 30) return null;
  if (b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { mime: 'image/jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const chunk = b.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8 ') return { mime: 'image/webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') return { mime: 'image/webp', w: 1 + (((b[22] & 0x3f) << 8) | b[21]), h: 1 + (((b[24] & 0xf) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)) };
    if (chunk === 'VP8X') return { mime: 'image/webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  return null;
};

const sniffVideo = (b) => {
  if (b.length < 12) return null;
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'video/webm';
  return null;
};

const sniffAudio = (b) => {
  if (b.length < 12) return null;
  const tag = (a, z) => b.subarray(a, z).toString('latin1');
  if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WAVE') return 'audio/wav';
  if (tag(0, 4) === 'OggS') return 'audio/ogg';
  if (tag(0, 4) === 'fLaC') return 'audio/flac';
  if (tag(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0)) return 'audio/mpeg';
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (tag(4, 8) === 'ftyp' && /^(M4A |M4B |mp42|isom|iso2|mp41|dash)/.test(tag(8, 12))) return 'audio/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  return null;
};

const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  const [salt, hash] = stored.split(':');
  const given = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(given, Buffer.from(hash, 'hex'));
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export function createApp({
  dbPath = process.env.DB_PATH || './data/scrxaper.db',
  production = process.env.NODE_ENV === 'production',
  ownerUsername = process.env.OWNER_USERNAME,
  ownerPassword = process.env.OWNER_PASSWORD,
  allowPrivateWebhooks = process.env.ALLOW_PRIVATE_WEBHOOKS === '1',
  authLimit = 10,
  trustProxyHops = Number(process.env.TRUST_PROXY_HOPS) || 0,
  callRingMs = 40000, ringPulseMs = 4000,
  claimMinAgeMs = 3600e3,
  currency = process.env.CURRENCY_NAME || 'Sparks',
  aiKeySecret = process.env.AI_KEY_SECRET,
  uploadDir = process.env.UPLOAD_DIR || './data/uploads',
  groqBase = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  apkUrl = process.env.APK_URL,
} = {}) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(schema);
  for (const [table, col, def] of [
    ['users', 'is_owner', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'is_system', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0'], ['users', 'birthday', 'TEXT'], ['users', 'birthday_year', 'INTEGER'],
    ['users', 'banned_at', 'INTEGER'], ['users', 'banned_reason', 'TEXT'], ['messages', 'kind', "TEXT NOT NULL DEFAULT 'text'"],
  ]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS communities (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_members (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
      timeout_until INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS community_members_user ON community_members (user_id);
    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'announcement', 'voice')),
      topic TEXT NOT NULL DEFAULT '', read_only INTEGER NOT NULL DEFAULT 0, private INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0, UNIQUE (community_id, name)
    );
    CREATE TABLE IF NOT EXISTS channel_messages (
      id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_messages_channel ON channel_messages (channel_id, id);
    CREATE TABLE IF NOT EXISTS community_invites (
      token_hash TEXT PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS community_bans (
      community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, reason TEXT, at INTEGER NOT NULL,
      PRIMARY KEY (community_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS mod_log (
      id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, bio TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT 'dark', accent TEXT, density TEXT NOT NULL DEFAULT 'comfortable', reduce_motion INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('frame', 'name_color', 'badge')), name TEXT NOT NULL,
      description TEXT NOT NULL, price INTEGER NOT NULL CHECK (price >= 0), value TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS inventory (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, item_id TEXT NOT NULL REFERENCES items(id),
      acquired_at INTEGER NOT NULL, PRIMARY KEY (user_id, item_id)
    );
    CREATE TABLE IF NOT EXISTS equipped (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES items(id),
      PRIMARY KEY (user_id, kind)
    );
    CREATE TABLE IF NOT EXISTS sparks_ledger (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, delta INTEGER NOT NULL,
      reason TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, UNIQUE (user_id, ref)
    );
    CREATE TABLE IF NOT EXISTS badges (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS user_badges (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, badge_id TEXT NOT NULL REFERENCES badges(id),
      at INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (user_id, badge_id)
    );
    CREATE TABLE IF NOT EXISTS ai_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, key_enc TEXT,
      model TEXT NOT NULL DEFAULT 'openai/gpt-oss-120b', personality TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ai_conversations (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_conversations_user ON ai_conversations (user_id, updated_at);
    CREATE TABLE IF NOT EXISTS ai_messages (
      id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ai_messages_conversation ON ai_messages (conversation_id, id);
    CREATE TABLE IF NOT EXISTS uploads (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mutes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, target TEXT NOT NULL,
      PRIMARY KEY (user_id, kind, target)
    );
    CREATE TABLE IF NOT EXISTS community_roles (
      id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL, color TEXT, perms TEXT NOT NULL, UNIQUE (community_id, name)
    );
    CREATE TABLE IF NOT EXISTS tones (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL, target TEXT NOT NULL, tone TEXT NOT NULL,
      PRIMARY KEY (user_id, kind, target)
    );
    CREATE TABLE IF NOT EXISTS ignores (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, ignored_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, ignored_id)
    );
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY, caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, callee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'ringing', video INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL, PRIMARY KEY (follower_id, followee_id)
    );
    CREATE INDEX IF NOT EXISTS follows_followee ON follows (followee_id);
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK (kind IN ('photo', 'reel')),
      media_id TEXT NOT NULL UNIQUE, caption TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, edited_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS posts_user ON posts (user_id, id);
    CREATE INDEX IF NOT EXISTS posts_kind ON posts (kind, id);
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS post_comments (
      id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS post_comments_post ON post_comments (post_id, id);
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, media_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stories_expiry ON stories (expires_at);
    CREATE TABLE IF NOT EXISTS story_views (
      story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, at INTEGER NOT NULL, PRIMARY KEY (story_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at INTEGER NOT NULL
    );`);
  for (const table of ['messages', 'group_messages', 'channel_messages']) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'attachment_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN attachment_id TEXT`);
  }
  if (!db.prepare('PRAGMA table_info(community_members)').all().some((c) => c.name === 'custom_role_id'))
    db.exec('ALTER TABLE community_members ADD COLUMN custom_role_id INTEGER REFERENCES community_roles(id) ON DELETE SET NULL');
  for (const [table, col, def] of [['communities', 'icon_id', 'TEXT'], ['communities', 'public', 'INTEGER NOT NULL DEFAULT 0'], ['groups', 'icon_id', 'TEXT'],
    ['groups', 'public', 'INTEGER NOT NULL DEFAULT 0'], ['groups', 'description', "TEXT NOT NULL DEFAULT ''"], ['uploads', 'label', 'TEXT'], ['profiles', 'ring_tone', "TEXT NOT NULL DEFAULT 'ring'"]]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
  db.prepare("UPDATE calls SET state = 'ended', reason = 'server-restart', ended_at = ? WHERE state != 'ended'").run(Date.now());
  for (const [col, def] of [['avatar_id', 'TEXT'], ['banner_id', 'TEXT'], ['who_can_message', "TEXT NOT NULL DEFAULT 'everyone'"], ['previews', 'INTEGER NOT NULL DEFAULT 1'], ['dnd', 'INTEGER NOT NULL DEFAULT 0'], ['tone', "TEXT NOT NULL DEFAULT 'chime'"], ['volume', 'INTEGER NOT NULL DEFAULT 60'], ['plain', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!db.prepare('PRAGMA table_info(profiles)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE profiles ADD COLUMN ${col} ${def}`);
  }

  // ---- v2 migrations ----
  const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const addCol = (table, col, def) => { if (!hasCol(table, col)) { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); return true; } return false; };
  const channelsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'channels'").get()?.sql ?? '';
  if (channelsSql && !channelsSql.includes("'voice'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    db.exec(`CREATE TABLE channels_new (
      id INTEGER PRIMARY KEY, community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'announcement', 'voice')),
      topic TEXT NOT NULL DEFAULT '', read_only INTEGER NOT NULL DEFAULT 0, private INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0, UNIQUE (community_id, name));
      INSERT INTO channels_new SELECT id, community_id, name, kind, topic, read_only, private, position FROM channels;
      DROP TABLE channels; ALTER TABLE channels_new RENAME TO channels;`);
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys = ON');
  }
  addCol('users', 'site_role', "TEXT NOT NULL DEFAULT 'user'");
  const freshOnboard = addCol('profiles', 'onboarded', 'INTEGER NOT NULL DEFAULT 0');
  if (freshOnboard) { db.exec('UPDATE profiles SET onboarded = 1'); db.exec('INSERT OR IGNORE INTO profiles (user_id, onboarded) SELECT id, 1 FROM users'); }
  addCol('community_members', 'position', 'INTEGER NOT NULL DEFAULT 0');
  for (const [t, c, d] of [['profiles', 'private', 'INTEGER NOT NULL DEFAULT 0'], ['profiles', 'interests', "TEXT NOT NULL DEFAULT '[]'"], ['profiles', 'custom', "TEXT NOT NULL DEFAULT '{}'"],
    ['profiles', 'calling_tune', "TEXT NOT NULL DEFAULT 'ringback'"], ['profiles', 'viz_style', "TEXT NOT NULL DEFAULT 'ring'"], ['profiles', 'viz_color', 'TEXT'],
    ['posts', 'music_id', 'TEXT'], ['posts', 'music_title', 'TEXT'], ['posts', 'music_start', 'INTEGER NOT NULL DEFAULT 0'], ['posts', 'music_mute', 'INTEGER NOT NULL DEFAULT 0'],
    ['stories', 'music_id', 'TEXT'], ['stories', 'music_title', 'TEXT'], ['stories', 'music_start', 'INTEGER NOT NULL DEFAULT 0'],
    ['messages', 'meta', 'TEXT'], ['group_messages', 'meta', 'TEXT'], ['channel_messages', 'meta', 'TEXT'],
    ['group_messages', 'kind', "TEXT NOT NULL DEFAULT 'text'"], ['channel_messages', 'kind', "TEXT NOT NULL DEFAULT 'text'"]]) addCol(t, c, d);
  db.exec(`
    DROP TABLE IF EXISTS bots;
    CREATE TABLE IF NOT EXISTS friendships (
      a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')), requester INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b)
    );
    CREATE INDEX IF NOT EXISTS friendships_b ON friendships (b);
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      actor_id INTEGER REFERENCES users(id) ON DELETE CASCADE, ref TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, kind, actor_id, ref)
    );
    CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, id);
    CREATE TABLE IF NOT EXISTS follow_requests (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at INTEGER NOT NULL, PRIMARY KEY (follower_id, followee_id)
    );
    CREATE TABLE IF NOT EXISTS post_tags (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (post_id, tag)
    );
    CREATE INDEX IF NOT EXISTS post_tags_tag ON post_tags (tag, post_id);
    CREATE TABLE IF NOT EXISTS bot_installs (
      scope TEXT NOT NULL CHECK (scope IN ('community', 'group')), scope_id INTEGER NOT NULL, bot TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
      installed_by INTEGER, at INTEGER NOT NULL, PRIMARY KEY (scope, scope_id, bot)
    );
    CREATE TABLE IF NOT EXISTS bot_tracks (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, scope_id INTEGER NOT NULL, upload_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, added_by INTEGER, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_tracks_scope ON bot_tracks (scope, scope_id);
    CREATE TABLE IF NOT EXISTS push_subs (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL, auth TEXT NOT NULL, ua TEXT, at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS e2ee_keys (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key_id TEXT NOT NULL, jwk TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, key_id)
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS votes (
      message_scope TEXT NOT NULL, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, choice INTEGER NOT NULL,
      PRIMARY KEY (message_scope, message_id, user_id)
    );
  `);
  mkdirSync(uploadDir, { recursive: true });
  const storeFile = (id, buf) => writeFileSync(path.join(uploadDir, id), buf);
  const removeFile = (id) => { if (id) { rmSync(path.join(uploadDir, id), { force: true }); db.prepare('DELETE FROM uploads WHERE id = ?').run(id); } };
  const sweepStories = () => {
    const expired = db.prepare('SELECT id, media_id FROM stories WHERE expires_at <= ?').all(Date.now());
    for (const s of expired) { db.prepare('DELETE FROM stories WHERE id = ?').run(s.id); removeFile(s.media_id); }
    return expired.length;
  };
  sweepStories();
  const storyTimer = setInterval(sweepStories, 3600e3);
  storyTimer.unref();
  const seedItem = db.prepare('INSERT OR IGNORE INTO items (id, kind, name, description, price, value) VALUES (?, ?, ?, ?, ?, ?)');
  [['frame_ring', 'frame', 'Quiet ring', 'A thin ring around your avatar.', 60, 'ring'],
    ['frame_aurora', 'frame', 'Aurora halo', 'A soft glow in your accent colour.', 150, 'aurora'],
    ['name_sky', 'name_color', 'Sky name', 'Your name in pale sky blue.', 80, '#b7c9e6'],
    ['name_rose', 'name_color', 'Rose name', 'Your name in muted rose.', 80, '#e3a7bd'],
    ['badge_butterfly', 'badge', 'Butterfly', 'A cosmetic butterfly badge. Not an official badge.', 200, 'Butterfly']].forEach((i) => seedItem.run(...i));
  const seedBadge = db.prepare('INSERT OR REPLACE INTO badges (id, name, description) VALUES (?, ?, ?)');
  seedBadge.run('early', 'Early member', 'One of the first 100 people to join Scrxaper.');
  seedBadge.run('owner', 'Owner', 'Owns and runs this Scrxaper instance.');
  seedBadge.run('admin', 'Admin', 'Has full moderation power on this Scrxaper instance.');
  seedBadge.run('staff', 'Staff', 'Helps moderate this Scrxaper instance.');
  db.prepare("INSERT OR IGNORE INTO users (username, display_name, password_hash, created_at, is_system) VALUES (?, 'Scrxaper Teams', '!', ?, 1)").run(TEAMS, Date.now());
  const teamsId = db.prepare('SELECT id FROM users WHERE username = ?').get(TEAMS).id;
  for (const [username, b] of Object.entries(BOT_USERS)) {
    db.prepare("INSERT OR IGNORE INTO users (username, display_name, password_hash, created_at, is_bot) VALUES (?, ?, '!', ?, 1)").run(username, b.name, Date.now());
    db.prepare('UPDATE users SET display_name = ? WHERE username = ?').run(b.name, username);
  }
  db.prepare(`DELETE FROM users WHERE is_bot = 1 AND username NOT IN (${Object.keys(BOT_USERS).map(() => '?').join(',')})`).run(...Object.keys(BOT_USERS));
  const botId = Object.fromEntries(db.prepare('SELECT id, username FROM users WHERE is_bot = 1').all().map((r) => [r.username, r.id]));

  const syncRoleBadge = (uid, role) => {
    db.prepare("DELETE FROM user_badges WHERE user_id = ? AND badge_id IN ('owner', 'admin', 'staff')").run(uid);
    if (['owner', 'admin', 'staff'].includes(role)) db.prepare('INSERT OR IGNORE INTO user_badges (user_id, badge_id, at, source) VALUES (?, ?, ?, ?)').run(uid, role, Date.now(), 'role');
  };
  if (ownerUsername || ownerPassword) {
    const name = String(ownerUsername ?? '').toLowerCase();
    if (!USERNAME.test(name) || String(ownerPassword ?? '').length < 12) throw new Error('OWNER_USERNAME must be a valid username and OWNER_PASSWORD at least 12 characters');
    for (const old of db.prepare("SELECT id FROM users WHERE is_owner = 1 AND username != ?").all(name)) { db.prepare("UPDATE users SET is_owner = 0, site_role = 'user' WHERE id = ?").run(old.id); syncRoleBadge(old.id, 'user'); }
    const hash = hashPassword(ownerPassword);
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) db.prepare("UPDATE users SET is_owner = 1, site_role = 'owner', password_hash = ? WHERE username = ?").run(hash, name);
    else db.prepare("INSERT INTO users (username, display_name, password_hash, created_at, is_owner, site_role) VALUES (?, ?, ?, ?, 1, 'owner')").run(name, name, hash, Date.now());
    syncRoleBadge(db.prepare('SELECT id FROM users WHERE username = ?').get(name).id, 'owner');
    db.prepare("INSERT OR IGNORE INTO profiles (user_id, onboarded) SELECT id, 1 FROM users WHERE username = ?").run(name);
  }

  const streams = new Map();
  const attempts = new Map();
  const hooks = {};

  const push = (userId, event, data) => {
    for (const res of streams.get(userId) ?? []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const clientIp = (req) => {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return (trustProxyHops && forwarded[forwarded.length - trustProxyHops]) || req.socket.remoteAddress;
  };
  const limited = (key, max = 10, windowMs = 15 * 60 * 1000) => {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.reset < now) { attempts.set(key, { count: 1, reset: now + windowMs }); return false; }
    return ++entry.count > max;
  };

  const sendJson = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
  });

  const cookie = (req, name) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
  const sessionCookie = (value, maxAge) =>
    `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${production ? '; Secure' : ''}`;

  const currentUser = (req) => {
    const token = cookie(req, 'sid');
    if (!token) return null;
    return db.prepare(`SELECT u.id, u.username, u.display_name, u.is_owner, u.is_bot, u.birthday, u.site_role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned_at IS NULL`).get(sha(token), Date.now()) ?? null;
  };

  const startSession = (res, userId, body) => {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha(token), userId, Date.now() + SESSION_DAYS * 864e5);
    sendJson(res, 200, body, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
  };

  const findPeer = (me, username) => {
    const peer = db.prepare('SELECT id, username, display_name, is_system, is_bot, site_role, is_owner FROM users WHERE username = ?').get(String(username ?? '').toLowerCase());
    if (!peer || peer.id === me.id) throw new HttpError(404, 'No such user');
    return peer;
  };
  const isBlocked = (a, b) => !!db.prepare(
    'SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)').get(a, b, b, a);

  const roleIn = (gid, uid) => db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(gid, uid)?.role;
  const needMember = (me, gid) => {
    const role = roleIn(Number(gid), me.id);
    if (!role) throw new HttpError(404, 'No such group');
    return role;
  };
  const needAdmin = (me, gid) => {
    if (needMember(me, gid) !== 'admin') throw new HttpError(403, 'Only group admins can do that.');
  };
  const pushGroup = (gid, event, data) => {
    for (const { user_id } of db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid)) if (!(event === 'message' && ignoredBy(user_id, data.from))) push(user_id, event, data);
  };
  const userNamed = (name) => {
    const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(String(name ?? '').toLowerCase());
    if (!u) throw new HttpError(404, `No user called ${name}`);
    return u;
  };
  const MAX_GROUP = 100;
  const addMember = (gid, uid, role = 'member') => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(gid).n;
    if (count >= MAX_GROUP) throw new HttpError(409, 'This group is full.');
    const added = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(gid, uid, role, Date.now()).changes;
    if (added && role === 'member') hooks.onJoin?.('group', gid, uid);
  };

  const notify = (userId, body, kind = 'text') => {
    const at = Date.now();
    const id = Number(db.prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?)').run(teamsId, userId, body, at, kind).lastInsertRowid);
    push(userId, 'message', { id, from: TEAMS, body, at, kind });
  };
  const audit = (actor, action, target, detail) =>
    db.prepare('INSERT INTO audit (actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?)').run(actor.id, action, target ?? null, detail ?? null, Date.now());

  const runBirthdays = (now = new Date()) => {
    const md = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
    const year = now.getUTCFullYear();
    const due = db.prepare('SELECT id, display_name FROM users WHERE birthday = ? AND (birthday_year IS NULL OR birthday_year < ?) AND banned_at IS NULL AND is_bot = 0').all(md, year);
    for (const u of due) {
      db.prepare('UPDATE users SET birthday_year = ? WHERE id = ?').run(year, u.id);
      notify(u.id, `Happy birthday, ${u.display_name}.`, 'card');
      notify(u.id, 'Everyone at Scrxaper Teams hopes you have a great day. Thanks for being here.');
    }
    return due.length;
  };
  runBirthdays();
  const birthdayTimer = setInterval(() => runBirthdays(), 3600e3);
  birthdayTimer.unref();

  const safeLookup = (host, opts, cb) => dns.lookup(host, opts, (err, addr, fam) => {
    if (err) return cb(err);
    const list = Array.isArray(addr) ? addr : [{ address: addr }];
    if (!allowPrivateWebhooks && list.some((a) => isPrivateAddress(a.address))) return cb(new Error('webhook address not allowed'));
    cb(null, addr, fam);
  });
  // ---- site roles ----
  const SITE_PERMS = { staff: ['warn', 'users'], admin: ['warn', 'users', 'ban', 'announce', 'sparks', 'staff'], owner: ['warn', 'users', 'ban', 'announce', 'sparks', 'staff', 'admin'] };
  const siteRole = (u) => (u.is_owner ? 'owner' : u.site_role || 'user');
  const sitePerms = (u) => SITE_PERMS[siteRole(u)] ?? [];
  const needSite = (me, perm) => { if (me.is_bot || !sitePerms(me).includes(perm)) throw new HttpError(404, 'Not found'); };
  const needOwner = (me) => needSite(me, 'admin');
  const tagOf = (r) => (r.is_bot ? 'bot' : r.is_owner ? 'owner' : ['admin', 'staff'].includes(r.site_role) ? r.site_role : null);
  const SITE_RANK = { user: 0, staff: 1, admin: 2, owner: 3 };

  // ---- notifications, friends ----
  const unreadCount = (uid) => countOf('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND seen = 0', uid);
  const online = (uid) => (streams.get(uid)?.size ?? 0) > 0;
  const addNotification = (uid, kind, actorId, ref = '', text = '') => {
    if (uid === actorId || (actorId && isBlocked(uid, actorId))) return;
    db.prepare('INSERT OR REPLACE INTO notifications (user_id, kind, actor_id, ref, text, at, seen) VALUES (?, ?, ?, ?, ?, ?, 0)').run(uid, kind, actorId ?? null, String(ref), text, Date.now());
    push(uid, 'notification', { kind, unread: unreadCount(uid) });
  };
  const pairOf = (x, y) => (x < y ? [x, y] : [y, x]);
  const friendRow = (x, y) => { const [a, b] = pairOf(x, y); return db.prepare('SELECT status, requester FROM friendships WHERE a = ? AND b = ?').get(a, b); };
  const areFriends = (x, y) => friendRow(x, y)?.status === 'accepted';
  const friendStatus = (me, other) => { const r = friendRow(me, other); return !r ? 'none' : r.status === 'accepted' ? 'friends' : r.requester === me ? 'outgoing' : 'incoming'; };

  // ---- web push (VAPID keys live in the database) ----
  let vapidKeys = null;
  const getVapid = () => {
    if (vapidKeys) return vapidKeys;
    const row = db.prepare("SELECT v FROM kv WHERE k = 'vapid'").get();
    if (row) vapidKeys = JSON.parse(row.v);
    else {
      vapidKeys = { ...generateVapidKeys(), subject: process.env.VAPID_SUBJECT || 'mailto:admin@scrxaper.invalid' };
      db.prepare("INSERT INTO kv (k, v) VALUES ('vapid', ?)").run(JSON.stringify(vapidKeys));
    }
    return vapidKeys;
  };
  const pushStats = { sent: 0, failed: 0 };
  const pushNotify = (uid, payload, { ttl = 60, urgency = 'normal' } = {}) => {
    const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE user_id = ?').all(uid);
    for (const sub of subs) {
      sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { vapid: getVapid(), ttl, urgency, lookup: safeLookup, allowHttp: allowPrivateWebhooks })
        .then((r) => { pushStats.sent++; if (r.gone) db.prepare('DELETE FROM push_subs WHERE id = ?').run(sub.id); })
        .catch(() => { pushStats.failed++; });
    }
  };
  const pushQuiet = (uid, payload, key) => {
    if (online(uid)) return;
    const p = privacyOf(uid);
    if (p.dnd || (key && db.prepare('SELECT 1 FROM mutes WHERE user_id = ? AND kind = ? AND target = ?').get(uid, ...key.split(':')))) return;
    pushNotify(uid, p.previews ? payload : { ...payload, body: 'New message' });
  };

  // ---- message payloads ----
  const classify = (mime) => (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');
  const fileInfo = (ids) => {
    const out = new Map();
    for (const id of [...new Set(ids)]) {
      const f = db.prepare('SELECT id, label, mime, size FROM uploads WHERE id = ?').get(id);
      if (f) out.set(id, { name: f.label || 'file', mime: f.mime, size: f.size, kind: classify(f.mime) });
    }
    return out;
  };
  const decorate = (rows, scope, uid) => {
    const files = fileInfo(rows.filter((r) => r.attachment).map((r) => r.attachment));
    return rows.map((r) => {
      const out = { ...r, tag: r.tag ?? tagOf(r), file: r.attachment ? files.get(r.attachment) ?? null : null };
      delete out.is_owner; delete out.site_role; delete out.is_bot; delete out.meta;
      if (r.meta) {
        out.meta = JSON.parse(r.meta);
        if (r.kind === 'poll' && scope !== 'dm') {
          const counts = out.meta.options.map(() => 0);
          let mine = null;
          for (const v of db.prepare('SELECT choice, user_id FROM votes WHERE message_scope = ? AND message_id = ?').all(scope, r.id)) { counts[v.choice]++; if (v.user_id === uid) mine = v.choice; }
          out.meta = { ...out.meta, counts, mine };
        }
      }
      return out;
    });
  };
  const SENDER = 'u.username AS "from", u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, u.is_owner, u.site_role, u.is_bot';
  const dmPayload = (id, sender, peer, text, at, att, kind, meta) => ({ id, from: sender.username, name: sender.display_name, body: text, at, attachment: att, kind, tag: tagOf(sender), ...(meta ? { meta: JSON.parse(meta) } : {}), ...(att ? { file: fileInfo([att]).get(att) } : {}) });

  const insertDm = (sender, peer, text, { att = null, kind = 'text', meta = null } = {}) => {
    const at = Date.now();
    const metaJson = meta ? JSON.stringify(meta) : null;
    const id = Number(db.prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at, attachment_id, kind, meta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sender.id, peer.id, text, at, att, kind, metaJson).lastInsertRowid);
    const payload = dmPayload(id, sender, peer, text, at, att, kind, metaJson);
    push(peer.id, 'message', payload);
    push(sender.id, 'message', { ...payload, to: peer.username });
    const body = kind === 'e2ee' ? 'Encrypted message' : kind === 'post' ? 'Shared a post' : text || (att ? 'Sent a file' : '');
    pushQuiet(peer.id, { t: 'msg', from: sender.username, name: sender.display_name, body: String(body).slice(0, 120), tag: `dm:${sender.username}` }, `dm:${sender.username}`);
    return payload;
  };
  const insertGroup = (gid, senderId, text, { att = null, kind = 'text', meta = null } = {}) => {
    const at = Date.now();
    const u = db.prepare('SELECT username, display_name, is_owner, site_role, is_bot FROM users WHERE id = ?').get(senderId);
    const metaJson = meta ? JSON.stringify(meta) : null;
    const id = Number(db.prepare('INSERT INTO group_messages (group_id, sender_id, body, created_at, attachment_id, kind, meta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(gid, senderId, text, at, att, kind, metaJson).lastInsertRowid);
    const payload = { id, group: Number(gid), from: u.username, name: u.display_name, avatar: avatarOf(senderId), body: text, at, attachment: att, kind, tag: tagOf(u),
      ...(meta ? { meta: kind === 'poll' ? { ...meta, counts: meta.options.map(() => 0), mine: null } : meta } : {}), ...(att ? { file: fileInfo([att]).get(att) } : {}) };
    pushGroup(gid, 'message', payload);
    const g = db.prepare('SELECT name FROM groups WHERE id = ?').get(gid);
    for (const { user_id } of db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?').all(gid, senderId))
      pushQuiet(user_id, { t: 'msg', from: u.username, name: g?.name ?? u.display_name, body: `${u.display_name}: ${String(text || 'Sent a file').slice(0, 100)}`, tag: `group:${gid}` }, `group:${gid}`);
    return payload;
  };
  const insertChannel = (ch, senderId, text, { att = null, kind = 'text', meta = null } = {}) => {
    const at = Date.now();
    const u = db.prepare('SELECT username, display_name, is_owner, site_role, is_bot FROM users WHERE id = ?').get(senderId);
    const metaJson = meta ? JSON.stringify(meta) : null;
    const id = Number(db.prepare('INSERT INTO channel_messages (channel_id, sender_id, body, created_at, attachment_id, kind, meta) VALUES (?, ?, ?, ?, ?, ?, ?)').run(ch.id, senderId, text, at, att, kind, metaJson).lastInsertRowid);
    const payload = { id, channel: ch.id, from: u.username, name: u.display_name, avatar: avatarOf(senderId), body: text, at, attachment: att, kind, tag: tagOf(u),
      ...(meta ? { meta: kind === 'poll' ? { ...meta, counts: meta.options.map(() => 0), mine: null } : meta } : {}), ...(att ? { file: fileInfo([att]).get(att) } : {}) };
    pushChannel(ch, 'channel-message', payload);
    return payload;
  };

  // ---- premade bots ----
  const installedBots = (scope, sid) => Object.fromEntries(db.prepare('SELECT bot, config FROM bot_installs WHERE scope = ? AND scope_id = ?').all(scope, Number(sid)).map((r) => [r.bot, JSON.parse(r.config)]));
  const botSay = (target, bot, text, opts) => (target.scope === 'group' ? insertGroup(target.id, botId[bot], text, opts) : insertChannel(target.ch, botId[bot], text, opts));
  const spamLog = new Map();
  const trivia = new Map();
  const music = new Map(); // `${scope}:${id}` -> { upload, title, startedAt, paused, pos, queue: [] }
  const scopeMembers = (scope, sid) => (scope === 'group'
    ? db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(sid) : db.prepare('SELECT user_id FROM community_members WHERE community_id = ?').all(sid)).map((r) => r.user_id);
  const musicView = (key) => {
    const m = music.get(key);
    return m && m.upload ? { upload: m.upload, title: m.title, startedAt: m.startedAt, paused: m.paused, pos: m.pos, queue: m.queue.map((q) => q.title), serverNow: Date.now() } : null;
  };
  const musicBroadcast = (scope, sid) => { const view = musicView(`${scope}:${sid}`); for (const uid of scopeMembers(scope, sid)) push(uid, 'music', { scope, id: Number(sid), now: view, serverNow: Date.now() }); };
  const startTrack = (scope, sid, track) => {
    const key = `${scope}:${sid}`;
    const st = music.get(key) ?? { queue: [] };
    Object.assign(st, { upload: track.upload_id, title: track.title, startedAt: Date.now(), paused: false, pos: 0 });
    music.set(key, st);
    musicBroadcast(scope, sid);
  };
  const nextTrack = (scope, sid) => {
    const key = `${scope}:${sid}`;
    const st = music.get(key);
    if (!st) return null;
    const next = st.queue.shift();
    if (next) { startTrack(scope, sid, { upload_id: next.upload, title: next.title }); return next; }
    music.delete(key); musicBroadcast(scope, sid);
    return null;
  };
  const musicCommand = (scope, sid, target, me, cmd, args) => {
    const key = `${scope}:${sid}`;
    const tracks = db.prepare('SELECT id, upload_id, title FROM bot_tracks WHERE scope = ? AND scope_id = ? ORDER BY id').all(scope, Number(sid));
    const say = (t, o) => botSay(target, 'jukebox', t, o);
    const st = music.get(key);
    if (cmd === 'tracks') return say(tracks.length ? `Tracks:\n${tracks.slice(0, 20).map((t, i) => `${i + 1}. ${t.title}`).join('\n')}` : 'No tracks yet. An admin can upload some in the bot settings.');
    if (cmd === 'queue') return say(st?.upload ? `Now: ${st.title}${st.queue.length ? `\nNext:\n${st.queue.map((q, i) => `${i + 1}. ${q.title}`).join('\n')}` : ''}` : 'The queue is empty.');
    if (cmd === 'now') return say(st?.upload ? `Now playing: ${st.title}${st.paused ? ' (paused)' : ''}` : 'Nothing is playing.');
    if (cmd === 'pause') { if (!st?.upload || st.paused) return say('Nothing to pause.'); st.pos += (Date.now() - st.startedAt) / 1000; st.paused = true; musicBroadcast(scope, sid); return say('Paused.'); }
    if (cmd === 'resume') { if (!st?.upload || !st.paused) return say('Nothing to resume.'); st.paused = false; st.startedAt = Date.now(); musicBroadcast(scope, sid); return say(`Resumed: ${st.title}`); }
    if (cmd === 'stop') { music.delete(key); musicBroadcast(scope, sid); return say('Stopped and cleared the queue.'); }
    if (cmd === 'skip') { if (!st?.upload) return say('Nothing is playing.'); const n = nextTrack(scope, sid); return say(n ? `Skipped. Now playing: ${n.title}` : 'Skipped. The queue is empty.', n ? { kind: 'track', meta: { upload: n.upload, title: n.title } } : undefined); }
    if (cmd === 'play') {
      if (!tracks.length) return say('No tracks yet. An admin can upload some in the bot settings.');
      if (!args) {
        if (st?.paused) return musicCommand(scope, sid, target, me, 'resume', '');
        if (st?.upload) return say(`Already playing: ${st.title}`);
      }
      const pickTrack = args ? (/^\d+$/.test(args) ? tracks[Number(args) - 1] : tracks.find((t) => t.title.toLowerCase().includes(args.toLowerCase()))) : tracks[0];
      if (!pickTrack) return say(`I could not find "${args.slice(0, 40)}". Try !tracks.`);
      if (st?.upload && !st.paused) { st.queue.push({ upload: pickTrack.upload_id, title: pickTrack.title }); musicBroadcast(scope, sid); return say(`Queued: ${pickTrack.title}`); }
      startTrack(scope, sid, pickTrack);
      const cfg = installedBots(scope, sid).jukebox ?? {};
      return say(`Now playing: ${pickTrack.title}`, cfg.announce === false ? undefined : { kind: 'track', meta: { upload: pickTrack.upload_id, title: pickTrack.title } });
    }
    return null;
  };
  // Run before a message is stored. Throws when Sentinel blocks it.
  const gateMessage = (scope, sid, me, text, exempt) => {
    const cfg = installedBots(scope, sid).sentinel;
    if (!cfg || exempt || !text) return;
    let reason = automod(cfg, text);
    if (!reason && cfg.spam) {
      const key = `${scope}:${sid}:${me.id}`;
      const now = Date.now();
      const log = (spamLog.get(key) ?? []).filter((t) => now - t < 6000);
      log.push(now); spamLog.set(key, log);
      if (log.length > 5) reason = 'slow down, that looks like spam';
    }
    if (!reason) return;
    if (scope === 'community') {
      logMod(Number(sid), { id: botId.sentinel }, 'sentinel-block', me.username, reason);
      const hits = (spamLog.get(`hits:${sid}:${me.id}`) ?? []).filter((t) => Date.now() - t < 60000);
      hits.push(Date.now()); spamLog.set(`hits:${sid}:${me.id}`, hits);
      if (hits.length >= 4) {
        db.prepare('UPDATE community_members SET timeout_until = ? WHERE community_id = ? AND user_id = ?').run(Date.now() + 120000, Number(sid), me.id);
        logMod(Number(sid), { id: botId.sentinel }, 'sentinel-timeout', me.username, '2 minutes for repeated blocked messages');
        throw new HttpError(403, 'Sentinel timed you out for 2 minutes after repeated blocked messages.');
      }
    }
    throw new HttpError(422, `Sentinel blocked your message: ${reason}.`);
  };
  // Run after a message is stored: bot commands.
  const afterMessage = (scope, sid, target, me, text) => {
    const bots = installedBots(scope, sid);
    const cmd = text && me.id !== botId.funbot ? parseCommand(text) : null;
    if (!cmd || !bots[cmd.bot]) return;
    if (cmd.bot === 'jukebox') return musicCommand(scope, sid, target, me, cmd.cmd, cmd.args);
    const out = funCommand(cmd.cmd, cmd.args, { user: me.display_name, trivia: trivia.get(`${scope}:${sid}`), setTrivia: (t) => (t ? trivia.set(`${scope}:${sid}`, t) : trivia.delete(`${scope}:${sid}`)) });
    if (out) botSay(target, 'funbot', out.text, out.kind ? { kind: out.kind, meta: out.meta } : undefined);
  };
  const generalChannel = (cid) => db.prepare("SELECT * FROM channels WHERE community_id = ? AND kind = 'text' AND private = 0 ORDER BY position, id LIMIT 1").get(Number(cid));
  const greetTarget = (scope, sid) => (scope === 'group' ? { scope, id: Number(sid) } : (() => { const ch = generalChannel(sid); return ch && { scope, id: ch.id, ch }; })());
  const fillTemplate = (tpl, scope, sid, u) => {
    const name = scope === 'group' ? db.prepare('SELECT name FROM groups WHERE id = ?').get(sid)?.name : db.prepare('SELECT name FROM communities WHERE id = ?').get(sid)?.name;
    return tpl.replaceAll('{user}', u.display_name).replaceAll('{name}', name ?? '');
  };
  hooks.onJoin = (scope, sid, uid) => {
    const cfg = installedBots(scope, sid).greeter;
    const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid);
    const target = cfg?.welcome && u && greetTarget(scope, sid);
    if (target) botSay(target, 'greeter', fillTemplate(cfg.welcome, scope, sid, u));
  };
  hooks.onLeave = (scope, sid, uid) => {
    const cfg = installedBots(scope, sid).greeter;
    const u = db.prepare('SELECT display_name FROM users WHERE id = ?').get(uid);
    const target = cfg?.farewell && u && greetTarget(scope, sid);
    if (target) botSay(target, 'greeter', fillTemplate(cfg.farewell, scope, sid, u));
  };
  const botScope = (me, scope, id) => {
    if (scope === 'community') { needRole(needCMember(me, id), 'admin'); return { scope, id: Number(id) }; }
    if (scope === 'group') { needAdmin(me, id); return { scope, id: Number(id) }; }
    throw new HttpError(400, 'Unknown scope.');
  };

    const countOf = (sql, ...args) => db.prepare(sql).get(...args).n;

  const RANK = { member: 0, moderator: 1, admin: 2, owner: 3 };
  const tx = (fn) => {
    db.exec('BEGIN');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  const ALL_PERMS = ['channels', 'invites', 'kick', 'timeout', 'delete_messages', 'log'];
  const BASE_PERMS = { member: [], moderator: ['kick', 'timeout', 'delete_messages', 'log'], admin: [...ALL_PERMS, 'ban', 'roles'], owner: [...ALL_PERMS, 'ban', 'roles'] };
  const loadMember = (cid, uid) => {
    const m = db.prepare(`SELECT cm.role, cm.timeout_until AS timeoutUntil, r.perms FROM community_members cm
      LEFT JOIN community_roles r ON r.id = cm.custom_role_id WHERE cm.community_id = ? AND cm.user_id = ?`).get(Number(cid), uid);
    return m && { ...m, perms: m.perms ? JSON.parse(m.perms) : [] };
  };
  const rankOf = (m) => Math.max(RANK[m.role], m.perms.length ? 1 : 0);
  const permsOf = (m) => [...new Set([...BASE_PERMS[m.role], ...m.perms])];
  const can = (m, perm) => permsOf(m).includes(perm);
  const needPerm = (m, perm) => { if (!can(m, perm)) throw new HttpError(403, 'You do not have permission to do that.'); };
  const needCMember = (me, cid) => {
    const m = loadMember(cid, me.id);
    if (!m) throw new HttpError(404, 'No such community');
    return m;
  };
  const needRole = (m, min) => {
    if (RANK[m.role] < RANK[min]) throw new HttpError(403, `Only ${min}s and above can do that.`);
  };
  const channelAccess = (me, channelId) => {
    const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(channelId));
    if (!ch) throw new HttpError(404, 'No such channel');
    const m = needCMember(me, ch.community_id);
    if (ch.private && RANK[m.role] < 1) throw new HttpError(404, 'No such channel');
    return { ch, m };
  };
  const canPost = (ch, m) => ch.kind !== 'voice' && (!(ch.read_only || ch.kind === 'announcement') || RANK[m.role] >= RANK.admin);
  const pushChannel = (ch, event, data) => {
    for (const r of db.prepare('SELECT user_id, role FROM community_members WHERE community_id = ?').all(ch.community_id))
      if ((!ch.private || RANK[r.role] >= 1) && !(event === 'channel-message' && ignoredBy(r.user_id, data.from))) push(r.user_id, event, data);
  };
  const pushCommunity = (cid, extra = []) => {
    for (const { user_id } of db.prepare('SELECT user_id FROM community_members WHERE community_id = ?').all(cid)) push(user_id, 'community', { id: cid });
    extra.forEach((uid) => push(uid, 'community', { id: cid }));
  };
  const logMod = (cid, actor, action, target, detail) =>
    db.prepare('INSERT INTO mod_log (community_id, actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(cid, actor.id, action, target ?? null, detail ?? null, Date.now());
  const lowerRanked = (me, m, cid, username) => {
    const user = userNamed(username);
    const target = loadMember(cid, user.id);
    if (!target) throw new HttpError(404, 'That person is not in this community.');
    if (user.id === me.id) throw new HttpError(400, 'You cannot do that to yourself.');
    if (rankOf(target) >= rankOf(m)) throw new HttpError(403, 'You cannot act on someone of equal or higher rank.');
    return user;
  };
  const joinCommunity = (cid, uid) => {
    const added = db.prepare('INSERT OR IGNORE INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(cid, uid, 'member', Date.now()).changes;
    if (added) hooks.onJoin?.('community', cid, uid);
  };
  const reasonOf = (v) => String(v ?? '').trim().slice(0, 200);

  const aesKey = aiKeySecret && aiKeySecret.length >= 32 ? crypto.scryptSync(aiKeySecret, 'scrxaper-ai-v1', 32) : null;
  const encryptKey = (plain) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  };
  const decryptKey = (stored) => {
    try {
      const raw = Buffer.from(stored, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch { throw new HttpError(400, 'Your stored key can no longer be read. Please enter it again.'); }
  };
  const needHuman = (me) => { if (me.is_bot) throw new HttpError(403, 'Not available to bots.'); };
  const userAi = (me) => {
    needHuman(me);
    const row = db.prepare('SELECT key_enc, model, personality FROM ai_settings WHERE user_id = ?').get(me.id);
    if (!row?.key_enc || !aesKey) throw new HttpError(400, 'Add your Groq API key first.');
    return { key: decryptKey(row.key_enc), model: row.model, personality: row.personality };
  };
  const groq = async (key, route, body) => {
    let res;
    try {
      res = await fetch(`${groqBase}${route}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    } catch { throw new HttpError(502, 'Could not reach the AI provider.'); }
    if (res.status === 401) throw new HttpError(400, 'Groq rejected that API key.');
    if (res.status === 404) throw new HttpError(400, 'That model is not available.');
    if (res.status === 429) throw new HttpError(429, 'Groq rate limit or quota reached. Try again later.');
    if (!res.ok) throw new HttpError(502, 'The AI provider had a problem. Try again.');
    return res.json();
  };
  const ownConversation = (me, id) => {
    const conv = db.prepare('SELECT id, title FROM ai_conversations WHERE id = ? AND user_id = ?').get(Number(id), me.id);
    if (!conv) throw new HttpError(404, 'No such conversation');
    return conv;
  };
  const privacyOf = (uid) => {
    prefsOf(uid);
    const p = db.prepare('SELECT who_can_message AS whoCanMessage, previews, dnd FROM profiles WHERE user_id = ?').get(uid);
    return { whoCanMessage: p.whoCanMessage, previews: !!p.previews, dnd: !!p.dnd };
  };
  const canMessage = (senderId, peerId) => {
    const rule = privacyOf(peerId).whoCanMessage;
    if (rule === 'everyone' || areFriends(senderId, peerId)) return true;
    if (db.prepare('SELECT 1 FROM messages WHERE sender_id = ? AND recipient_id = ?').get(peerId, senderId)) return true;
    if (rule === 'nobody' || rule === 'friends') return false;
    return !!(db.prepare('SELECT 1 FROM group_members a JOIN group_members b ON a.group_id = b.group_id WHERE a.user_id = ? AND b.user_id = ?').get(senderId, peerId)
      || db.prepare('SELECT 1 FROM community_members a JOIN community_members b ON a.community_id = b.community_id WHERE a.user_id = ? AND b.user_id = ?').get(senderId, peerId));
  };
  const likePattern = (q) => `%${q.replace(/[!%_]/g, '!$&')}%`;
  const prefsOf = (uid) => {
    db.prepare('INSERT OR IGNORE INTO profiles (user_id) VALUES (?)').run(uid);
    const p = db.prepare('SELECT theme, accent, density, reduce_motion AS reduceMotion, plain, custom, viz_style AS vizStyle, viz_color AS vizColor, onboarded, private, interests FROM profiles WHERE user_id = ?').get(uid);
    return { ...p, reduceMotion: !!p.reduceMotion, plain: !!p.plain, onboarded: !!p.onboarded, private: !!p.private, custom: JSON.parse(p.custom || '{}'), interests: JSON.parse(p.interests || '[]') };
  };
  const balanceOf = (uid) => countOf('SELECT COALESCE(SUM(delta), 0) AS n FROM sparks_ledger WHERE user_id = ?', uid);
  const award = (uid, delta, reason, ref) =>
    db.prepare('INSERT OR IGNORE INTO sparks_ledger (user_id, delta, reason, ref, at) VALUES (?, ?, ?, ?, ?)').run(uid, delta, reason, ref, Date.now()).changes === 1;
  const itemNamed = (id) => {
    const item = db.prepare('SELECT * FROM items WHERE id = ? AND active = 1').get(String(id ?? ''));
    if (!item) throw new HttpError(404, 'No such item');
    return item;
  };

  const avatarOf = (uid) => db.prepare('SELECT avatar_id AS id FROM profiles WHERE user_id = ?').get(uid)?.id ?? null;
  const ignoredBy = (uid, username) => !!db.prepare('SELECT 1 FROM ignores i JOIN users u ON u.id = i.ignored_id WHERE i.user_id = ? AND u.username = ?').get(uid, username);
  const callTimers = new Map();
  const callOf = (me, id) => {
    const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(Number(id));
    if (!c || (c.caller_id !== me.id && c.callee_id !== me.id)) throw new HttpError(404, 'No such call');
    return c;
  };
  const inCall = (uid) => !!db.prepare("SELECT 1 FROM calls WHERE state != 'ended' AND (caller_id = ? OR callee_id = ?) AND created_at > ?").get(uid, uid, Date.now() - 4 * 3600e3);
  // Ring pulse: repeat the call notification while the call rings, so a closed app or locked phone keeps sounding the system
  // notification tone and vibration like a real ring (a web push cannot carry custom audio).
  const ringPulses = new Map();
  const stopPulse = (id) => { clearInterval(ringPulses.get(id)); ringPulses.delete(id); };
  const startPulse = (id, uid, payload) => {
    let n = 0;
    const t = setInterval(() => {
      const c = db.prepare('SELECT state FROM calls WHERE id = ?').get(id);
      if (c?.state !== 'ringing' || ++n > 8) return stopPulse(id);
      pushNotify(uid, payload, { ttl: 8, urgency: 'high' });
    }, ringPulseMs);
    t.unref(); ringPulses.set(id, t);
  };
  const finishCall = (c, reason) => {
    stopPulse(c.id);
    clearTimeout(callTimers.get(c.id));
    callTimers.delete(c.id);
    const now = Date.now();
    db.prepare("UPDATE calls SET state = 'ended', reason = ?, ended_at = ? WHERE id = ? AND state != 'ended'").run(reason, now, c.id);
    const secs = c.answered_at ? Math.round((now - c.answered_at) / 1000) : 0;
    const text = c.answered_at ? `Call ended · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
      : { missed: 'Missed call', declined: 'Call declined' }[reason] ?? 'Call cancelled';
    const id = Number(db.prepare("INSERT INTO messages (sender_id, recipient_id, body, created_at, kind) VALUES (?, ?, ?, ?, 'call')").run(c.caller_id, c.callee_id, text, now).lastInsertRowid);
    const [from, to] = [c.caller_id, c.callee_id].map((uid) => db.prepare('SELECT username FROM users WHERE id = ?').get(uid).username);
    push(c.callee_id, 'message', { id, from, body: text, at: now, kind: 'call' });
    push(c.caller_id, 'message', { id, from, to, body: text, at: now, kind: 'call' });
    for (const uid of [c.caller_id, c.callee_id]) push(uid, 'call', { type: 'ended', id: c.id, reason });
    if (!c.answered_at) pushNotify(c.callee_id, { t: 'callend', id: c.id, from, name: db.prepare('SELECT display_name FROM users WHERE id = ?').get(c.caller_id).display_name, missed: reason === 'missed' || reason === 'cancelled', tag: 'call' }, { ttl: 60 });
  };
  const attachmentOf = (me, id) => {
    if (!id) return null;
    if (!db.prepare("SELECT 1 FROM uploads WHERE id = ? AND user_id = ? AND kind = 'attachment'").get(String(id), me.id)) throw new HttpError(400, 'That attachment is not available.');
    return String(id);
  };
  const canSeeAttachment = (me, id, ownerId) => ownerId === me.id
    || !!db.prepare('SELECT 1 FROM messages WHERE attachment_id = ? AND (sender_id = ? OR recipient_id = ?)').get(id, me.id, me.id)
    || !!db.prepare('SELECT 1 FROM group_messages x JOIN group_members gm ON gm.group_id = x.group_id AND gm.user_id = ? WHERE x.attachment_id = ?').get(me.id, id)
    || db.prepare('SELECT channel_id FROM channel_messages WHERE attachment_id = ?').all(id).some(({ channel_id: cid }) => {
      try { channelAccess(me, cid); return true; } catch { return false; }
    });
  const hiddenFrom = (uid) => `AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ${Number(uid)} AND b.blocked_id = p.user_id) OR (b.blocker_id = p.user_id AND b.blocked_id = ${Number(uid)}))
    AND p.user_id NOT IN (SELECT ignored_id FROM ignores WHERE user_id = ${Number(uid)})
    AND (p.user_id = ${Number(uid)} OR COALESCE((SELECT private FROM profiles pr WHERE pr.user_id = p.user_id), 0) = 0
      OR EXISTS (SELECT 1 FROM follows fl WHERE fl.follower_id = ${Number(uid)} AND fl.followee_id = p.user_id))`;
  const canView = (me, id, file) => {
    if (file.owner === me.id) return true;
    if (file.kind === 'attachment') return canSeeAttachment(me, id, file.owner);
    if (file.kind === 'wallpaper') return false;
    if (file.kind === 'track') {
      const t = db.prepare('SELECT scope, scope_id FROM bot_tracks WHERE upload_id = ?').get(id);
      return !!t && scopeMembers(t.scope, t.scope_id).includes(me.id);
    }
    if (file.kind === 'sound') {
      return !!db.prepare(`SELECT 1 FROM posts p WHERE p.music_id = ? ${hiddenFrom(me.id)}`).get(id)
        || !!db.prepare(`SELECT 1 FROM stories p WHERE p.music_id = ? AND p.expires_at > ? ${hiddenFrom(me.id)}`).get(id, Date.now());
    }
    if (file.kind === 'post' || file.kind === 'reel') return !!db.prepare(`SELECT 1 FROM posts p WHERE p.media_id = ? ${hiddenFrom(me.id)}`).get(id);
    if (file.kind === 'story') return !!db.prepare(`SELECT 1 FROM stories p WHERE p.media_id = ? AND p.expires_at > ? ${hiddenFrom(me.id)}`).get(id, Date.now());
    return true;
  };
  const TONES = ['chime', 'drop', 'pluck', 'none', 'ring', 'soft', 'pulse', 'ringback', 'ringback_soft', 'ringback_beep', 'ringback_melody'];
  const toneValid = (me, tone) => TONES.includes(tone)
    || (/^custom:[a-f0-9]{32}$/.test(String(tone)) && !!db.prepare("SELECT 1 FROM uploads WHERE id = ? AND user_id = ? AND kind = 'sound'").get(String(tone).slice(7), me.id));
  const soundOf = (uid) => {
    prefsOf(uid);
    return { ...db.prepare('SELECT tone, ring_tone AS ringtone, calling_tune AS callingTune, volume FROM profiles WHERE user_id = ?').get(uid), overrides: db.prepare('SELECT kind, target, tone FROM tones WHERE user_id = ?').all(uid) };
  };
  const postSelect = (uid) => `SELECT p.id, p.kind, p.media_id AS media, p.caption, p.created_at AS at, p.edited_at AS editedAt, p.music_id AS musicId, p.music_title AS musicTitle, p.music_start AS musicStart, p.music_mute AS musicMute, u.username, u.display_name AS name,
    (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) AS likes,
    (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) AS comments, EXISTS (SELECT 1 FROM post_likes WHERE post_id = p.id AND user_id = ${Number(uid)}) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id`;
  const shapePost = (r) => ({ ...r, liked: !!r.liked });
  const visiblePost = (me, id) => {
    const row = db.prepare(`${postSelect(me.id)} WHERE p.id = ? ${hiddenFrom(me.id)}`).get(Number(id));
    if (!row) throw new HttpError(404, 'No such post');
    return shapePost(row);
  };
  const readBytes = (req, max) => new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > max) { req.resume(); return reject(new HttpError(413, 'That file is too large.')); }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new HttpError(413, 'That file is too large.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const routes = {
    'POST /api/communities': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot create communities.');
      const { name, description } = await readJson(req);
      const title = String(name ?? '').trim().slice(0, 60);
      if (!title) throw new HttpError(400, 'Give the community a name.');
      if (countOf("SELECT COUNT(*) AS n FROM community_members WHERE user_id = ? AND role = 'owner'", me.id) >= 10) throw new HttpError(409, 'You can own up to 10 communities.');
      const id = tx(() => {
        const cid = Number(db.prepare('INSERT INTO communities (name, description, created_at) VALUES (?, ?, ?)').run(title, String(description ?? '').trim().slice(0, 300), Date.now()).lastInsertRowid);
        db.prepare("INSERT INTO community_members (community_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)").run(cid, me.id, Date.now());
        db.prepare("INSERT INTO channels (community_id, name, kind, position) VALUES (?, 'general', 'text', 0)").run(cid);
        db.prepare("INSERT INTO channels (community_id, name, kind, read_only, position) VALUES (?, 'announcements', 'announcement', 1, 1)").run(cid);
        return cid;
      });
      sendJson(res, 201, { id });
    },

    'GET /api/community': (req, res, me, url) => {
      const id = Number(url.searchParams.get('id'));
      const m = needCMember(me, id);
      sendJson(res, 200, {
        role: m.role, myPerms: permsOf(m),
        roles: db.prepare('SELECT id, name, color, perms FROM community_roles WHERE community_id = ? ORDER BY id').all(id).map((r) => ({ ...r, perms: JSON.parse(r.perms) })),
        community: db.prepare('SELECT id, name, description, public, icon_id AS icon FROM communities WHERE id = ?').get(id),
        channels: db.prepare('SELECT id, name, kind, topic, read_only AS readOnly, private FROM channels WHERE community_id = ? AND (private = 0 OR ?) ORDER BY position, id').all(id, RANK[m.role] >= 1 ? 1 : 0),
        bots: Object.keys(installedBots('community', id)),
        members: db.prepare(`SELECT u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, u.is_owner, u.site_role, cm.role, r.name AS customRole, cm.timeout_until > ? AS timedOut FROM community_members cm
          JOIN users u ON u.id = cm.user_id LEFT JOIN community_roles r ON r.id = cm.custom_role_id WHERE cm.community_id = ? ORDER BY u.username`).all(Date.now(), id)
          .map((r) => { const { is_owner, site_role, ...rest } = r; return { ...rest, tag: tagOf({ is_owner, site_role }), timedOut: !!r.timedOut }; }).sort((a, b) => RANK[b.role] - RANK[a.role]),
      });
    },

    'POST /api/channels': async (req, res, me) => {
      const { community, name, kind = 'text', topic = '', readOnly = false, private: isPrivate = false } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'channels');
      const slug = String(name ?? '').toLowerCase().trim().replace(/\s+/g, '-');
      if (!/^[a-z0-9-]{1,30}$/.test(slug)) throw new HttpError(400, 'Channel names use letters, numbers and dashes (up to 30).');
      if (!['text', 'announcement', 'voice'].includes(kind)) throw new HttpError(400, 'Unknown channel type.');
      if (countOf('SELECT COUNT(*) AS n FROM channels WHERE community_id = ?', community) >= 50) throw new HttpError(409, 'Channel limit reached.');
      try {
        const id = Number(db.prepare('INSERT INTO channels (community_id, name, kind, topic, read_only, private, position) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM channels WHERE community_id = ?))')
          .run(community, slug, kind, String(topic).slice(0, 200), readOnly ? 1 : 0, isPrivate ? 1 : 0, community).lastInsertRowid);
        logMod(community, me, 'create-channel', slug);
        pushCommunity(Number(community));
        sendJson(res, 201, { id });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'A channel with that name exists.');
        throw err;
      }
    },

    'POST /api/channel-message-delete': async (req, res, me) => {
      const { channel, id } = await readJson(req);
      const { ch, m } = channelAccess(me, channel);
      const msg = db.prepare('SELECT sender_id FROM channel_messages WHERE id = ? AND channel_id = ?').get(Number(id), ch.id);
      if (!msg) throw new HttpError(404, 'No such message');
      if (msg.sender_id !== me.id) { needPerm(m, 'delete_messages'); logMod(ch.community_id, me, 'delete-message', `#${ch.name}`, `message ${id}`); }
      db.prepare('DELETE FROM channel_messages WHERE id = ?').run(Number(id));
      pushChannel(ch, 'channel-delete', { channel: ch.id, id: Number(id) });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-invite': async (req, res, me) => {
      const { community } = await readJson(req);
      needPerm(needCMember(me, community), 'invites');
      const code = crypto.randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO community_invites (token_hash, community_id, expires_at) VALUES (?, ?, ?)').run(sha(code), Number(community), Date.now() + 7 * 864e5);
      sendJson(res, 201, { code, expiresInDays: 7 });
    },

    'POST /api/community-join': async (req, res, me) => {
      const { code } = await readJson(req);
      const invite = db.prepare('SELECT community_id FROM community_invites WHERE token_hash = ? AND expires_at > ?').get(sha(String(code ?? '')), Date.now());
      if (!invite || me.is_bot) throw new HttpError(404, 'That invite is invalid or expired.');
      if (db.prepare('SELECT 1 FROM community_bans WHERE community_id = ? AND user_id = ?').get(invite.community_id, me.id)) throw new HttpError(403, 'You cannot join this community.');
      joinCommunity(invite.community_id, me.id);
      pushCommunity(invite.community_id);
      sendJson(res, 200, { id: invite.community_id });
    },

    'POST /api/community-role': async (req, res, me) => {
      const { community, username, role } = await readJson(req);
      const m = needCMember(me, community);
      needRole(m, 'admin');
      if (!['member', 'moderator', 'admin'].includes(role) || RANK[role] >= RANK[m.role]) throw new HttpError(403, 'You can only grant roles below your own.');
      const user = lowerRanked(me, m, Number(community), username);
      db.prepare('UPDATE community_members SET role = ? WHERE community_id = ? AND user_id = ?').run(role, Number(community), user.id);
      logMod(community, me, 'set-role', user.username, role);
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-kick': async (req, res, me) => {
      const { community, username, reason } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'kick');
      const user = lowerRanked(me, m, Number(community), username);
      db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(community), user.id);
      logMod(community, me, 'kick', user.username, reasonOf(reason));
      pushCommunity(Number(community), [user.id]);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-ban': async (req, res, me) => {
      const { community, username, reason } = await readJson(req);
      const m = needCMember(me, community);
      needRole(m, 'admin');
      const user = lowerRanked(me, m, Number(community), username);
      tx(() => {
        db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(community), user.id);
        db.prepare('INSERT OR REPLACE INTO community_bans (community_id, user_id, reason, at) VALUES (?, ?, ?, ?)').run(Number(community), user.id, reasonOf(reason), Date.now());
      });
      logMod(community, me, 'ban', user.username, reasonOf(reason));
      pushCommunity(Number(community), [user.id]);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-unban': async (req, res, me) => {
      const { community, username } = await readJson(req);
      needRole(needCMember(me, community), 'admin');
      const user = userNamed(username);
      db.prepare('DELETE FROM community_bans WHERE community_id = ? AND user_id = ?').run(Number(community), user.id);
      logMod(community, me, 'unban', user.username);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-timeout': async (req, res, me) => {
      const { community, username, minutes, reason } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'timeout');
      const mins = Math.min(Math.max(Number(minutes) || 0, 0), 10080);
      const user = lowerRanked(me, m, Number(community), username);
      db.prepare('UPDATE community_members SET timeout_until = ? WHERE community_id = ? AND user_id = ?').run(mins ? Date.now() + mins * 60000 : 0, Number(community), user.id);
      logMod(community, me, mins ? 'timeout' : 'clear-timeout', user.username, mins ? `${mins} min. ${reasonOf(reason)}` : '');
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-leave': async (req, res, me) => {
      const { community } = await readJson(req);
      if (needCMember(me, community).role === 'owner') throw new HttpError(400, 'Owners cannot leave. Delete the community instead.');
      db.prepare('DELETE FROM community_members WHERE community_id = ? AND user_id = ?').run(Number(community), me.id);
      pushCommunity(Number(community), [me.id]);
      hooks.onLeave?.('community', Number(community), me.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-delete': async (req, res, me) => {
      const { community } = await readJson(req);
      if (needCMember(me, community).role !== 'owner') throw new HttpError(403, 'Only the owner can delete a community.');
      const ids = db.prepare('SELECT user_id FROM community_members WHERE community_id = ?').all(Number(community)).map((r) => r.user_id);
      db.prepare('DELETE FROM communities WHERE id = ?').run(Number(community));
      ids.forEach((uid) => push(uid, 'community', { id: Number(community) }));
      sendJson(res, 200, { ok: true });
    },

    'GET /api/community-log': (req, res, me, url) => {
      const id = Number(url.searchParams.get('id'));
      needPerm(needCMember(me, id), 'log');
      sendJson(res, 200, db.prepare(`SELECT l.action, l.target, l.detail, l.at, u.username AS actor FROM mod_log l JOIN users u ON u.id = l.actor_id
        WHERE l.community_id = ? ORDER BY l.id DESC LIMIT 50`).all(id));
    },

    'POST /api/upload/delete': async (req, res, me) => {
      const { kind } = await readJson(req);
      if (!['avatar', 'banner'].includes(kind)) throw new HttpError(400, 'Unknown upload type.');
      const column = kind === 'avatar' ? 'avatar_id' : 'banner_id';
      prefsOf(me.id);
      const previous = db.prepare(`SELECT ${column} AS id FROM profiles WHERE user_id = ?`).get(me.id).id;
      db.prepare(`UPDATE profiles SET ${column} = NULL WHERE user_id = ?`).run(me.id);
      removeFile(previous);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/account/delete': async (req, res, me) => {
      if (me.is_bot || me.is_owner || me.site_role === 'admin') throw new HttpError(403, 'This account cannot be deleted here.');
      const { password } = await readJson(req);
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(me.id);
      if (typeof password !== 'string' || !checkPassword(password, row.password_hash)) throw new HttpError(403, 'Wrong password.');
      if (countOf("SELECT COUNT(*) AS n FROM community_members WHERE user_id = ? AND role = 'owner'", me.id)) throw new HttpError(409, 'Delete the communities you own first.');
      const files = db.prepare('SELECT id FROM uploads WHERE user_id = ?').all(me.id);
      tx(() => {
        for (const { group_id: gid } of db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(me.id)) {
          db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, me.id);
          const next = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1').get(gid);
          if (!next) db.prepare('DELETE FROM groups WHERE id = ?').run(gid);
          else if (!db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND role = 'admin'").get(gid))
            db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(gid, next.user_id);
        }
        db.prepare('UPDATE groups SET created_by = ? WHERE created_by = ?').run(teamsId, me.id);
        db.prepare('DELETE FROM users WHERE id = ?').run(me.id);
      });
      files.forEach(({ id }) => rmSync(path.join(uploadDir, id), { force: true }));
      for (const stream of streams.get(me.id) ?? []) stream.end();
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    },

    'GET /api/ai/settings': (req, res, me) => {
      needHuman(me);
      const row = db.prepare('SELECT key_enc, model, personality FROM ai_settings WHERE user_id = ?').get(me.id);
      sendJson(res, 200, { available: !!aesKey, hasKey: !!row?.key_enc, model: row?.model ?? 'openai/gpt-oss-120b', personality: row?.personality ?? '' });
    },

    'POST /api/ai/settings': async (req, res, me) => {
      needHuman(me);
      const { apiKey, model, personality } = await readJson(req);
      if (!aesKey) throw new HttpError(503, 'AI key storage is not configured on this server.');
      const name = String(model ?? '').trim();
      if (!/^[\w./:-]{1,100}$/.test(name)) throw new HttpError(400, 'Enter a model name.');
      let enc = db.prepare('SELECT key_enc FROM ai_settings WHERE user_id = ?').get(me.id)?.key_enc ?? null;
      if (apiKey) {
        const k = String(apiKey).trim();
        if (!/^\S{20,300}$/.test(k)) throw new HttpError(400, 'That does not look like an API key.');
        enc = encryptKey(k);
      }
      if (!enc) throw new HttpError(400, 'Add your Groq API key first.');
      db.prepare(`INSERT INTO ai_settings (user_id, key_enc, model, personality) VALUES (?, ?, ?, ?)
        ON CONFLICT (user_id) DO UPDATE SET key_enc = excluded.key_enc, model = excluded.model, personality = excluded.personality`)
        .run(me.id, enc, name, String(personality ?? '').trim().slice(0, 500));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/key/delete': (req, res, me) => {
      needHuman(me);
      db.prepare('UPDATE ai_settings SET key_enc = NULL WHERE user_id = ?').run(me.id);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/ai/models': async (req, res, me) => {
      const { key } = userAi(me);
      sendJson(res, 200, (await groq(key, '/models')).data.map((m) => m.id).sort());
    },

    'POST /api/ai/test': async (req, res, me) => {
      const { key, model } = userAi(me);
      const ids = (await groq(key, '/models')).data.map((m) => m.id);
      if (!ids.includes(model)) throw new HttpError(400, `The model ${model} is not available for this key.`);
      sendJson(res, 200, { ok: true, model });
    },

    'GET /api/ai/conversations': (req, res, me) => sendJson(res, 200,
      db.prepare('SELECT id, title FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').all(me.id)),

    'GET /api/ai/messages': (req, res, me, url) => {
      const conv = ownConversation(me, url.searchParams.get('conversation'));
      sendJson(res, 200, { conversation: conv, messages: db.prepare('SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id').all(conv.id) });
    },

    'POST /api/ai/rename': async (req, res, me) => {
      const { conversation, title } = await readJson(req);
      const conv = ownConversation(me, conversation);
      const t = String(title ?? '').trim().slice(0, 60);
      if (!t) throw new HttpError(400, 'Give the conversation a title.');
      db.prepare('UPDATE ai_conversations SET title = ? WHERE id = ?').run(t, conv.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/clear': async (req, res, me) => {
      db.prepare('DELETE FROM ai_messages WHERE conversation_id = ?').run(ownConversation(me, (await readJson(req)).conversation).id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/delete': async (req, res, me) => {
      db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(ownConversation(me, (await readJson(req)).conversation).id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/delete-all': (req, res, me) => {
      needHuman(me);
      db.prepare('DELETE FROM ai_conversations WHERE user_id = ?').run(me.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ai/chat': async (req, res, me) => {
      const { conversation, text, localTime } = await readJson(req);
      const message = String(text ?? '').trim();
      if (!message || message.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      const { key, model, personality } = userAi(me);
      if (limited(`ai:${me.id}`, 30, 60000)) throw new HttpError(429, 'Slow down a little.');
      const existing = conversation ? ownConversation(me, conversation) : null;
      const now = Date.now();
      const convId = existing?.id ?? Number(db.prepare('INSERT INTO ai_conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(me.id, message.slice(0, 40), now, now).lastInsertRowid);
      const userMsg = Number(db.prepare("INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(convId, message, now).lastInsertRowid);
      const history = db.prepare('SELECT role, content FROM ai_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20').all(convId).reverse();
      const system = 'You are Scrxaper Buddy, a small friendly flower-cloud creature inside the Scrxaper messaging app. Be warm, concise and honest. '
        + 'Do not claim to know anything about the user that they have not told you in this chat.'
        + (personality ? ` The user asked for this personality: ${personality}` : '')
        + (localTime ? ` The user's local time is ${String(localTime).slice(0, 40)}.` : '');
      try {
        const data = await groq(key, '/chat/completions', { model, messages: [{ role: 'system', content: system }, ...history] });
        const reply = String(data.choices?.[0]?.message?.content ?? '').slice(0, 20000);
        if (!reply) throw new HttpError(502, 'The AI provider returned an empty reply.');
        db.prepare("INSERT INTO ai_messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").run(convId, reply, Date.now());
        db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), convId);
        sendJson(res, 200, { conversation: convId, reply });
      } catch (err) {
        db.prepare('DELETE FROM ai_messages WHERE id = ?').run(userMsg);
        if (!existing) db.prepare('DELETE FROM ai_conversations WHERE id = ?').run(convId);
        throw err;
      }
    },

    'GET /api/feed': (req, res, me, url) => {
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      sendJson(res, 200, db.prepare(`${postSelect(me.id)} WHERE p.id < ? AND (p.user_id = ? OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)) ${hiddenFrom(me.id)} ORDER BY p.id DESC LIMIT 20`)
        .all(before, me.id, me.id).map(shapePost));
    },

    'GET /api/reels': (req, res, me, url) => {
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      sendJson(res, 200, db.prepare(`${postSelect(me.id)} WHERE p.kind = 'reel' AND p.id < ? ${hiddenFrom(me.id)} ORDER BY p.id DESC LIMIT 10`).all(before).map(shapePost));
    },

    'GET /api/user-posts': (req, res, me, url) => {
      const user = userNamed(url.searchParams.get('user'));
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      sendJson(res, 200, db.prepare(`${postSelect(me.id)} WHERE p.user_id = ? AND p.id < ? ${hiddenFrom(me.id)} ORDER BY p.id DESC LIMIT 30`).all(user.id, before).map(shapePost));
    },

    'GET /api/post': (req, res, me, url) => {
      const post = visiblePost(me, url.searchParams.get('id'));
      sendJson(res, 200, { ...post, comments: db.prepare(`SELECT c.id, c.body, c.created_at AS at, u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar
        FROM post_comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? AND c.user_id NOT IN (SELECT ignored_id FROM ignores WHERE user_id = ?) ORDER BY c.id LIMIT 100`).all(post.id, me.id) });
    },

    'POST /api/posts/delete': async (req, res, me) => {
      const row = db.prepare('SELECT id, media_id FROM posts WHERE id = ? AND user_id = ?').get(Number((await readJson(req)).post), me.id);
      if (!row) throw new HttpError(404, 'No such post');
      db.prepare('DELETE FROM posts WHERE id = ?').run(row.id);
      removeFile(row.media_id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/posts/comment-delete': async (req, res, me) => {
      const c = db.prepare('SELECT c.id, c.user_id, p.user_id AS owner FROM post_comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?').get(Number((await readJson(req)).comment));
      if (!c || (c.user_id !== me.id && c.owner !== me.id)) throw new HttpError(404, 'No such comment');
      db.prepare('DELETE FROM post_comments WHERE id = ?').run(c.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/stories/view': async (req, res, me) => {
      const row = db.prepare(`SELECT p.id, p.user_id FROM stories p WHERE p.id = ? AND p.expires_at > ? ${hiddenFrom(me.id)}`).get(Number((await readJson(req)).story), Date.now());
      if (!row) throw new HttpError(404, 'No such story');
      if (row.user_id !== me.id) db.prepare('INSERT OR IGNORE INTO story_views (story_id, user_id, at) VALUES (?, ?, ?)').run(row.id, me.id, Date.now());
      sendJson(res, 200, { ok: true });
    },

    'GET /api/stories/viewers': (req, res, me, url) => {
      const id = Number(url.searchParams.get('story'));
      if (!db.prepare('SELECT 1 FROM stories WHERE id = ? AND user_id = ?').get(id, me.id)) throw new HttpError(404, 'No such story');
      sendJson(res, 200, db.prepare('SELECT u.username, u.display_name AS name, v.at FROM story_views v JOIN users u ON u.id = v.user_id WHERE v.story_id = ? ORDER BY v.at DESC LIMIT 200').all(id));
    },

    'POST /api/stories/delete': async (req, res, me) => {
      const row = db.prepare('SELECT id, media_id FROM stories WHERE id = ? AND user_id = ?').get(Number((await readJson(req)).story), me.id);
      if (!row) throw new HttpError(404, 'No such story');
      db.prepare('DELETE FROM stories WHERE id = ?').run(row.id);
      removeFile(row.media_id);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/discover': (req, res, me, url) => {
      const p = likePattern(String(url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 50));
      const list = (table, memberTable, key) => db.prepare(`SELECT t.id, t.name, t.description, t.icon_id AS icon,
        (SELECT COUNT(*) FROM ${memberTable} WHERE ${key} = t.id) AS members,
        EXISTS (SELECT 1 FROM ${memberTable} WHERE ${key} = t.id AND user_id = ?) AS joined
        FROM ${table} t WHERE t.public = 1 AND (t.name LIKE ? ESCAPE '!' OR t.description LIKE ? ESCAPE '!') ORDER BY members DESC, t.id DESC LIMIT 30`)
        .all(me.id, p, p).map((r) => ({ ...r, joined: !!r.joined }));
      sendJson(res, 200, { communities: list('communities', 'community_members', 'community_id'), groups: list('groups', 'group_members', 'group_id') });
    },

    'POST /api/discover/join': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot join this way.');
      const { kind, id } = await readJson(req);
      if (kind === 'community') {
        const c = db.prepare('SELECT id FROM communities WHERE id = ? AND public = 1').get(Number(id));
        if (!c) throw new HttpError(404, 'No such community');
        if (db.prepare('SELECT 1 FROM community_bans WHERE community_id = ? AND user_id = ?').get(c.id, me.id)) throw new HttpError(403, 'You cannot join this community.');
        joinCommunity(c.id, me.id);
        pushCommunity(c.id);
      } else if (kind === 'group') {
        const g = db.prepare('SELECT id FROM groups WHERE id = ? AND public = 1').get(Number(id));
        if (!g) throw new HttpError(404, 'No such group');
        addMember(g.id, me.id);
        pushGroup(g.id, 'group', { id: g.id });
      } else throw new HttpError(400, 'Unknown type.');
      sendJson(res, 200, { id: Number(id) });
    },

    'POST /api/community-settings': async (req, res, me) => {
      const { community, description, public: isPublic } = await readJson(req);
      needRole(needCMember(me, community), 'admin');
      db.prepare('UPDATE communities SET description = ?, public = ? WHERE id = ?').run(String(description ?? '').trim().slice(0, 300), isPublic ? 1 : 0, Number(community));
      logMod(community, me, 'settings', isPublic ? 'public' : 'private');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-settings': async (req, res, me) => {
      const { group, description, public: isPublic } = await readJson(req);
      needAdmin(me, group);
      db.prepare('UPDATE groups SET description = ?, public = ? WHERE id = ?').run(String(description ?? '').trim().slice(0, 300), isPublic ? 1 : 0, Number(group));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/ignore': async (req, res, me) => {
      const { username, ignored } = await readJson(req);
      const user = userNamed(username);
      if (user.id === me.id) throw new HttpError(400, 'You cannot ignore yourself.');
      if (ignored) {
        if (countOf('SELECT COUNT(*) AS n FROM ignores WHERE user_id = ?', me.id) >= 500) throw new HttpError(409, 'Your ignore list is full.');
        db.prepare('INSERT OR IGNORE INTO ignores (user_id, ignored_id) VALUES (?, ?)').run(me.id, user.id);
      } else db.prepare('DELETE FROM ignores WHERE user_id = ? AND ignored_id = ?').run(me.id, user.id);
      sendJson(res, 200, { ignored: !!ignored });
    },

    'GET /api/ice': (req, res) => sendJson(res, 200, { iceServers: [
      { urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' },
      ...(process.env.TURN_URL ? [{ urls: process.env.TURN_URL, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }] : []),
    ] }),

    'POST /api/call/start': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot make calls.');
      const { to, video } = await readJson(req);
      const peer = findPeer(me, to);
      if (peer.is_system || peer.is_bot) throw new HttpError(403, 'You cannot call this account.');
      if (isBlocked(me.id, peer.id) || !canMessage(me.id, peer.id)) throw new HttpError(403, "This person isn't accepting calls from you.");
      if (limited(`call:${me.id}`, 20, 600000)) throw new HttpError(429, 'Too many calls. Try again shortly.');
      if (inCall(me.id) || inCall(peer.id)) throw new HttpError(409, 'Someone is already in a call.');
      const id = Number(db.prepare('INSERT INTO calls (caller_id, callee_id, video, created_at) VALUES (?, ?, ?, ?)').run(me.id, peer.id, video ? 1 : 0, Date.now()).lastInsertRowid);
      const timer = setTimeout(() => {
        const c = db.prepare('SELECT * FROM calls WHERE id = ?').get(id);
        if (c?.state === 'ringing') finishCall(c, 'missed');
      }, callRingMs);
      timer.unref();
      callTimers.set(id, timer);
      push(peer.id, 'call', { type: 'incoming', id, from: me.username, name: me.display_name, avatar: avatarOf(me.id), video: !!video });
      if (!privacyOf(peer.id).dnd) {
        const ring = { t: 'call', id, from: me.username, name: me.display_name, video: !!video, tag: 'call' };
        pushNotify(peer.id, ring, { ttl: 30, urgency: 'high' });
        startPulse(id, peer.id, { ...ring, again: true });
      }
      sendJson(res, 201, { id });
    },

    // Ringing call for me right now (the Android app uses this when it is opened from the Answer button)
    'GET /api/call/pending': (req, res, me) => {
      const c = db.prepare("SELECT c.id, c.video, c.caller_id, u.username AS from_, u.display_name AS name FROM calls c JOIN users u ON u.id = c.caller_id WHERE c.callee_id = ? AND c.state = 'ringing' AND c.created_at > ? ORDER BY c.id DESC LIMIT 1").get(me.id, Date.now() - callRingMs);
      sendJson(res, 200, c ? { id: c.id, from: c.from_, name: c.name, avatar: avatarOf(c.caller_id), video: !!c.video } : null);
    },

    'POST /api/call/answer': async (req, res, me) => {
      const c = callOf(me, (await readJson(req)).call);
      if (c.callee_id !== me.id || c.state !== 'ringing') throw new HttpError(409, 'This call can no longer be answered.');
      clearTimeout(callTimers.get(c.id));
      stopPulse(c.id);
      pushNotify(c.callee_id, { t: 'callend', id: c.id, from: '', name: '', missed: false, tag: 'call' }, { ttl: 10 });
      db.prepare("UPDATE calls SET state = 'active', answered_at = ? WHERE id = ?").run(Date.now(), c.id);
      push(c.caller_id, 'call', { type: 'answered', id: c.id });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/call/decline': async (req, res, me) => {
      const c = callOf(me, (await readJson(req)).call);
      if (c.callee_id !== me.id || c.state !== 'ringing') throw new HttpError(409, 'This call can no longer be declined.');
      finishCall(c, 'declined');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/call/end': async (req, res, me) => {
      const c = callOf(me, (await readJson(req)).call);
      if (c.state !== 'ended') finishCall(c, c.state === 'ringing' && c.caller_id === me.id ? 'cancelled' : 'ended');
      sendJson(res, 200, { ok: true });
    },

    'POST /api/call/signal': async (req, res, me) => {
      const { call, data } = await readJson(req);
      const c = callOf(me, call);
      if (c.state === 'ended') throw new HttpError(409, 'This call has ended.');
      if (JSON.stringify(data ?? null).length > 20000) throw new HttpError(413, 'Signal too large.');
      if (limited(`signal:${me.id}`, 600, 60000)) throw new HttpError(429, 'Slow down.');
      push(c.caller_id === me.id ? c.callee_id : c.caller_id, 'call', { type: 'signal', id: c.id, data });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/sound/override': async (req, res, me) => {
      const { kind, target, tone } = await readJson(req);
      const key = String(target ?? '').slice(0, 40);
      if (!['dm', 'group', 'channel', 'ring'].includes(kind) || !key) throw new HttpError(400, 'Unknown target.');
      if (!tone || tone === 'default') db.prepare('DELETE FROM tones WHERE user_id = ? AND kind = ? AND target = ?').run(me.id, kind, key);
      else if (!toneValid(me, tone)) throw new HttpError(400, 'Unknown tone.');
      else db.prepare('INSERT OR REPLACE INTO tones (user_id, kind, target, tone) VALUES (?, ?, ?, ?)').run(me.id, kind, key, tone);
      sendJson(res, 200, soundOf(me.id));
    },

    'POST /api/community-roles': async (req, res, me) => {
      const { community, name, color, perms } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'roles');
      const title = String(name ?? '').trim().slice(0, 30);
      const list = [...new Set(Array.isArray(perms) ? perms : [])];
      if (!title || !list.length || list.some((p) => !ALL_PERMS.includes(p))) throw new HttpError(400, 'Name the role and pick permissions from the list.');
      if (color && !/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'Colour must look like #c8d6e5.');
      if (countOf('SELECT COUNT(*) AS n FROM community_roles WHERE community_id = ?', Number(community)) >= 10) throw new HttpError(409, 'A community can have up to 10 custom roles.');
      try {
        const id = Number(db.prepare('INSERT INTO community_roles (community_id, name, color, perms) VALUES (?, ?, ?, ?)').run(Number(community), title, color || null, JSON.stringify(list)).lastInsertRowid);
        logMod(community, me, 'create-role', title, list.join(', '));
        pushCommunity(Number(community));
        sendJson(res, 201, { id });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'A role with that name exists.');
        throw err;
      }
    },

    'POST /api/community-role-delete': async (req, res, me) => {
      const { community, role } = await readJson(req);
      needPerm(needCMember(me, community), 'roles');
      db.prepare('DELETE FROM community_roles WHERE id = ? AND community_id = ?').run(Number(role), Number(community));
      logMod(community, me, 'delete-role', String(role));
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/community-custom-role': async (req, res, me) => {
      const { community, username, role } = await readJson(req);
      const m = needCMember(me, community);
      needPerm(m, 'roles');
      const user = lowerRanked(me, m, Number(community), username);
      if (role !== null && !db.prepare('SELECT 1 FROM community_roles WHERE id = ? AND community_id = ?').get(Number(role), Number(community))) throw new HttpError(404, 'No such role');
      db.prepare('UPDATE community_members SET custom_role_id = ? WHERE community_id = ? AND user_id = ?').run(role === null ? null : Number(role), Number(community), user.id);
      logMod(community, me, 'assign-role', user.username, String(role));
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/mute': async (req, res, me) => {
      const { kind, target, muted } = await readJson(req);
      const key = String(target ?? '').slice(0, 40);
      if (!['dm', 'group', 'community', 'channel'].includes(kind) || !key) throw new HttpError(400, 'Unknown mute target.');
      if (muted) {
        if (countOf('SELECT COUNT(*) AS n FROM mutes WHERE user_id = ?', me.id) >= 500) throw new HttpError(409, 'Too many muted conversations.');
        db.prepare('INSERT OR IGNORE INTO mutes (user_id, kind, target) VALUES (?, ?, ?)').run(me.id, kind, key);
      } else db.prepare('DELETE FROM mutes WHERE user_id = ? AND kind = ? AND target = ?').run(me.id, kind, key);
      sendJson(res, 200, { muted: !!muted });
    },

    'GET /api/shop': (req, res, me) => sendJson(res, 200, {
      currency, balance: balanceOf(me.id),
      items: db.prepare(`SELECT i.id, i.kind, i.name, i.description, i.price, i.value,
        EXISTS (SELECT 1 FROM inventory v WHERE v.user_id = ? AND v.item_id = i.id) AS owned,
        EXISTS (SELECT 1 FROM equipped e WHERE e.user_id = ? AND e.item_id = i.id) AS equipped FROM items i WHERE i.active = 1 ORDER BY i.price`)
        .all(me.id, me.id).map((r) => ({ ...r, owned: !!r.owned, equipped: !!r.equipped })),
      history: db.prepare('SELECT delta, reason, at FROM sparks_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(me.id),
    }),

    'POST /api/sparks/daily': (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot earn rewards.');
      const created = db.prepare('SELECT created_at FROM users WHERE id = ?').get(me.id).created_at;
      if (Date.now() - created < claimMinAgeMs) throw new HttpError(403, 'Daily rewards unlock an hour after you sign up.');
      if (!award(me.id, 10, 'Daily check-in', `daily:${new Date().toISOString().slice(0, 10)}`)) throw new HttpError(409, 'You already claimed today. Come back tomorrow.');
      sendJson(res, 200, { balance: balanceOf(me.id) });
    },

    'POST /api/shop/buy': async (req, res, me) => {
      const item = itemNamed((await readJson(req)).item);
      tx(() => {
        if (db.prepare('SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?').get(me.id, item.id)) throw new HttpError(409, 'You already own this.');
        if (balanceOf(me.id) < item.price) throw new HttpError(402, `Not enough ${currency}.`);
        award(me.id, -item.price, `Bought ${item.name}`, `buy:${item.id}`);
        db.prepare('INSERT INTO inventory (user_id, item_id, acquired_at) VALUES (?, ?, ?)').run(me.id, item.id, Date.now());
      });
      sendJson(res, 200, { balance: balanceOf(me.id) });
    },

    'POST /api/shop/equip': async (req, res, me) => {
      const item = itemNamed((await readJson(req)).item);
      if (!db.prepare('SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?').get(me.id, item.id)) throw new HttpError(403, 'You do not own this item.');
      db.prepare('INSERT OR REPLACE INTO equipped (user_id, kind, item_id) VALUES (?, ?, ?)').run(me.id, item.kind, item.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/shop/unequip': async (req, res, me) => {
      db.prepare('DELETE FROM equipped WHERE user_id = ? AND kind = ?').run(me.id, String((await readJson(req)).kind ?? ''));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/birthday': async (req, res, me) => {
      const { month, day, clear } = await readJson(req);
      if (clear) { db.prepare('UPDATE users SET birthday = NULL WHERE id = ?').run(me.id); return sendJson(res, 200, { birthday: null }); }
      const d = new Date(Date.UTC(2000, Number(month) - 1, Number(day)));
      if (!Number.isInteger(Number(month)) || !Number.isInteger(Number(day)) || d.getUTCMonth() !== Number(month) - 1 || d.getUTCDate() !== Number(day)) throw new HttpError(400, 'That is not a valid date.');
      const birthday = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      db.prepare('UPDATE users SET birthday = ? WHERE id = ?').run(birthday, me.id);
      sendJson(res, 200, { birthday });
    },

    'POST /api/groups': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot create groups.');
      const { name, members = [] } = await readJson(req);
      const title = String(name ?? '').trim().slice(0, 60);
      if (!title) throw new HttpError(400, 'Give the group a name.');
      const others = [...new Set(members.map((m) => String(m).toLowerCase()))].filter((m) => m !== me.username).map(userNamed);
      db.exec('BEGIN');
      try {
        const gid = Number(db.prepare('INSERT INTO groups (name, created_by, created_at) VALUES (?, ?, ?)').run(title, me.id, Date.now()).lastInsertRowid);
        addMember(gid, me.id, 'admin');
        others.forEach((u) => addMember(gid, u.id));
        db.exec('COMMIT');
        others.forEach((u) => push(u.id, 'group', { id: gid }));
        sendJson(res, 201, { id: gid, name: title });
      } catch (err) { db.exec('ROLLBACK'); throw err; }
    },

    'GET /api/groups': (req, res, me) => sendJson(res, 200, db.prepare(`
      SELECT g.id, g.name, g.icon_id AS icon, g.public, gm.role, (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS members,
        (SELECT body FROM group_messages WHERE group_id = g.id ORDER BY id DESC LIMIT 1) AS body
      FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? ORDER BY g.id DESC`).all(me.id)),

    'POST /api/group-members': async (req, res, me) => {
      const { group, username } = await readJson(req);
      needAdmin(me, group);
      const user = userNamed(username);
      addMember(group, user.id);
      push(user.id, 'group', { id: group });
      pushGroup(group, 'group', { id: group });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-remove': async (req, res, me) => {
      const { group, username } = await readJson(req);
      needAdmin(me, group);
      const user = userNamed(username);
      if (user.id === me.id) throw new HttpError(400, 'Use Leave to remove yourself.');
      db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group, user.id);
      push(user.id, 'group', { id: group, removed: true });
      pushGroup(group, 'group', { id: group });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-leave': async (req, res, me) => {
      const { group } = await readJson(req);
      const role = needMember(me, group);
      db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(group, me.id);
      hooks.onLeave?.('group', Number(group), me.id);
      const left = db.prepare('SELECT user_id, role FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1').get(group);
      if (!left) db.prepare('DELETE FROM groups WHERE id = ?').run(group);
      else if (role === 'admin' && !db.prepare("SELECT 1 FROM group_members WHERE group_id = ? AND role = 'admin'").get(group))
        db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(group, left.user_id);
      pushGroup(group, 'group', { id: group });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/group-invite': async (req, res, me) => {
      const { group } = await readJson(req);
      needAdmin(me, group);
      const code = crypto.randomBytes(12).toString('base64url');
      db.prepare('INSERT INTO group_invites (token_hash, group_id, expires_at) VALUES (?, ?, ?)').run(sha(code), group, Date.now() + 7 * 864e5);
      sendJson(res, 201, { code, expiresInDays: 7 });
    },

    'POST /api/group-join': async (req, res, me) => {
      const { code } = await readJson(req);
      const invite = db.prepare('SELECT group_id FROM group_invites WHERE token_hash = ? AND expires_at > ?').get(sha(String(code ?? '')), Date.now());
      if (!invite) throw new HttpError(404, 'That invite is invalid or expired.');
      addMember(invite.group_id, me.id);
      pushGroup(invite.group_id, 'group', { id: invite.group_id });
      sendJson(res, 200, { id: invite.group_id });
    },

    'POST /api/register': async (req, res) => {
      if (limited(`reg:${clientIp(req)}`, authLimit)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const { username, displayName, password } = await readJson(req);
      const name = String(username ?? '').toLowerCase();
      if (!USERNAME.test(name) || RESERVED.has(name)) throw new HttpError(400, 'Usernames are 3–24 characters: letters, numbers, underscore.');
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');
      const display = String(displayName ?? '').trim().slice(0, 40) || name;
      try {
        const { lastInsertRowid } = db.prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
          .run(name, display, hashPassword(password), Date.now());
        if (countOf('SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND is_bot = 0') <= 100)
          db.prepare("INSERT OR IGNORE INTO user_badges (user_id, badge_id, at, source) VALUES (?, 'early', ?, 'registration')").run(Number(lastInsertRowid), Date.now());
        startSession(res, Number(lastInsertRowid), { username: name, displayName: display });
      } catch (err) {
        if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'That username is taken.');
        throw err;
      }
    },

    'POST /api/login': async (req, res) => {
      if (limited(`login:${clientIp(req)}`, authLimit)) throw new HttpError(429, 'Too many attempts. Try again later.');
      const { username, password } = await readJson(req);
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username ?? '').toLowerCase());
      const ok = user && !user.is_system && !user.is_bot && typeof password === 'string' && checkPassword(password, user.password_hash);
      if (!ok) throw new HttpError(401, 'Wrong username or password.');
      if (user.banned_at) throw new HttpError(403, `This account is suspended: ${user.banned_reason || 'no reason given'}.`, { banned: true, reason: user.banned_reason || 'No reason given' });
      startSession(res, user.id, { username: user.username, displayName: user.display_name });
    },

    'POST /api/logout': async (req, res) => {
      const token = cookie(req, 'sid');
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    },

    'POST /api/block': async (req, res, me) => {
      const { username, blocked } = await readJson(req);
      const peer = findPeer(me, username);
      if (blocked) db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)').run(me.id, peer.id);
      else db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(me.id, peer.id);
      sendJson(res, 200, { blocked: !!blocked });
    },

  };

  // ---------------------------------------------------------------- v2 routes
  const rooms = makeRooms({ db, push, HttpError, readJson, sendJson, channelAccess, needMember, avatarOf, limited, needHuman,
    pushPresence: (uid, payload) => pushQuiet(uid, payload, null),
    postGroupSystem: (gid, username, text) => { const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username); if (u) insertGroup(gid, u.id, text, { kind: 'call' }); } });
  Object.assign(routes, rooms.routes);

  const cleanFileName = (n) => String(n ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '').trim().slice(0, 80) || null;
  const parseTags = (c) => [...new Set([...String(c ?? '').toLowerCase().matchAll(/#([\p{L}\p{N}_]{1,40})/gu)].map((m) => m[1]))].slice(0, 10);
  const setTags = (id, caption) => {
    db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(id);
    for (const t of parseTags(caption)) db.prepare('INSERT OR IGNORE INTO post_tags (post_id, tag) VALUES (?, ?)').run(id, t);
  };
  const musicFields = (me, m) => {
    if (!m || !m.id) return { id: null, title: null, start: 0, mute: 0 };
    const id = String(m.id);
    const own = db.prepare("SELECT label FROM uploads WHERE id = ? AND kind = 'sound' AND user_id = ?").get(id, me.id);
    const shared = !own && db.prepare("SELECT 1 FROM uploads WHERE id = ? AND kind = 'sound'").get(id) && canView(me, id, { kind: 'sound', owner: -1 });
    if (!own && !shared) throw new HttpError(400, 'That music is not available.');
    return { id, title: String(m.title ?? own?.label ?? '').trim().slice(0, 80) || 'Original audio', start: Math.min(Math.max(Math.trunc(Number(m.start)) || 0, 0), 3600), mute: m.mute ? 1 : 0 };
  };
  const registerUpload = (id, userId, kind, mimeType, size, label = null) =>
    db.prepare('INSERT INTO uploads (id, user_id, kind, mime, size, created_at, label) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, userId, kind, mimeType, size, Date.now(), label);
  const CUSTOM_BUBBLES = ['glass', 'solid', 'outline', 'minimal'];
  const WALLPAPERS = ['default', 'aurora', 'dusk', 'forest', 'mono', 'plain', 'custom'];
  const cleanCustom = (me, c = {}, old = {}) => {
    const out = {};
    if (CUSTOM_BUBBLES.includes(c.bubble)) out.bubble = c.bubble;
    if (Number.isFinite(Number(c.radius))) out.radius = Math.min(Math.max(Math.round(Number(c.radius)), 4), 28);
    if (Number.isFinite(Number(c.fontScale))) out.fontScale = Math.min(Math.max(Number(c.fontScale), 0.85), 1.4);
    if (Number.isFinite(Number(c.blur))) out.blur = Math.min(Math.max(Math.round(Number(c.blur)), 0), 40);
    if (WALLPAPERS.includes(c.wallpaper)) out.wallpaper = c.wallpaper;
    if (/^#[0-9a-f]{6}$/i.test(c.bubbleColor ?? '')) out.bubbleColor = c.bubbleColor;
    if (['left', 'right'].includes(c.mineSide)) out.mineSide = c.mineSide;
    if (typeof c.contrast === 'boolean') out.contrast = c.contrast;
    if (typeof c.showAvatars === 'boolean') out.showAvatars = c.showAvatars;
    if (typeof c.confetti === 'boolean') out.confetti = c.confetti;
    if (c.wallpaperId && db.prepare("SELECT 1 FROM uploads WHERE id = ? AND user_id = ? AND kind = 'wallpaper'").get(String(c.wallpaperId), me.id)) out.wallpaperId = String(c.wallpaperId);
    if (old.wallpaperId && old.wallpaperId !== out.wallpaperId) removeFile(old.wallpaperId);
    return out;
  };

  Object.assign(routes, {
    'POST /api/upload': async (req, res, me, url) => {
      needHuman(me);
      const kind = url.searchParams.get('kind');
      if (!['avatar', 'banner', 'attachment', 'community-icon', 'group-icon', 'post', 'story', 'reel', 'sound', 'wallpaper'].includes(kind)) throw new HttpError(400, 'Unknown upload type.');
      if (limited(`upload:${kind}:${me.id}`, ['attachment', 'post', 'story', 'reel', 'sound'].includes(kind) ? 60 : 10, 3600e3)) throw new HttpError(429, 'Too many uploads. Try again later.');
      const maxBytes = ({ attachment: 25, post: 10, story: 10, banner: 4, reel: 40, sound: 10, wallpaper: 4 }[kind] ?? 2) * 1024 * 1024;
      const body = await readBytes(req, maxBytes);
      if (!body.length) throw new HttpError(400, 'That file is empty.');
      const label = cleanFileName(url.searchParams.get('name'));
      const mediaId = crypto.randomBytes(16).toString('hex');
      if (kind === 'reel' || kind === 'sound') {
        const mimeType = kind === 'reel' ? sniffVideo(body) : sniffAudio(body);
        if (!mimeType) throw new HttpError(400, kind === 'reel' ? 'Upload an MP4 or WebM video.' : 'Upload an MP3, WAV, OGG, M4A, AAC or FLAC sound.');
        if (kind === 'sound' && countOf("SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND kind = 'sound'", me.id) >= 20) throw new HttpError(409, 'You can keep up to 20 sounds. Delete one first.');
        storeFile(mediaId, body);
        registerUpload(mediaId, me.id, kind, mimeType, body.length, label?.slice(0, 40) ?? null);
        return sendJson(res, 201, { id: mediaId });
      }
      if (kind === 'attachment') {
        const img = sniffImage(body);
        let mimeType = 'application/octet-stream';
        if (img && img.w >= 1 && img.h >= 1 && img.w <= 8192 && img.h <= 8192 && !(img.mime === 'image/gif' && body.length > 10 * 1024 * 1024)) mimeType = img.mime;
        else mimeType = sniffVideo(body) || sniffAudio(body) || 'application/octet-stream';
        storeFile(mediaId, body);
        registerUpload(mediaId, me.id, 'attachment', mimeType, body.length, label ?? 'file');
        return sendJson(res, 201, { id: mediaId, name: label ?? 'file', mime: mimeType, size: body.length, kind: classify(mimeType) });
      }
      const img = sniffImage(body);
      if (!img) throw new HttpError(400, 'Upload a PNG, JPEG, GIF or WebP image.');
      if (!(img.w >= 1 && img.h >= 1 && img.w <= 4096 && img.h <= 4096)) throw new HttpError(400, 'Images can be at most 4096 pixels on each side.');
      if (img.mime === 'image/gif' && body.length > maxBytes / 2) throw new HttpError(400, `GIFs must be under ${maxBytes / 2 / 1024 / 1024} MB.`);
      if (['post', 'story', 'wallpaper'].includes(kind)) {
        storeFile(mediaId, body);
        registerUpload(mediaId, me.id, kind, img.mime, body.length);
        return sendJson(res, 201, { id: mediaId });
      }
      if (kind.endsWith('-icon')) {
        const target = Number(url.searchParams.get('id'));
        const table = kind === 'community-icon' ? 'communities' : 'groups';
        if (table === 'communities') needRole(needCMember(me, target), 'admin'); else needAdmin(me, target);
        const old = db.prepare(`SELECT icon_id AS id FROM ${table} WHERE id = ?`).get(target).id;
        storeFile(mediaId, body);
        registerUpload(mediaId, me.id, kind, img.mime, body.length);
        db.prepare(`UPDATE ${table} SET icon_id = ? WHERE id = ?`).run(mediaId, target);
        removeFile(old);
        return sendJson(res, 201, { id: mediaId });
      }
      const column = kind === 'avatar' ? 'avatar_id' : 'banner_id';
      prefsOf(me.id);
      const previous = db.prepare(`SELECT ${column} AS id FROM profiles WHERE user_id = ?`).get(me.id).id;
      storeFile(mediaId, body);
      registerUpload(mediaId, me.id, kind, img.mime, body.length);
      db.prepare(`UPDATE profiles SET ${column} = ? WHERE user_id = ?`).run(mediaId, me.id);
      removeFile(previous);
      sendJson(res, 201, { id: mediaId });
    },

    'GET /api/sounds': (req, res, me) => sendJson(res, 200, db.prepare("SELECT id, label, size FROM uploads WHERE user_id = ? AND kind = 'sound' ORDER BY created_at").all(me.id)),

    'POST /api/sounds/delete': async (req, res, me) => {
      const id = String((await readJson(req)).id ?? '');
      if (!db.prepare("SELECT 1 FROM uploads WHERE id = ? AND user_id = ? AND kind = 'sound'").get(id, me.id)) throw new HttpError(404, 'No such sound');
      const key = `custom:${id}`;
      prefsOf(me.id);
      db.prepare("UPDATE profiles SET tone = CASE WHEN tone = ? THEN 'chime' ELSE tone END, ring_tone = CASE WHEN ring_tone = ? THEN 'ring' ELSE ring_tone END, calling_tune = CASE WHEN calling_tune = ? THEN 'ringback' ELSE calling_tune END WHERE user_id = ?").run(key, key, key, me.id);
      db.prepare('DELETE FROM tones WHERE user_id = ? AND tone = ?').run(me.id, key);
      db.prepare('UPDATE posts SET music_id = NULL, music_title = NULL WHERE music_id = ?').run(id);
      db.prepare('UPDATE stories SET music_id = NULL, music_title = NULL WHERE music_id = ?').run(id);
      removeFile(id);
      sendJson(res, 200, soundOf(me.id));
    },

    'GET /api/music/library': (req, res, me) => {
      const rows = db.prepare(`SELECT music_id AS id, music_title AS title, u.display_name AS by, MAX(p.at) AS at FROM (
          SELECT id, user_id, music_id, music_title, created_at AS at FROM posts WHERE music_id IS NOT NULL
          UNION ALL SELECT id, user_id, music_id, music_title, created_at AS at FROM stories WHERE music_id IS NOT NULL AND expires_at > ${Date.now()}) p
        JOIN users u ON u.id = p.user_id WHERE 1 = 1 ${hiddenFrom(me.id)} GROUP BY music_id ORDER BY at DESC LIMIT 30`).all();
      sendJson(res, 200, rows);
    },

    'POST /api/sound': async (req, res, me) => {
      const { tone, ringtone = 'ring', callingTune = 'ringback', volume } = await readJson(req);
      const vol = Number(volume);
      if (!toneValid(me, tone) || !toneValid(me, ringtone) || !toneValid(me, callingTune) || !Number.isInteger(vol) || vol < 0 || vol > 100) throw new HttpError(400, 'Unknown tone or volume.');
      prefsOf(me.id);
      db.prepare('UPDATE profiles SET tone = ?, ring_tone = ?, calling_tune = ?, volume = ? WHERE user_id = ?').run(tone, ringtone, callingTune, vol, me.id);
      sendJson(res, 200, soundOf(me.id));
    },

    // ---- messages
    'GET /api/conversations': (req, res, me) => {
      const rows = db.prepare(`
        SELECT u.username, u.display_name AS displayName, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, u.is_owner, u.site_role,
          CASE WHEN m.kind = 'e2ee' THEN 'Encrypted message' WHEN m.kind = 'post' THEN 'Shared a post' WHEN m.body = '' AND m.attachment_id IS NOT NULL THEN 'Sent a file' ELSE m.body END AS body,
          m.kind, m.created_at AS at, m.sender_id = :me AS mine,
          (SELECT COUNT(*) FROM messages x WHERE x.sender_id = u.id AND x.recipient_id = :me AND x.read_at IS NULL) AS unread,
          EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = :me AND b.blocked_id = u.id) AS blocked
        FROM messages m JOIN users u ON u.id = CASE WHEN m.sender_id = :me THEN m.recipient_id ELSE m.sender_id END
        WHERE m.id IN (SELECT MAX(id) FROM messages WHERE sender_id = :me OR recipient_id = :me
                       GROUP BY CASE WHEN sender_id = :me THEN recipient_id ELSE sender_id END)
        ORDER BY m.id DESC`).all({ me: me.id });
      sendJson(res, 200, rows.map(({ is_owner, site_role, ...r }) => ({ ...r, tag: tagOf({ is_owner, site_role }), mine: !!r.mine, blocked: !!r.blocked })));
    },

    'GET /api/messages': (req, res, me, url) => {
      const peer = findPeer(me, url.searchParams.get('with'));
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare(`
        SELECT id, sender_id = ? AS mine, body, kind, meta, attachment_id AS attachment, created_at AS at FROM messages
        WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND id < ?
        ORDER BY id DESC LIMIT 50`).all(me.id, me.id, peer.id, peer.id, me.id, before);
      db.prepare('UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL').run(Date.now(), peer.id, me.id);
      const { is_owner, site_role, ...p } = peer;
      sendJson(res, 200, { peer: { ...p, avatar: avatarOf(peer.id), tag: tagOf(peer), friend: friendStatus(me.id, peer.id) },
        messages: decorate(rows.reverse().map((r) => ({ ...r, mine: !!r.mine })), 'dm', me.id) });
    },

    'POST /api/messages': async (req, res, me) => {
      const { to, body, attachment, kind: wanted } = await readJson(req);
      const peer = findPeer(me, to);
      const text = String(body ?? '').trim();
      const att = attachmentOf(me, attachment);
      const secret = wanted === 'e2ee';
      if (secret) {
        let env; try { env = JSON.parse(text); } catch { env = null; }
        if (!env || env.v !== 1 || !['s', 'r', 'i', 'c'].every((k) => typeof env[k] === 'string') || text.length > 16000) throw new HttpError(400, 'Not a valid encrypted message.');
      } else if ((!text && !att) || text.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      if (peer.is_system) throw new HttpError(403, 'Scrxaper Teams sends notices only and does not read replies.');
      if (peer.is_bot) throw new HttpError(403, 'Built-in bots live in groups and communities. Add one from the group or community settings.');
      if (isBlocked(me.id, peer.id)) throw new HttpError(403, "You can't message this user.");
      if (!canMessage(me.id, peer.id)) throw new HttpError(403, "This person isn't accepting messages from you.");
      if (limited(`dm:${me.id}`, 60, 10000)) throw new HttpError(429, 'Slow down a little.');
      const p = insertDm(me, peer, text, { att, kind: secret ? 'e2ee' : 'text' });
      sendJson(res, 201, { id: p.id, body: text, at: p.at, mine: true });
    },

    'GET /api/group-messages': (req, res, me, url) => {
      const gid = Number(url.searchParams.get('group'));
      const role = needMember(me, gid);
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare(`SELECT m.id, ${SENDER}, m.body, m.kind, m.meta, m.attachment_id AS attachment, m.created_at AS at
        FROM group_messages m JOIN users u ON u.id = m.sender_id WHERE m.group_id = ? AND m.id < ? AND m.sender_id NOT IN (SELECT ignored_id FROM ignores WHERE user_id = ?) ORDER BY m.id DESC LIMIT 50`).all(gid, before, me.id);
      const members = db.prepare(`SELECT u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, u.is_owner, u.site_role, gm.role FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? ORDER BY gm.role, u.username`).all(gid).map(({ is_owner, site_role, ...r }) => ({ ...r, tag: tagOf({ is_owner, site_role }) }));
      sendJson(res, 200, { role, members, bots: Object.keys(installedBots('group', gid)), group: db.prepare('SELECT id, name, description, public, icon_id AS icon FROM groups WHERE id = ?').get(gid),
        messages: decorate(rows.reverse().map((r) => ({ ...r, mine: r.from === me.username })), 'group', me.id) });
    },

    'POST /api/group-messages': async (req, res, me) => {
      const { group, body, attachment } = await readJson(req);
      const role = needMember(me, group);
      const text = String(body ?? '').trim();
      const att = attachmentOf(me, attachment);
      if ((!text && !att) || text.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      if (limited(`grp:${me.id}`, 30, 10000)) throw new HttpError(429, 'Slow down a little.');
      gateMessage('group', group, me, text, role === 'admin');
      const p = insertGroup(Number(group), me.id, text, { att });
      afterMessage('group', group, { scope: 'group', id: Number(group) }, me, text);
      sendJson(res, 201, { id: p.id });
    },

    'GET /api/channel-messages': (req, res, me, url) => {
      const { ch, m } = channelAccess(me, url.searchParams.get('channel'));
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      const rows = db.prepare(`SELECT x.id, ${SENDER}, x.body, x.kind, x.meta, x.attachment_id AS attachment, x.created_at AS at
        FROM channel_messages x JOIN users u ON u.id = x.sender_id WHERE x.channel_id = ? AND x.id < ? AND x.sender_id NOT IN (SELECT ignored_id FROM ignores WHERE user_id = ?) ORDER BY x.id DESC LIMIT 50`).all(ch.id, before, me.id);
      sendJson(res, 200, { channel: { id: ch.id, name: ch.name, topic: ch.topic, kind: ch.kind, communityId: ch.community_id }, canPost: canPost(ch, m), canModerate: can(m, 'delete_messages'),
        messages: decorate(rows.reverse().map((r) => ({ ...r, mine: r.from === me.username })), 'channel', me.id) });
    },

    'POST /api/channel-messages': async (req, res, me) => {
      const { channel, body, attachment } = await readJson(req);
      const { ch, m } = channelAccess(me, channel);
      if (ch.kind === 'voice') throw new HttpError(400, 'This is a voice channel. Join it to talk.');
      if (!canPost(ch, m)) throw new HttpError(403, 'Only admins can post in this channel.');
      if (m.timeoutUntil > Date.now()) throw new HttpError(403, `You are timed out until ${new Date(m.timeoutUntil).toLocaleString()}.`);
      const text = String(body ?? '').trim();
      const att = attachmentOf(me, attachment);
      if ((!text && !att) || text.length > 4000) throw new HttpError(400, 'Messages need 1–4000 characters.');
      if (limited(`chan:${me.id}`, 20, 10000)) throw new HttpError(429, 'Slow down a little.');
      gateMessage('community', ch.community_id, me, text, rankOf(m) >= 1);
      const p = insertChannel(ch, me.id, text, { att });
      afterMessage('community', ch.community_id, { scope: 'community', id: ch.id, ch }, me, text);
      sendJson(res, 201, { id: p.id });
    },

    'POST /api/poll/vote': async (req, res, me) => {
      const { scope, id, choice } = await readJson(req);
      let msg;
      if (scope === 'group') { msg = db.prepare('SELECT group_id AS sid, meta FROM group_messages WHERE id = ? AND kind = ?').get(Number(id), 'poll'); if (msg) needMember(me, msg.sid); }
      else if (scope === 'channel') { msg = db.prepare('SELECT channel_id AS sid, meta FROM channel_messages WHERE id = ? AND kind = ?').get(Number(id), 'poll'); if (msg) channelAccess(me, msg.sid); }
      if (!msg) throw new HttpError(404, 'No such poll');
      const meta = JSON.parse(msg.meta);
      const c = Number(choice);
      if (!Number.isInteger(c) || c < 0 || c >= meta.options.length) throw new HttpError(400, 'Pick one of the options.');
      db.prepare('INSERT OR REPLACE INTO votes (message_scope, message_id, user_id, choice) VALUES (?, ?, ?, ?)').run(scope, Number(id), me.id, c);
      const counts = meta.options.map(() => 0);
      for (const v of db.prepare('SELECT choice FROM votes WHERE message_scope = ? AND message_id = ?').all(scope, Number(id))) counts[v.choice]++;
      const ev = { scope, id: Number(id), counts };
      if (scope === 'group') for (const uid of scopeMembers('group', msg.sid)) push(uid, 'poll', ev);
      else { const ch = db.prepare('SELECT community_id FROM channels WHERE id = ?').get(msg.sid); for (const uid of scopeMembers('community', ch.community_id)) push(uid, 'poll', ev); }
      sendJson(res, 200, { counts, mine: c });
    },

    'POST /api/channels/reorder': async (req, res, me) => {
      const { community, order } = await readJson(req);
      needPerm(needCMember(me, community), 'channels');
      const ids = new Set(db.prepare('SELECT id FROM channels WHERE community_id = ?').all(Number(community)).map((r) => r.id));
      (Array.isArray(order) ? order : []).filter((i) => ids.has(Number(i))).forEach((i, n) => db.prepare('UPDATE channels SET position = ? WHERE id = ?').run(n, Number(i)));
      pushCommunity(Number(community));
      sendJson(res, 200, { ok: true });
    },

    'POST /api/channel-edit': async (req, res, me) => {
      const { channel, name, topic } = await readJson(req);
      const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number(channel));
      if (!ch) throw new HttpError(404, 'No such channel');
      needPerm(needCMember(me, ch.community_id), 'channels');
      const slug = String(name ?? ch.name).toLowerCase().trim().replace(/\s+/g, '-');
      if (!/^[a-z0-9-]{1,30}$/.test(slug)) throw new HttpError(400, 'Channel names use letters, numbers and dashes (up to 30).');
      try { db.prepare('UPDATE channels SET name = ?, topic = ? WHERE id = ?').run(slug, String(topic ?? ch.topic).slice(0, 200), ch.id); }
      catch (err) { if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'A channel with that name exists.'); throw err; }
      logMod(ch.community_id, me, 'edit-channel', slug);
      pushCommunity(ch.community_id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/channel-delete': async (req, res, me) => {
      const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(Number((await readJson(req)).channel));
      if (!ch) throw new HttpError(404, 'No such channel');
      needPerm(needCMember(me, ch.community_id), 'channels');
      if (countOf("SELECT COUNT(*) AS n FROM channels WHERE community_id = ? AND kind != 'voice'", ch.community_id) <= 1 && ch.kind !== 'voice') throw new HttpError(409, 'A community needs at least one text channel.');
      db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
      logMod(ch.community_id, me, 'delete-channel', ch.name);
      pushCommunity(ch.community_id);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/communities': (req, res, me) => sendJson(res, 200, db.prepare(`SELECT c.id, c.name, c.icon_id AS icon, cm.role,
      (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) AS members
      FROM communities c JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ? ORDER BY cm.position, c.id DESC`).all(me.id)),

    'POST /api/communities/reorder': async (req, res, me) => {
      const { order } = await readJson(req);
      (Array.isArray(order) ? order : []).forEach((id, n) => db.prepare('UPDATE community_members SET position = ? WHERE community_id = ? AND user_id = ?').run(n, Number(id), me.id));
      sendJson(res, 200, { ok: true });
    },

    // ---- friends
    'GET /api/friends': (req, res, me) => {
      const rows = db.prepare(`SELECT f.status, f.requester, f.at, u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, u.is_owner, u.site_role
        FROM friendships f JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END WHERE (f.a = ? OR f.b = ?) AND u.banned_at IS NULL ORDER BY u.display_name`).all(me.id, me.id, me.id);
      const shape = ({ is_owner, site_role, requester, status, ...r }) => ({ ...r, tag: tagOf({ is_owner, site_role }), status });
      sendJson(res, 200, { friends: rows.filter((r) => r.status === 'accepted').map(shape),
        incoming: rows.filter((r) => r.status === 'pending' && r.requester !== me.id).map(shape), outgoing: rows.filter((r) => r.status === 'pending' && r.requester === me.id).map(shape) });
    },

    'POST /api/friends/request': async (req, res, me) => {
      needHuman(me);
      const peer = findPeer(me, (await readJson(req)).username);
      if (peer.is_system || peer.is_bot) throw new HttpError(403, 'You cannot add this account.');
      if (isBlocked(me.id, peer.id)) throw new HttpError(403, 'You cannot send this person a request.');
      if (limited(`freq:${me.id}`, 30, 3600e3)) throw new HttpError(429, 'Too many requests. Try again later.');
      const row = friendRow(me.id, peer.id);
      const [a, b] = pairOf(me.id, peer.id);
      if (row?.status === 'accepted') throw new HttpError(409, 'You are already friends.');
      if (row && row.requester === me.id) throw new HttpError(409, 'Request already sent.');
      if (countOf("SELECT COUNT(*) AS n FROM friendships WHERE (a = ? OR b = ?) AND status = 'accepted'", me.id, me.id) >= 500) throw new HttpError(409, 'Your friends list is full.');
      if (row) { // they already asked us: accept
        db.prepare("UPDATE friendships SET status = 'accepted', at = ? WHERE a = ? AND b = ?").run(Date.now(), a, b);
        addNotification(peer.id, 'friend_accept', me.id);
        for (const uid of [me.id, peer.id]) push(uid, 'friend', {});
        return sendJson(res, 200, { status: 'friends' });
      }
      db.prepare("INSERT INTO friendships (a, b, status, requester, at) VALUES (?, ?, 'pending', ?, ?)").run(a, b, me.id, Date.now());
      addNotification(peer.id, 'friend_request', me.id);
      push(peer.id, 'friend', {}); push(me.id, 'friend', {});
      pushQuiet(peer.id, { t: 'friend', name: me.display_name, from: me.username, body: `${me.display_name} sent you a friend request`, tag: `friend:${me.username}` }, null);
      sendJson(res, 201, { status: 'outgoing' });
    },

    'POST /api/friends/respond': async (req, res, me) => {
      const { username, accept } = await readJson(req);
      const peer = findPeer(me, username);
      const row = friendRow(me.id, peer.id);
      if (!row || row.status !== 'pending' || row.requester === me.id) throw new HttpError(404, 'No such request');
      const [a, b] = pairOf(me.id, peer.id);
      if (accept) { db.prepare("UPDATE friendships SET status = 'accepted', at = ? WHERE a = ? AND b = ?").run(Date.now(), a, b); addNotification(peer.id, 'friend_accept', me.id); }
      else db.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').run(a, b);
      db.prepare("DELETE FROM notifications WHERE user_id = ? AND kind = 'friend_request' AND actor_id = ?").run(me.id, peer.id);
      for (const uid of [me.id, peer.id]) push(uid, 'friend', {});
      sendJson(res, 200, { status: accept ? 'friends' : 'none' });
    },

    'POST /api/friends/remove': async (req, res, me) => {
      const peer = findPeer(me, (await readJson(req)).username);
      const [a, b] = pairOf(me.id, peer.id);
      db.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').run(a, b);
      for (const uid of [me.id, peer.id]) push(uid, 'friend', {});
      sendJson(res, 200, { status: 'none' });
    },

    // ---- notifications
    'GET /api/notifications': (req, res, me) => sendJson(res, 200, { unread: unreadCount(me.id),
      items: db.prepare(`SELECT n.id, n.kind, n.ref, n.text, n.at, n.seen, u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar
        FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.user_id = ? ORDER BY n.at DESC LIMIT 60`).all(me.id).map((r) => ({ ...r, seen: !!r.seen })) }),

    'POST /api/notifications/read': async (req, res, me) => {
      const { id } = await readJson(req);
      if (id) db.prepare('UPDATE notifications SET seen = 1 WHERE id = ? AND user_id = ?').run(Number(id), me.id);
      else db.prepare('UPDATE notifications SET seen = 1 WHERE user_id = ?').run(me.id);
      sendJson(res, 200, { unread: unreadCount(me.id) });
    },

    // ---- follow, private accounts
    'POST /api/follow': async (req, res, me) => {
      const { username, follow } = await readJson(req);
      const user = userNamed(username);
      if (user.id === me.id) throw new HttpError(400, 'You cannot follow yourself.');
      const isPrivate = !!db.prepare('SELECT private FROM profiles WHERE user_id = ?').get(user.id)?.private;
      let state = 'none';
      if (follow) {
        if (isBlocked(me.id, user.id)) throw new HttpError(403, 'You cannot follow this person.');
        if (countOf('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', me.id) >= 5000) throw new HttpError(409, 'You follow too many people.');
        if (db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(me.id, user.id)) state = 'following';
        else if (isPrivate) {
          db.prepare('INSERT OR IGNORE INTO follow_requests (follower_id, followee_id, at) VALUES (?, ?, ?)').run(me.id, user.id, Date.now());
          addNotification(user.id, 'follow_request', me.id);
          state = 'requested';
        } else {
          db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(me.id, user.id, Date.now());
          addNotification(user.id, 'follow', me.id);
          state = 'following';
        }
      } else {
        db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(me.id, user.id);
        db.prepare('DELETE FROM follow_requests WHERE follower_id = ? AND followee_id = ?').run(me.id, user.id);
      }
      sendJson(res, 200, { following: state === 'following', requested: state === 'requested', followers: countOf('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', user.id) });
    },

    'GET /api/follow-requests': (req, res, me) => sendJson(res, 200, db.prepare(`SELECT u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, r.at
      FROM follow_requests r JOIN users u ON u.id = r.follower_id WHERE r.followee_id = ? ORDER BY r.at DESC`).all(me.id)),

    'POST /api/follow-requests/respond': async (req, res, me) => {
      const { username, accept } = await readJson(req);
      const user = userNamed(username);
      if (!db.prepare('SELECT 1 FROM follow_requests WHERE follower_id = ? AND followee_id = ?').get(user.id, me.id)) throw new HttpError(404, 'No such request');
      db.prepare('DELETE FROM follow_requests WHERE follower_id = ? AND followee_id = ?').run(user.id, me.id);
      db.prepare("DELETE FROM notifications WHERE user_id = ? AND kind = 'follow_request' AND actor_id = ?").run(me.id, user.id);
      if (accept) { db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(user.id, me.id, Date.now()); addNotification(user.id, 'follow_accept', me.id); }
      sendJson(res, 200, { ok: true });
    },

    // ---- posts, stories, tags, explore
    'POST /api/posts': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot post.');
      const { media, caption, music } = await readJson(req);
      const file = db.prepare("SELECT id, kind FROM uploads WHERE id = ? AND user_id = ? AND kind IN ('post', 'reel')").get(String(media ?? ''), me.id);
      if (!file) throw new HttpError(400, 'Upload a photo or video first.');
      if (db.prepare('SELECT 1 FROM posts WHERE media_id = ?').get(file.id)) throw new HttpError(409, 'That upload is already posted.');
      const mu = musicFields(me, music);
      const text = String(caption ?? '').trim().slice(0, 1000);
      const id = Number(db.prepare('INSERT INTO posts (user_id, kind, media_id, caption, created_at, music_id, music_title, music_start, music_mute) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(me.id, file.kind === 'reel' ? 'reel' : 'photo', file.id, text, Date.now(), mu.id, mu.title, mu.start, mu.mute).lastInsertRowid);
      setTags(id, text);
      sendJson(res, 201, { id });
    },

    'POST /api/posts/edit': async (req, res, me) => {
      const { post, caption } = await readJson(req);
      const row = db.prepare('SELECT id FROM posts WHERE id = ? AND user_id = ?').get(Number(post), me.id);
      if (!row) throw new HttpError(404, 'No such post');
      const text = String(caption ?? '').trim().slice(0, 1000);
      db.prepare('UPDATE posts SET caption = ?, edited_at = ? WHERE id = ?').run(text, Date.now(), row.id);
      setTags(row.id, text);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/posts/like': async (req, res, me) => {
      const { post, liked } = await readJson(req);
      const row = visiblePost(me, post);
      if (liked) {
        if (db.prepare('INSERT OR IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)').run(row.id, me.id).changes) {
          const owner = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(row.id).user_id;
          addNotification(owner, 'like', me.id, row.id);
        }
      } else db.prepare('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?').run(row.id, me.id);
      sendJson(res, 200, { liked: !!liked, likes: countOf('SELECT COUNT(*) AS n FROM post_likes WHERE post_id = ?', row.id) });
    },

    'POST /api/posts/comment': async (req, res, me) => {
      const { post, body } = await readJson(req);
      const row = visiblePost(me, post);
      const text = String(body ?? '').trim();
      if (!text || text.length > 500) throw new HttpError(400, 'Comments need 1–500 characters.');
      if (limited(`comment:${me.id}`, 30, 60000)) throw new HttpError(429, 'Slow down a little.');
      const id = Number(db.prepare('INSERT INTO post_comments (post_id, user_id, body, created_at) VALUES (?, ?, ?, ?)').run(row.id, me.id, text, Date.now()).lastInsertRowid);
      const owner = db.prepare('SELECT user_id FROM posts WHERE id = ?').get(row.id).user_id;
      addNotification(owner, 'comment', me.id, `${row.id}:${id}`, text.slice(0, 80));
      sendJson(res, 201, { id });
    },

    'POST /api/posts/share': async (req, res, me) => {
      needHuman(me);
      const { post, kind, target, note } = await readJson(req);
      const p = visiblePost(me, post);
      const meta = { post: p.id, media: p.media, mk: p.kind, by: p.username, name: p.name, cap: p.caption.slice(0, 100) };
      const text = String(note ?? '').trim().slice(0, 300);
      if (limited(`share:${me.id}`, 30, 60000)) throw new HttpError(429, 'Slow down a little.');
      if (kind === 'dm') {
        const peer = findPeer(me, target);
        if (peer.is_system || peer.is_bot) throw new HttpError(403, 'You cannot message this account.');
        if (isBlocked(me.id, peer.id) || !canMessage(me.id, peer.id)) throw new HttpError(403, "This person isn't accepting messages from you.");
        insertDm(me, peer, text, { kind: 'post', meta });
      } else if (kind === 'group') {
        needMember(me, target);
        insertGroup(Number(target), me.id, text, { kind: 'post', meta });
      } else if (kind === 'channel') {
        const { ch, m } = channelAccess(me, target);
        if (!canPost(ch, m) || m.timeoutUntil > Date.now()) throw new HttpError(403, 'You cannot post in this channel.');
        insertChannel(ch, me.id, text, { kind: 'post', meta });
      } else throw new HttpError(400, 'Choose where to share it.');
      sendJson(res, 200, { ok: true });
    },

    'GET /api/tag': (req, res, me, url) => {
      const tag = String(url.searchParams.get('tag') ?? '').toLowerCase().replace(/^#/, '').slice(0, 40);
      const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
      sendJson(res, 200, { tag, posts: db.prepare(`${postSelect(me.id)} JOIN post_tags t ON t.post_id = p.id AND t.tag = ? WHERE p.id < ? ${hiddenFrom(me.id)} ORDER BY p.id DESC LIMIT 30`).all(tag, before).map(shapePost) });
    },

    'GET /api/explore': (req, res, me) => {
      const since = Date.now() - 14 * 864e5;
      sendJson(res, 200, {
        tags: db.prepare(`SELECT t.tag, COUNT(*) AS n FROM post_tags t JOIN posts p ON p.id = t.post_id WHERE p.created_at > ? ${hiddenFrom(me.id)} GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 14`).all(since),
        posts: db.prepare(`${postSelect(me.id)} WHERE p.created_at > ? ${hiddenFrom(me.id)} ORDER BY likes DESC, p.id DESC LIMIT 30`).all(since).map(shapePost),
        people: db.prepare(`SELECT u.username, u.display_name AS name, (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, (SELECT COUNT(*) FROM follows WHERE followee_id = u.id) AS followers
          FROM users u WHERE u.is_system = 0 AND u.is_bot = 0 AND u.banned_at IS NULL AND u.id != ? AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)) ORDER BY followers DESC, u.id DESC LIMIT 8`).all(me.id, me.id, me.id, me.id),
      });
    },

    'GET /api/stories': (req, res, me) => {
      const rows = db.prepare(`SELECT p.id, p.media_id AS media, p.created_at AS at, p.music_id AS musicId, p.music_title AS musicTitle, p.music_start AS musicStart, u.id AS uid, u.username, u.display_name AS name,
        (SELECT avatar_id FROM profiles WHERE user_id = u.id) AS avatar, EXISTS (SELECT 1 FROM story_views v WHERE v.story_id = p.id AND v.user_id = ${me.id}) AS seen
        FROM stories p JOIN users u ON u.id = p.user_id WHERE p.expires_at > ? AND (p.user_id = ? OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)) ${hiddenFrom(me.id)} ORDER BY p.id`).all(Date.now(), me.id, me.id);
      const by = new Map();
      for (const r of rows) {
        if (!by.has(r.uid)) by.set(r.uid, { username: r.username, name: r.name, avatar: r.avatar, mine: r.uid === me.id, stories: [] });
        by.get(r.uid).stories.push({ id: r.id, media: r.media, at: r.at, seen: !!r.seen, musicId: r.musicId, musicTitle: r.musicTitle, musicStart: r.musicStart });
      }
      const groups = [...by.values()].map((g) => ({ ...g, allSeen: g.stories.every((s) => s.seen) }));
      sendJson(res, 200, groups.sort((a, b) => (b.mine - a.mine) || (a.allSeen - b.allSeen)));
    },

    'POST /api/stories': async (req, res, me) => {
      if (me.is_bot) throw new HttpError(403, 'Bots cannot post stories.');
      const { media: m, music } = await readJson(req);
      const media = String(m ?? '');
      if (!db.prepare("SELECT 1 FROM uploads WHERE id = ? AND user_id = ? AND kind = 'story'").get(media, me.id)) throw new HttpError(400, 'Upload a photo first.');
      if (db.prepare('SELECT 1 FROM stories WHERE media_id = ?').get(media)) throw new HttpError(409, 'That upload is already posted.');
      const mu = musicFields(me, music);
      const now = Date.now();
      const id = Number(db.prepare('INSERT INTO stories (user_id, media_id, created_at, expires_at, music_id, music_title, music_start) VALUES (?, ?, ?, ?, ?, ?, ?)').run(me.id, media, now, now + 24 * 3600e3, mu.id, mu.title, mu.start).lastInsertRowid);
      sendJson(res, 201, { id });
    },

    'GET /api/search': (req, res, me, url) => {
      const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (q.length < 2 || q.length > 50) throw new HttpError(400, 'Search needs 2 to 50 characters.');
      const p = likePattern(q);
      const staffOnly = "(c.private = 0 OR cm.role != 'member')";
      sendJson(res, 200, {
        people: db.prepare("SELECT username, display_name AS name FROM users WHERE is_system = 0 AND is_bot = 0 AND banned_at IS NULL AND id != ? AND (username LIKE ? ESCAPE '!' OR display_name LIKE ? ESCAPE '!') LIMIT 20").all(me.id, p, p),
        tags: db.prepare(`SELECT t.tag, COUNT(*) AS n FROM post_tags t JOIN posts p ON p.id = t.post_id WHERE t.tag LIKE ? ESCAPE '!' ${hiddenFrom(me.id)} GROUP BY t.tag ORDER BY n DESC LIMIT 10`).all(likePattern(q.replace(/^#/, ''))),
        groups: db.prepare("SELECT g.id, g.name FROM groups g JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? WHERE g.name LIKE ? ESCAPE '!' LIMIT 20").all(me.id, p),
        communities: db.prepare("SELECT c.id, c.name FROM communities c JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ? WHERE c.name LIKE ? ESCAPE '!' LIMIT 20").all(me.id, p),
        channels: db.prepare(`SELECT c.id, c.name, co.name AS community FROM channels c JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = ?
          JOIN communities co ON co.id = c.community_id WHERE c.name LIKE ? ESCAPE '!' AND ${staffOnly} LIMIT 20`).all(me.id, p),
        messages: [
          ...db.prepare(`SELECT 'dm' AS kind, u.username AS target, u.display_name AS where_, m.body, m.created_at AS at FROM messages m
            JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
            WHERE (m.sender_id = ? OR m.recipient_id = ?) AND m.kind != 'e2ee' AND m.body LIKE ? ESCAPE '!' ORDER BY m.id DESC LIMIT 20`).all(me.id, me.id, me.id, p),
          ...db.prepare(`SELECT 'group' AS kind, CAST(x.group_id AS TEXT) AS target, g.name AS where_, x.body, x.created_at AS at FROM group_messages x
            JOIN group_members gm ON gm.group_id = x.group_id AND gm.user_id = ? JOIN groups g ON g.id = x.group_id
            WHERE x.body LIKE ? ESCAPE '!' ORDER BY x.id DESC LIMIT 20`).all(me.id, p),
          ...db.prepare(`SELECT 'channel' AS kind, CAST(x.channel_id AS TEXT) AS target, '#' || c.name || ' in ' || co.name AS where_, x.body, x.created_at AS at FROM channel_messages x
            JOIN channels c ON c.id = x.channel_id JOIN community_members cm ON cm.community_id = c.community_id AND cm.user_id = ?
            JOIN communities co ON co.id = c.community_id WHERE x.body LIKE ? ESCAPE '!' AND ${staffOnly} ORDER BY x.id DESC LIMIT 20`).all(me.id, p),
        ].sort((a, b) => b.at - a.at).slice(0, 30),
      });
    },

    // ---- profile, prefs, privacy, onboarding
    'GET /api/profile': (req, res, me, url) => {
      const u = db.prepare('SELECT id, username, display_name, is_owner, site_role, is_bot FROM users WHERE username = ? AND is_system = 0').get(String(url.searchParams.get('user') || me.username).toLowerCase());
      if (!u) throw new HttpError(404, 'No such user');
      prefsOf(u.id);
      const p = db.prepare('SELECT bio, status, accent, avatar_id AS avatar, banner_id AS banner, private, interests FROM profiles WHERE user_id = ?').get(u.id);
      const isFollowing = !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(me.id, u.id);
      const self = u.id === me.id;
      sendJson(res, 200, { username: u.username, displayName: u.display_name, bio: p.bio, status: p.status, accent: p.accent, avatar: p.avatar, banner: p.banner, private: !!p.private, interests: JSON.parse(p.interests || '[]'),
        tag: tagOf(u), friend: self ? 'self' : friendStatus(me.id, u.id), canSee: self || !p.private || isFollowing,
        requested: !!db.prepare('SELECT 1 FROM follow_requests WHERE follower_id = ? AND followee_id = ?').get(me.id, u.id),
        posts: countOf('SELECT COUNT(*) AS n FROM posts WHERE user_id = ?', u.id), followers: countOf('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?', u.id),
        following: countOf('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?', u.id), isFollowing,
        followsYou: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(u.id, me.id),
        badges: db.prepare('SELECT b.id, b.name, b.description FROM user_badges ub JOIN badges b ON b.id = ub.badge_id WHERE ub.user_id = ? ORDER BY ub.at').all(u.id),
        cosmetics: db.prepare('SELECT i.kind, i.id, i.name, i.value FROM equipped e JOIN items i ON i.id = e.item_id WHERE e.user_id = ?').all(u.id) });
    },

    'POST /api/profile': async (req, res, me) => {
      const { bio, status, displayName, interests } = await readJson(req);
      prefsOf(me.id);
      db.prepare('UPDATE profiles SET bio = ?, status = ? WHERE user_id = ?').run(String(bio ?? '').trim().slice(0, 200), String(status ?? '').trim().slice(0, 60), me.id);
      if (Array.isArray(interests)) db.prepare('UPDATE profiles SET interests = ? WHERE user_id = ?').run(JSON.stringify([...new Set(interests.map((i) => String(i).trim().toLowerCase().slice(0, 24)).filter(Boolean))].slice(0, 12)), me.id);
      const name = String(displayName ?? '').trim().slice(0, 40);
      if (name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, me.id);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/prefs': async (req, res, me) => {
      const { theme, accent, density, reduceMotion, plain, custom, vizStyle, vizColor } = await readJson(req);
      if (!['dark', 'light', 'system'].includes(theme) || !['comfortable', 'compact'].includes(density)) throw new HttpError(400, 'Unknown theme or density.');
      if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) throw new HttpError(400, 'Accent must be a hex colour like #b7c9e6.');
      if (vizStyle !== undefined && !['none', 'ring', 'cd', 'bars', 'wave', 'pulse', 'orbit'].includes(vizStyle)) throw new HttpError(400, 'Unknown call visual.');
      if (vizColor && !/^#[0-9a-f]{6}$/i.test(vizColor)) throw new HttpError(400, 'Colour must look like #b7c9e6.');
      const old = prefsOf(me.id);
      const nextCustom = custom === undefined ? old.custom : cleanCustom(me, custom, old.custom);
      db.prepare('UPDATE profiles SET theme = ?, accent = ?, density = ?, reduce_motion = ?, plain = ?, custom = ?, viz_style = ?, viz_color = ? WHERE user_id = ?')
        .run(theme, accent || null, density, reduceMotion ? 1 : 0, plain ? 1 : 0, JSON.stringify(nextCustom), vizStyle ?? old.vizStyle, vizColor === undefined ? old.vizColor : vizColor || null, me.id);
      sendJson(res, 200, prefsOf(me.id));
    },

    'POST /api/privacy': async (req, res, me) => {
      const { whoCanMessage, previews, dnd, private: isPrivate } = await readJson(req);
      if (!['everyone', 'friends', 'groups', 'nobody'].includes(whoCanMessage)) throw new HttpError(400, 'Unknown setting.');
      prefsOf(me.id);
      db.prepare('UPDATE profiles SET who_can_message = ?, previews = ?, dnd = ? WHERE user_id = ?').run(whoCanMessage, previews ? 1 : 0, dnd ? 1 : 0, me.id);
      if (typeof isPrivate === 'boolean') {
        db.prepare('UPDATE profiles SET private = ? WHERE user_id = ?').run(isPrivate ? 1 : 0, me.id);
        if (!isPrivate) {
          for (const r of db.prepare('SELECT follower_id FROM follow_requests WHERE followee_id = ?').all(me.id)) { db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)').run(r.follower_id, me.id, Date.now()); addNotification(r.follower_id, 'follow_accept', me.id); }
          db.prepare('DELETE FROM follow_requests WHERE followee_id = ?').run(me.id);
        }
      }
      sendJson(res, 200, privacyOf(me.id));
    },

    'POST /api/onboarding/done': (req, res, me) => { prefsOf(me.id); db.prepare('UPDATE profiles SET onboarded = 1 WHERE user_id = ?').run(me.id); sendJson(res, 200, { ok: true }); },

    'GET /api/me': (req, res, me) => sendJson(res, 200, { username: me.username, displayName: me.display_name, isOwner: !!me.is_owner, isBot: !!me.is_bot, role: siteRole(me), perms: sitePerms(me), birthday: me.birthday, avatar: avatarOf(me.id),
      ignored: db.prepare('SELECT u.username FROM ignores i JOIN users u ON u.id = i.ignored_id WHERE i.user_id = ?').all(me.id).map((r) => r.username), prefs: prefsOf(me.id), privacy: privacyOf(me.id), sound: soundOf(me.id),
      mutes: db.prepare('SELECT kind, target FROM mutes WHERE user_id = ?').all(me.id), unread: unreadCount(me.id),
      friendRequests: countOf("SELECT COUNT(*) AS n FROM friendships WHERE (a = ? OR b = ?) AND status = 'pending' AND requester != ?", me.id, me.id, me.id) }),

    'POST /api/sparks/send': async (req, res, me) => {
      needHuman(me);
      const { username, amount } = await readJson(req);
      const user = userNamed(username);
      const n = Number(amount);
      if (user.id === me.id || !Number.isInteger(n) || n < 1 || n > 500) throw new HttpError(400, 'Send between 1 and 500.');
      if (!areFriends(me.id, user.id)) throw new HttpError(403, `You can only send ${currency} to friends.`);
      tx(() => {
        if (balanceOf(me.id) < n) throw new HttpError(402, `Not enough ${currency}.`);
        const ref = crypto.randomUUID();
        award(me.id, -n, `Sent to ${user.username}`, `tip-out:${ref}`);
        award(user.id, n, `Gift from ${me.username}`, `tip-in:${ref}`);
      });
      addNotification(user.id, 'tip', me.id, crypto.randomUUID(), `${n}`);
      sendJson(res, 200, { balance: balanceOf(me.id) });
    },

    // ---- site staff
    'GET /api/owner/stats': (req, res, me) => {
      needSite(me, 'users');
      const day = Date.now() - 864e5;
      sendJson(res, 200, {
        users: countOf('SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND is_bot = 0'),
        newUsers7d: countOf('SELECT COUNT(*) AS n FROM users WHERE is_system = 0 AND is_bot = 0 AND created_at > ?', Date.now() - 7 * 864e5),
        online: [...streams.values()].filter((set) => set.size).length,
        bots: db.prepare('SELECT COUNT(*) AS n FROM bot_installs').get().n,
        banned: countOf('SELECT COUNT(*) AS n FROM users WHERE banned_at IS NOT NULL'),
        groups: countOf('SELECT COUNT(*) AS n FROM groups'),
        communities: countOf('SELECT COUNT(*) AS n FROM communities'),
        messages: countOf('SELECT COUNT(*) AS n FROM messages WHERE sender_id != ?', teamsId) + countOf('SELECT COUNT(*) AS n FROM group_messages'),
        messages24h: countOf('SELECT COUNT(*) AS n FROM messages WHERE sender_id != ? AND created_at > ?', teamsId, day) + countOf('SELECT COUNT(*) AS n FROM group_messages WHERE created_at > ?', day),
        audit: db.prepare('SELECT a.action, a.target, a.detail, a.at, u.username AS actor FROM audit a JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 15').all(),
      });
    },

    'GET /api/owner/users': (req, res, me, url) => {
      needSite(me, 'users');
      const q = likePattern(String(url.searchParams.get('q') ?? '').toLowerCase().trim());
      sendJson(res, 200, db.prepare(`SELECT username, display_name AS displayName, created_at AS createdAt, banned_at AS bannedAt, is_bot AS isBot, site_role AS role
        FROM users WHERE is_system = 0 AND is_owner = 0 AND is_bot = 0 AND (username LIKE ? ESCAPE '!' OR lower(display_name) LIKE ? ESCAPE '!') ORDER BY id DESC LIMIT 50`).all(q, q));
    },

    'POST /api/owner/warn': async (req, res, me) => {
      needSite(me, 'warn');
      const { username, reason } = await readJson(req);
      const user = userNamed(username);
      const why = String(reason ?? '').trim().slice(0, 300);
      if (!why) throw new HttpError(400, 'A reason is required.');
      notify(user.id, `Official warning: ${why}. Repeated violations may lead to suspension.`);
      audit(me, 'warn', user.username, why);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/owner/ban': async (req, res, me) => {
      needSite(me, 'ban');
      const { username, reason } = await readJson(req);
      const user = db.prepare('SELECT id, username, is_owner, is_system, site_role FROM users WHERE username = ?').get(String(username ?? '').toLowerCase());
      if (!user) throw new HttpError(404, `No user called ${username}`);
      const why = String(reason ?? '').trim().slice(0, 300);
      if (!why) throw new HttpError(400, 'A reason is required.');
      if (user.is_owner || user.is_system || SITE_RANK[user.site_role] >= SITE_RANK[siteRole(me)]) throw new HttpError(403, 'That account cannot be suspended.');
      notify(user.id, `Your account has been suspended: ${why}.`);
      db.prepare('UPDATE users SET banned_at = ?, banned_reason = ? WHERE id = ?').run(Date.now(), why, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      push(user.id, 'banned', { reason: why });
      rooms.leave(user.id, 'suspended');
      for (const stream of streams.get(user.id) ?? []) stream.end();
      audit(me, 'ban', user.username, why);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/owner/unban': async (req, res, me) => {
      needSite(me, 'ban');
      const user = userNamed((await readJson(req)).username);
      db.prepare('UPDATE users SET banned_at = NULL, banned_reason = NULL WHERE id = ?').run(user.id);
      notify(user.id, 'Your account has been restored. Welcome back.');
      audit(me, 'unban', user.username);
      sendJson(res, 200, { ok: true });
    },

    'POST /api/owner/announce': async (req, res, me) => {
      needSite(me, 'announce');
      const text = String((await readJson(req)).text ?? '').trim().slice(0, 1000);
      if (!text) throw new HttpError(400, 'Write an announcement first.');
      const ids = db.prepare('SELECT id FROM users WHERE is_system = 0 AND is_bot = 0 AND banned_at IS NULL').all();
      ids.forEach(({ id }) => notify(id, text, 'announcement'));
      audit(me, 'announce', `${ids.length} users`, text);
      sendJson(res, 200, { sent: ids.length });
    },

    'POST /api/owner/sparks': async (req, res, me) => {
      needSite(me, 'sparks');
      const { username, amount, reason } = await readJson(req);
      const user = userNamed(username);
      const delta = Number(amount);
      if (!Number.isInteger(delta) || !delta || Math.abs(delta) > 10000) throw new HttpError(400, 'Amount must be a non-zero whole number up to 10000.');
      if (balanceOf(user.id) + delta < 0) throw new HttpError(400, 'That would make the balance negative.');
      const why = reasonOf(reason) || 'Adjustment by Scrxaper Teams';
      award(user.id, delta, why, `owner:${crypto.randomUUID()}`);
      audit(me, 'sparks', user.username, `${delta}: ${why}`);
      if (delta > 0) addNotification(user.id, 'sparks', me.id, crypto.randomUUID(), `${delta}`);
      sendJson(res, 200, { balance: balanceOf(user.id) });
    },

    'POST /api/owner/role': async (req, res, me) => {
      needSite(me, 'staff');
      const { username, role } = await readJson(req);
      if (!['user', 'staff', 'admin'].includes(role)) throw new HttpError(400, 'Choose user, staff or admin.');
      if (role === 'admin') needSite(me, 'admin');
      const user = db.prepare('SELECT id, username, is_owner, is_system, is_bot, site_role FROM users WHERE username = ?').get(String(username ?? '').toLowerCase());
      if (!user || user.is_system || user.is_bot) throw new HttpError(404, `No user called ${username}`);
      if (user.is_owner || user.id === me.id) throw new HttpError(403, 'That role cannot be changed.');
      if (user.site_role === 'admin' && !me.is_owner) throw new HttpError(403, 'Only the owner can change an admin.');
      db.prepare('UPDATE users SET site_role = ? WHERE id = ?').run(role, user.id);
      syncRoleBadge(user.id, role);
      audit(me, 'role', user.username, role);
      notify(user.id, role === 'user' ? 'Your Scrxaper staff role was removed.' : `You are now ${role === 'admin' ? 'an admin' : 'staff'} on Scrxaper.`);
      sendJson(res, 200, { role });
    },

    // ---- premade bots
    'GET /api/bots/catalog': (req, res, me, url) => {
      const { scope, id } = botScope(me, url.searchParams.get('scope'), url.searchParams.get('id'));
      const installed = installedBots(scope, id);
      sendJson(res, 200, { bots: BOT_CATALOG.map((b) => ({ ...b, installed: !!installed[b.id], config: installed[b.id] ?? b.defaults,
        tracks: b.id === 'jukebox' ? db.prepare('SELECT id, title FROM bot_tracks WHERE scope = ? AND scope_id = ? ORDER BY id').all(scope, id) : undefined })) });
    },

    'POST /api/bots/install': async (req, res, me) => {
      const { scope: sc, id: sid, bot, config } = await readJson(req);
      const { scope, id } = botScope(me, sc, sid);
      const cfg = applyConfig(bot, config ?? {});
      if (!cfg) throw new HttpError(404, 'No such bot');
      const fresh = !installedBots(scope, id)[bot];
      db.prepare('INSERT INTO bot_installs (scope, scope_id, bot, config, installed_by, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, scope_id, bot) DO UPDATE SET config = excluded.config')
        .run(scope, id, bot, JSON.stringify(cfg), me.id, Date.now());
      if (scope === 'community') logMod(id, me, fresh ? 'add-bot' : 'configure-bot', bot);
      if (fresh) {
        const target = greetTarget(scope, id);
        const intro = { sentinel: 'Sentinel is on watch. Blocked messages are logged for moderators.', jukebox: 'Jukebox is here. Use !tracks to see the playlist and !play to start.',
          greeter: 'Greeter will welcome new people.', funbot: 'Funbot is here. Try !help.' }[bot];
        if (target && intro) botSay(target, bot, intro);
      }
      scope === 'community' ? pushCommunity(id) : pushGroup(id, 'group', { id });
      sendJson(res, 200, { ok: true, config: cfg });
    },

    'POST /api/bots/remove': async (req, res, me) => {
      const { scope: sc, id: sid, bot } = await readJson(req);
      const { scope, id } = botScope(me, sc, sid);
      db.prepare('DELETE FROM bot_installs WHERE scope = ? AND scope_id = ? AND bot = ?').run(scope, id, bot);
      if (bot === 'jukebox') { music.delete(`${scope}:${id}`); musicBroadcast(scope, id); }
      if (scope === 'community') { logMod(id, me, 'remove-bot', bot); pushCommunity(id); } else pushGroup(id, 'group', { id });
      sendJson(res, 200, { ok: true });
    },

    'POST /api/bots/music/upload': async (req, res, me, url) => {
      needHuman(me);
      const { scope, id } = botScope(me, url.searchParams.get('scope'), url.searchParams.get('id'));
      if (!installedBots(scope, id).jukebox) throw new HttpError(400, 'Add the Jukebox bot first.');
      if (countOf('SELECT COUNT(*) AS n FROM bot_tracks WHERE scope = ? AND scope_id = ?', scope, id) >= 30) throw new HttpError(409, 'Jukebox holds up to 30 tracks.');
      if (limited(`track:${me.id}`, 40, 3600e3)) throw new HttpError(429, 'Too many uploads. Try again later.');
      const body = await readBytes(req, 10 * 1024 * 1024);
      const mimeType = sniffAudio(body);
      if (!mimeType) throw new HttpError(400, 'Upload an MP3, WAV, OGG, M4A, AAC or FLAC file.');
      const uploadId = crypto.randomBytes(16).toString('hex');
      const title = (cleanFileName(url.searchParams.get('name')) ?? 'Untitled').replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 60) || 'Untitled';
      storeFile(uploadId, body);
      registerUpload(uploadId, me.id, 'track', mimeType, body.length, title);
      const trackId = Number(db.prepare('INSERT INTO bot_tracks (scope, scope_id, upload_id, title, added_by, at) VALUES (?, ?, ?, ?, ?, ?)').run(scope, id, uploadId, title, me.id, Date.now()).lastInsertRowid);
      sendJson(res, 201, { id: trackId, title });
    },

    'POST /api/bots/music/delete': async (req, res, me) => {
      const { scope: sc, id: sid, track } = await readJson(req);
      const { scope, id } = botScope(me, sc, sid);
      const t = db.prepare('SELECT id, upload_id FROM bot_tracks WHERE id = ? AND scope = ? AND scope_id = ?').get(Number(track), scope, id);
      if (!t) throw new HttpError(404, 'No such track');
      db.prepare('DELETE FROM bot_tracks WHERE id = ?').run(t.id);
      removeFile(t.upload_id);
      const st = music.get(`${scope}:${id}`);
      if (st?.upload === t.upload_id) { music.delete(`${scope}:${id}`); musicBroadcast(scope, id); }
      sendJson(res, 200, { ok: true });
    },

    'GET /api/music/state': (req, res, me, url) => {
      const scope = url.searchParams.get('scope'); const id = Number(url.searchParams.get('id'));
      if (scope === 'group') needMember(me, id); else if (scope === 'community') needCMember(me, id); else throw new HttpError(400, 'Unknown scope.');
      sendJson(res, 200, { now: musicView(`${scope}:${id}`), serverNow: Date.now() });
    },

    'POST /api/music/ended': async (req, res, me) => {
      const { scope, id, upload } = await readJson(req);
      if (scope === 'group') needMember(me, Number(id)); else if (scope === 'community') needCMember(me, Number(id)); else throw new HttpError(400, 'Unknown scope.');
      const st = music.get(`${scope}:${Number(id)}`);
      if (st?.upload === upload && Date.now() - st.startedAt > 1500) nextTrack(scope, Number(id));
      sendJson(res, 200, { ok: true });
    },

    // ---- web push
    'GET /api/push/key': (req, res) => sendJson(res, 200, { publicKey: getVapid().publicKey }),

    'POST /api/push/subscribe': async (req, res, me) => {
      needHuman(me);
      const { subscription } = await readJson(req);
      const endpoint = String(subscription?.endpoint ?? '');
      const k = subscription?.keys ?? {};
      let parsed;
      try { parsed = new URL(endpoint); } catch { throw new HttpError(400, 'That subscription is not valid.'); }
      if (!(parsed.protocol === 'https:' || (allowPrivateWebhooks && parsed.protocol === 'http:')) || endpoint.length > 600 || typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 60)
        throw new HttpError(400, 'That subscription is not valid.');
      if (countOf('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', me.id) >= 10) db.prepare('DELETE FROM push_subs WHERE id = (SELECT MIN(id) FROM push_subs WHERE user_id = ?)').run(me.id);
      db.prepare('INSERT INTO push_subs (user_id, endpoint, p256dh, auth, ua, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth')
        .run(me.id, endpoint, k.p256dh, k.auth, String(req.headers['user-agent'] ?? '').slice(0, 120), Date.now());
      sendJson(res, 201, { ok: true });
    },

    'POST /api/push/unsubscribe': async (req, res, me) => {
      const { endpoint } = await readJson(req);
      if (endpoint) db.prepare('DELETE FROM push_subs WHERE user_id = ? AND endpoint = ?').run(me.id, String(endpoint)); else db.prepare('DELETE FROM push_subs WHERE user_id = ?').run(me.id);
      sendJson(res, 200, { ok: true });
    },

    'GET /api/push/status': (req, res, me) => sendJson(res, 200, { subscriptions: countOf('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', me.id) }),

    // ---- secret chats (end-to-end encrypted 1:1 text; the server only stores public keys and ciphertext)
    'POST /api/e2ee/key': async (req, res, me) => {
      needHuman(me);
      const { jwk } = await readJson(req);
      if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || jwk.x.length > 64 || jwk.y.length > 64) throw new HttpError(400, 'That is not a valid public key.');
      const clean = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
      const id = crypto.createHash('sha256').update(JSON.stringify(clean)).digest('hex').slice(0, 16);
      if (countOf('SELECT COUNT(*) AS n FROM e2ee_keys WHERE user_id = ?', me.id) >= 50) throw new HttpError(409, 'Too many keys.');
      db.prepare('INSERT OR IGNORE INTO e2ee_keys (user_id, key_id, jwk, at) VALUES (?, ?, ?, ?)').run(me.id, id, JSON.stringify(clean), Date.now());
      db.prepare('UPDATE e2ee_keys SET at = ? WHERE user_id = ? AND key_id = ?').run(Date.now(), me.id, id);
      sendJson(res, 200, { id });
    },

    'GET /api/e2ee/key': (req, res, me, url) => {
      const peer = findPeer(me, url.searchParams.get('user'));
      const wanted = url.searchParams.get('id');
      const row = wanted ? db.prepare('SELECT key_id, jwk FROM e2ee_keys WHERE user_id = ? AND key_id = ?').get(peer.id, wanted)
        : db.prepare('SELECT key_id, jwk FROM e2ee_keys WHERE user_id = ? ORDER BY at DESC LIMIT 1').get(peer.id);
      sendJson(res, 200, row ? { id: row.key_id, jwk: JSON.parse(row.jwk) } : { id: null, jwk: null });
    },

    'GET /api/events': (req, res, me) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      if (!streams.has(me.id)) streams.set(me.id, new Set());
      streams.get(me.id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        streams.get(me.id)?.delete(res);
        if (!streams.get(me.id)?.size) { const t = setTimeout(() => { if (!streams.get(me.id)?.size) rooms.leave(me.id, 'disconnected'); }, 8000); t.unref(); }
      });
    },
  });


  const serveStatic = async (res, pathname, viewer) => {
    if (pathname === '/download/android') {
      if (!apkUrl || !/^https:\/\//.test(apkUrl)) throw new HttpError(404, 'The Android app has not been published yet.');
      res.writeHead(302, { Location: apkUrl, 'Cache-Control': 'no-store' });
      return res.end();
    }
    let file = path.normalize(pathname);
    if (file === '/' ) file = viewer ? '/index.html' : '/landing.html';
    if (file === '/app' || file === '/app/') file = '/index.html';
    const full = path.join(publicDir, file);
    if (!full.startsWith(publicDir + path.sep)) throw new HttpError(404, 'Not found');
    try {
      const data = await readFile(full);
      res.writeHead(200, { 'Content-Type': mime[path.extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch { throw new HttpError(404, 'Not found'); }
  };

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      if (url.pathname === '/healthz') {
        db.prepare('SELECT 1').get();
        return sendJson(res, 200, { status: 'ok' });
      }
      if (url.pathname.startsWith('/files/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        const viewer = currentUser(req);
        if (!viewer) throw new HttpError(401, 'Sign in required.');
        const id = url.pathname.slice(7);
        const file = /^[a-f0-9]{32}$/.test(id) && db.prepare('SELECT mime, kind, label, user_id AS owner FROM uploads WHERE id = ?').get(id);
        if (!file || !canView(viewer, id, file)) throw new HttpError(404, 'Not found');
        const full = path.join(uploadDir, id);
        let size;
        try { size = statSync(full).size; } catch { throw new HttpError(404, 'Not found'); }
        const inline = /^(image|audio|video)\//.test(file.mime) && file.mime !== 'image/svg+xml';
        const headers = { 'Content-Type': inline ? file.mime : 'application/octet-stream',
          'Content-Disposition': inline ? 'inline' : `attachment; filename*=UTF-8''${encodeURIComponent(file.label || 'file')}`, 'Accept-Ranges': 'bytes',
          'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': file.kind === 'story' ? 'private, no-store' : 'private, max-age=86400, immutable' };
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        let start = 0; let end = size - 1; let status = 200;
        if (range && (range[1] || range[2])) {
          start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
          end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
          status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        }
        res.writeHead(status, { ...headers, 'Content-Length': end - start + 1 });
        if (size === 0) return res.end();
        const stream = createReadStream(full, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        return stream.pipe(res);
      }
      if (url.pathname.startsWith('/api/')) {
        const handler = routes[`${req.method} ${url.pathname}`];
        if (!handler) throw new HttpError(404, 'Not found');
        if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'scrxaper') throw new HttpError(403, 'Forbidden');
        const open = url.pathname === '/api/register' || url.pathname === '/api/login' || url.pathname === '/api/logout';
        const me = open ? null : currentUser(req);
        if (!open && !me) throw new HttpError(401, 'Sign in required.');
        return await handler(req, res, me, url);
      }
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      await serveStatic(res, url.pathname, currentUser(req));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(JSON.stringify({ level: 'error', requestId, path: url.pathname, message: err.message }));
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong.' : err.message, ...(err.extra ?? {}) });
    }
  });

  const close = () => new Promise((resolve) => {
    clearInterval(birthdayTimer);
    clearInterval(storyTimer);
    for (const set of streams.values()) for (const res of set) res.end();
    server.close(() => { db.close(); resolve(); });
    server.closeAllConnections?.();
  });
  return { server, db, close, runBirthdays, sweepStories, pushStats };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT) || 3000;
  app.server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', message: `listening on ${port}` })));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
}
