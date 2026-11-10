// Must be the first import: loads server/.env before any other module reads
// process.env (see env.js for why the order matters).
import './env.js';
import Fastify from 'fastify';
import { Server as SocketIOServer } from 'socket.io';
import fastifyStatic from '@fastify/static';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import db, { dbPath, getRooms, getRecentMessages, getOlderMessages, saveMessage, editMessage, deleteMessage, createRoom, renameRoom, deleteRoom, reorderRooms, registerUser, loginUser, getUserById, getUserAuthRow, getAllUsers, updateUserProfile, changePassword, getUserAvatarByUsername, deleteUserByAdmin, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, getFriends, getFriendRequests, getOrCreateDMRoom, AI_BOT_USERNAME, CS2_ROOM_ID, toggleReaction, markDmRead, getDmReadState, getMessageById, getRoomById } from './db.js';
import { initSfu, joinSfu, handleSfuAnswer, handleSfuIceCandidate, leaveSfu } from './sfu.js';
import { getIceServers } from './ice-config.js';
import { issueToken, decodeToken, sessionVersionFor, safeEqual } from './auth.js';
import { searchGifs, isGifSearchConfigured } from './gifs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8001';

const fastify = Fastify({
  logger: false, // Keep logger minimal to save CPU/RAM on low-spec server
  keepAliveTimeout: 65000 // Prevent Cloudflare Tunnel stream canceled error code 0
});
// Must stay above keepAliveTimeout. Fastify has no option for it, so it is
// set on the underlying Node http server directly.
fastify.server.headersTimeout = 66000;

// Enable CORS for HTTP API requests (Tauri desktop app & Vite dev compatibility).
// A wildcard origin is safe here because the API authenticates with a Bearer
// token the browser never attaches on its own (no cookies are used), so a
// foreign page can't act as the user.
fastify.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  // Basic hardening headers for everything this server returns.
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (request.method === 'OPTIONS') {
    return reply.status(200).send();
  }
});

// Socket.IO attached straight to Fastify's HTTP server. (fastify-socket.io,
// which used to do this, only supports Fastify 4, and Fastify 4 is end of
// life with unpatched security advisories.)
const io = new SocketIOServer(fastify.server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Chat images are resized client-side to <=800px JPEG (~100-300 KB as a
  // data URL); 2 MB leaves headroom without letting one emit hog the server.
  maxHttpBufferSize: 2 * 1024 * 1024
});
fastify.decorate('io', io);
fastify.addHook('onClose', (instance, done) => {
  io.close();
  done();
});

// Serve client static files if client/dist exists
const clientDistPath = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDistPath)) {
  await fastify.register(fastifyStatic, {
    root: clientDistPath,
    prefix: '/'
  });
} else {
  fastify.get('/', async (request, reply) => {
    return {
      status: 'online',
      app: 'AnucVC Server',
      message: 'AnucVC Fastify Backend is running. Web client is running on port 5173 or build with npm run build.'
    };
  });
}

// Desktop app auto-updater artifacts (installers + latest.json) get mirrored
// here by the GitHub Actions release workflow, and the Tauri updater fetches
// this URL with no auth. Served statically so the updater's plain HTTP GET
// can reach it.
const updatesDir = path.join(__dirname, 'release-updates');
if (!fs.existsSync(updatesDir)) fs.mkdirSync(updatesDir, { recursive: true });
await fastify.register(fastifyStatic, {
  root: updatesDir,
  prefix: '/updates/',
  decorateReply: false,
  // The release workflow gives every updater archive a per-run name
  // (r<run id>_...), so those bytes never change under a URL and Cloudflare
  // may keep them at the edge - otherwise each download crawls straight off
  // this server's uplink (measured ~50 KB/s, about a minute per installer).
  // Everything else, latest.json above all, has to be revalidated or clients
  // would keep being offered an old release.
  cacheControl: false,
  // @fastify/static >= 8 passes the Fastify reply here (not Node's raw
  // response), so it is reply.header() - res.setHeader() made every file
  // under /updates/ a 500, latest.json included.
  setHeaders: (reply, filePath) => {
    const immutable = /^r\d+_/.test(path.basename(filePath));
    reply.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  }
});

const UPDATE_UPLOAD_SECRET = process.env.UPDATE_UPLOAD_SECRET || null;
// Must contain at least one character other than "." so "." / ".." can never
// name a directory.
const UPDATE_FILENAME_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,200}$/;

fastify.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (request, body, done) => {
  done(null, body);
});

// CI-only upload endpoint (see .github/workflows/release.yml) - not part of
// the app's user-facing API. Requires UPDATE_UPLOAD_SECRET to be set in this
// server's environment; refuses all uploads if it isn't configured.
fastify.post('/api/updates/upload', { bodyLimit: 200 * 1024 * 1024 }, async (request, reply) => {
  if (!UPDATE_UPLOAD_SECRET || !safeEqual(String(request.headers['x-update-secret'] || ''), UPDATE_UPLOAD_SECRET)) {
    return reply.status(403).send({ error: 'Forbidden' });
  }
  const filename = request.query?.filename;
  if (typeof filename !== 'string' || !UPDATE_FILENAME_RE.test(filename)) {
    return reply.status(400).send({ error: 'Invalid filename' });
  }
  if (!Buffer.isBuffer(request.body)) {
    return reply.status(400).send({ error: 'Expected binary body' });
  }
  fs.writeFileSync(path.join(updatesDir, filename), request.body);
  return { ok: true, filename };
});

// The client asks for its WebRTC ICE servers here instead of hard-coding
// them, so a TURN relay can be swapped in from server/.env without shipping a
// new desktop build. Same list the server-relayed CS2 ROOM uses - see
// ice-config.js. Cheap and public on purpose: it holds no user data, and the
// client needs it before it can join any voice room.
fastify.get('/api/ice-servers', async () => ({ iceServers: getIceServers() }));

// --- SESSIONS ---------------------------------------------------------------
// Every identity the server acts on comes from a signed token (auth.js) that
// is checked against the database, never from a username/userId the client
// sends along - those used to be trusted as-is, which let anyone act as any
// user (or as the admin) with a hand-written socket emit.
function verifySession(token) {
  const decoded = decodeToken(token);
  if (!decoded) return null;
  const row = getUserAuthRow(decoded.uid);
  if (!row || row.role === 'bot') return null;
  if (sessionVersionFor(row.salt) !== decoded.sv) return null;
  return { id: row.id, username: row.username, avatar: row.avatar || null, role: row.role || 'user' };
}

function authFromRequest(request) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  return verifySession(header.slice(7).trim());
}

function tokenForUser(userId) {
  const row = getUserAuthRow(userId);
  return row ? issueToken(row.id, row.salt) : null;
}

const UNAUTHORIZED = { error: 'Oturumunuz geçersiz veya süresi dolmuş. Lütfen tekrar giriş yapın.' };

// Best-effort client address. Behind Cloudflare (tunnel or proxy) every
// request arrives from the proxy itself, so the forwarded header is what
// tells clients apart; only used for rate limiting.
function clientIp(request) {
  const cf = request.headers['cf-connecting-ip'];
  return (typeof cf === 'string' && cf) ? cf : request.ip;
}

// Small fixed-window rate limiter, in memory (single-process server).
function createRateLimiter(windowMs, max) {
  const hits = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset <= now) hits.delete(key);
  }, windowMs);
  sweep.unref();
  return {
    // true while the key is still within its allowance
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.reset <= now) {
        entry = { count: 0, reset: now + windowMs };
        hits.set(key, entry);
      }
      entry.count++;
      return entry.count <= max;
    },
    reset(key) {
      hits.delete(key);
    }
  };
}

