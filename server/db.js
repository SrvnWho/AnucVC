import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANUCVC_DB_PATH lets tests (or a second instance) use a separate database
// file instead of the real one next to this file.
export const dbPath = process.env.ANUCVC_DB_PATH
  ? path.resolve(process.env.ANUCVC_DB_PATH)
  : path.join(__dirname, 'anucvc.db');

function initDbInstance() {
  try {
    const instance = new Database(dbPath);
    instance.pragma('journal_mode = WAL');
    instance.pragma('synchronous = NORMAL');
    instance.pragma('temp_store = MEMORY');
    return instance;
  } catch (err) {
    if (err.message && (err.message.includes('malformed') || err.code === 'SQLITE_CORRUPT')) {
      console.error('⚠️ Bozuk SQLite veritabanı tespit edildi! Otomatik temizlenip sıfırdan oluşturuluyor...');
      try {
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
        if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
      } catch (e) {}
      const instance = new Database(dbPath);
      instance.pragma('journal_mode = WAL');
      instance.pragma('synchronous = NORMAL');
      instance.pragma('temp_store = MEMORY');
      return instance;
    }
    throw err;
  }
}

const db = initDbInstance();

// Prepared-statement cache. better-sqlite3 does NOT cache compiled statements,
// so calling q() inline on every query (as this file used to) forced
// SQLite to re-parse and re-plan the same SQL on every single message, login
// and broadcast. On the low-power phone this server runs on that was a
// measurable share of CPU time. q() compiles each distinct SQL string once.
const stmtCache = new Map();
function q(sql) {
  let stmt = stmtCache.get(sql);
  if (!stmt) {
    stmt = db['prepare'](sql);
    stmtCache.set(sql, stmt);
  }
  return stmt;
}

function closeDbGracefully() {
  try {
    if (db && db.open) {
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    }
  } catch (e) {}
}

process.on('SIGINT', () => { closeDbGracefully(); process.exit(0); });
process.on('SIGTERM', () => { closeDbGracefully(); process.exit(0); });

// Initialize database schema
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    avatar TEXT,
    bio TEXT,
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text'
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    username TEXT NOT NULL,
    content TEXT,
    image_data TEXT,
    reply_to TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id INTEGER NOT NULL,
    receiver_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(sender_id, receiver_id)
  );

  CREATE TABLE IF NOT EXISTS friends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id1 INTEGER NOT NULL,
    user_id2 INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id1, user_id2)
  );

  CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, username, emoji)
  );

  CREATE TABLE IF NOT EXISTS dm_read_state (
    room_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    last_read_message_id INTEGER NOT NULL,
    UNIQUE(room_id, user_id)
  );
`);

// Migration helper: add role column if table already exists without it
try {
  db.exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';`);
} catch (e) {
  // Column already exists
}

// Migration helper: add avatar column if table already exists without it
try {
  db.exec(`ALTER TABLE users ADD COLUMN avatar TEXT;`);
} catch (e) {
  // Column already exists
}

// Migration helper: add bio column if table already exists without it
try {
  db.exec(`ALTER TABLE users ADD COLUMN bio TEXT;`);
} catch (e) {
  // Column already exists
}

// Migration helper: add banner column if table already exists without it
try {
  db.exec(`ALTER TABLE users ADD COLUMN banner TEXT;`);
} catch (e) {
  // Column already exists
}

// Migration helper: add status_text column (custom status message) if missing
try {
  db.exec(`ALTER TABLE users ADD COLUMN status_text TEXT;`);
} catch (e) {
  // Column already exists
}

// Migration helper: add image_data and reply_to columns if table already exists without them
const msgCols = q(`PRAGMA table_info(messages)`).all().map(c => c.name);
if (!msgCols.includes('image_data')) {
  try { db.exec(`ALTER TABLE messages ADD COLUMN image_data TEXT;`); } catch (e) {}
}
if (!msgCols.includes('reply_to')) {
  try { db.exec(`ALTER TABLE messages ADD COLUMN reply_to TEXT;`); } catch (e) {}
}

// Insert default rooms if table is empty
const countStmt = q('SELECT COUNT(*) as count FROM rooms');
const { count } = countStmt.get();

