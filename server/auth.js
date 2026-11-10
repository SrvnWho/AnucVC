// Session tokens.
//
// Tokens used to be base64(JSON.stringify({ id, email, time })) with no
// signature, so anyone could mint a valid token for any user id - including
// the admin's - with one line in the browser console. They are now HMAC-SHA256
// signed with a server-side secret:
//
//   v1.<base64url(JSON payload)>.<base64url(HMAC of "v1.<payload>")>
//
// payload = { uid, sv, iat, exp }. `sv` is derived from the user's current
// password salt, which changes on every password change, so changing the
// password logs out every other session holding an old token.
//
// The secret comes from AUTH_SECRET in server/.env. When that isn't set, a
// random one is generated once and kept in server/.auth-secret (gitignored),
// so tokens survive restarts without any configuration.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.join(__dirname, '.auth-secret');
const TOKEN_VERSION = 'v1';
const TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

let cachedSecret = null;

function getSecret() {
  if (cachedSecret) return cachedSecret;

  const fromEnv = (process.env.AUTH_SECRET || '').trim();
  if (fromEnv.length >= 32) {
    cachedSecret = fromEnv;
    return cachedSecret;
  }
  if (fromEnv) {
    console.warn('[auth] AUTH_SECRET 32 karakterden kısa, yok sayıldı - server/.auth-secret kullanılıyor.');
  }

  try {
    const stored = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (stored.length >= 32) {
      cachedSecret = stored;
      return cachedSecret;
    }
  } catch (e) {
    // Not created yet - fall through and generate one.
  }

  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  cachedSecret = generated;
  return cachedSecret;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(data) {
  return crypto.createHmac('sha256', getSecret()).update(data).digest('base64url');
}

// Short fingerprint of the password salt. A new salt is generated on every
// password change, so this changing is what revokes older tokens.
export function sessionVersionFor(salt) {
  return crypto.createHash('sha256').update(String(salt || '')).digest('base64url').slice(0, 16);
}

export function issueToken(userId, salt) {
  const now = Date.now();
  const payload = b64url(JSON.stringify({ uid: Number(userId), sv: sessionVersionFor(salt), iat: now, exp: now + TOKEN_TTL_MS }));
  const body = `${TOKEN_VERSION}.${payload}`;
  return `${body}.${sign(body)}`;
}

// Returns { uid, sv } for a well-formed, correctly signed, unexpired token,
// otherwise null. Callers still have to check `sv` against the user's
// current salt (see verifySession in server.js) - this only proves the
// server issued the token.
export function decodeToken(token) {
  if (typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;

  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (e) {
    return null;
  }
  if (!payload || !Number.isInteger(payload.uid) || typeof payload.sv !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
  return { uid: payload.uid, sv: payload.sv };
}

// Constant-time string comparison for shared secrets (e.g. the CI upload
// secret), so response timing can't be used to guess them byte by byte.
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}