const loginIpLimiter = createRateLimiter(15 * 60 * 1000, 30);
const loginAccountLimiter = createRateLimiter(15 * 60 * 1000, 10);
const registerIpLimiter = createRateLimiter(60 * 60 * 1000, 10);
const TOO_MANY = { error: 'Çok fazla deneme yapıldı. Lütfen birkaç dakika sonra tekrar deneyin.' };

// --- INPUT VALIDATION ---------------------------------------------------------
// Image fields end up inside <img src="..."> on every client, so anything that
// isn't a plain base64 image data URL (or a GIPHY media URL for GIFs) is
// refused - a crafted value used to be enough for stored XSS.
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const GIPHY_MEDIA_URL_RE = /^https:\/\/(?:media\d*|i)\.giphy\.com\/[A-Za-z0-9_\-./]+(?:\?[A-Za-z0-9_\-.=&%]*)?$/;
const MAX_CHAT_IMAGE_CHARS = 1.5 * 1024 * 1024;
const MAX_AVATAR_CHARS = 400 * 1024;
const MAX_BANNER_CHARS = 800 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_BIO_CHARS = 500;
const MAX_STATUS_CHARS = 128;
const MAX_CHANNEL_NAME_CHARS = 50;

function isImageDataUrl(value, maxChars) {
  return typeof value === 'string' && value.length <= maxChars && IMAGE_DATA_URL_RE.test(value);
}

function isAllowedChatImage(value) {
  if (typeof value !== 'string') return false;
  if (value.startsWith('data:')) return isImageDataUrl(value, MAX_CHAT_IMAGE_CHARS);
  return value.length <= 2048 && GIPHY_MEDIA_URL_RE.test(value);
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fixed reaction set (matches the picker in client/src/app.js) - kept
// server-side too so a raw socket emit can't attach an arbitrary emoji/string.
const ALLOWED_REACTIONS = ['😀', '🥹', '😍', '🤪', '😱', '👍', '👎', '🖕', '🍆'];

// --- AUTHENTICATION API ROUTES ---
fastify.post('/api/auth/register', async (request, reply) => {
  const { email, password, username } = request.body || {};

  if (!registerIpLimiter.hit(clientIp(request))) {
    return reply.status(429).send(TOO_MANY);
  }

  if (typeof email !== 'string' || email.length > 254 || !EMAIL_REGEX.test(email)) {
    return reply.status(400).send({ error: 'Geçerli bir e-posta adresi giriniz.' });
  }

  if (typeof password !== 'string' || password.length < 6) {
    return reply.status(400).send({ error: 'Şifre en az 6 karakter olmalıdır.' });
  }
  if (password.length > 128) {
    return reply.status(400).send({ error: 'Şifre en fazla 128 karakter olabilir.' });
  }

  try {
    const user = await registerUser(email, password, username);
    const token = tokenForUser(user.id);
    invalidateAllUsersCache();
    broadcastOnlineUsers(io);
    return { success: true, user, token };
  } catch (err) {
    return reply.status(400).send({ error: err.message });
  }
});

fastify.post('/api/auth/login', async (request, reply) => {
  const { email, identifier, password } = request.body || {};
  const loginInput = email || identifier;

  if (typeof loginInput !== 'string' || !loginInput.trim() || loginInput.length > 254) {
    return reply.status(400).send({ error: 'Lütfen e-posta adresinizi veya kullanıcı adınızı giriniz.' });
  }

  if (typeof password !== 'string' || !password || password.length > 128) {
    return reply.status(400).send({ error: 'Şifrenizi giriniz.' });
  }

  const accountKey = loginInput.trim().toLowerCase();
  if (!loginIpLimiter.hit(clientIp(request)) || !loginAccountLimiter.hit(accountKey)) {
    return reply.status(429).send(TOO_MANY);
  }

  try {
    const user = await loginUser(loginInput, password);
    loginAccountLimiter.reset(accountKey);
    const token = tokenForUser(user.id);
    return { success: true, user, token };
  } catch (err) {
    return reply.status(400).send({ error: err.message });
  }
});

fastify.get('/api/auth/me', async (request, reply) => {
  const session = authFromRequest(request);
  if (!session) return reply.status(401).send(UNAUTHORIZED);
  const user = getUserById(session.id);
  if (!user) return reply.status(401).send({ error: 'Kullanıcı bulunamadı.' });
  return { success: true, user };
});

fastify.post('/api/auth/update-profile', async (request, reply) => {
  const session = authFromRequest(request);
  if (!session) return reply.status(401).send(UNAUTHORIZED);
  const id = session.id;

  try {
    const { username, avatar, bio, banner, status } = request.body || {};

    if (typeof username !== 'string' || !username.trim()) {
      return reply.status(400).send({ error: 'Kullanıcı adı boş olamaz.' });
    }

    // An unchanged value is always accepted, so an account whose stored
    // avatar/banner predates this validation can still save other fields.
    const current = getUserById(id) || {};
    if (avatar && avatar !== current.avatar && !isImageDataUrl(avatar, MAX_AVATAR_CHARS)) {
      return reply.status(400).send({ error: 'Profil fotoğrafı geçersiz veya çok büyük.' });
    }
    if (banner && banner !== current.banner && !isImageDataUrl(banner, MAX_BANNER_CHARS)) {
      return reply.status(400).send({ error: 'Kapak görseli geçersiz veya çok büyük.' });
    }
    if (bio != null && (typeof bio !== 'string' || bio.length > MAX_BIO_CHARS)) {
      return reply.status(400).send({ error: `Hakkımda en fazla ${MAX_BIO_CHARS} karakter olabilir.` });
    }
    if (status != null && (typeof status !== 'string' || status.length > MAX_STATUS_CHARS)) {
      return reply.status(400).send({ error: `Durum mesajı en fazla ${MAX_STATUS_CHARS} karakter olabilir.` });
    }

    const updatedUser = updateUserProfile(id, username.trim(), avatar || null, bio || '', banner || null, status || '');
    invalidateAllUsersCache();

    // Every live socket of this user - matched by user id, not by the old
    // tracked username (that comparison can never be true on an actual
    // rename, which left the voice room entry and the online roster showing
    // the stale name until reconnect).
    const userSocketIds = [];
    for (const [sId, data] of onlineUsers.entries()) {
      if (data.userId === id) userSocketIds.push(sId);
    }

    for (const usersMap of voiceRooms.values()) {
      for (const sId of userSocketIds) {
        const userObj = usersMap.get(sId);
        if (userObj) {
          userObj.username = updatedUser.username;
          userObj.avatar = updatedUser.avatar;
        }
      }
    }
    io.to('authed').emit('user-profile-updated', {
      userId: id,
      username: updatedUser.username,
      avatar: updatedUser.avatar,
      bio: updatedUser.bio,
      banner: updatedUser.banner,
      status: updatedUser.status
    });
    broadcastVoiceOccupants(io);
    for (const sId of userSocketIds) {
      const data = onlineUsers.get(sId);
      onlineUsers.set(sId, { username: updatedUser.username, avatar: updatedUser.avatar || null, userId: id, away: !!(data && data.away) });
      const targetSocket = io.sockets.sockets.get(sId);
      if (targetSocket && targetSocket.data.user) {
        targetSocket.data.user.username = updatedUser.username;
        targetSocket.data.user.avatar = updatedUser.avatar || null;
      }
    }
    broadcastOnlineUsers(io);
    return { success: true, user: updatedUser };
  } catch (e) {
    return reply.status(400).send({ error: e.message || 'Profil güncellenemedi.' });
  }
});

fastify.post('/api/auth/change-password', async (request, reply) => {
  const session = authFromRequest(request);
  if (!session) return reply.status(401).send(UNAUTHORIZED);

  try {
    const { oldPassword, newPassword } = request.body || {};

    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword || !newPassword) {
      return reply.status(400).send({ error: 'Lütfen tüm şifre alanlarını doldurunuz.' });
    }

    if (!loginAccountLimiter.hit(`pw:${session.id}`)) {
      return reply.status(429).send(TOO_MANY);
    }

    await changePassword(session.id, oldPassword, newPassword);
    loginAccountLimiter.reset(`pw:${session.id}`);
    // Every older token is now invalid (its session version came from the
    // old salt), this one included - hand back a fresh one.
    return { success: true, message: 'Şifreniz başarıyla değiştirildi.', token: tokenForUser(session.id) };
  } catch (e) {
    return reply.status(400).send({ error: e.message });
  }
});