if (count === 0) {
  const insertRoom = q('INSERT INTO rooms (id, name, type) VALUES (?, ?, ?)');
  const defaultRooms = [
    { id: 'genel', name: 'genel', type: 'text' },
    { id: 'duyurular', name: 'duyurular', type: 'text' },
    { id: 'ses-1', name: '🔊 Ses Odası 1', type: 'voice' },
    { id: 'ses-2', name: '🔊 Ses Odası 2', type: 'voice' }
  ];
  for (const room of defaultRooms) {
    insertRoom.run(room.id, room.name, room.type);
  }
}

// Password Hashing Helper using native Node.js scrypt
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

// Async variant for request handlers. scryptSync blocks the whole event loop
// for the duration of the hash (tens of ms on the low-power host), which
// stalled every socket - voice signaling included - on each login, and let a
// burst of login attempts freeze the server outright. This runs on libuv's
// thread pool instead.
function hashPasswordAsync(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve({ hash: derived.toString('hex'), salt });
    });
  });
}

// Constant-time comparison of two hex digests.
function hashesMatch(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Usernames show up in mentions, notifications and every message, so they
// are limited to letters (any script), digits, spaces and _ . - ; "all" and
// "everyone" are reserved for @-mentions.
const USERNAME_RE = /^[\p{L}\p{N}_.\- ]{2,32}$/u;
const RESERVED_USERNAMES = new Set(['all', 'everyone']);

export function validateUsername(raw) {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (!name) throw new Error('Kullanıcı adı boş olamaz.');
  if (!USERNAME_RE.test(name)) {
    throw new Error('Kullanıcı adı 2-32 karakter olmalı; sadece harf, rakam, boşluk, _ . - kullanılabilir.');
  }
  if (RESERVED_USERNAMES.has(name.toLowerCase())) throw new Error('Bu kullanıcı adı kullanılamaz.');
  return name;
}

// Seed the AnucAI bot account once. It logs in via nothing (random unusable
// password) and only ever posts through saveMessage() from the server side,
// but needs a real row so it shows up in @mentions, avatars, message
// history etc. through the exact same code paths as a normal user.
export const AI_BOT_USERNAME = 'AnucAI';
(function ensureBotUser() {
  const existing = q('SELECT id FROM users WHERE LOWER(username) = ?').get(AI_BOT_USERNAME.toLowerCase());
  if (existing) return;
  const { hash, salt } = hashPassword(crypto.randomBytes(32).toString('hex'));
  q("INSERT INTO users (email, username, password_hash, salt, role, bio) VALUES (?, ?, ?, ?, 'bot', ?)")
    .run('anucai@anucvc.bot', AI_BOT_USERNAME, hash, salt, 'AnucVC\'nin resmi maskotu 🌰');
})();

// User Authentication DB Functions
export const registerUser = async (email, password, rawUsername) => {
  const normalizedEmail = String(email).toLowerCase().trim();
  const username = validateUsername(rawUsername);

  // Check if email already exists
  const existingUser = q('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existingUser) {
    throw new Error('Bu e-posta adresi ile zaten bir hesap var.');
  }

  // Check if username already exists (case-insensitive)
  const existingUsername = q('SELECT id FROM users WHERE LOWER(username) = ?').get(username.toLowerCase());
  if (existingUsername) {
    throw new Error('Bu kullanıcı adı zaten alınmış.');
  }

  const { hash, salt } = await hashPasswordAsync(password);

  // Re-checked after the (async) hash: two sign-ups racing for the same
  // email/username could otherwise both pass the checks above.
  if (q('SELECT id FROM users WHERE email = ? OR LOWER(username) = ?').get(normalizedEmail, username.toLowerCase())) {
    throw new Error('Bu e-posta adresi veya kullanıcı adı zaten kullanılıyor.');
  }

  // First real (non-bot) registered user gets 'admin' role automatically
  const userCount = q("SELECT COUNT(*) as count FROM users WHERE role != 'bot'").get().count;
  const role = userCount === 0 ? 'admin' : 'user';

  const stmt = q('INSERT INTO users (email, username, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)');
  const result = stmt.run(normalizedEmail, username, hash, salt, role);

  // Auto-friend AnucAI and drop a welcome DM, waiting the first time the new
  // user opens their DMs. The friend row is what makes the bot show up in
  // the friends dashboard / recent-DMs sidebar at all (both are friend-list
  // driven) - the bot isn't connected via a socket at registration time, so
  // the message just needs to exist in the DB for history to pick up later.
  const botUser = q('SELECT id FROM users WHERE LOWER(username) = ?').get(AI_BOT_USERNAME.toLowerCase());
  if (botUser && botUser.id !== result.lastInsertRowid) {
    const u1 = Math.min(result.lastInsertRowid, botUser.id);
    const u2 = Math.max(result.lastInsertRowid, botUser.id);
    q('INSERT OR IGNORE INTO friends (user_id1, user_id2) VALUES (?, ?)').run(u1, u2);

    const dmRoom = getOrCreateDMRoom(result.lastInsertRowid, botUser.id);
    const welcomeText = `Selam ${username}, ben Anuc, demek bu uygulamaya bir şans verdin eğer bir sorun olursa şarkı söylemeyi bırakıp sana yardımcı olabilirim. Chestnuts roasting on an open fire...`;
    saveMessage(dmRoom.id, AI_BOT_USERNAME, welcomeText, null, null);
  }

  return {
    id: Number(result.lastInsertRowid),
    email: normalizedEmail,
    username,
    avatar: null,
    bio: '',
    banner: null,
    status: '',
    role: role
  };
};

export const deleteUserByAdmin = (identifier) => {
  // Username first: matching `id = ? OR username = ?` in one query meant a
  // user literally named e.g. "5" could resolve to whoever has id 5 instead.
  let user = q('SELECT * FROM users WHERE LOWER(username) = ?').get(String(identifier).toLowerCase());
  if (!user && /^\d+$/.test(String(identifier))) {
    user = q('SELECT * FROM users WHERE id = ?').get(Number(identifier));
  }
  if (!user) {
    throw new Error('Kullanıcı bulunamadı.');
  }
  if (user.role === 'bot') {
    throw new Error('AnucAI hesabı silinemez.');
  }

  const targetUsername = user.username;
  const lower = targetUsername.toLowerCase();

  db.transaction(() => {
    // Delete all messages sent by this user from messages table
    q('DELETE FROM messages WHERE LOWER(username) = ?').run(lower);
    q('DELETE FROM message_reactions WHERE LOWER(username) = ?').run(lower);
    // Friendships, requests and read cursors would otherwise linger as
    // orphan rows pointing at an id that no longer exists.
    q('DELETE FROM friends WHERE user_id1 = ? OR user_id2 = ?').run(user.id, user.id);
    q('DELETE FROM friend_requests WHERE sender_id = ? OR receiver_id = ?').run(user.id, user.id);
    q('DELETE FROM dm_read_state WHERE user_id = ?').run(user.id);

    // Delete user from users table
    q('DELETE FROM users WHERE id = ?').run(user.id);
  })();

  return { id: user.id, username: targetUsername };
};

export const getMessageById = (id) => {
  return q('SELECT id, room_id, username, content, image_data FROM messages WHERE id = ?').get(id) || null;
};

export const getRoomById = (id) => {
  return q('SELECT * FROM rooms WHERE id = ?').get(id) || null;
};

export const loginUser = async (identifier, password) => {
  const clean = String(identifier).toLowerCase().trim();
  const user = q('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?').get(clean, clean);

  // The bot account is never meant to be logged into.
  if (!user || user.role === 'bot') {
    // Still spend a hash's worth of time so response timing doesn't reveal
    // whether the account exists.
    await hashPasswordAsync(password, 'timing-equalizer');
    throw new Error('E-posta / kullanıcı adı veya şifre hatalı.');
  }

  const { hash } = await hashPasswordAsync(password, user.salt);
  if (!hashesMatch(hash, user.password_hash)) {
    throw new Error('E-posta / kullanıcı adı veya şifre hatalı.');
  }

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    avatar: user.avatar || null,
    bio: user.bio || '',
    banner: user.banner || null,
    status: user.status_text || '',
    role: user.role || 'user'
  };
};

