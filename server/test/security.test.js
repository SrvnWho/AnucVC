// End-to-end security regression tests.
//
// Starts a real server.js on a throwaway database and port, then attacks it
// the way the pre-hardening code could be attacked: forged tokens, a socket
// claiming someone else's identity, reading other people's DMs, stored-XSS
// payloads, self-accepted friend requests, brute-force logins. Run with:
//
//   npm test            (from server/)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anucvc-test-'));

// A stand-in for the Python AI service that always fails, like it does
// when the Groq key is expired.
let fakeAi;
const AI_PORT = PORT + 1000;

let serverProc;
const sockets = [];

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

function connect(token) {
  const s = ioClient(BASE, { transports: ['websocket'], auth: token ? { token } : {}, forceNew: true, reconnection: false });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function waitFor(socket, event, ms = 1500, predicate = () => true) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload ?? true);
    }
    socket.on(event, handler);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let admin, alice, bob; // { user, token }

before(async () => {
  fakeAi = http.createServer((req, res) => { res.writeHead(500); res.end('groq key expired'); });
  await new Promise(r => fakeAi.listen(AI_PORT, '127.0.0.1', r));

  serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ANUCVC_DB_PATH: path.join(tmpDir, 'test.db'),
      AUTH_SECRET: 'test-only-secret-0123456789abcdef0123456789abcdef',
      AI_SERVICE_URL: `http://127.0.0.1:${AI_PORT}`,
      GIPHY_API_KEY: '',
      UPDATE_UPLOAD_SECRET: 'ci-secret-value'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
    serverProc.stdout.on('data', (d) => { if (String(d).includes('running on')) { clearTimeout(timer); resolve(); } });
    serverProc.stderr.on('data', (d) => process.stderr.write(d));
    serverProc.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });

  const reg = async (email, username) => {
    const r = await api('POST', '/api/auth/register', { email, password: 'secret123', username });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { user: r.data.user, token: r.data.token };
  };
  admin = await reg('admin@test.local', 'AdminUser');
  alice = await reg('alice@test.local', 'Alice');
  bob = await reg('bob@test.local', 'Bob');
});

after(async () => {
  for (const s of sockets) s.disconnect();
  if (serverProc) serverProc.kill();
  if (fakeAi) fakeAi.close();
  await sleep(300);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
});

test('first account is admin, later ones are not', () => {
  assert.equal(admin.user.role, 'admin');
  assert.equal(alice.user.role, 'user');
});

test('the old unsigned base64 token format is rejected everywhere', async () => {
  const forged = Buffer.from(JSON.stringify({ id: admin.user.id, email: 'x', time: Date.now() })).toString('base64');
  assert.equal((await api('GET', '/api/auth/me', null, forged)).status, 401);
  assert.equal((await api('GET', '/api/system/stats', null, forged)).status, 401);
  assert.equal((await api('GET', '/api/users', null, forged)).status, 401);
  assert.equal((await api('POST', '/api/auth/update-profile', { username: 'pwned' }, forged)).status, 401);
});

test('a signed token with a swapped user id is rejected', async () => {
  const [v, payload, sig] = alice.token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
  decoded.uid = admin.user.id;
  const tampered = [v, Buffer.from(JSON.stringify(decoded)).toString('base64url'), sig].join('.');
  assert.equal((await api('GET', '/api/auth/me', null, tampered)).status, 401);
  assert.equal((await api('GET', '/api/auth/me', null, alice.token)).status, 200);
});

test('admin-only HTTP endpoint refuses normal users', async () => {
  assert.equal((await api('GET', '/api/system/stats', null, alice.token)).status, 403);
  assert.equal((await api('GET', '/api/system/stats', null, admin.token)).status, 200);
});

test('a socket without a valid session cannot impersonate the admin', async () => {
  const s = await connect(null);
  const invalid = waitFor(s, 'session-invalid');
  s.emit('set-username', { username: 'AdminUser', userId: admin.user.id });
  assert.ok(await invalid, 'expected session-invalid');

  const deleted = waitFor(s, 'user-deleted-by-admin', 800);
  s.emit('delete-user-by-admin', { targetUsername: 'Bob' });
  assert.equal(await deleted, null, 'unauthenticated socket deleted a user');
  assert.equal((await api('GET', '/api/auth/me', null, bob.token)).status, 200);
});

