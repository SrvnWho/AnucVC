/**
 * WebRTC P2P Full-Mesh Voice Manager for AnucVC
 * Uses Google STUN server for NAT traversal and direct peer audio streaming.
 * Includes hot-swapping audio input (mic) and output (headset/speaker) devices.
 */

// Fallback used until (and if) the server's own list arrives - see
// loadIceServers() below and server/ice-config.js. STUN only: the four
// metered.ca "openrelayproject" TURN entries that used to live here stopped
// issuing allocations ("400 TURN allocate error"), and a TURN server that
// never answers is not free - Chrome kept retrying them until the ICE
// gathering timeout, which took gathering from ~0.1s to a full 20s on every
// voice connection while never once producing a relay candidate.
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// TURN is still the only way through a symmetric NAT, so it stays supported -
// just configured server-side (TURN_URL/TURN_USERNAME/TURN_CREDENTIAL in
// server/.env) and fetched at startup, which means a working relay can be
// added later without shipping a new desktop build. Failure is non-fatal:
// RTC_CONFIG keeps its STUN-only defaults and voice still works for everyone
// not behind a symmetric NAT, exactly as it does today.
export async function loadIceServers(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/api/ice-servers`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      RTC_CONFIG.iceServers = data.iceServers;
    }
  } catch (err) {
    console.warn('ICE server list unavailable, using built-in STUN defaults:', err);
  }
}

// The one voice channel that's server-relayed instead of P2P - must match
// CS2_ROOM_ID in server/db.js. Fixed, non-deletable room id.
export const SFU_ROOM_ID = 'cs2-room';

// Screen-share resolution/framerate presets. Exported so the quality menu in
// app.js is built from the same source of truth the constraints come from -
// adding a preset here is all it takes for it to show up in the UI.
export const SCREEN_QUALITY_PRESETS = {
  '1080p_60': { label: '1080p', fps: 60, width: 1920, height: 1080, note: 'En yüksek kalite' },
  '1080p_30': { label: '1080p', fps: 30, width: 1920, height: 1080, note: 'Keskin görüntü, dengeli' },
  '720p_60':  { label: '720p',  fps: 60, width: 1280, height: 720,  note: 'Oyunlar için ideal' },
  '720p_30':  { label: '720p',  fps: 30, width: 1280, height: 720,  note: 'Önerilen ayar' },
  '480p_60':  { label: '480p',  fps: 60, width: 854,  height: 480,  note: 'Düşük bant genişliği' }
};

export class VoiceManager {
  constructor(socket, callbacks = {}) {
    this.socket = socket;
    this.callbacks = callbacks; // { onPeerJoined, onPeerLeft, onStatusChange }
    this.localStream = null;
    this.peers = new Map(); // socketId -> { connection: RTCPeerConnection, audioElem: HTMLAudioElement, username: string, avatar: string, volume: number, isMuted: boolean, isDeafened: boolean }
    this.isMuted = false;
    this.isDeafened = false;
    this.currentRoomId = null;
    // Push-to-talk: when active, the mic only actually transmits while the
    // assigned key is held (pttKeyHeld) - VAD's talking indicator is
    // meaningless here since holding the key already means "I'm talking",
    // so VAD is stopped while this is on.
    this.pttMode = localStorage.getItem('anucvc_ptt_enabled') === 'true';
    this.pttKeyHeld = false;
    this.selectedInputId = localStorage.getItem('anucvc_mic_id') || '';
    this.selectedOutputId = localStorage.getItem('anucvc_output_id') || '';
    this.vadSensitivity = parseInt(localStorage.getItem('anucvc_vad_sensitivity') || '35', 10);

    this.screenStream = null;
    this.isScreenSharing = false;

    this.cameraStream = null;
    this.isCameraOn = false;

    this.setupSocketListeners();
  }

  // Shared by the live VAD loop and the mic test preview so a threshold
  // calibrated in one reads identically in the other. They used to compute
  // volume differently (RMS over speech bins vs. a plain mean over every
  // bin, scaled 0-100 vs 0-80) despite a comment claiming they matched -
  // so a threshold that looked right in the mic test didn't actually
  // trigger the talking indicator at the same point in a real call.
  getSpeechVolume(analyser, dataArray) {
    analyser.getByteFrequencyData(dataArray);
    // RMS energy across speech frequencies (approx 150Hz - 3500Hz, bins 2 to 45)
    let sumSquares = 0;
    let count = 0;
    for (let i = 2; i < Math.min(45, dataArray.length); i++) {
      sumSquares += dataArray[i] * dataArray[i];
      count++;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, count));
    return (rms / 255) * 100;
  }

  getAudioConstraints() {
    const savedMicId = localStorage.getItem('anucvc_mic_id');
    const ns = localStorage.getItem('anucvc_noise_suppression') !== 'false';
    const ec = localStorage.getItem('anucvc_echo_cancel') !== 'false';
    const ag = localStorage.getItem('anucvc_auto_gain') !== 'false';
    return {
      audio: {
        deviceId: savedMicId ? { ideal: savedMicId } : undefined,
        noiseSuppression: ns,
        echoCancellation: ec,
        autoGainControl: ag
      },
      video: false
    };
  }

  async getAudioDevices() {
    try {
      if (!this.localStream) {
        try {
          const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          tempStream.getTracks().forEach(t => t.stop());
        } catch (e) {}
      }

      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(d => d.kind === 'audioinput');
      const outputs = devices.filter(d => d.kind === 'audiooutput');

      return { inputs, outputs };
    } catch (err) {
      console.error('Enumerate audio devices error:', err);
      return { inputs: [], outputs: [] };
    }
  }

  async setAudioInputDevice(deviceId) {
    this.selectedInputId = deviceId;
    localStorage.setItem('anucvc_mic_id', deviceId || '');

    if (!this.localStream) return;

    try {
      const constraints = this.getAudioConstraints();

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const newAudioTrack = newStream.getAudioTracks()[0];

      if (this.localStream) {
        this.localStream.getAudioTracks().forEach(track => track.stop());
      }
      this.localStream = newStream;

      newAudioTrack.enabled = this.pttMode ? (this.pttKeyHeld && !this.isMuted) : !this.isMuted;

      if (this.currentRoomId === SFU_ROOM_ID && this.sfuMicTransceiver) {
        await this.sfuMicTransceiver.sender.replaceTrack(newAudioTrack);
      } else {
        for (const peer of this.peers.values()) {
          if (peer.connection) {
            // Use the sender we captured when the mic track was first added
            // rather than "the first sender of kind audio" - if this peer is
            // also screen-sharing with system audio, that sender is a second
            // audio sender on the same connection, and picking the wrong one
            // would swap the mic track onto the screen-share audio channel.
            const audioSender = peer.micSender || peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (audioSender) {
              await audioSender.replaceTrack(newAudioTrack);
              peer.micSender = audioSender;
            }
          }
        }
      }
    } catch (err) {
      console.error('Failed to set audio input device:', err);
    }
  }

  async setAudioOutputDevice(deviceId) {
    this.selectedOutputId = deviceId;
    localStorage.setItem('anucvc_output_id', deviceId || '');

    for (const peer of this.peers.values()) {
      if (peer.audioElem && typeof peer.audioElem.setSinkId === 'function') {
        try {
          await peer.audioElem.setSinkId(deviceId || '');
        } catch (err) {
          console.error('Failed to set audio output device on element:', err);
        }
      }
      if (peer.screenAudioElem && typeof peer.screenAudioElem.setSinkId === 'function') {
        try {
          await peer.screenAudioElem.setSinkId(deviceId || '');
        } catch (err) {
          console.error('Failed to set audio output device on screen audio element:', err);
        }
      }
    }
  }

  async initLocalAudio() {
    if (this.localStream) return this.localStream;
    const constraints = this.getAudioConstraints();

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      return this.localStream;
    } catch (err) {
      console.error('Failed to get local microphone stream with device constraint:', err);
      // Fallback: keep audio processing settings but drop device constraint
      const ns = localStorage.getItem('anucvc_noise_suppression') !== 'false';
      const ec = localStorage.getItem('anucvc_echo_cancel') !== 'false';
      const ag = localStorage.getItem('anucvc_auto_gain') !== 'false';
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: ec, noiseSuppression: ns, autoGainControl: ag },
        video: false
      });
      return this.localStream;
    }
  }

  async updateAudioProcessing() {
    if (!this.localStream) return;
    try {
      const constraints = this.getAudioConstraints();
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = newStream.getAudioTracks()[0];
      this.localStream.getAudioTracks().forEach(t => t.stop());
      this.localStream = newStream;
      newTrack.enabled = this.pttMode ? (this.pttKeyHeld && !this.isMuted) : !this.isMuted;
      if (this.currentRoomId === SFU_ROOM_ID && this.sfuMicTransceiver) {
        await this.sfuMicTransceiver.sender.replaceTrack(newTrack);
      } else {
        for (const peer of this.peers.values()) {
          if (peer.connection) {
            const sender = peer.micSender || peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) {
              await sender.replaceTrack(newTrack);
              peer.micSender = sender;
            }
          }
        }
      }
      // Restart VAD with new stream
      this.stopVoiceActivityDetection();
      this.startVoiceActivityDetection();
    } catch (err) {
      console.error('Failed to update audio processing:', err);
    }
  }

  async joinVoiceRoom(roomId, username) {
    await this.initLocalAudio();
    // A freshly acquired MediaStreamTrack always starts enabled, regardless
    // of isMuted/pttMode state carried over from before this join.
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = this.pttMode ? (this.pttKeyHeld && !this.isMuted) : !this.isMuted;
      });
    }

    if (this.currentRoomId) {
      this.stopScreenShare();
      this.stopCamera();
      this.socket.emit('leave-voice-room', { roomId: this.currentRoomId });
      if (this.currentRoomId === SFU_ROOM_ID) {
        this.leaveSfuConnection();
      }
      for (const [socketId] of this.peers.entries()) {
        this.closePeer(socketId);
      }
      this.peers.clear();
    }

    this.currentRoomId = roomId;
    // Occupant bookkeeping (sidebar list, mute/talking badges) is generic
    // server-side metadata shared by every voice room regardless of audio
    // transport, so this event is still emitted here even for the
    // server-relayed room below - only the actual audio path differs.
    this.socket.emit('join-voice-room', { roomId, senderName: username, isMuted: this.isMuted, isDeafened: this.isDeafened });

    if (roomId === SFU_ROOM_ID) {
      this.startSfuConnection();
    }

    // VAD's talking indicator is meaningless in PTT mode (holding the key
    // already means "talking"), and running it would just burn CPU for no
    // reason - see setPushToTalkMode().
    if (!this.pttMode) {
      this.startVoiceActivityDetection();
    }
  }

  leaveVoiceRoom() {
    if (!this.currentRoomId) return;

    this.stopVoiceActivityDetection();
    this.stopScreenShare();
    this.stopCamera();
    this.socket.emit('leave-voice-room', { roomId: this.currentRoomId });

    if (this.currentRoomId === SFU_ROOM_ID) {
      this.leaveSfuConnection();
    }

    for (const [socketId] of this.peers.entries()) {
      this.closePeer(socketId);
    }
    this.peers.clear();
    this.currentRoomId = null;

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
  }

  // --- CS2 ROOM: server-relayed audio (SFU) ---------------------------
  // A single RTCPeerConnection to the server, which forwards every other
  // participant's mic audio in as separate tracks on this same connection -
  // as opposed to every other voice room's one-RTCPeerConnection-per-peer
  // full mesh. Existing per-peer state (this.peers, audioElem, volume,
  // mute/deafen handling) is reused unchanged so the rest of the app's
  // rendering code doesn't need to know which mode is active.
  startSfuConnection() {
    this.sfuPc = new RTCPeerConnection(RTC_CONFIG);
    this.sfuMicTransceiver = null;
    this.sfuMidToSocketId = new Map();
    this.sfuPendingCandidates = [];

    this.sfuPc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('sfu-ice-candidate', { candidate: event.candidate });
      }
    };

    this.sfuPc.ontrack = (event) => {
      const mid = event.transceiver && event.transceiver.mid;
      const socketId = mid != null ? this.sfuMidToSocketId.get(String(mid)) : null;
      if (!socketId) return;
      const peer = this.peers.get(socketId);
      if (!peer) return;
      const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
      peer.audioElem.srcObject = stream;
      peer.audioElem.volume = peer.volume || 1.0;
      peer.audioElem.play().catch(err => console.log('SFU audio element play pending interaction:', err));
    };

    this.socket.emit('sfu-join');
  }

  leaveSfuConnection() {
    if (this.sfuPc) {
      try { this.sfuPc.close(); } catch (e) {}
      this.sfuPc = null;
    }
    this.sfuMicTransceiver = null;
    this.sfuMidToSocketId = null;
    this.sfuPendingCandidates = null;
    this.socket.emit('sfu-leave');
  }

  // Ensures a this.peers entry (audio element, avatar, volume, mute state)
  // exists for every participant named in an 'sfu-offer' payload, before
  // setRemoteDescription() can make their relayed track's 'ontrack' fire.
  ensureSfuPeer(meta) {
    if (this.peers.has(meta.socketId)) {
      const existing = this.peers.get(meta.socketId);
      if (meta.username) existing.username = meta.username;
      if (meta.avatar) existing.avatar = meta.avatar;
      return;
    }
    const audioElem = new Audio();
    audioElem.autoplay = true;
    audioElem.muted = this.isDeafened;
    if (this.selectedOutputId && typeof audioElem.setSinkId === 'function') {
      audioElem.setSinkId(this.selectedOutputId).catch(err => console.error('Sink ID error (SFU):', err));
    }
    document.getElementById('remote-audio-container')?.appendChild(audioElem);

    this.peers.set(meta.socketId, {
      connection: null,
      audioElem,
      screenAudioElem: null,
      username: meta.username || 'Peer',
      avatar: meta.avatar || null,
      volume: 1.0,
      screenVolume: 1.0,
      screenAudioAllowed: false,
      isMuted: false,
      isDeafened: false,
      isScreenSharing: false,
      isCameraOn: false
    });
  }

  setVadSensitivity(val) {
    this.vadSensitivity = parseInt(val, 10) || 35;
    localStorage.setItem('anucvc_vad_sensitivity', this.vadSensitivity);
  }

  startVoiceActivityDetection() {
    if (!this.localStream || !this.currentRoomId) return;
    try {
      if (this.vadAudioCtx) {
        this.vadAudioCtx.close().catch(() => {});
      }
      this.vadAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.vadAudioCtx.createMediaStreamSource(this.localStream);
      this.vadAnalyser = this.vadAudioCtx.createAnalyser();
      this.vadAnalyser.fftSize = 512;
      this.vadAnalyser.smoothingTimeConstant = 0.3;
      this.vadAnalyser.minDecibels = -90;
      this.vadAnalyser.maxDecibels = -10;
      source.connect(this.vadAnalyser);

      const bufferLength = this.vadAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      let wasTalking = false;
      let lastSpokeTime = 0;
      const HANGTIME_MS = 300;
      // 20Hz is plenty for VAD given the 300ms hangtime tolerance above -
      // this used to run on every animation frame (60Hz) via
      // requestAnimationFrame, burning a main-thread wakeup every frame for
      // as long as you're connected to voice, including while the window is
      // unfocused/backgrounded (e.g. gaming with voice chat running behind
      // it). A plain interval at a lower rate cuts that by two-thirds.
      const VAD_INTERVAL_MS = 50;

      const checkVol = () => {
        if (!this.localStream || !this.currentRoomId) {
          this.stopVoiceActivityDetection();
          return;
        }
        if (this.vadAudioCtx && this.vadAudioCtx.state === 'suspended') {
          this.vadAudioCtx.resume().catch(() => {});
        }

        if (this.isMuted) {
          if (wasTalking) {
            wasTalking = false;
            this.isTalking = false;
            this.socket.emit('voice-status-update', { isMuted: this.isMuted, isDeafened: this.isDeafened, isTalking: false });
            if (this.callbacks.onStatusChange) {
              this.callbacks.onStatusChange({ socketId: 'local', isTalking: false });
            }
          }
          return;
        }

        const volume = this.getSpeechVolume(this.vadAnalyser, dataArray);

        const currentThreshold = this.vadSensitivity || parseInt(localStorage.getItem('anucvc_vad_sensitivity') || '35', 10);

        const now = Date.now();
        if (volume > currentThreshold) {
          lastSpokeTime = now;
        }

        const isCurrentlyTalking = (now - lastSpokeTime) < HANGTIME_MS;

        if (isCurrentlyTalking !== wasTalking) {
          const emitNow = Date.now();
          if (emitNow - (this.lastVadEmitTime || 0) >= 150 || !isCurrentlyTalking) {
            wasTalking = isCurrentlyTalking;
            this.isTalking = isCurrentlyTalking;
            this.lastVadEmitTime = emitNow;
            this.socket.emit('voice-status-update', { isMuted: this.isMuted, isDeafened: this.isDeafened, isTalking: isCurrentlyTalking });
            if (this.callbacks.onStatusChange) {
              this.callbacks.onStatusChange({ socketId: 'local', isTalking: isCurrentlyTalking });
            }
          }
        }

      };
      this.vadIntervalId = setInterval(checkVol, VAD_INTERVAL_MS);
    } catch (e) {
      console.error('VAD start error:', e);
    }
  }

  stopVoiceActivityDetection() {
    if (this.vadIntervalId) {
      clearInterval(this.vadIntervalId);
      this.vadIntervalId = null;
    }
    if (this.vadSource) {
      try { this.vadSource.disconnect(); } catch (e) {}
      this.vadSource = null;
    }
    if (this.vadAnalyser) {
      try { this.vadAnalyser.disconnect(); } catch (e) {}
      this.vadAnalyser = null;
    }
    if (this.vadAudioCtx) {
      this.vadAudioCtx.close().catch(() => {});
      this.vadAudioCtx = null;
    }
    this.isTalking = false;
  }

  async startMicTest(onVolume) {
    this.stopMicTest();
    try {
      const constraints = this.getAudioConstraints();

      this.testStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.isTestingMic = true;

      this.testAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.testAudioCtx.createMediaStreamSource(this.testStream);
      this.testAnalyser = this.testAudioCtx.createAnalyser();
      this.testAnalyser.fftSize = 512;
      this.testAnalyser.smoothingTimeConstant = 0.3;
      this.testAnalyser.minDecibels = -90;
      this.testAnalyser.maxDecibels = -10;

      source.connect(this.testAnalyser);
      this.testAnalyser.connect(this.testAudioCtx.destination);

      const bufferLength = this.testAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateTestVol = () => {
        if (!this.isTestingMic) return;
        const vol = this.getSpeechVolume(this.testAnalyser, dataArray);
        if (onVolume) onVolume(vol);
        this.testAnimId = requestAnimationFrame(updateTestVol);
      };
      updateTestVol();

      return true;
    } catch (err) {
      console.error('Failed to start mic test:', err);
      this.stopMicTest();
      return false;
    }
  }

  stopMicTest() {
    this.isTestingMic = false;
    if (this.testAnimId) {
      cancelAnimationFrame(this.testAnimId);
      this.testAnimId = null;
    }
    if (this.testStream) {
      this.testStream.getTracks().forEach(t => t.stop());
      this.testStream = null;
    }
    if (this.testAudioCtx) {
      this.testAudioCtx.close().catch(() => {});
      this.testAudioCtx = null;
    }
  }

  async renegotiate(targetSocketId, iceRestart = false) {
    const peer = this.peers.get(targetSocketId);
    if (!peer || !peer.connection) return;
    const pc = peer.connection;

    if (pc.signalingState !== 'stable' && !iceRestart) {
      // Another negotiation is already in flight; try again shortly once it settles
      setTimeout(() => this.renegotiate(targetSocketId), 500);
      return;
    }

    try {
      peer.makingOffer = true;
      const offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      await pc.setLocalDescription(offer);
      this.socket.emit('offer', {
        targetSocketId,
        sdp: offer,
        meta: {
          cameraStreamId: this.cameraStream ? this.cameraStream.id : null,
          screenStreamId: this.screenStream ? this.screenStream.id : null
        }
      });
    } catch (err) {
      console.error('Renegotiation error:', err);
    } finally {
      peer.makingOffer = false;
    }
  }

  getCameraConstraints() {
    return {
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
        facingMode: 'user'
      },
      audio: false
    };
  }

  async startCamera() {
    if (this.isCameraOn) return true;
    // CS2 ROOM is audio-only - its whole point is to keep client CPU/bandwidth
    // low for gaming, which a camera stream would work directly against.
    if (this.currentRoomId === SFU_ROOM_ID) return false;

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      console.error('Camera is not supported in this environment.');
      return false;
    }

    let camStream;
    try {
      camStream = await navigator.mediaDevices.getUserMedia(this.getCameraConstraints());
    } catch (err) {
      console.error('Camera start failed or was denied:', err);
      return false;
    }

    this.cameraStream = camStream;
    this.isCameraOn = true;

    const videoTrack = camStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        // Fired if the camera device is unplugged/revoked externally
        this.stopCamera();
        if (this.callbacks.onLocalCameraEnded) {
          this.callbacks.onLocalCameraEnded();
        }
      };
    }

    for (const [socketId, peer] of this.peers.entries()) {
      if (videoTrack) {
        peer.cameraSender = peer.connection.addTrack(videoTrack, camStream);
        await this.renegotiate(socketId);
      }
    }

    this.socket.emit('camera-status', { on: true });

    return true;
  }

  stopCamera() {
    if (!this.isCameraOn) return;
    this.isCameraOn = false;

    for (const [socketId, peer] of this.peers.entries()) {
      if (peer.cameraSender) {
        try { peer.connection.removeTrack(peer.cameraSender); } catch (e) {}
        peer.cameraSender = null;
        this.renegotiate(socketId);
      }
    }

    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(t => t.stop());
      this.cameraStream = null;
    }

    this.socket.emit('camera-status', { on: false });
  }

  getScreenConstraints() {
    const quality = localStorage.getItem('anucvc_screen_quality') || '720p_30';
    const preset = SCREEN_QUALITY_PRESETS[quality] || SCREEN_QUALITY_PRESETS['720p_30'];

    return {
      video: {
        cursor: 'always',
        width: { ideal: preset.width, max: preset.width },
        height: { ideal: preset.height, max: preset.height },
        frameRate: { ideal: preset.fps, max: preset.fps }
      },
      audio: true
    };
  }

  async startScreenShare() {
    if (this.isScreenSharing) return true;
    // Audio-only room by design - see the same guard in startCamera().
    if (this.currentRoomId === SFU_ROOM_ID) return false;

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      console.error('Screen sharing is not supported in this environment.');
      return false;
    }

    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia(this.getScreenConstraints());
    } catch (err) {
      // Fallback: try without system audio if system audio capture is unsupported (common in WebView2/macOS/Linux)
      try {
        const constraints = this.getScreenConstraints();
        constraints.audio = false;
        displayStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      } catch (err2) {
        console.error('Screen share cancelled or failed:', err2);
        return false;
      }
    }

    this.screenStream = displayStream;
    this.isScreenSharing = true;

    const videoTrack = displayStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        // Fired when the user stops sharing via the browser/OS native UI
        this.stopScreenShare();
        if (this.callbacks.onLocalScreenShareEnded) {
          this.callbacks.onLocalScreenShareEnded();
        }
      };
    }
    const audioTrack = displayStream.getAudioTracks()[0];

    for (const [socketId, peer] of this.peers.entries()) {
      if (videoTrack) {
        peer.screenSender = peer.connection.addTrack(videoTrack, displayStream);
      }
      if (audioTrack) {
        peer.screenAudioSender = peer.connection.addTrack(audioTrack, displayStream);
      }
      if (videoTrack || audioTrack) {
        await this.renegotiate(socketId);
      }
    }

    this.socket.emit('screen-share-status', { sharing: true });

    return true;
  }

  stopScreenShare() {
    if (!this.isScreenSharing) return;
    this.isScreenSharing = false;

    for (const [socketId, peer] of this.peers.entries()) {
      let needsRenegotiate = false;
      if (peer.screenSender) {
        try { peer.connection.removeTrack(peer.screenSender); } catch (e) {}
        peer.screenSender = null;
        needsRenegotiate = true;
      }
      if (peer.screenAudioSender) {
        try { peer.connection.removeTrack(peer.screenAudioSender); } catch (e) {}
        peer.screenAudioSender = null;
        needsRenegotiate = true;
      }
      if (needsRenegotiate) {
        this.renegotiate(socketId);
      }
    }

    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    this.socket.emit('screen-share-status', { sharing: false });
  }

  setupSocketListeners() {
    this.socket.on('voice-room-users', async (existingPeers) => {
      // CS2 ROOM's audio is server-relayed (see sfu-offer below) - it must
      // never open real P2P connections to the other occupants.
      if (this.currentRoomId === SFU_ROOM_ID) return;
      for (const peer of existingPeers) {
        await this.createPeerConnection(peer.socketId, peer.username, true, peer.isMuted, peer.isDeafened, peer.avatar, peer.isScreenSharing, peer.isCameraOn);
      }
      if (this.callbacks.onStatusChange) {
        this.callbacks.onStatusChange();
      }
    });

    this.socket.on('user-joined-voice', async ({ socketId, username, isMuted, isDeafened, avatar, isScreenSharing, isCameraOn }) => {
      if (this.currentRoomId === SFU_ROOM_ID) return;
      await this.createPeerConnection(socketId, username, false, isMuted, isDeafened, avatar, isScreenSharing, isCameraOn);
      if (this.isScreenSharing) {
        this.socket.emit('screen-share-status', { sharing: true });
      }
      if (this.isCameraOn) {
        this.socket.emit('camera-status', { on: true });
      }
      if (this.callbacks.onPeerJoined) {
        this.callbacks.onPeerJoined({ socketId, username, isMuted, isDeafened, avatar });
      }
    });

    this.socket.on('user-left-voice', ({ socketId }) => {
      this.closePeer(socketId);
      if (this.callbacks.onPeerLeft) {
        this.callbacks.onPeerLeft(socketId);
      }
    });

    this.socket.on('peer-status-update', ({ socketId, isMuted, isDeafened, isTalking, isScreenSharing, isCameraOn }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.isMuted = !!isMuted;
        peer.isDeafened = !!isDeafened;
        peer.isTalking = !!isTalking;
        if (isScreenSharing !== undefined) {
          peer.isScreenSharing = !!isScreenSharing;
        }
        if (isScreenSharing === false) {
          peer.screenStream = null;
        }
        if (isCameraOn !== undefined) {
          peer.isCameraOn = !!isCameraOn;
        }
        if (isCameraOn === false) {
          peer.cameraStream = null;
        }
      }
      if (this.callbacks.onStatusChange) {
        this.callbacks.onStatusChange({ socketId, isMuted, isDeafened, isTalking, isScreenSharing, isCameraOn });
      }
    });

    this.socket.on('offer', async ({ fromSocketId, username, sdp, avatar, meta }) => {
      if (this.currentRoomId === SFU_ROOM_ID) return;
      let peer = this.peers.get(fromSocketId);
      if (!peer) {
        peer = await this.createPeerConnection(fromSocketId, username, false, false, false, avatar);
      }
      const pc = peer.connection;

      if (meta) {
        if (meta.cameraStreamId !== undefined) peer.remoteCameraStreamId = meta.cameraStreamId;
        if (meta.screenStreamId !== undefined) peer.remoteScreenStreamId = meta.screenStreamId;
      }

      // Perfect-negotiation-lite: both sides run identical code, so if an offer
      // arrives while we're also mid-negotiation (glare), only the "impolite"
      // side (deterministically picked by comparing socket IDs) rolls back its
      // own offer and accepts the incoming one. This prevents a screen-share
      // renegotiation (or any other track change) from ever leaving the
      // connection - including the existing audio - in a broken state.
      const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
      if (offerCollision && !peer.polite) {
        // We're impolite and mid-offer ourselves: ignore this incoming offer,
        // our own offer will be answered instead.
        return;
      }

      try {
        if (offerCollision && peer.polite) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(new RTCSessionDescription(sdp))
          ]);
        } else {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        }
      } catch (err) {
        console.error('Error setting remote offer:', err);
        return;
      }

      // Flush pending ICE candidates that arrived before setRemoteDescription
      if (peer.pendingCandidates && peer.pendingCandidates.length > 0) {
        for (const candidate of peer.pendingCandidates) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {}
        }
        peer.pendingCandidates = [];
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.socket.emit('answer', {
        targetSocketId: fromSocketId,
        sdp: answer,
        meta: {
          cameraStreamId: this.cameraStream ? this.cameraStream.id : null,
          screenStreamId: this.screenStream ? this.screenStream.id : null
        }
      });

      // If we're already screen sharing and/or have our camera on,
      // createPeerConnection() (either just above, or earlier via the
      // 'user-joined-voice' handler racing ahead of this offer - see the
      // 'negotiated' field comment) already attached those tracks to this
      // connection - but a joining peer's first offer only has an audio
      // m-line (they aren't sharing/on camera yet), and per WebRTC/JSEP an
      // answer can never add m-lines that weren't in the offer. Those tracks
      // were therefore left out of the answer we just sent, so the new peer
      // never gets our video. This used to be gated on "is the peer object
      // brand new", which is true almost none of the time in practice: the
      // sharer's 'user-joined-voice' handler fires and pre-creates the peer
      // object (with the track already attached) before the joiner's offer
      // even arrives, so the object always already existed here and this
      // follow-up renegotiation never ran - late joiners never got the
      // stream. What actually matters is whether *this connection* has ever
      // completed a negotiation before, tracked separately below.
      const isFirstNegotiation = !peer.negotiated;
      peer.negotiated = true;
      if (isFirstNegotiation && ((this.isScreenSharing && this.screenStream) || (this.isCameraOn && this.cameraStream))) {
        this.renegotiate(fromSocketId);
      }
    });

    this.socket.on('answer', async ({ fromSocketId, sdp, meta }) => {
      const peer = this.peers.get(fromSocketId);
      if (peer && peer.connection) {
        if (meta) {
          if (meta.cameraStreamId !== undefined) peer.remoteCameraStreamId = meta.cameraStreamId;
          if (meta.screenStreamId !== undefined) peer.remoteScreenStreamId = meta.screenStreamId;
        }
        try {
          await peer.connection.setRemoteDescription(new RTCSessionDescription(sdp));
          peer.negotiated = true;
        } catch (err) {
          console.error('Error setting remote answer:', err);
          return;
        }

        // Flush pending ICE candidates
        if (peer.pendingCandidates && peer.pendingCandidates.length > 0) {
          for (const candidate of peer.pendingCandidates) {
            try {
              await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {}
          }
          peer.pendingCandidates = [];
        }
      }
    });

    this.socket.on('ice-candidate', async ({ fromSocketId, candidate }) => {
      const peer = this.peers.get(fromSocketId);
      if (peer && peer.connection && candidate) {
        if (!peer.connection.remoteDescription) {
          if (!peer.pendingCandidates) peer.pendingCandidates = [];
          peer.pendingCandidates.push(candidate);
        } else {
          try {
            await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error('Error adding ICE candidate:', e);
          }
        }
      }
    });

    // --- CS2 ROOM: server-relayed audio (SFU) signaling ---
    this.socket.on('sfu-offer', async ({ sdp, participants, micMid: rawMicMid }) => {
      if (!this.sfuPc || this.currentRoomId !== SFU_ROOM_ID) return;

      for (const meta of (participants || [])) {
        if (meta.mid == null) continue;
        this.sfuMidToSocketId.set(String(meta.mid), meta.socketId);
        this.ensureSfuPeer(meta);
      }

      try {
        await this.sfuPc.setRemoteDescription(new RTCSessionDescription(sdp));
      } catch (err) {
        console.error('SFU setRemoteDescription error:', err);
        return;
      }

      // Fulfil our own mic upload slot. The server names its mid explicitly
      // (micMid); older payloads without it always used the connection's
      // first transceiver, which is mid '0'.
      const micMid = (typeof rawMicMid === 'string' || typeof rawMicMid === 'number') ? String(rawMicMid) : '0';
      if (!this.sfuMicTransceiver) {
        this.sfuMicTransceiver = this.sfuPc.getTransceivers().find(t => t.mid === micMid) || null;
      }
      if (this.sfuMicTransceiver) {
        // A transceiver the browser created while applying a remote offer
        // always starts out 'recvonly' (WebRTC spec), and replaceTrack()
        // never changes a direction. Left alone, our answer would say
        // a=recvonly on the very m-line the server offered recvonly on, the
        // two would resolve to 'inactive', and the microphone would never be
        // uploaded at all - which is exactly why CS2 ROOM stayed silent.
        if (this.sfuMicTransceiver.direction !== 'sendonly') {
          try { this.sfuMicTransceiver.direction = 'sendonly'; } catch (e) {}
        }
        if (this.localStream) {
          const micTrack = this.localStream.getAudioTracks()[0];
          if (micTrack && this.sfuMicTransceiver.sender.track !== micTrack) {
            try { await this.sfuMicTransceiver.sender.replaceTrack(micTrack); } catch (e) {}
          }
        }
      }

      if (this.sfuPendingCandidates && this.sfuPendingCandidates.length > 0) {
        for (const candidate of this.sfuPendingCandidates) {
          try { await this.sfuPc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) {}
        }
        this.sfuPendingCandidates = [];
      }

      try {
        const answer = await this.sfuPc.createAnswer();
        await this.sfuPc.setLocalDescription(answer);
        this.socket.emit('sfu-answer', { sdp: answer });
      } catch (err) {
        console.error('SFU createAnswer error:', err);
      }
    });

    this.socket.on('sfu-ice-candidate', async ({ candidate }) => {
      if (!this.sfuPc || !candidate) return;
      if (!this.sfuPc.remoteDescription) {
        if (!this.sfuPendingCandidates) this.sfuPendingCandidates = [];
        this.sfuPendingCandidates.push(candidate);
      } else {
        try {
          await this.sfuPc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding SFU ICE candidate:', e);
        }
      }
    });
  }

  async createPeerConnection(targetSocketId, username, isInitiator, isMuted = false, isDeafened = false, avatar = null, isScreenSharing = false, isCameraOn = false) {
    if (this.peers.has(targetSocketId)) {
      const existingPeer = this.peers.get(targetSocketId);
      existingPeer.isMuted = isMuted;
      existingPeer.isDeafened = isDeafened;
      if (isScreenSharing !== undefined) existingPeer.isScreenSharing = !!isScreenSharing;
      if (isCameraOn !== undefined) existingPeer.isCameraOn = !!isCameraOn;
      if (avatar) existingPeer.avatar = avatar;
      return existingPeer;
    }

    const pc = new RTCPeerConnection(RTC_CONFIG);

    let micSender = null;
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        const sender = pc.addTrack(track, this.localStream);
        if (track.kind === 'audio') micSender = sender;
      });
    }

    const audioElem = new Audio();
    audioElem.autoplay = true;
    audioElem.muted = this.isDeafened;

    if (this.selectedOutputId && typeof audioElem.setSinkId === 'function') {
      audioElem.setSinkId(this.selectedOutputId).catch(err => console.error('Sink ID error:', err));
    }

    document.getElementById('remote-audio-container')?.appendChild(audioElem);

    // Separate element for the peer's screen-share system/tab audio. A screen
    // share's audio track arrives as its own MediaStream on the same
    // RTCPeerConnection as the peer's microphone track - reusing audioElem for
    // both meant the second 'audio' ontrack event (whichever one it was) would
    // overwrite audioElem.srcObject and silently replace the peer's mic with
    // their screen audio, making that peer inaudible. Routing each stream to
    // its own <audio> element keeps mic and screen audio independent.
    const screenAudioElem = new Audio();
    screenAudioElem.autoplay = true;
    // A stream's audio is opt-in: nothing plays until the viewer actually
    // clicks the stream tile to watch it (see setScreenAudioAllowed).
    screenAudioElem.muted = true;

    if (this.selectedOutputId && typeof screenAudioElem.setSinkId === 'function') {
      screenAudioElem.setSinkId(this.selectedOutputId).catch(err => console.error('Sink ID error (screen audio):', err));
    }

    document.getElementById('remote-audio-container')?.appendChild(screenAudioElem);

    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
        // The first audio stream we ever see from this peer is always their
        // microphone (createPeerConnection() adds the mic track before any
        // screen-share track ever exists). Any later audio stream with a
        // different stream id is their screen-share system audio - route it
        // to the dedicated screenAudioElem instead of clobbering the mic.
        if (!peerObj.micStreamId || stream.id === peerObj.micStreamId) {
          peerObj.micStreamId = stream.id;
          audioElem.srcObject = stream;
          audioElem.volume = peerObj.volume || 1.0;
          audioElem.play().catch(err => console.log('Audio element play pending interaction:', err));
        } else {
          screenAudioElem.srcObject = stream;
          // Stream audio has its own volume, independent of the peer's mic -
          // right-clicking a stream tile adjusts this one.
          screenAudioElem.volume = peerObj.screenVolume ?? 1.0;
          screenAudioElem.muted = this.isDeafened || !peerObj.screenAudioAllowed;
          screenAudioElem.play().catch(err => console.log('Screen audio element play pending interaction:', err));
        }
      } else if (event.track.kind === 'video') {
        const stream = event.streams[0] || new MediaStream([event.track]);
        const peer = this.peers.get(targetSocketId);
        const isScreen = peer && peer.remoteScreenStreamId && stream.id === peer.remoteScreenStreamId;
        const isCamera = peer && peer.remoteCameraStreamId && stream.id === peer.remoteCameraStreamId;
        // Fallback for the rare case the stream-id metadata hasn't arrived
        // yet: fall back to the peer's last-known screen-sharing status
        // rather than guessing wrong and mixing up camera/screen video.
        const treatAsScreen = isScreen || (!isCamera && peer && peer.isScreenSharing);

        if (treatAsScreen) {
          if (peer) peer.screenStream = stream;
          if (this.callbacks.onScreenShareTrack) {
            this.callbacks.onScreenShareTrack(targetSocketId, stream);
          }
          event.track.onended = () => {
            const p = this.peers.get(targetSocketId);
            if (p) p.screenStream = null;
            if (this.callbacks.onScreenShareTrack) {
              this.callbacks.onScreenShareTrack(targetSocketId, null);
            }
          };
        } else {
          if (peer) peer.cameraStream = stream;
          if (this.callbacks.onCameraTrack) {
            this.callbacks.onCameraTrack(targetSocketId, stream);
          }
          event.track.onended = () => {
            const p = this.peers.get(targetSocketId);
            if (p) p.cameraStream = null;
            if (this.callbacks.onCameraTrack) {
              this.callbacks.onCameraTrack(targetSocketId, null);
            }
          };
        }
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', {
          targetSocketId,
          candidate: event.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[voice] ICE state with ${targetSocketId}: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'failed') {
        const now = Date.now();
        const lastAttempt = this._lastIceRestartAttempt?.get(targetSocketId) || 0;
        if (now - lastAttempt > 4000) {
          if (!this._lastIceRestartAttempt) this._lastIceRestartAttempt = new Map();
          this._lastIceRestartAttempt.set(targetSocketId, now);
          // Try an ICE restart before giving up - this recovers connections
          // that briefly lost their path (e.g. network change, NAT rebinding)
          // instead of leaving that peer permanently silent.
          this.renegotiate(targetSocketId, true);
        }
      }
    };

    const peerObj = {
      connection: pc,
      audioElem,
      screenAudioElem,
      micStreamId: null,
      micSender,
      username: username || 'Peer',
      avatar: avatar || null,
      volume: 1.0,
      screenVolume: 1.0,
      screenAudioAllowed: false,
      isMuted,
      isDeafened,
      isScreenSharing: !!isScreenSharing,
      screenStream: null,
      screenSender: null,
      screenAudioSender: null,
      cameraStream: null,
      cameraSender: null,
      isCameraOn: !!isCameraOn,
      remoteCameraStreamId: null,
      remoteScreenStreamId: null,
      makingOffer: false,
      // Whether an offer/answer exchange has ever completed on this
      // connection. Distinct from "was the peer object just created in this
      // handler call": when we're the answerer and already had a camera/
      // screen track queued via addTrack() above (e.g. this peerObj was
      // pre-created by the 'user-joined-voice' handler before their offer
      // even arrived), the very first answer we send still can't carry
      // those tracks per JSEP - only the first *negotiation*, not the first
      // *connection object*, determines that.
      negotiated: false,
      // Deterministic tie-breaker so both sides agree on who backs off if
      // offers ever collide (e.g. simultaneous screen-share renegotiation).
      polite: this.socket.id < targetSocketId
    };

    this.peers.set(targetSocketId, peerObj);

    // If we're already sharing our screen when this peer connects, include it
    if (this.isScreenSharing && this.screenStream) {
      const videoTrack = this.screenStream.getVideoTracks()[0];
      if (videoTrack) {
        peerObj.screenSender = pc.addTrack(videoTrack, this.screenStream);
      }
      const audioTrack = this.screenStream.getAudioTracks()[0];
      if (audioTrack) {
        peerObj.screenAudioSender = pc.addTrack(audioTrack, this.screenStream);
      }
    }

    // Same idea for an already-active camera
    if (this.isCameraOn && this.cameraStream) {
      const camTrack = this.cameraStream.getVideoTracks()[0];
      if (camTrack) {
        peerObj.cameraSender = pc.addTrack(camTrack, this.cameraStream);
      }
    }

    if (isInitiator) {
      try {
        peerObj.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('offer', {
          targetSocketId,
          sdp: offer,
          meta: {
            cameraStreamId: this.cameraStream ? this.cameraStream.id : null,
            screenStreamId: this.screenStream ? this.screenStream.id : null
          }
        });
      } finally {
        peerObj.makingOffer = false;
      }
    }

    return peerObj;
  }

  closePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (peer) {
      if (peer.remoteStream) {
        try { peer.remoteStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        peer.remoteStream = null;
      }
      if (peer.screenStream) {
        try { peer.screenStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        peer.screenStream = null;
      }
      if (peer.cameraStream) {
        try { peer.cameraStream.getTracks().forEach(t => t.stop()); } catch (e) {}
        peer.cameraStream = null;
      }
      if (peer.connection) {
        try { peer.connection.close(); } catch (e) {}
      }
      if (peer.audioElem) {
        peer.audioElem.srcObject = null;
        peer.audioElem.remove();
      }
      if (peer.screenAudioElem) {
        peer.screenAudioElem.srcObject = null;
        peer.screenAudioElem.remove();
      }
      this.peers.delete(socketId);
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        // In PTT mode, un-muting here must NOT start transmitting on its own -
        // the key still has to be held. Muting still always wins over a held key.
        track.enabled = this.pttMode ? (!this.isMuted && this.pttKeyHeld) : !this.isMuted;
      });
    }
    this.socket.emit('voice-status-update', { isMuted: this.isMuted, isDeafened: this.isDeafened });
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange({ socketId: 'local', isMuted: this.isMuted, isDeafened: this.isDeafened });
    }
    return this.isMuted;
  }

  // Enables/disables push-to-talk mode. While on, the mic is silent by
  // default and VAD's talking indicator is redundant (holding the key
  // already means "talking"), so VAD is stopped/restarted alongside it.
  setPushToTalkMode(enabled) {
    this.pttMode = enabled;
    this.pttKeyHeld = false;
    if (!this.localStream) return;
    if (enabled) {
      this.stopVoiceActivityDetection();
      this.localStream.getAudioTracks().forEach(track => { track.enabled = false; });
      if (this.isTalking) {
        this.isTalking = false;
        this.socket.emit('voice-status-update', { isMuted: this.isMuted, isDeafened: this.isDeafened, isTalking: false });
        if (this.callbacks.onStatusChange) this.callbacks.onStatusChange({ socketId: 'local', isTalking: false });
      }
    } else {
      this.localStream.getAudioTracks().forEach(track => { track.enabled = !this.isMuted; });
      // Defensive stop first: startVoiceActivityDetection() doesn't clear a
      // prior vadIntervalId itself, so calling it twice in a row (e.g. if
      // this were ever invoked while already off) would leak an interval.
      if (this.currentRoomId) {
        this.stopVoiceActivityDetection();
        this.startVoiceActivityDetection();
      }
    }
  }

  // Called on every keydown/keyup of the assigned PTT combo (see app.js).
  setPushToTalkActive(active) {
    this.pttKeyHeld = active;
    if (!this.pttMode || !this.localStream) return;
    const shouldTransmit = active && !this.isMuted;
    this.localStream.getAudioTracks().forEach(track => { track.enabled = shouldTransmit; });
    if (this.isTalking === shouldTransmit) return;
    this.isTalking = shouldTransmit;
    this.socket.emit('voice-status-update', { isMuted: this.isMuted, isDeafened: this.isDeafened, isTalking: shouldTransmit });
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange({ socketId: 'local', isTalking: shouldTransmit });
    }
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    for (const peer of this.peers.values()) {
      if (peer.audioElem) {
        peer.audioElem.muted = this.isDeafened;
      }
      if (peer.screenAudioElem) {
        peer.screenAudioElem.muted = this.isDeafened || !peer.screenAudioAllowed;
      }
    }
    this.socket.emit('voice-status-update', { isMuted: this.isMuted, isDeafened: this.isDeafened });
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange({ socketId: 'local', isMuted: this.isMuted, isDeafened: this.isDeafened });
    }
    return this.isDeafened;
  }

  setPeerVolume(socketId, volume) {
    const peer = this.peers.get(socketId);
    if (peer && peer.audioElem) {
      peer.volume = Math.max(0, Math.min(1, volume));
      peer.audioElem.volume = peer.volume;
    }
  }

  // A peer's screen share carries its own audio track on its own <audio>
  // element, so its level is adjusted separately from their microphone -
  // turning a loud stream down must not also turn the person down.
  setPeerScreenVolume(socketId, volume) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    peer.screenVolume = Math.max(0, Math.min(1, volume));
    if (peer.screenAudioElem) peer.screenAudioElem.volume = peer.screenVolume;
  }

  getPeerScreenVolume(socketId) {
    const peer = this.peers.get(socketId);
    return peer ? (peer.screenVolume ?? 1.0) : 1.0;
  }

  // Called when the viewer starts/stops watching a stream. Un-watching only
  // silences and stops rendering it locally - the sender is untouched, so
  // watching again is instant and costs no renegotiation.
  setScreenAudioAllowed(socketId, allowed) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    peer.screenAudioAllowed = !!allowed;
    if (peer.screenAudioElem) {
      peer.screenAudioElem.muted = this.isDeafened || !peer.screenAudioAllowed;
      if (peer.screenAudioAllowed) {
        peer.screenAudioElem.play().catch(() => {});
      }
    }
  }
}
