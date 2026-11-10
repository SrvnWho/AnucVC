// Server-relayed audio SFU (Selective Forwarding Unit) for the "CS2 ROOM"
// voice channel. Every other voice channel stays full-mesh P2P (see the
// offer/answer/ice-candidate relay in server.js) - each client there opens a
// direct RTCPeerConnection to every other participant, which is what eats
// CPU on a gaming PC once a few people are in a call. This room instead
// gives every participant exactly one RTCPeerConnection - to the server -
// and the server forwards raw RTP audio packets between them without ever
// decoding/mixing/re-encoding anything, so its own cost stays low
// regardless of room size.
//
// werift (https://github.com/shinyoshiaki/werift-webrtc) is used here
// specifically because it's a pure JS/TS WebRTC stack with no native
// addon to compile - this server runs on a phone, where a build toolchain
// for something like mediasoup/wrtc can't be assumed.
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from 'werift';
// Same ICE servers the P2P voice rooms use client-side - the server is just
// another WebRTC endpoint as far as ICE is concerned. See ice-config.js for
// why the hard-coded TURN relay that used to sit here is gone, and how to put
// a working one back through server/.env.
import { getIceServers } from './ice-config.js';

// All participants must negotiate the exact same Opus payload type, since
// forwarded RTP packets are never rewritten - only ever passed straight
// through from one connection to another.
const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: 'audio/opus',
  clockRate: 48000,
  channels: 2,
  payloadType: 111
});

let io = null;
export function initSfu(ioInstance) {
  io = ioInstance;
}

// socketId -> {
//   pc, username, avatar,
//   outgoing: Map(otherSocketId -> { track, transceiver })  - tracks THIS
//     connection sends out, one per other participant, each carrying that
//     participant's forwarded mic audio,
//   renegotiating/renegotiatePending - serializes createOffer() calls so a
//     join/leave burst can't start two overlapping negotiations on the same
//     connection.
// }
const participants = new Map();

function metaOf(socketId) {
  const p = participants.get(socketId);
  return p ? { socketId, username: p.username, avatar: p.avatar || null } : null;
}

async function renegotiate(socketId) {
  const p = participants.get(socketId);
  if (!p) return;
  if (p.renegotiating) {
    p.renegotiatePending = true;
    return;
  }
  // The client's answer to a previous offer may still be in flight (or, on
  // a bad connection, arrive late) - createOffer() while not 'stable' would
  // start a second, conflicting negotiation. Defer instead, same as the
  // client-side P2P renegotiate() in webrtc.js does. Only ever one timer at
  // a time: a join/leave burst used to stack one retry per call, all firing
  // together a moment later.
  if (p.pc.signalingState !== 'stable') {
    if (p.retryTimer) return;
    p.retryTimer = setTimeout(() => {
      p.retryTimer = null;
      renegotiate(socketId);
    }, 500);
    return;
  }
  p.renegotiating = true;
  try {
    const offer = await p.pc.createOffer();
    // createOffer()'s return value already has the flat {type, sdp} shape
    // (RTCSessionDescription) - setLocalDescription() itself resolves to
    // werift's internal structured SessionDescription instead, which has no
    // such flat .sdp string field, so it must not be used for the payload.
    await p.pc.setLocalDescription(offer);
    const participantsMeta = [];
    // setLocalDescription() above is slow (it waits for ICE gathering to
    // finish), and anyone joining during that window adds a relay slot to
    // this connection that the already-created offer predates. Such a
    // transceiver has no mid yet, and announcing it as mid=null pointed the
    // client at an m-line that does not exist in the SDP it just received -
    // so that participant was never heard. Skip it here and schedule another
    // round, which will carry the slot properly.
    let hasUnannouncedSlot = false;
    for (const [otherId, relay] of p.outgoing.entries()) {
      const meta = metaOf(otherId);
      if (!meta) continue;
      const mid = relay.transceiver.mid;
      if (mid == null) {
        hasUnannouncedSlot = true;
        continue;
      }
      participantsMeta.push({ ...meta, mid: String(mid) });
    }
    io.to(socketId).emit('sfu-offer', {
      sdp: { type: offer.type, sdp: offer.sdp },
      // Which m-line is this client's own microphone upload slot. It is
      // always the connection's first transceiver, but sending it explicitly
      // means the client never has to assume that.
      micMid: p.micTransceiver && p.micTransceiver.mid != null ? String(p.micTransceiver.mid) : '0',
      participants: participantsMeta
    });
    if (hasUnannouncedSlot) p.renegotiatePending = true;
  } catch (err) {
    console.error('[SFU] renegotiate error:', err);
  } finally {
    p.renegotiating = false;
    if (p.renegotiatePending) {
      p.renegotiatePending = false;
      renegotiate(socketId);
    }
  }
}

// Forwards every RTP packet arriving on this participant's mic straight
// through to whichever other participants currently have a relay track set
// up to receive it. No decoding, no mixing - just packet passthrough.
function wireMicRelay(socketId) {
  const p = participants.get(socketId);
  p.pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((packet) => {
      for (const [otherId, other] of participants.entries()) {
        if (otherId === socketId) continue;
        const relay = other.outgoing.get(socketId);
        if (relay) {
          try { relay.track.writeRtp(packet); } catch (e) {}
        }
      }
    });
  });
}