test('a normal user cannot delete users or manage channels', async () => {
  const s = await connect(alice.token);
  s.emit('set-username', {});
  await sleep(150);

  const err1 = waitFor(s, 'error');
  s.emit('delete-user-by-admin', { targetUsername: 'Bob' });
  assert.match((await err1).message, /admin/i);

  const created = waitFor(s, 'channel-created', 800);
  s.emit('create-channel', { name: 'spam', type: 'text' });
  assert.equal(await created, null);

  const deleted = waitFor(s, 'channel-deleted', 800);
  s.emit('delete-channel', { roomId: 'genel' });
  assert.equal(await deleted, null);
  const rooms = (await api('GET', '/api/rooms')).data;
  assert.ok(rooms.some(r => r.id === 'genel'), '#genel was deleted');
});

test('admin can still manage channels', async () => {
  const s = await connect(admin.token);
  s.emit('set-username', {});
  const created = waitFor(s, 'channel-created');
  s.emit('create-channel', { name: 'yeni-kanal', type: 'text' });
  const room = await created;
  assert.ok(room && room.id);
  const deleted = waitFor(s, 'channel-deleted');
  s.emit('delete-channel', { roomId: room.id });
  assert.ok(await deleted);
});

test('messages carry the verified author, not the senderName the client claims', async () => {
  const s = await connect(alice.token);
  s.emit('set-username', {});
  s.emit('join-text-room', 'genel');
  await waitFor(s, 'message-history');
  const got = waitFor(s, 'new-message', 1500, m => m.content === 'impersonation attempt');
  s.emit('send-message', { roomId: 'genel', content: 'impersonation attempt', senderName: 'AdminUser' });
  const msg = await got;
  assert.ok(msg);
  assert.equal(msg.username, 'Alice');
});

test('DMs are private to their two participants', async () => {
  const a = await connect(alice.token);
  a.emit('set-username', {});
  const ready = waitFor(a, 'dm-room-ready');
  a.emit('get-or-create-dm', { targetUserId: bob.user.id });
  const { room } = await ready;
  assert.match(room.id, /^dm_\d+_\d+$/);

  const outsider = await connect(admin.token);
  outsider.emit('set-username', {});
  await sleep(150);

  const leaked = waitFor(outsider, 'new-message', 1000, m => m.room_id === room.id);
  a.emit('join-text-room', room.id);
  await waitFor(a, 'message-history');
  a.emit('send-message', { roomId: room.id, content: 'secret for bob' });
  assert.equal(await leaked, null, 'DM was broadcast to a non-participant');

  const history = waitFor(outsider, 'message-history');
  outsider.emit('join-text-room', room.id);
  assert.deepEqual((await history).messages, []);

  assert.equal((await api('GET', `/api/messages/${room.id}`, null, admin.token)).status, 403);
  const own = await api('GET', `/api/messages/${room.id}`, null, bob.token);
  assert.equal(own.status, 200);
  assert.ok(own.data.some(m => m.content === 'secret for bob'));

  const rooms = (await api('GET', '/api/rooms')).data;
  assert.ok(!rooms.some(r => r.type === 'dm'), '/api/rooms leaks DM rooms');
});

test('stored XSS payloads are refused', async () => {
  const s = await connect(alice.token);
  s.emit('set-username', {});
  s.emit('join-text-room', 'genel');
  await waitFor(s, 'message-history');
  const err = waitFor(s, 'error');
  s.emit('send-message', { roomId: 'genel', content: '', imageData: 'x" onerror="alert(document.domain)' });
  assert.match((await err).message, /Görsel/);

  const r = await api('POST', '/api/auth/update-profile', { username: 'Alice', avatar: 'javascript:alert(1)//" onerror="alert(1)' }, alice.token);
  assert.equal(r.status, 400);

  const okGif = waitFor(s, 'new-message', 1500, m => m.image_data && m.image_data.includes('giphy'));
  s.emit('send-message', { roomId: 'genel', content: '', imageData: 'https://media2.giphy.com/media/v1.abc/giphy.gif?cid=1&rid=giphy.gif&ct=g' });
  assert.ok(await okGif, 'legitimate GIPHY GIF was rejected');
});

test('usernames with markup are refused at registration', async () => {
  const r = await api('POST', '/api/auth/register', { email: 'x@test.local', password: 'secret123', username: '<img src=x onerror=alert(1)>' });
  assert.equal(r.status, 400);
});