export const getUserById = (id) => {
  const user = q('SELECT id, email, username, avatar, bio, banner, status_text AS status, role, created_at FROM users WHERE id = ?').get(id);
  return user || null;
};

// What session checks need: identity, role and the salt the token's
// session version is derived from. Never sent to clients.
export const getUserAuthRow = (id) => {
  return q('SELECT id, username, avatar, role, salt FROM users WHERE id = ?').get(id) || null;
};

export const getUserIdByUsername = (username) => {
  if (!username) return null;
  const row = q('SELECT id FROM users WHERE LOWER(username) = ?').get(String(username).toLowerCase());
  return row ? row.id : null;
};

export const getAllUsers = () => {
  return q('SELECT id, username, avatar, bio, banner, status_text AS status, role FROM users ORDER BY username COLLATE NOCASE ASC').all();
};

export const updateUserProfile = (id, rawUsername, avatar, bio, banner, status) => {
  const existingUser = q('SELECT username, role FROM users WHERE id = ?').get(id);
  if (!existingUser) throw new Error('Kullanıcı bulunamadı.');
  const oldUsername = existingUser.username;

  // Only a *changed* name has to pass the username rules, so an existing
  // account whose name predates them can still update its avatar or bio.
  let username = String(rawUsername).trim();
  if (username !== oldUsername) username = validateUsername(username);

  const existingSameName = q('SELECT id FROM users WHERE LOWER(username) = ? AND id != ?').get(username.toLowerCase(), id);
  if (existingSameName) {
    throw new Error('Bu kullanıcı adı zaten başka bir kullanıcı tarafından kullanılıyor.');
  }

  const stmt = q('UPDATE users SET username = ?, avatar = ?, bio = ?, banner = ?, status_text = ? WHERE id = ?');
  stmt.run(username, avatar || null, bio || '', banner || null, status || '', id);

  if (oldUsername && oldUsername.toLowerCase() !== username.toLowerCase()) {
    q('UPDATE messages SET username = ? WHERE LOWER(username) = ?').run(username, oldUsername.toLowerCase());
    // Reactions are keyed by username too - without this a rename silently
    // detached every reaction the user had ever added.
    q('UPDATE message_reactions SET username = ? WHERE LOWER(username) = ?').run(username, oldUsername.toLowerCase());
  }

  return { id, username, avatar: avatar || null, bio: bio || '', banner: banner || null, status: status || '' };
};