// --- GIF SEARCH ---------------------------------------------------------------
// Proxied so the GIPHY API key stays in server/.env instead of being shipped
// inside every copy of the client (and in the public repo). It also gets
// around the desktop app's CSP, which only allows connecting to this server.
fastify.get('/api/gifs', async (request, reply) => {
  const session = authFromRequest(request);
  if (!session) return reply.status(401).send(UNAUTHORIZED);
  if (!isGifSearchConfigured()) {
    return reply.status(503).send({ error: 'GIF araması bu sunucuda yapılandırılmamış.' });
  }
  const q = typeof request.query?.q === 'string' ? request.query.q.slice(0, 100) : '';
  try {
    return { success: true, gifs: await searchGifs(q) };
  } catch (err) {
    console.error('[GIF] search failed:', err.message);
    return reply.status(502).send({ error: 'GIF servisine şu an ulaşılamıyor.' });
  }
});

// --- SYSTEM STATS ---------------------------------------------------------
// Reports both how much RAM this process holds and what share of the phone's
// total memory that is, so the number means something without having to know
// the device's spec by heart. Shared by the admin panel and `npm run ram`.
let lastCpuSample = { time: Date.now(), usage: process.cpuUsage() };

export function collectSystemStats() {
  const mem = process.memoryUsage();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;

  const toMB = (b) => Math.round(b / (1024 * 1024));
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

  // CPU share since the previous call to this function.
  const now = Date.now();
  const cpu = process.cpuUsage();
  const elapsedMs = Math.max(1, now - lastCpuSample.time);
  const cpuMicros = (cpu.user - lastCpuSample.usage.user) + (cpu.system - lastCpuSample.usage.system);
  const cpuPercent = Math.min(100, Math.round((cpuMicros / 1000 / elapsedMs) * 1000) / 10);
  lastCpuSample = { time: now, usage: cpu };

  return {
    processRamMB: toMB(mem.rss),
    processRamPercent: pct(mem.rss, totalBytes),
    processHeapMB: toMB(mem.heapUsed),
    systemTotalMB: toMB(totalBytes),
    systemUsedMB: toMB(usedBytes),
    systemFreeMB: toMB(freeBytes),
    systemRamPercent: pct(usedBytes, totalBytes),
    cpuPercent,
    loadAvg: os.loadavg().map(n => Math.round(n * 100) / 100)
  };
}