test('a friend request cannot be accepted by its own sender', async () => {
  const a = await connect(alice.token);
  a.emit('set-username', {});
  const sent = waitFor(a, 'friend-request-sent');
  a.emit('send-friend-request', { targetUsername: 'AdminUser' });
  const res = await sent;
  assert.ok(res && res.res.requestId);
  const err = waitFor(a, 'error');
  a.emit('accept-friend-request', { requestId: res.res.requestId });
  assert.match((await err).message, /yetkiniz yok/);
});

test('reply quotes are rebuilt from the database', async () => {
  const s = await connect(bob.token);
  s.emit('set-username', {});
  s.emit('join-text-room', 'genel');
  const hist = await waitFor(s, 'message-history');
  const target = hist.messages.find(m => m.content === 'impersonation attempt');
  assert.ok(target);
  const got = waitFor(s, 'new-message', 1500, m => m.content === 'reply test');
  s.emit('send-message', { roomId: 'genel', content: 'reply test', replyTo: { id: target.id, username: 'AdminUser', content: 'I never said this' } });
  const reply = JSON.parse((await got).reply_to);
  assert.equal(reply.username, 'Alice');
  assert.equal(reply.content, 'impersonation attempt');
});

test('changing the password revokes old tokens and returns a new one', async () => {
  const r = await api('POST', '/api/auth/change-password', { oldPassword: 'secret123', newPassword: 'newsecret456' }, bob.token);
  assert.equal(r.status, 200);
  assert.ok(r.data.token);
  assert.equal((await api('GET', '/api/auth/me', null, bob.token)).status, 401);
  assert.equal((await api('GET', '/api/auth/me', null, r.data.token)).status, 200);
  bob.token = r.data.token;
});

test('repeated failed logins are rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) {
    last = await api('POST', '/api/auth/login', { identifier: 'Alice', password: 'wrong-password' });
  }
  assert.equal(last.status, 429);
});

test('the CI upload endpoint needs the shared secret and a safe filename', async () => {
  const send = (headers, name) => fetch(`${BASE}/api/updates/upload?filename=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: Buffer.from('x')
  });
  assert.equal((await send({}, 'a.txt')).status, 403);
  assert.equal((await send({ 'x-update-secret': 'wrong' }, 'a.txt')).status, 403);
  assert.equal((await send({ 'x-update-secret': 'ci-secret-value' }, '..')).status, 400);
  assert.equal((await send({ 'x-update-secret': 'ci-secret-value' }, '../evil.js')).status, 400);
});

test('static file serving does not escape client/dist', async () => {
  for (const p of ['/..%2fserver%2f.env', '/..%2f..%2fserver%2fserver.js', '/%2e%2e/server/db.js', '/updates/..%2f..%2fserver.js']) {
    const res = await fetch(BASE + p);
    const body = await res.text();
    assert.ok(!body.includes('import ') && !body.includes('AUTH_SECRET'), `served a source file for ${p}`);
  }
});

test('GIF search needs a session and reports a missing key cleanly', async () => {
  assert.equal((await api('GET', '/api/gifs?q=cat')).status, 401);
  assert.equal((await api('GET', '/api/gifs?q=cat', null, alice.token)).status, 503);
});

test('a failing AI service ends the typing indicator and tells the user', async () => {
  const s = await connect(alice.token);
  s.emit('set-username', {});
  s.emit('join-text-room', 'genel');
  await waitFor(s, 'message-history');
  const stop = waitFor(s, 'user-stop-typing', 5000, d => d.username === 'AnucAI');
  const err = waitFor(s, 'error', 5000, d => /AnucAI/.test(d.message));
  s.emit('send-message', { roomId: 'genel', content: '@AnucAI selam' });
  assert.ok(await stop, 'typing indicator never stopped');
  assert.ok(await err, 'user got no feedback');
});

test('WebRTC signaling is only relayed between peers in the same voice room', async () => {
  const a = await connect(alice.token);
  a.emit('set-username', {});
  const b = await connect(admin.token);
  b.emit('set-username', {});
  await sleep(150);
  const got = waitFor(b, 'offer', 800);
  a.emit('offer', { targetSocketId: b.id, sdp: 'v=0 fake', meta: {} });
  assert.equal(await got, null, 'offer relayed outside a voice room');

  a.emit('join-voice-room', { roomId: 'ses-1' });
  b.emit('join-voice-room', { roomId: 'ses-1' });
  await sleep(200);
  const got2 = waitFor(b, 'offer', 1500);
  a.emit('offer', { targetSocketId: b.id, sdp: 'v=0 fake', meta: {} });
  const offer = await got2;
  assert.ok(offer, 'offer not relayed inside the same voice room');
  assert.equal(offer.username, 'Alice');
});