export const getUserAvatarByUsername = (username) => {
  if (!username) return null;
  const user = q('SELECT avatar FROM users WHERE LOWER(username) = ?').get(username.toLowerCase());
  return user ? user.avatar : null;
};

// Returns the new salt, which the caller uses to issue a fresh token - the
// old ones stop verifying because their session version came from the old
// salt (see auth.js).
export const changePassword = async (userId, oldPassword, newPassword) => {
  const user = q('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) {
    throw new Error('Kullanıcı bulunamadı.');
  }

  const { hash: oldHash } = await hashPasswordAsync(oldPassword, user.salt);
  if (!hashesMatch(oldHash, user.password_hash)) {
    throw new Error('Mevcut şifreniz hatalı.');
  }

  if (typeof newPassword !== 'string' || newPassword.length < 6) {
    throw new Error('Yeni şifre en az 6 karakter olmalıdır.');
  }
  if (newPassword.length > 128) {
    throw new Error('Şifre en fazla 128 karakter olabilir.');
  }

  const { hash: newHash, salt: newSalt } = await hashPasswordAsync(newPassword);
  q('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(newHash, newSalt, userId);

  return newSalt;
};

// Migration helper: add position column to rooms if missing
const roomCols = q(`PRAGMA table_info(rooms)`).all().map(c => c.name);
if (!roomCols.includes('position')) {
  try { db.exec(`ALTER TABLE rooms ADD COLUMN position INTEGER DEFAULT 0;`); } catch (e) {}
}

// Seed the protected, server-relayed "CS2 ROOM" voice channel once. Runs
// unconditionally (not just gated on an empty rooms table like the default
// rooms above) so it also appears on existing, already-deployed databases,
// not just fresh installs. server.js refuses to delete this room and only
// lets admins rename it - see the CS2_ROOM_ID checks in its
// delete-channel/rename-channel handlers.
export const CS2_ROOM_ID = 'cs2-room';
const CS2_ROOM_NAME = 'CS2 ROOM';
(function ensureCs2Room() {
  const existing = q('SELECT id FROM rooms WHERE id = ?').get(CS2_ROOM_ID);
  if (existing) return;
  const { maxPos } = q('SELECT MAX(position) as maxPos FROM rooms').get();
  q('INSERT INTO rooms (id, name, type, position) VALUES (?, ?, ?, ?)')
    .run(CS2_ROOM_ID, CS2_ROOM_NAME, 'voice', (maxPos || 0) + 1);
})();

// Rooms & Messages DB Functions
export const getRooms = () => {
  return q('SELECT * FROM rooms ORDER BY position ASC, rowid ASC').all();
};

export const reorderRooms = (orderedIds) => {
  if (!Array.isArray(orderedIds)) return getRooms();
  const updateStmt = q('UPDATE rooms SET position = ? WHERE id = ?');
  const transaction = db.transaction((ids) => {
    ids.forEach((id, index) => {
      updateStmt.run(index, id);
    });
  });
  transaction(orderedIds);
  return getRooms();
};

// Create performance indexes for instant message fetching.
// The partial index on reply_to keeps the "cascade a message edit/delete into
// its cached reply snapshots" pass from degenerating into a full table scan of
// every message ever sent.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_room_id ON messages(room_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_messages_username ON messages(username COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_messages_replies ON messages(room_id, id) WHERE reply_to IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_friends_u1 ON friends(user_id1);
  CREATE INDEX IF NOT EXISTS idx_friends_u2 ON friends(user_id2);
  CREATE INDEX IF NOT EXISTS idx_freq_receiver ON friend_requests(receiver_id, status);
  CREATE INDEX IF NOT EXISTS idx_freq_sender ON friend_requests(sender_id, status);
  CREATE INDEX IF NOT EXISTS idx_rooms_position ON rooms(position);
  CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
  CREATE INDEX IF NOT EXISTS idx_dm_read_room ON dm_read_state(room_id);
`);

// Let SQLite build its stat tables once at boot so the new indexes are actually
// picked by the query planner instead of after the first few thousand queries.
try { db.pragma('optimize'); } catch (e) {}
try { db.pragma('cache_size = -8000'); } catch (e) {} // ~8 MB page cache
try { db.pragma('mmap_size = 67108864'); } catch (e) {} // 64 MB memory-mapped I/O

// Attaches a `reactions` field ({emoji: [usernames]}) to each message in
// place. One query for the whole batch rather than per-message, since this
// runs on every room load (up to 50 messages) and per older-messages page.
function attachReactions(messages) {
  if (!messages || messages.length === 0) return messages;
  const ids = messages.map(m => m.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT message_id, emoji, username FROM message_reactions WHERE message_id IN (${placeholders})`
  ).all(...ids);

  const byMessage = new Map();
  for (const row of rows) {
    let forMsg = byMessage.get(row.message_id);
    if (!forMsg) {
      forMsg = {};
      byMessage.set(row.message_id, forMsg);
    }
    if (!forMsg[row.emoji]) forMsg[row.emoji] = [];
    forMsg[row.emoji].push(row.username);
  }

  for (const msg of messages) {
    msg.reactions = byMessage.get(msg.id) || {};
  }
  return messages;
}