export async function joinSfu(socketId, username, avatar) {
  if (!io || participants.has(socketId)) return;

  const pc = new RTCPeerConnection({
    codecs: { audio: [AUDIO_CODEC] },
    iceServers: getIceServers(),
    // One ICE transport for every m-line. Otherwise werift gathers (host +
    // STUN round trip) separately for each m-line of a newcomer's first
    // offer, and setLocalDescription() waits for all of them before the offer
    // can be sent - 1.6-3.3s of silence per join measured locally, ~2.3s on
    // the production phone. Chrome answers bundled anyway.
    bundlePolicy: 'max-bundle'
  });

  // recvonly from the server's point of view: this is the slot the client
  // uploads their mic into. Always the first transceiver added on this
  // connection; its mid is handed to the client in every offer so it can
  // tell its own upload slot apart from the relayed-audio m-lines.
  const micTransceiver = pc.addTransceiver('audio', { direction: 'recvonly' });

  const p = {
    pc,
    micTransceiver,
    outgoing: new Map(),
    username,
    avatar,
    renegotiating: false,
    renegotiatePending: false,
    retryTimer: null
  };
  participants.set(socketId, p);

  // One line per outcome is enough to tell "never connected" (ICE/NAT) apart
  // from "connected but silent" (negotiation) in the server logs.
  pc.connectionStateChange.subscribe((state) => {
    if (state === 'connected' || state === 'failed') {
      console.log(`[SFU] ${username}: ${state}`);
    }
  });

  pc.onIceCandidate.subscribe((candidate) => {
    if (!candidate) return;
    io.to(socketId).emit('sfu-ice-candidate', { candidate });
  });

  wireMicRelay(socketId);

  // Wire the new participant up to receive everyone already in the room,
  // and everyone already in the room up to receive the new participant -
  // one dedicated relay track per direction per pair.
  for (const [otherId, other] of participants.entries()) {
    if (otherId === socketId) continue;

    const toNewTrack = new MediaStreamTrack({ kind: 'audio' });
    const toNewTransceiver = pc.addTransceiver(toNewTrack, { direction: 'sendonly' });
    p.outgoing.set(otherId, { track: toNewTrack, transceiver: toNewTransceiver });

    const toExistingTrack = new MediaStreamTrack({ kind: 'audio' });
    const toExistingTransceiver = other.pc.addTransceiver(toExistingTrack, { direction: 'sendonly' });
    other.outgoing.set(socketId, { track: toExistingTrack, transceiver: toExistingTransceiver });
  }

  // One combined offer for the new participant (mic slot + one relay slot
  // per existing participant, all added above), plus a renegotiation for
  // everyone already in the room so their client learns about the new relay
  // slot carrying this participant's audio. Deliberately not awaited in
  // sequence: one negotiation can take several seconds here (werift's
  // setLocalDescription waits for ICE gathering), and awaiting the newcomer's
  // first meant nobody else was told about them until it finished - or, if
  // someone joined during that window, not until that second join's await
  // resolved either. Each connection already serializes its own offers via
  // renegotiating/renegotiatePending, so starting them together is safe.
  renegotiate(socketId);
  for (const otherId of participants.keys()) {
    if (otherId === socketId) continue;
    renegotiate(otherId);
  }
}

export async function handleSfuAnswer(socketId, sdp) {
  const p = participants.get(socketId);
  if (!p || !sdp) return;
  try {
    await p.pc.setRemoteDescription({ type: sdp.type, sdp: sdp.sdp });
  } catch (err) {
    console.error('[SFU] setRemoteDescription error:', err);
  }
}

export async function handleSfuIceCandidate(socketId, candidate) {
  const p = participants.get(socketId);
  if (!p || !candidate) return;
  try {
    await p.pc.addIceCandidate(candidate);
  } catch (err) {
    console.error('[SFU] addIceCandidate error:', err);
  }
}

// Note: this deliberately does not remove/renegotiate the now-idle relay
// tracks it leaves behind on other participants' connections (WebRTC can't
// remove an m-line once negotiated anyway, only mark it inactive, which
// would need its own renegotiation round). They just stop receiving RTP and
// stay silent. For a small friend group with occasional churn that's a
// non-issue; a long-running room with many people cycling through it would
// slowly accumulate unused transceivers on whoever stays connected longest.
export function leaveSfu(socketId) {
  const p = participants.get(socketId);
  if (!p) return;
  participants.delete(socketId);
  if (p.retryTimer) {
    clearTimeout(p.retryTimer);
    p.retryTimer = null;
  }
  // Drop everyone else's relay bookkeeping for this participant so the map
  // doesn't grow forever in a long-running room and renegotiate() stops
  // walking dead entries on every offer it builds. The transceiver itself
  // stays (see note above) - it just goes silent.
  for (const other of participants.values()) {
    other.outgoing.delete(socketId);
  }
  try {
    const closing = p.pc.close();
    if (closing && typeof closing.catch === 'function') closing.catch(() => {});
  } catch (e) {}
}
