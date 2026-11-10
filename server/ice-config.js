// Single source of truth for the ICE servers every WebRTC connection in the
// app uses - the server-relayed CS2 ROOM (sfu.js) and, via GET
// /api/ice-servers, the full-mesh P2P voice rooms in the browser/desktop
// client too.
//
// Why this file exists at all: the app used to hard-code metered.ca's free
// "openrelayproject" TURN relay in both places. Those endpoints stopped
// issuing allocations (every request comes back "400 TURN allocate error" /
// "Failed to establish connection"), and a TURN server that never answers is
// not a harmless leftover - ICE keeps trying it until the gathering timeout:
//
//   werift (server, blocks on gathering)  13.0s  ->  0.06s without them
//   Chrome (client, gathers in parallel)  20.0s  ->  ~0.1s without them
//
// On the server that delay was paid on every single offer, which is what made
// joining CS2 ROOM look broken: ~13 seconds of silence before the first
// participant was even announced, and the same again for each person who
// joined after. Neither run ever produced a single relay candidate, so
// nothing was lost by dropping them.
//
// TURN is still worth having for users behind a symmetric NAT, so it stays
// configurable: set TURN_URL (plus TURN_USERNAME / TURN_CREDENTIAL) in
// server/.env and both the SFU and every client pick it up with no rebuild.
// TURN_URL may list several URLs separated by commas.
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

function parseTurnConfig(env) {
  const raw = (env.TURN_URL || '').trim();
  if (!raw) return [];
  const urls = raw.split(',').map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) return [];
  const entry = { urls };
  if (env.TURN_USERNAME) entry.username = env.TURN_USERNAME;
  if (env.TURN_CREDENTIAL) entry.credential = env.TURN_CREDENTIAL;
  return [entry];
}

export function getIceServers(env = process.env) {
  return [...STUN_SERVERS, ...parseTurnConfig(env)];
}