export const getRecentMessages = (roomId, limit = 50) => {
  const messages = q(`
    SELECT m.*, u.avatar
    FROM messages m
    LEFT JOIN users u ON u.username = m.username COLLATE NOCASE
    WHERE m.room_id = ?
    ORDER BY m.id DESC LIMIT ?
  `).all(roomId, limit).reverse();
  return attachReactions(messages);
};

export const getOlderMessages = (roomId, beforeId, limit = 30) => {
  const messages = q(`
    SELECT m.*, u.avatar
    FROM messages m
    LEFT JOIN users u ON u.username = m.username COLLATE NOCASE
    WHERE m.room_id = ? AND m.id < ?
    ORDER BY m.id DESC LIMIT ?
  `).all(roomId, beforeId, limit).reverse();
  return attachReactions(messages);
};

// Add/remove a reaction is one toggle: if this user already reacted with
// this emoji on this message, the click removes it; otherwise it adds it -
// matches how the client renders its own reaction as already-active.
export const toggleReaction = (messageId, username, emoji) => {
  const existing = q('SELECT id FROM message_reactions WHERE message_id = ? AND username = ? AND emoji = ?')
    .get(messageId, username, emoji);
  if (existing) {
    q('DELETE FROM message_reactions WHERE id = ?').run(existing.id);
    return { action: 'remove' };
  }
  q('INSERT INTO message_reactions (message_id, username, emoji) VALUES (?, ?, ?)').run(messageId, username, emoji);
  return { action: 'add' };
};