fastify.get('/api/system/stats', async (request, reply) => {
  const session = authFromRequest(request);
  if (!session) return reply.status(401).send(UNAUTHORIZED);
  if (session.role !== 'admin') {
    return reply.status(403).send({ error: 'Bu bilgiye sadece Admin erişebilir.' });
  }

  try {
    const stats = collectSystemStats();

    let dbBytes = 0;
    if (fs.existsSync(dbPath)) {
      dbBytes = fs.statSync(dbPath).size;
    }
    // WAL journal counts towards what the database actually occupies on disk.
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) dbBytes += fs.statSync(dbPath + suffix).size;
    }

    let dbSizeFormatted = `${(dbBytes / 1024).toFixed(1)} KB`;
    if (dbBytes > 1024 * 1024) {
      dbSizeFormatted = `${(dbBytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    return {
      success: true,
      // Kept for backwards compatibility with older clients
      ramUsage: `${stats.processRamMB} MB`,
      dbSize: dbSizeFormatted,
      // Process (this Node/pm2 app)
      processRamMB: stats.processRamMB,
      processRamPercent: stats.processRamPercent,
      processHeapMB: stats.processHeapMB,
      // Whole device
      systemTotalMB: stats.systemTotalMB,
      systemUsedMB: stats.systemUsedMB,
      systemFreeMB: stats.systemFreeMB,
      systemRamPercent: stats.systemRamPercent,
      cpuPercent: stats.cpuPercent,
      loadAvg: stats.loadAvg,
      uptimeSeconds: Math.round(process.uptime()),
      onlineCount: onlineUsers.size,
      voiceRoomCount: voiceRooms.size
    };
  } catch (e) {
    return reply.status(400).send({ error: e.message });
  }
});

// API routes
// DM rooms are left out: their names ("@a & @b") would tell everyone who is
// talking to whom, and the channel list never shows them anyway.
fastify.get('/api/rooms', async () => {
  return getCachedRooms().filter(r => r.type !== 'dm');
});

fastify.get('/api/users', async (request, reply) => {
  const session = authFromRequest(request);
  if (!session) return reply.status(401).send(UNAUTHORIZED);
  return { success: true, users: getAllUsers() };
});

fastify.get('/api/messages/:roomId', async (request, reply) => {
  const session = authFromRequest(request);
  if (!session) return reply.status(401).send(UNAUTHORIZED);
  const { roomId } = request.params;
  if (!canReadRoom(session, roomId)) return reply.status(403).send({ error: 'Bu kanala erişiminiz yok.' });
  return getRecentMessages(roomId);
});

// In-memory mapping of voice rooms and users: roomId -> Map(socketId -> { username, isMuted, isDeafened })
const voiceRooms = new Map();
const onlineUsers = new Map(); // socketId -> { username, avatar, userId, away }

// Cache allUsers to avoid DB query on every broadcast
let cachedAllUsers = null;
let cachedAllUsersDirty = true;
// Bumped whenever the registered-user set changes (register / profile update /
// admin delete). Clients keep their own copy of the roster and only need a new
// one when this changes - see broadcastOnlineUsers().
let allUsersRevision = 0;

function getCachedAllUsers() {
  if (cachedAllUsersDirty || !cachedAllUsers) {
    cachedAllUsers = getAllUsers();
    cachedAllUsersDirty = false;
    // Rebuild the username -> user lookup used by the message hot path.
    usersByNameLower = new Map();
    for (const u of cachedAllUsers) {
      if (u.username) usersByNameLower.set(u.username.toLowerCase(), u);
    }
    mentionRegexCache = null;
  }
  return cachedAllUsers;
}

function invalidateAllUsersCache() {
  cachedAllUsersDirty = true;
  allUsersRevision++;
}

// --- Message hot-path caches -------------------------------------------------
// Every incoming chat message used to run getAllUsers() (a full table read),
// getRooms() and getUserAvatarByUsername() and then compile a fresh regex built
// from every username in the database. All of that is now computed once and
// reused until the underlying data actually changes.
let usersByNameLower = new Map();
let mentionRegexCache = null;
let cachedRooms = null;

function getUsersByNameLower() {
  getCachedAllUsers();
  return usersByNameLower;
}

function getMentionRegex() {
  if (mentionRegexCache) return mentionRegexCache;
  const names = Array.from(getUsersByNameLower().values())
    .map(u => u.username)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const namePatterns = names
    .map(n => n.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'))
    .concat(['all', 'everyone']);
  mentionRegexCache = new RegExp(
    `@(?:(${namePatterns.join('|')})|([A-Za-z0-9_\\.\\-ğĞıİöÖçÇüÜŞş]+))`,
    'gi'
  );
  return mentionRegexCache;
}

function getCachedRooms() {
  if (!cachedRooms) cachedRooms = getRooms();
  return cachedRooms;
}

function invalidateRoomsCache() {
  cachedRooms = null;
}

// --- ROOM ACCESS --------------------------------------------------------------
// "dm_<a>_<b>" -> [a, b] (numbers), or null for anything else.
function dmParticipants(roomId) {
  const m = /^dm_(\d+)_(\d+)$/.exec(String(roomId || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Whether this (verified) user may read/write a text room. Channels are open
// to every signed-in user; a DM only to its two participants. Previously
// anyone could load any DM's full history just by asking for its room id.
function canReadRoom(user, roomId) {
  if (!user || typeof roomId !== 'string' || !roomId) return false;
  const participants = dmParticipants(roomId);
  if (participants) {
    return participants.includes(user.id) && !!getRoomById(roomId);
  }
  if (roomId.startsWith('dm_')) return false;
  const room = getCachedRooms().find(r => r.id === roomId);
  return !!room && room.type !== 'dm';
}

// Sends a room-scoped event the way the client expects, but never wider than
// it has to.
//
// Regular text channels stay a plain io.emit: everyone online needs it, since
// that is what drives unread badges for channels they are not currently
// looking at. A DM, however, has exactly two participants, and emitting it to
// every connected socket meant the full text of every private conversation in
// the app was delivered to every other user - hidden in the UI by a
// participant check on the client, but plainly visible to anyone who opened
// devtools. DM events go only to the two participants' own socket rooms (all
// of their sockets, so a second tab or the desktop app still gets them).
function emitToRoomAudience(roomId, event, payload) {
  const participants = dmParticipants(roomId);
  if (!participants) {
    io.to('authed').emit(event, payload);
    return;
  }
  io.to(`user:${participants[0]}`).to(`user:${participants[1]}`).emit(event, payload);
}

function emitNewMessage(savedMsg) {
  emitToRoomAudience(String(savedMsg.room_id || savedMsg.roomId || ''), 'new-message', savedMsg);
}

// Asks the local FastAPI/Groq microservice for a reply and broadcasts it as
// a normal message from the AnucAI bot user, reusing the exact same
// saveMessage + new-message path a real user's message takes (so avatars,
// mentions, unread badges etc. all just work).
async function triggerAiReply(roomId, author, messageText, requesterSocketId) {
  const typingTarget = io.to(`text:${roomId}`);
  try {
    typingTarget.emit('user-typing', { username: AI_BOT_USERNAME, roomId });

    const cleanedText = messageText.replace(new RegExp(`@${AI_BOT_USERNAME}`, 'gi'), '').trim();
    const res = await fetch(`${AI_SERVICE_URL}/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: cleanedText || messageText, username: author }),
      // The Python service gives Groq 15s; never leave the typing indicator
      // hanging much longer than that if the service itself is stuck.
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`AI service HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const reply = (data.reply || '').trim();
    if (!reply) {
      throw new Error('AI service returned an empty reply - check `pm2 logs anucai-ai` for the underlying Groq error.');
    }

    const savedMsg = saveMessage(roomId, AI_BOT_USERNAME, reply, null, null);
    const botRow = getUsersByNameLower().get(AI_BOT_USERNAME.toLowerCase());
    if (botRow && botRow.avatar) savedMsg.avatar = botRow.avatar;
    emitNewMessage(savedMsg);
  } catch (err) {
    console.error('[AnucAI] reply failed:', err.message);
    // Without this the user only ever saw "AnucAI yazıyor..." and then
    // nothing at all whenever the AI service was down or had no valid key.
    if (requesterSocketId) {
      io.to(requesterSocketId).emit('error', { message: 'AnucAI şu an yanıt veremiyor, lütfen daha sonra tekrar dene.' });
    }
  } finally {
    typingTarget.emit('user-stop-typing', { username: AI_BOT_USERNAME, roomId });
  }
}

function getVoiceOccupantsData() {
  const occupants = {};
  for (const [roomId, usersMap] of voiceRooms.entries()) {
    occupants[roomId] = Array.from(usersMap.entries()).map(([id, userObj]) => ({
      socketId: id,
      username: userObj.username,
      avatar: userObj.avatar || null,
      isMuted: userObj.isMuted || false,
      isDeafened: userObj.isDeafened || false,
      isTalking: userObj.isTalking || false,
      isScreenSharing: userObj.isScreenSharing || false,
      isCameraOn: userObj.isCameraOn || false
    }));
  }
  return occupants;
}

// Voice occupant updates arrive in bursts (a user joining a room triggers a
// join + a status sync + an avatar sync within a few ms, and every client
// rebuilds its whole channel sidebar for each one). Coalescing them into a
// single emit on the next tick collapses those bursts into one update.
let voiceBroadcastPending = false;
function broadcastVoiceOccupants(ioInstance) {
  if (!ioInstance || voiceBroadcastPending) return;
  voiceBroadcastPending = true;
  setTimeout(() => {
    voiceBroadcastPending = false;
    ioInstance.to('authed').emit('voice-occupants-updated', getVoiceOccupantsData());
  }, 40);
}

// The roster (allUsers) carries every user's avatar AND profile banner as
// base64 data URLs, so it can easily be hundreds of KB. Re-sending it to every
// connected client on every connect/disconnect was by far the heaviest thing
// this server did. It is now only attached when the roster actually changed;
// otherwise clients reuse the copy they already hold.
let lastBroadcastUsersRevision = -1;

// The bot has no real socket connection, so it never lands in `onlineUsers`
// naturally - it's injected as a synthetic entry so it always shows online
// wherever the client renders the shared onlineUsernamesSet (member list,
// friends dashboard, mention dropdown, etc).
function getBotOnlineEntry() {
  const botRow = getUsersByNameLower().get(AI_BOT_USERNAME.toLowerCase());
  if (!botRow) return null;
  return { socketId: 'ai-bot', username: botRow.username, avatar: botRow.avatar || null, userId: botRow.id };
}

function broadcastOnlineUsers(ioInstance, force = false) {
  if (!ioInstance) return;
  const users = [];
  for (const [socketId, data] of onlineUsers.entries()) {
    users.push({ socketId, username: data.username, avatar: data.avatar || null, userId: data.userId || null, away: !!data.away });
  }
  const botEntry = getBotOnlineEntry();
  if (botEntry) users.push(botEntry);

  const payload = { onlineUsers: users, usersRevision: allUsersRevision };
  if (force || allUsersRevision !== lastBroadcastUsersRevision) {
    payload.allUsers = getCachedAllUsers();
    lastBroadcastUsersRevision = allUsersRevision;
  }
  // Only signed-in sockets ever get the roster.
  ioInstance.to('authed').emit('online-users-updated', payload);
}

// Sent only to one socket (on connect), so it always carries the full roster.
function sendOnlineUsersTo(socket) {
  const users = [];
  for (const [socketId, data] of onlineUsers.entries()) {
    users.push({ socketId, username: data.username, avatar: data.avatar || null, userId: data.userId || null, away: !!data.away });
  }
  const botEntry = getBotOnlineEntry();
  if (botEntry) users.push(botEntry);
  socket.emit('online-users-updated', {
    onlineUsers: users,
    allUsers: getCachedAllUsers(),
    usersRevision: allUsersRevision
  });
}

// Reads the token the client hands over in the socket.io handshake
// (`auth: { token }`). The connection is still accepted without one so an
// outdated client gets a readable "please update / log in again" error
// instead of an endless reconnect loop - it just can't do anything.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  socket.data.user = token ? verifySession(token) : null;
  next();
});

const SESSION_INVALID_MESSAGE = 'Oturumunuz doğrulanamadı. Lütfen tekrar giriş yapın (masaüstü uygulamasını kullanıyorsanız önce son sürüme güncelleyin).';

fastify.ready((err) => {
  if (err) throw err;

  initSfu(io);

  io.on('connection', (socket) => {
    let currentVoiceRoom = null;
    let currentTextRoom = null;

    // Verified identity of this socket, or null. Kept on socket.data so the
    // profile-update route can refresh the username/avatar in place.
    const me = () => socket.data.user || null;

    // Per-socket flood limits: a raw client could otherwise fill the
    // database (and everyone's screen) with messages in a tight loop.
    const messageLimiter = createRateLimiter(5000, 10);
    const actionLimiter = createRateLimiter(10000, 20);

    function adoptIdentity(user) {
      const previous = socket.data.user;
      if (previous && previous.id !== user.id) socket.leave(`user:${previous.id}`);
      socket.data.user = user;
      socket.join(`user:${user.id}`);
      socket.join('authed');
    }

    function requireUser() {
      const user = me();
      if (!user) socket.emit('error', { message: SESSION_INVALID_MESSAGE });
      return user;
    }

    function requireAdmin() {
      const user = me();
      if (!user) {
        socket.emit('error', { message: SESSION_INVALID_MESSAGE });
        return null;
      }
      // Re-read the role: it is the one thing a stale in-memory copy must
      // never be trusted for.
      const row = getUserById(user.id);
      if (!row || row.role !== 'admin') {
        socket.emit('error', { message: 'Bu işlem için admin yetkisi gerekiyor.' });
        return null;
      }
      return user;
    }

    if (me()) adoptIdentity(me());

    // Send initial voice occupants map (signed-in sockets only; one that
    // authenticates later via set-username gets it there)
    if (me()) socket.emit('voice-occupants-updated', getVoiceOccupantsData());

    // Registers this socket as online. The token is accepted here as well
    // (not just in the handshake) so a client can re-authenticate an open
    // socket, e.g. after a password change hands it a new token. The
    // username/avatar/userId the client sends along are ignored - the
    // verified account decides them.
    socket.on('set-username', (data) => {
      const token = data && typeof data === 'object' ? data.token : null;
      if (token) {
        const user = verifySession(token);
        if (user) adoptIdentity(user);
      }
      const user = me();
      if (!user) {
        socket.emit('session-invalid');
        socket.emit('error', { message: SESSION_INVALID_MESSAGE });
        return;
      }

      const isNewIdentity = !onlineUsers.has(socket.id);
      const previousEntry = onlineUsers.get(socket.id);
      onlineUsers.set(socket.id, { username: user.username, avatar: user.avatar || null, userId: user.id, away: !!(previousEntry && previousEntry.away) });

      // Sync username & avatar inside active voice room
      if (currentVoiceRoom && voiceRooms.has(currentVoiceRoom)) {
        const userObj = voiceRooms.get(currentVoiceRoom).get(socket.id);
        if (userObj) {
          userObj.username = user.username;
          userObj.avatar = user.avatar || null;
        }
        broadcastVoiceOccupants(io);
      }

      broadcastOnlineUsers(io);
      // A freshly identified socket has no roster yet, and the broadcast
      // above only carries one when the roster changed - so hand this one
      // client its own full copy.
      if (isNewIdentity) {
        sendOnlineUsersTo(socket);
        socket.emit('voice-occupants-updated', getVoiceOccupantsData());
      }
    });

    socket.on('typing', (data) => {
      const user = me();
      if (!user || !data || data.roomId !== currentTextRoom || !currentTextRoom) return;
      socket.to(`text:${data.roomId}`).emit('user-typing', {
        username: user.username,
        roomId: data.roomId
      });
    });

    socket.on('stop-typing', (data) => {
      const user = me();
      if (!user || !data || data.roomId !== currentTextRoom || !currentTextRoom) return;
      socket.to(`text:${data.roomId}`).emit('user-stop-typing', {
        username: user.username,
        roomId: data.roomId
      });
    });

    // --- CHANNEL MANAGEMENT EVENTS ---
    // Admin only: deleting a channel also deletes every message in it, and
    // any signed-in (or, before, even signed-out) socket used to be able to.
    socket.on('create-channel', (data) => {
      if (!requireAdmin()) return;
      const name = data && typeof data.name === 'string' ? data.name.trim() : '';
      const type = data && data.type === 'voice' ? 'voice' : 'text';
      if (!name || name.length > MAX_CHANNEL_NAME_CHARS) {
        socket.emit('error', { message: `Kanal adı 1-${MAX_CHANNEL_NAME_CHARS} karakter olmalıdır.` });
        return;
      }
      const newRoom = createRoom(name, type);
      invalidateRoomsCache();
      io.emit('channel-created', newRoom);
    });

    socket.on('rename-channel', (data) => {
      if (!requireAdmin()) return;
      const roomId = data && data.roomId;
      const newName = data && typeof data.newName === 'string' ? data.newName.trim() : '';
      if (!roomId || !newName) return;
      if (newName.length > MAX_CHANNEL_NAME_CHARS) {
        socket.emit('error', { message: `Kanal adı en fazla ${MAX_CHANNEL_NAME_CHARS} karakter olabilir.` });
        return;
      }
      const room = getCachedRooms().find(r => r.id === roomId);
      if (!room || room.type === 'dm') return;

      const updatedRoom = renameRoom(roomId, newName);
      invalidateRoomsCache();
      io.emit('channel-renamed', updatedRoom);
    });

    socket.on('delete-channel', (data) => {
      if (!requireAdmin()) return;
      const roomId = data && data.roomId;
      if (!roomId) return;
      if (roomId === CS2_ROOM_ID) {
        socket.emit('error', { message: 'CS2 ROOM silinemez.' });
        return;
      }
      const room = getCachedRooms().find(r => r.id === roomId);
      if (!room || room.type === 'dm') return;
      deleteRoom(roomId);
      invalidateRoomsCache();
      io.emit('channel-deleted', { roomId });
    });

    socket.on('reorder-channels', (data) => {
      if (!requireAdmin()) return;
      const channelIds = data && data.channelIds;
      if (Array.isArray(channelIds) && channelIds.length <= 500 && channelIds.every(id => typeof id === 'string')) {
        const updatedRooms = reorderRooms(channelIds);
        invalidateRoomsCache();
        io.emit('channels-reordered', updatedRooms.filter(r => r.type !== 'dm'));
      }
    });

    // --- TEXT CHAT EVENTS ---
    socket.on('join-text-room', (roomId) => {
      const user = me();
      try {
        if (!user || !canReadRoom(user, roomId)) {
          socket.emit('message-history', { roomId, messages: [] });
          if (!user) socket.emit('error', { message: SESSION_INVALID_MESSAGE });
          return;
        }
        // Leave previous text room to stop receiving its messages
        if (currentTextRoom && currentTextRoom !== roomId) {
          socket.leave(`text:${currentTextRoom}`);
        }
        currentTextRoom = roomId;
        socket.join(`text:${roomId}`);
        const history = getRecentMessages(roomId);
        const payload = { roomId, messages: history || [] };
        // Read-receipt cursors are only meaningful for DMs (a channel has no
        // concept of "the other person"), so skip the extra query elsewhere.
        if (roomId.startsWith('dm_')) {
          payload.dmReadState = getDmReadState(roomId);
        }
        socket.emit('message-history', payload);
      } catch (err) {
        console.error('Error in join-text-room:', err);
        socket.emit('message-history', { roomId, messages: [] });
      }
    });

    socket.on('mark-dm-read', (data) => {
      const user = me();
      const roomId = data && data.roomId;
      const messageId = Number(data && data.messageId);
      if (!user || !dmParticipants(roomId) || !Number.isInteger(messageId) || messageId <= 0) return;
      if (!canReadRoom(user, roomId)) return;
      try {
        markDmRead(roomId, user.id, messageId);
        emitToRoomAudience(roomId, 'dm-read-updated', { roomId, userId: user.id, lastReadMessageId: messageId });
      } catch (err) {
        console.error('mark-dm-read error:', err);
      }
    });

    socket.on('leave-text-room', (roomId) => {
      if (roomId) {
        socket.leave(`text:${roomId}`);
        if (currentTextRoom === roomId) {
          currentTextRoom = null;
        }
      }
    });

    socket.on('get-older-messages', (data) => {
      const user = me();
      const roomId = data && data.roomId;
      const beforeId = Number(data && data.beforeId);
      if (!user || !roomId || !Number.isInteger(beforeId)) return;
      if (!canReadRoom(user, roomId)) return;
      const older = getOlderMessages(roomId, beforeId, 30);
      socket.emit('older-messages-history', { roomId, beforeId: data.beforeId, messages: older || [] });
    });

    // The quoted snapshot is rebuilt from the database rather than taken
    // from the client, so a reply can't put words in someone else's mouth.
    function buildReplySnapshot(replyTo, roomId) {
      const replyId = Number(replyTo && replyTo.id);
      if (!Number.isInteger(replyId)) return null;
      const original = getMessageById(replyId);
      if (!original || original.room_id !== roomId) return null;
      return {
        id: original.id,
        username: original.username,
        content: (original.content || (original.image_data ? '[Görsel]' : '')).slice(0, 300)
      };
    }

    socket.on('send-message', (data) => {
      try {
        const user = requireUser();
        if (!user || !data) return;
        const { roomId, content, imageData, replyTo } = data;
        const author = user.username;
        const text = typeof content === 'string' ? content.trim() : '';
        if (!text && !imageData) return;

        if (!canReadRoom(user, roomId)) {
          socket.emit('error', { message: 'Bu kanala mesaj gönderemezsiniz.' });
          return;
        }
        if (text.length > MAX_MESSAGE_CHARS) {
          socket.emit('error', { message: `Mesaj en fazla ${MAX_MESSAGE_CHARS} karakter olabilir.` });
          return;
        }
        if (imageData && !isAllowedChatImage(imageData)) {
          socket.emit('error', { message: 'Görsel geçersiz veya çok büyük.' });
          return;
        }
        if (!messageLimiter.hit('msg')) {
          socket.emit('error', { message: 'Çok hızlı mesaj gönderiyorsun, biraz yavaşla.' });
          return;
        }

        const savedMsg = saveMessage(roomId, author, text, imageData || null, replyTo ? buildReplySnapshot(replyTo, roomId) : null);

        const authorRow = getUsersByNameLower().get(author.toLowerCase());
        const avatar = authorRow ? authorRow.avatar : getUserAvatarByUsername(author);
        if (avatar) {
          savedMsg.avatar = avatar;
        }

        emitNewMessage(savedMsg);

        const messageText = text;

        // DMs with the bot: every message gets a reply, no @mention needed -
        // it's a 1:1 conversation, so there's no ambiguity about who it's for.
        const dmIds = dmParticipants(roomId);
        if (dmIds) {
          const botRow = getUsersByNameLower().get(AI_BOT_USERNAME.toLowerCase());
          if (botRow && dmIds.includes(botRow.id)) {
            if (messageText) triggerAiReply(roomId, author, messageText, socket.id);
            return;
          }
        }

        // --- Mention detection & notification ---
        // Skip all of this entirely for the common case of a message with no
        // "@" in it, and reuse the precompiled roster regex otherwise.
        if (!messageText.includes('@')) return;

        const mentionRegex = getMentionRegex();
        mentionRegex.lastIndex = 0;
        const rawMentions = [...messageText.matchAll(mentionRegex)].map(m => m[1] || m[2]).filter(Boolean);
        if (rawMentions.length > 0) {
          const mentionsAll = rawMentions.some(m => m.toLowerCase() === 'all' || m.toLowerCase() === 'everyone');
          const room = getCachedRooms().find(r => r.id === roomId);
          const roomName = room ? room.name : roomId;
          const payload = {
            roomId,
            roomName,
            author,
            content: messageText,
            messageId: savedMsg.id
          };
          // A mention inside a DM must never notify (and so leak the text
          // to) anyone outside that DM.
          const mayNotify = (data) => !dmIds || dmIds.includes(data.userId);

          if (mentionsAll) {
            for (const [sId, data] of onlineUsers.entries()) {
              if (sId !== socket.id && data.username && data.username.toLowerCase() !== author.toLowerCase() && mayNotify(data)) {
                io.to(sId).emit('mention-notify', payload);
              }
            }
          } else {
            const mentionedUsernamesLower = new Set(
              rawMentions
                .filter(m => m.toLowerCase() !== 'all' && m.toLowerCase() !== 'everyone')
                .map(m => m.toLowerCase())
            );
            for (const [sId, data] of onlineUsers.entries()) {
              if (sId === socket.id) continue;
              if (data.username && mayNotify(data)) {
                const uNameLower = data.username.toLowerCase();
                if (uNameLower !== author.toLowerCase() && mentionedUsernamesLower.has(uNameLower)) {
                  io.to(sId).emit('mention-notify', payload);
                }
              }
            }
          }

          if (rawMentions.some(m => m.toLowerCase() === AI_BOT_USERNAME.toLowerCase())) {
            triggerAiReply(roomId, author, messageText, socket.id);
          }
        }
      } catch (err) {
        console.error('Error in send-message handler:', err);
      }
    });

    socket.on('edit-message', (data) => {
      const user = requireUser();
      if (!user || !data) return;
      const { messageId, newContent } = data;
      const text = typeof newContent === 'string' ? newContent.trim() : '';
      if (!messageId || !text) return;
      if (text.length > MAX_MESSAGE_CHARS) {
        socket.emit('error', { message: `Mesaj en fazla ${MAX_MESSAGE_CHARS} karakter olabilir.` });
        return;
      }
      try {
        const original = getMessageById(messageId);
        if (!original) throw new Error('Mesaj bulunamadı veya düzenleme yetkiniz yok.');
        editMessage(messageId, user.username, text);
        emitToRoomAudience(original.room_id, 'message-edited', { id: original.id, roomId: original.room_id, content: text });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('delete-message', (data) => {
      const user = requireUser();
      const messageId = data && data.messageId;
      if (!user || !messageId) return;
      // Admin rights come from the database, not from whatever token the
      // client attached to the event.
      const row = getUserById(user.id);
      const isAdmin = !!row && row.role === 'admin';
      try {
        const original = getMessageById(messageId);
        if (!original) throw new Error('Mesaj bulunamadı veya silme yetkiniz yok.');
        deleteMessage(original.id, user.username, isAdmin);
        emitToRoomAudience(original.room_id, 'message-deleted', { id: original.id, roomId: original.room_id });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('toggle-reaction', (data) => {
      const user = me();
      if (!user || !data || !data.messageId || !ALLOWED_REACTIONS.includes(data.emoji)) return;
      if (!actionLimiter.hit('reaction')) return;
      try {
        const original = getMessageById(data.messageId);
        if (!original || !canReadRoom(user, original.room_id)) return;
        const result = toggleReaction(original.id, user.username, data.emoji);
        emitToRoomAudience(original.room_id, 'reaction-updated', { messageId: original.id, roomId: original.room_id, emoji: data.emoji, username: user.username, action: result.action });
      } catch (err) {
        console.error('Reaction toggle error:', err);
      }
    });

    // --- WEBRTC VOICE SIGNALING EVENTS ---
    socket.on('join-voice-room', (data) => {
      const user = requireUser();
      const roomId = data && data.roomId;
      if (!user || !roomId) return;
      const room = getCachedRooms().find(r => r.id === roomId);
      if (!room || room.type !== 'voice') {
        socket.emit('error', { message: 'Ses odası bulunamadı.' });
        return;
      }
      const username = user.username;

      // Leave previous voice room if any
      if (currentVoiceRoom && currentVoiceRoom !== roomId) {
        leaveVoiceRoom(socket, currentVoiceRoom);
      }

      currentVoiceRoom = roomId;
      socket.join(`voice:${roomId}`);

      if (!voiceRooms.has(roomId)) {
        voiceRooms.set(roomId, new Map());
      }
      const roomUsers = voiceRooms.get(roomId);

      const userAvatar = user.avatar || getUserAvatarByUsername(username) || null;
      const initialMuted = !!data.isMuted;
      const initialDeafened = !!data.isDeafened;

      // Get existing users in room before adding new one
      const existingPeers = Array.from(roomUsers.entries())
        .filter(([id]) => id !== socket.id)
        .map(([id, userObj]) => ({
          socketId: id,
          username: userObj.username,
          avatar: userObj.avatar || null,
          isMuted: userObj.isMuted || false,
          isDeafened: userObj.isDeafened || false,
          isScreenSharing: userObj.isScreenSharing || false,
          isCameraOn: userObj.isCameraOn || false
        }));

      // Add current user
      roomUsers.set(socket.id, {
        username,
        avatar: userAvatar,
        isMuted: initialMuted,
        isDeafened: initialDeafened,
        isScreenSharing: false,
        isCameraOn: false
      });

      // Send existing peers list to the newly connected user
      socket.emit('voice-room-users', existingPeers);

      // Notify existing users about the new peer
      socket.to(`voice:${roomId}`).emit('user-joined-voice', {
        socketId: socket.id,
        username,
        avatar: userAvatar,
        isMuted: initialMuted,
        isDeafened: initialDeafened,
        isScreenSharing: false
      });

      // Broadcast sidebar voice occupants list
      broadcastVoiceOccupants(io);
    });

    socket.on('leave-voice-room', () => {
      leaveVoiceRoom(socket, currentVoiceRoom);
      currentVoiceRoom = null;
      broadcastVoiceOccupants(io);
    });

    // WebRTC signaling is only relayed between two sockets that are in the
    // same voice room right now - not to arbitrary socket ids.
    function isVoicePeer(targetSocketId) {
      if (!me() || !currentVoiceRoom || typeof targetSocketId !== 'string' || targetSocketId === socket.id) return false;
      const roomUsers = voiceRooms.get(currentVoiceRoom);
      return !!roomUsers && roomUsers.has(targetSocketId);
    }

    // WebRTC Signaling Forwarding
    socket.on('offer', (data) => {
      if (!data || !isVoicePeer(data.targetSocketId)) return;
      const user = me();
      io.to(data.targetSocketId).emit('offer', {
        fromSocketId: socket.id,
        username: user.username,
        avatar: user.avatar || null,
        sdp: data.sdp,
        meta: data.meta
      });
    });

    socket.on('answer', (data) => {
      if (!data || !isVoicePeer(data.targetSocketId)) return;
      io.to(data.targetSocketId).emit('answer', {
        fromSocketId: socket.id,
        sdp: data.sdp,
        meta: data.meta
      });
    });

    socket.on('ice-candidate', (data) => {
      if (!data || !isVoicePeer(data.targetSocketId)) return;
      io.to(data.targetSocketId).emit('ice-candidate', {
        fromSocketId: socket.id,
        candidate: data.candidate
      });
    });

    // --- CS2 ROOM: server-relayed audio SFU signaling (see sfu.js) ---
    // Separate from the P2P offer/answer/ice-candidate events above - this
    // room's clients each hold exactly one RTCPeerConnection, to the server,
    // instead of one per other participant.
    socket.on('sfu-join', () => {
      const user = me();
      // Only someone who actually joined CS2 ROOM gets a server-side
      // WebRTC connection (each one costs the host real CPU/RAM).
      if (!user || currentVoiceRoom !== CS2_ROOM_ID) return;
      joinSfu(socket.id, user.username, user.avatar || null).catch(err => console.error('[SFU] join error:', err));
    });

    socket.on('sfu-answer', (data) => {
      if (data && typeof data.sdp === 'string') handleSfuAnswer(socket.id, data.sdp);
    });

    socket.on('sfu-ice-candidate', (data) => {
      if (data) handleSfuIceCandidate(socket.id, data.candidate);
    });

    socket.on('sfu-leave', () => {
      leaveSfu(socket.id);
    });

    socket.on('voice-status-update', (data) => {
      if (!data) return;
      const { isMuted, isDeafened, isTalking } = data;
      if (currentVoiceRoom && voiceRooms.has(currentVoiceRoom)) {
        const roomUsers = voiceRooms.get(currentVoiceRoom);
        const userObj = roomUsers.get(socket.id);
        const muteStateChanged = userObj && (userObj.isMuted !== !!isMuted || userObj.isDeafened !== !!isDeafened);
        if (userObj) {
          userObj.isMuted = !!isMuted;
          userObj.isDeafened = !!isDeafened;
          userObj.isTalking = !!isTalking;
        }

        // Forward talking/mute/deafen status to peers in the same voice room
        socket.to(`voice:${currentVoiceRoom}`).emit('peer-status-update', {
          socketId: socket.id,
          isMuted: !!isMuted,
          isDeafened: !!isDeafened,
          isTalking: !!isTalking
        });

        // Only broadcast sidebar occupants on mute/deafen changes, NOT on every isTalking toggle
        // isTalking is handled peer-to-peer via peer-status-update above
        if (muteStateChanged) {
          broadcastVoiceOccupants(io);
        }
      }
    });

    socket.on('screen-share-status', (data) => {
      const sharing = !!(data && data.sharing);
      if (currentVoiceRoom && voiceRooms.has(currentVoiceRoom)) {
        const roomUsers = voiceRooms.get(currentVoiceRoom);
        const userObj = roomUsers.get(socket.id);
        if (userObj) {
          userObj.isScreenSharing = sharing;
        }
        broadcastVoiceOccupants(io);
        socket.to(`voice:${currentVoiceRoom}`).emit('peer-status-update', {
          socketId: socket.id,
          isMuted: userObj ? userObj.isMuted : false,
          isDeafened: userObj ? userObj.isDeafened : false,
          isTalking: userObj ? userObj.isTalking : false,
          isScreenSharing: sharing
        });
      }
    });

    socket.on('camera-status', (data) => {
      const on = !!(data && data.on);
      if (currentVoiceRoom && voiceRooms.has(currentVoiceRoom)) {
        const roomUsers = voiceRooms.get(currentVoiceRoom);
        const userObj = roomUsers.get(socket.id);
        if (userObj) {
          userObj.isCameraOn = on;
        }
        broadcastVoiceOccupants(io);
        socket.to(`voice:${currentVoiceRoom}`).emit('peer-status-update', {
          socketId: socket.id,
          isMuted: userObj ? userObj.isMuted : false,
          isDeafened: userObj ? userObj.isDeafened : false,
          isTalking: userObj ? userObj.isTalking : false,
          isCameraOn: on
        });
      }
    });

    socket.on('delete-user-by-admin', (data) => {
      const admin = requireAdmin();
      const targetUsername = data && data.targetUsername;
      if (!admin || targetUsername == null) return;

      if (admin.username.toLowerCase() === String(targetUsername).toLowerCase()) {
        socket.emit('error', { message: 'Kendi hesabınızı silemezsiniz.' });
        return;
      }

      try {
        const deleted = deleteUserByAdmin(targetUsername);
        // Without this, getCachedAllUsers() keeps serving the pre-delete
        // roster and broadcastOnlineUsers() below sees no revision change,
        // so it skips attaching `allUsers` entirely - clients fall back to
        // their own stale copy and the deleted (often offline) user never
        // disappears until some unrelated register/profile-update happens.
        invalidateAllUsersCache();

        // Disconnect active socket connections for the deleted user
        for (const [sId, uObj] of onlineUsers.entries()) {
          if (uObj.userId === deleted.id) {
            const targetSocket = io.sockets.sockets.get(sId);
            if (targetSocket) {
              targetSocket.emit('account-deleted', { message: 'Hesabınız yönetici tarafından silindi.' });
              targetSocket.disconnect(true);
            }
            onlineUsers.delete(sId);
          }
        }

        broadcastOnlineUsers(io);

        // Broadcast user deletion so all clients remove messages and update UI
        io.emit('user-deleted-by-admin', {
          username: deleted.username,
          userId: deleted.id
        });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // --- FRIEND & DM SYSTEM SOCKET LISTENERS ---
    const getActiveUserId = () => {
      const user = me();
      return user ? user.id : null;
    };

    function sendFriendsDataToUser(uId) {
      const fList = getFriends(uId);
      const reqs = getFriendRequests(uId);
      io.to(`user:${uId}`).emit('friends-data-response', { friends: fList, requests: reqs });
    }

    socket.on('get-friends-data', () => {
      const activeUserId = getActiveUserId();
      if (!activeUserId) return;
      try {
        const friendsList = getFriends(activeUserId);
        const requests = getFriendRequests(activeUserId);
        socket.emit('friends-data-response', { friends: friendsList, requests });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('send-friend-request', (data) => {
      const activeUserId = getActiveUserId();
      const targetUsername = data && typeof data.targetUsername === 'string' ? data.targetUsername.trim() : '';
      if (!activeUserId) {
        socket.emit('error', { message: 'Oturum bilgisi alınamadı, lütfen tekrar giriş yapın.' });
        return;
      }
      if (!targetUsername) return;
      if (!actionLimiter.hit('friend-request')) {
        socket.emit('error', { message: 'Çok fazla istek gönderdin, biraz bekle.' });
        return;
      }
      try {
        const res = sendFriendRequest(activeUserId, targetUsername);
        socket.emit('friend-request-sent', { message: `"${res.targetUser.username}" adlı kullanıcıya arkadaşlık isteği gönderildi.`, res });

        // Refresh the sender's own lists (every tab of theirs)
        sendFriendsDataToUser(activeUserId);

        // Notify target user if connected
        io.to(`user:${res.targetUser.id}`).emit('friend-request-received', {
          senderUsername: me().username,
          senderId: activeUserId
        });
        sendFriendsDataToUser(res.targetUser.id);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('accept-friend-request', (data) => {
      const activeUserId = getActiveUserId();
      if (!activeUserId || !data) return;
      try {
        const res = acceptFriendRequest(Number(data.requestId), activeUserId);
        socket.emit('friend-request-accepted', res);

        // Send updated friends data to both users
        sendFriendsDataToUser(res.senderId);
        sendFriendsDataToUser(res.receiverId);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('reject-friend-request', (data) => {
      const activeUserId = getActiveUserId();
      if (!activeUserId || !data) return;
      try {
        const requestId = Number(data.requestId);
        const before = db.prepare('SELECT sender_id, receiver_id FROM friend_requests WHERE id = ?').get(requestId);
        rejectFriendRequest(requestId, activeUserId);
        sendFriendsDataToUser(activeUserId);
        // The other side's pending list changes too (a cancelled outgoing
        // request used to stay visible to its recipient until reload).
        if (before) {
          const otherId = before.sender_id === activeUserId ? before.receiver_id : before.sender_id;
          sendFriendsDataToUser(otherId);
        }
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('remove-friend', (data) => {
      const activeUserId = getActiveUserId();
      const friendId = Number(data && data.friendId);
      if (!activeUserId || !Number.isInteger(friendId)) return;
      try {
        removeFriend(activeUserId, friendId);
        sendFriendsDataToUser(activeUserId);
        sendFriendsDataToUser(friendId);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('get-or-create-dm', (data) => {
      const activeUserId = getActiveUserId();
      const targetUserId = Number(data && data.targetUserId);
      if (!activeUserId || !Number.isInteger(targetUserId)) return;
      try {
        const dmRoom = getOrCreateDMRoom(activeUserId, targetUserId);
        socket.emit('dm-room-ready', { room: dmRoom });

        // Notify other user
        io.to(`user:${targetUserId}`).emit('dm-room-created', { room: dmRoom });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // Fired once by a freshly-registered client right after its first
    // 'set-username'. The welcome DM is written straight to the DB during
    // HTTP registration (no socket exists yet at that point), so it never
    // went through the normal new-message broadcast and the client never
    // got a notification for it - this replays it, targeted only at the
    // requesting socket, through that exact same 'new-message' path so the
    // existing unread badge / toast / desktop notification logic just works.
    socket.on('claim-welcome-dm', () => {
      const activeUserId = getActiveUserId();
      if (!activeUserId) return;
      try {
        const botRow = getUsersByNameLower().get(AI_BOT_USERNAME.toLowerCase());
        if (!botRow || botRow.id === activeUserId) return;
        const dmRoom = getOrCreateDMRoom(activeUserId, botRow.id);
        const recent = getRecentMessages(dmRoom.id, 5);
        const welcomeMsg = [...recent].reverse().find(m => m.username === AI_BOT_USERNAME);
        if (welcomeMsg) socket.emit('new-message', welcomeMsg);
      } catch (err) {
        console.error('[AnucAI] claim-welcome-dm failed:', err.message);
      }
    });

    // The window was hidden (tray-minimized or a backgrounded tab) for long
    // enough that the client decided the user counts as away - flips the
    // roster dot from green to amber for everyone else without dropping the
    // socket (voice chat and notifications keep working normally).
    socket.on('set-away', (away) => {
      const entry = onlineUsers.get(socket.id);
      if (!entry) return;
      const val = !!away;
      if (entry.away === val) return;
      entry.away = val;
      broadcastOnlineUsers(io);
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(socket.id);
      broadcastOnlineUsers(io);
      if (currentVoiceRoom) {
        leaveVoiceRoom(socket, currentVoiceRoom);
        broadcastVoiceOccupants(io);
      }
      leaveSfu(socket.id);
    });
  });
});

function leaveVoiceRoom(socket, roomId) {
  if (!roomId) return;
  socket.leave(`voice:${roomId}`);

  if (voiceRooms.has(roomId)) {
    const roomUsers = voiceRooms.get(roomId);
    roomUsers.delete(socket.id);

    if (roomUsers.size === 0) {
      voiceRooms.delete(roomId);
    } else {
      socket.to(`voice:${roomId}`).emit('user-left-voice', {
        socketId: socket.id
      });
    }
  }
}

const PORT = process.env.PORT || 8080;
// HOST lets a reverse-proxied deployment (e.g. Cloudflare Tunnel on the same
// machine) bind to 127.0.0.1 only, so the app port isn't exposed directly.
const HOST = process.env.HOST || '0.0.0.0';

try {
  try {
    await fastify.listen({ port: Number(PORT), host: HOST });
    console.log(`🚀 AnucVC Server running on http://${HOST}:${PORT}`);
  } catch (e) {
    if (HOST === '127.0.0.1') throw e;
    await fastify.listen({ port: Number(PORT), host: '127.0.0.1' });
    console.log(`🚀 AnucVC Server running on http://127.0.0.1:${PORT}`);
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}