// VACUUM reclaims disk space left behind by deleted rows (e.g. deleted image
// messages) - DELETE only frees pages for reuse inside the file, it never
// shrinks the file on its own. Runs shortly after startup (to reclaim any
// backlog) and then once a day; skipped otherwise since it briefly locks the
// whole DB and rewrites the file, which is too heavy to do every 12h.
setTimeout(() => {
  try {
    db.exec('VACUUM');
  } catch (e) {
    console.error('DB Vacuum error:', e);
  }
  setInterval(() => {
    try {
      db.exec('VACUUM');
    } catch (e) {
      console.error('DB Vacuum error:', e);
    }
  }, 24 * 60 * 60 * 1000);
}, 2 * 60 * 1000);

// Periodic DB maintenance (every 12 hours)
setInterval(() => {
  try {
    db.pragma('optimize');
    db.pragma('wal_checkpoint(PASSIVE)');
  } catch (e) {
    console.error('DB Maintenance error:', e);
  }
}, 12 * 60 * 60 * 1000);

export const saveMessage = (roomId, username, content, imageData = null, replyTo = null) => {
  const replyToFormatted = replyTo ? (typeof replyTo === 'string' ? replyTo : JSON.stringify(replyTo)) : null;
  const nowISO = new Date().toISOString();
  const stmt = q('INSERT INTO messages (room_id, username, content, image_data, reply_to, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
  const info = stmt.run(roomId, username, content || '', imageData, replyToFormatted, nowISO);
  return {
    id: info.lastInsertRowid,
    room_id: roomId,
    username,
    content: content || '',
    image_data: imageData,
    reply_to: replyToFormatted,
    timestamp: nowISO,
    reactions: {}
  };
};

export const editMessage = (messageId, username, newContent) => {
  const existing = q('SELECT image_data FROM messages WHERE id = ?').get(messageId);
  if (existing && existing.image_data) {
    throw new Error('Görsel veya GIF içeren mesajlar düzenlenemez, sadece silinebilir.');
  }

  const stmt = q('UPDATE messages SET content = ? WHERE id = ? AND username = ?');
  const result = stmt.run(newContent, messageId, username);
  if (result.changes === 0) {
    throw new Error('Mesaj bulunamadı veya düzenleme yetkiniz yok.');
  }

  // Cascade-update any cached reply_to snapshots that quote this message,
  // so reply previews stay accurate even after a page reload. The LIKE filter
  // narrows the candidate rows to messages whose snapshot actually mentions
  // this id, instead of JSON.parse-ing every reply in the room.
  const editedMsg = q('SELECT room_id FROM messages WHERE id = ?').get(messageId);
  if (editedMsg) {
    const referencingMessages = q(
      "SELECT id, reply_to FROM messages WHERE room_id = ? AND reply_to IS NOT NULL AND reply_to LIKE ?"
    ).all(editedMsg.room_id, `%"id":${messageId}%`);

    const updateReplyTo = q('UPDATE messages SET reply_to = ? WHERE id = ?');
    for (const refMsg of referencingMessages) {
      try {
        const replyData = JSON.parse(refMsg.reply_to);
        if (replyData && String(replyData.id) === String(messageId)) {
          replyData.content = newContent;
          updateReplyTo.run(JSON.stringify(replyData), refMsg.id);
        }
      } catch (e) {
        // Malformed reply_to JSON, skip
      }
    }
  }

  return { id: messageId, content: newContent };
};

export const deleteMessage = (messageId, username, isAdmin = false) => {
  // Read the room before deleting so the reply-snapshot cascade below can be
  // scoped to that room rather than scanning the entire messages table.
  const target = q('SELECT room_id FROM messages WHERE id = ?').get(messageId);

  let stmt;
  let result;
  if (isAdmin) {
    stmt = q('DELETE FROM messages WHERE id = ?');
    result = stmt.run(messageId);
  } else {
    stmt = q('DELETE FROM messages WHERE id = ? AND username = ?');
    result = stmt.run(messageId, username);
  }
  if (result.changes === 0) {
    throw new Error('Mesaj bulunamadı veya silme yetkiniz yok.');
  }

  q('DELETE FROM message_reactions WHERE message_id = ?').run(messageId);

  // Update reply_to snapshots in other messages referencing this deleted message
  const referencingMessages = target
    ? q("SELECT id, reply_to FROM messages WHERE room_id = ? AND reply_to IS NOT NULL AND reply_to LIKE ?")
        .all(target.room_id, `%"id":${messageId}%`)
    : q("SELECT id, reply_to FROM messages WHERE reply_to IS NOT NULL AND reply_to LIKE ?")
        .all(`%"id":${messageId}%`);

  const updateReplyTo = q('UPDATE messages SET reply_to = ? WHERE id = ?');
  for (const refMsg of referencingMessages) {
    try {
      const replyObj = JSON.parse(refMsg.reply_to);
      if (replyObj && String(replyObj.id) === String(messageId)) {
        replyObj.is_deleted = true;
        replyObj.content = 'Bu mesaj silindi';
        updateReplyTo.run(JSON.stringify(replyObj), refMsg.id);
      }
    } catch (e) {}
  }

  return { id: messageId };
};

export const createRoom = (name, type = 'text') => {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
  const id = `${type}-${slug}-${Date.now().toString(36)}`;
  const stmt = q('INSERT INTO rooms (id, name, type) VALUES (?, ?, ?)');
  stmt.run(id, name, type);
  return { id, name, type };
};

export const renameRoom = (id, newName) => {
  const stmt = q('UPDATE rooms SET name = ? WHERE id = ?');
  stmt.run(newName, id);
  return { id, name: newName };
};

export const deleteRoom = (id) => {
  const stmt = q('DELETE FROM rooms WHERE id = ?');
  stmt.run(id);
  q('DELETE FROM messages WHERE room_id = ?').run(id);
  return { id };
};

// --- FRIEND SYSTEM FUNCTIONS ---
export const sendFriendRequest = (senderId, targetUsername) => {
  const targetUser = q('SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)').get(targetUsername);
  if (!targetUser) throw new Error('Kullanıcı bulunamadı.');
  if (targetUser.id === senderId) throw new Error('Kendinize arkadaşlık isteği gönderemezsiniz.');

  // Check if already friends
  const u1 = Math.min(senderId, targetUser.id);
  const u2 = Math.max(senderId, targetUser.id);
  const existingFriend = q('SELECT id FROM friends WHERE user_id1 = ? AND user_id2 = ?').get(u1, u2);
  if (existingFriend) throw new Error('Bu kullanıcı ile zaten arkadaşsınız.');

  // Check existing request
  const existingReq = q(
    'SELECT id, sender_id, status FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)'
  ).get(senderId, targetUser.id, targetUser.id, senderId);

  if (existingReq) {
    if (existingReq.status === 'pending') {
      if (existingReq.sender_id === senderId) {
        throw new Error('Zaten bekleyen bir arkadaşlık isteğiniz var.');
      } else {
        // Reverse request exists, auto accept!
        acceptFriendRequest(existingReq.id, senderId);
        return { autoAccepted: true, targetUser };
      }
    } else {
      // Re-open request
      q("UPDATE friend_requests SET sender_id = ?, receiver_id = ?, status = 'pending', created_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(senderId, targetUser.id, existingReq.id);
      return { requestId: existingReq.id, targetUser };
    }
  }

  const stmt = q("INSERT INTO friend_requests (sender_id, receiver_id, status) VALUES (?, ?, 'pending')");
  const res = stmt.run(senderId, targetUser.id);
  return { requestId: res.lastInsertRowid, targetUser };
};

export const acceptFriendRequest = (requestId, userId) => {
  const req = q('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
  if (!req || req.status !== 'pending') throw new Error('İstek bulunamadı.');
  // Only the person who received the request may accept it - the sender
  // being allowed to as well meant anyone could force a friendship (and with
  // it a DM channel) on anyone else by sending and then self-accepting.
  if (Number(req.receiver_id) !== Number(userId)) throw new Error('Bu isteği kabul etme yetkiniz yok.');

  q("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(requestId);

  const u1 = Math.min(req.sender_id, req.receiver_id);
  const u2 = Math.max(req.sender_id, req.receiver_id);

  try {
    q('INSERT OR IGNORE INTO friends (user_id1, user_id2) VALUES (?, ?)').run(u1, u2);
  } catch (e) {}

  return { success: true, senderId: req.sender_id, receiverId: req.receiver_id };
};

export const rejectFriendRequest = (requestId, userId) => {
  const req = q('SELECT * FROM friend_requests WHERE id = ?').get(requestId);
  if (!req) throw new Error('İstek bulunamadı.');
  // Either side may withdraw/decline a request.
  if (Number(req.receiver_id) !== Number(userId) && Number(req.sender_id) !== Number(userId)) throw new Error('Yetkiniz yok.');

  q('DELETE FROM friend_requests WHERE id = ?').run(requestId);
  return { success: true };
};

export const removeFriend = (userId, friendId) => {
  const u1 = Math.min(userId, friendId);
  const u2 = Math.max(userId, friendId);
  q('DELETE FROM friends WHERE user_id1 = ? AND user_id2 = ?').run(u1, u2);
  q('DELETE FROM friend_requests WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)').run(userId, friendId, friendId, userId);
  return { success: true };
};

export const getFriends = (userId) => {
  const rows = q(`
    SELECT u.id, u.username, u.avatar, u.bio
    FROM friends f
    JOIN users u ON (u.id = CASE WHEN f.user_id1 = ? THEN f.user_id2 ELSE f.user_id1 END)
    WHERE f.user_id1 = ? OR f.user_id2 = ?
  `).all(userId, userId, userId);
  return rows;
};

export const getFriendRequests = (userId) => {
  const incoming = q(`
    SELECT fr.id, fr.sender_id, fr.created_at, u.username as sender_username, u.avatar as sender_avatar
    FROM friend_requests fr
    JOIN users u ON u.id = fr.sender_id
    WHERE fr.receiver_id = ? AND fr.status = 'pending'
  `).all(userId);

  const outgoing = q(`
    SELECT fr.id, fr.receiver_id, fr.created_at, u.username as receiver_username, u.avatar as receiver_avatar
    FROM friend_requests fr
    JOIN users u ON u.id = fr.receiver_id
    WHERE fr.sender_id = ? AND fr.status = 'pending'
  `).all(userId);

  return { incoming, outgoing };
};

export const getOrCreateDMRoom = (userId1, userId2) => {
  const a = Number(userId1);
  const b = Number(userId2);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) {
    throw new Error('Geçersiz kullanıcı.');
  }
  const u1 = Math.min(a, b);
  const u2 = Math.max(a, b);
  const roomId = `dm_${u1}_${u2}`;

  const existingRoom = q('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (existingRoom) return existingRoom;

  // Refuse to mint DM rooms for ids that don't exist - a raw socket emit
  // could otherwise fill the rooms table with dm_<anything> rows.
  const user1 = q('SELECT username FROM users WHERE id = ?').get(a);
  const user2 = q('SELECT username FROM users WHERE id = ?').get(b);
  if (!user1 || !user2) throw new Error('Kullanıcı bulunamadı.');
  const name = `@${user1.username} & @${user2.username}`;

  q("INSERT INTO rooms (id, name, type) VALUES (?, ?, 'dm')").run(roomId, name);
  return { id: roomId, name, type: 'dm' };
};

// --- DM READ STATE (Telegram-style single/double tick) ---
// One "last read message id" cursor per (room, user) rather than tracking
// every message's read status individually - a DM only ever has two
// participants, so a single cursor per side is enough to answer "has the
// other person seen this message yet" (their cursor >= this message's id).
export const markDmRead = (roomId, userId, messageId) => {
  q(`
    INSERT INTO dm_read_state (room_id, user_id, last_read_message_id) VALUES (?, ?, ?)
    ON CONFLICT(room_id, user_id) DO UPDATE SET
      last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id)
  `).run(roomId, userId, messageId);
};

// {userId: lastReadMessageId} for every participant who has read anything
// in this room - the client looks up whichever id isn't its own.
export const getDmReadState = (roomId) => {
  const rows = q('SELECT user_id, last_read_message_id FROM dm_read_state WHERE room_id = ?').all(roomId);
  const result = {};
  for (const row of rows) result[row.user_id] = row.last_read_message_id;
  return result;
};

export default db;
