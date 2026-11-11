"use strict";

/**
 * Concord WebRTC P2P Mesh Engine (Inspirado no discord_voice)
 * - Suporta até 6+ participantes em malha P2P direta com baixa latência
 * - Múltiplas transmissões de tela simultâneas (720p/1080p/1440p a 30/60 FPS) + Áudio do Sistema
 * - Câmera simultânea + Compartilhamento de tela separado (meta-mapeamento de MediaStream)
 * - Controle de volume individual de 0% a 200% (Web Audio GainNode) + Pan Estéreo
 * - Detecção de voz (VAD com anel verde) e modo Push-to-Talk (PTT)
 */
class ConcordWebRTCMesh {
  constructor(gateway, sounds) {
    this.gateway = gateway;
    this.sounds = sounds;

    this.myUserId = null;
    this.activeServerId = null;
    this.activeChannelId = null;

    // Estados locais
    this.selfMuted = false;
    this.selfDeafened = false;
    this.cameraEnabled = false;
    this.screenShareEnabled = false;
    this.screenShareAudio = true;
    this.screenQuality = { width: 1920, height: 1080, fps: 60, label: "1080p 60fps" };

    // Modo de entrada: 'vad' (Detecção de Voz) ou 'ptt' (Push-to-Talk)
    this.inputMode = localStorage.getItem("concord_input_mode") || "vad";
    this.pttKey = localStorage.getItem("concord_ptt_key") || "Space";
    this.pttPressed = false;
    this.vadThreshold = Number(localStorage.getItem("concord_vad_threshold") || 12);
    this.isSpeaking = false;

    // Dispositivos selecionados
    this.selectedAudioInput = localStorage.getItem("concord_audio_input") || "default";
    this.selectedVideoInput = localStorage.getItem("concord_video_input") || "default";

    // Streams locais
    this.micStream = null;
    this.cameraStream = null;
    this.screenStream = null;

    // Conexões P2P: userId -> PeerEntry
    this.peers = new Map();

    // Volumes e mutes locais por usuário (persistidos)
    this.userVolumes = this.loadUserVolumes(); // userId -> 0..200 (default 100)
    this.userLocalMutes = new Set();
    this.userStereoPan = new Map(); // userId -> -1..1

    // Web Audio API para VAD local e amplificação 0-200% dos pares
    this.audioCtx = null;
    this.vadInterval = null;

    // Callbacks para a UI
    this.onStreamsChanged = null;
    this.onSpeakingChanged = null;
    this.onStatsUpdated = null;

    this.iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" }
    ];

    this.bindGatewayEvents();
    this.bindPttKeyboard();
  }

  loadUserVolumes() {
    try {
      const raw = localStorage.getItem("concord_user_volumes");
      return raw ? JSON.parse(raw) : {};
    } catch (_) {
      return {};
    }
  }

  saveUserVolumes() {
    try {
      localStorage.setItem("concord_user_volumes", JSON.stringify(this.userVolumes));
    } catch (_) {}
  }

  ensureAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  bindGatewayEvents() {
    this.gateway.on("WEBRTC_SIGNAL", async (payload) => {
      if (!this.activeChannelId) return;
      if (payload.channelId && payload.channelId !== this.activeChannelId) return;
      await this.handleSignal(payload);
    });

    this.gateway.on("VOICE_STATE_UPDATE", async (payload) => {
      if (!this.activeChannelId) return;
      const states = payload.voiceStates || [];
      const peersInMyChannel = states.filter(
        (s) => s.channelId === this.activeChannelId && s.userId !== this.myUserId
      );
      const activeIds = new Set(peersInMyChannel.map((p) => p.userId));

      // Remove pares que saíram do canal
      for (const [peerUserId] of this.peers) {
        if (!activeIds.has(peerUserId)) {
          this.destroyPeer(peerUserId);
          if (payload.action === "leave" && payload.userId === peerUserId) {
            this.sounds.playLeave();
          }
        }
      }

      // Conecta aos pares que estão no canal
      for (const peerState of peersInMyChannel) {
        if (!this.peers.has(peerState.userId)) {
          if (payload.action === "join" && payload.userId === peerState.userId) {
            this.sounds.playJoin();
          }
          const shouldInitiate = String(this.myUserId) < String(peerState.userId);
          await this.ensurePeerConnection(peerState.userId, shouldInitiate);
        }
      }

      this.notifyUI();
    });
  }

  bindPttKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (this.inputMode !== "ptt" || !this.activeChannelId) return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) {
        return;
      }
      if (e.code === this.pttKey && !this.pttPressed) {
        this.pttPressed = true;
        this.updateMicTrackEnabled();
        this.sounds.playPttActivate();
      }
    });

    window.addEventListener("keyup", (e) => {
      if (this.inputMode !== "ptt" || !this.activeChannelId) return;
      if (e.code === this.pttKey && this.pttPressed) {
        this.pttPressed = false;
        this.updateMicTrackEnabled();
        this.sounds.playPttRelease();
      }
    });
  }

  async joinVoiceChannel(serverId, channelId, myUserId, currentVoiceStates = []) {
    if (this.activeChannelId === channelId) return;
    if (this.activeChannelId) {
      await this.leaveVoiceChannel(false);
    }

    this.myUserId = myUserId;
    this.activeServerId = serverId;
    this.activeChannelId = channelId;

    this.ensureAudioContext();

    // Tenta capturar microfone (permite entrar em modo escuta caso não tenha microfone físico)
    try {
      const audioConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      };
      if (this.selectedAudioInput && this.selectedAudioInput !== "default") {
        audioConstraints.deviceId = { ideal: this.selectedAudioInput };
      }
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
      });
      this.startLocalVad(this.micStream);
      this.updateMicTrackEnabled();
    } catch (err) {
      console.warn("[WebRTC] Entrando sem microfone físico (modo escuta/transmissão):", err.message);
      this.micStream = null;
    }

    this.sounds.playJoin();

    this.gateway.send("VOICE_JOIN", {
      serverId,
      channelId,
      muted: this.selfMuted,
      deafened: this.selfDeafened,
      video: this.cameraEnabled
    });

    if (window.ConcordNative && window.ConcordNative.voice) {
      window.ConcordNative.voice.updateState({
        connected: true,
        muted: this.selfMuted,
        deafened: this.selfDeafened
      });
    }

    // Inicia conexão P2P com quem já está na call
    const peersInChannel = currentVoiceStates.filter(
      (s) => s.channelId === channelId && s.userId !== myUserId
    );
    for (const p of peersInChannel) {
      await this.ensurePeerConnection(p.userId, true);
    }

    this.notifyUI();
  }

  async leaveVoiceChannel(playSound = true) {
    if (!this.activeChannelId) return;

    await this.stopScreenShare(false);
    await this.stopCamera(false);

    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }

    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop();
      this.micStream = null;
    }

    for (const [peerUserId] of this.peers) {
      this.destroyPeer(peerUserId);
    }
    this.peers.clear();

    this.gateway.send("VOICE_LEAVE", { channelId: this.activeChannelId });
    this.activeChannelId = null;
    this.activeServerId = null;
    this.isSpeaking = false;

    if (playSound) {
      this.sounds.playLeave();
    }

    if (window.ConcordNative && window.ConcordNative.voice) {
      window.ConcordNative.voice.updateState({
        connected: false,
        muted: this.selfMuted,
        deafened: this.selfDeafened
      });
    }

    this.notifyUI();
  }

  startLocalVad(stream) {
    if (this.vadInterval) clearInterval(this.vadInterval);
    const ctx = this.ensureAudioContext();
    if (!ctx || !stream) return;

    try {
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      this.vadInterval = setInterval(() => {
        if (!this.activeChannelId || this.selfMuted || this.selfDeafened) {
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this.gateway.send("VOICE_UPDATE", { speaking: false });
            if (this.onSpeakingChanged) this.onSpeakingChanged(this.myUserId, false);
          }
          return;
        }

        if (this.inputMode === "ptt" && !this.pttPressed) {
          if (this.isSpeaking) {
            this.isSpeaking = false;
            this.gateway.send("VOICE_UPDATE", { speaking: false });
            if (this.onSpeakingChanged) this.onSpeakingChanged(this.myUserId, false);
          }
          return;
        }

        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length;
        const speakingNow = avg > this.vadThreshold;

        if (speakingNow !== this.isSpeaking) {
          this.isSpeaking = speakingNow;
          this.gateway.send("VOICE_UPDATE", { speaking: speakingNow });
          if (this.onSpeakingChanged) this.onSpeakingChanged(this.myUserId, speakingNow);
        }
      }, 90);
    } catch (_) {}
  }

  updateMicTrackEnabled() {
    if (!this.micStream) return;
    const shouldEnable =
      !this.selfMuted &&
      !this.selfDeafened &&
      (this.inputMode === "vad" || (this.inputMode === "ptt" && this.pttPressed));

    for (const track of this.micStream.getAudioTracks()) {
      track.enabled = shouldEnable;
    }
  }

  toggleMute() {
    this.selfMuted = !this.selfMuted;
    if (!this.selfMuted && this.selfDeafened) {
      this.selfDeafened = false;
      this.applyDeafenToRemotePeers();
    }
    this.updateMicTrackEnabled();
    if (this.selfMuted) {
      this.sounds.playMute();
    } else {
      this.sounds.playUnmute();
    }
    if (this.activeChannelId) {
      this.gateway.send("VOICE_UPDATE", {
        muted: this.selfMuted,
        deafened: this.selfDeafened,
        speaking: false
      });
    }
    if (window.ConcordNative && window.ConcordNative.voice) {
      window.ConcordNative.voice.updateState({
        connected: !!this.activeChannelId,
        muted: this.selfMuted,
        deafened: this.selfDeafened
      });
    }
    this.notifyUI();
    return this.selfMuted;
  }

  toggleDeafen() {
    this.selfDeafened = !this.selfDeafened;
    if (this.selfDeafened) {
      this.selfMuted = true;
      this.sounds.playDeafen();
    } else {
      this.selfMuted = false;
      this.sounds.playUndeafen();
    }
    this.updateMicTrackEnabled();
    this.applyDeafenToRemotePeers();

    if (this.activeChannelId) {
      this.gateway.send("VOICE_UPDATE", {
        muted: this.selfMuted,
        deafened: this.selfDeafened,
        speaking: false
      });
    }
    if (window.ConcordNative && window.ConcordNative.voice) {
      window.ConcordNative.voice.updateState({
        connected: !!this.activeChannelId,
        muted: this.selfMuted,
        deafened: this.selfDeafened
      });
    }
    this.notifyUI();
    return this.selfDeafened;
  }

  applyDeafenToRemotePeers() {
    for (const [peerUserId] of this.peers) {
      this.applyPeerAudioGain(peerUserId);
    }
  }

  async toggleCamera() {
    if (this.cameraEnabled) {
      await this.stopCamera(true);
    } else {
      await this.startCamera();
    }
    return this.cameraEnabled;
  }

  async startCamera() {
    if (!this.activeChannelId) return;
    try {
      const videoConstraints = {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      };
      if (this.selectedVideoInput && this.selectedVideoInput !== "default") {
        videoConstraints.deviceId = { ideal: this.selectedVideoInput };
      }
      this.cameraStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: false
      });
      this.cameraEnabled = true;

      for (const [peerUserId, entry] of this.peers) {
        for (const track of this.cameraStream.getVideoTracks()) {
          const sender = entry.pc.addTrack(track, this.cameraStream);
          entry.cameraSenders.push(sender);
        }
        this.sendStreamMeta(peerUserId);
        await this.renegotiatePeer(peerUserId);
      }

      this.gateway.send("VOICE_UPDATE", { video: true });
      this.notifyUI();
    } catch (err) {
      throw new Error("Não foi possível acessar a câmera: " + err.message);
    }
  }

  async stopCamera(notifyServer = true) {
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) track.stop();
      this.cameraStream = null;
    }
    this.cameraEnabled = false;

    for (const [peerUserId, entry] of this.peers) {
      for (const sender of entry.cameraSenders) {
        try {
          entry.pc.removeTrack(sender);
        } catch (_) {}
      }
      entry.cameraSenders = [];
      if (notifyServer) {
        await this.renegotiatePeer(peerUserId);
      }
    }

    if (notifyServer && this.activeChannelId) {
      this.gateway.send("VOICE_UPDATE", { video: false });
    }
    this.notifyUI();
  }

  /**
   * Inicia Compartilhamento de Tela ("Go Live") com resolução/FPS e áudio do sistema
   */
  async startScreenShare({
    sourceId = null,
    width = 1920,
    height = 1080,
    fps = 60,
    includeAudio = true,
    label = "1080p 60fps"
  } = {}) {
    if (!this.activeChannelId) {
      throw new Error("Entre em um canal de voz antes de compartilhar a tela.");
    }

    if (this.screenShareEnabled) {
      await this.stopScreenShare(false);
    }

    this.screenQuality = { width, height, fps, label };
    this.screenShareAudio = includeAudio;

    // Se estiver rodando no Electron Desktop e uma fonte específica foi escolhida
    if (window.ConcordNative && window.ConcordNative.desktopCapture && sourceId) {
      await window.ConcordNative.desktopCapture.selectSource(sourceId, includeAudio);
    }

    const displayConstraints = {
      video: {
        width: { ideal: width, max: width },
        height: { ideal: height, max: height },
        frameRate: { ideal: fps, max: fps },
        cursor: "always"
      },
      audio: includeAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        : false
    };

    const stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
    this.screenStream = stream;
    this.screenShareEnabled = true;

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      // Otimiza contentHint para fluidez em jogos (motion) ou nitidez de texto
      try {
        videoTrack.contentHint = fps >= 60 ? "motion" : "detail";
      } catch (_) {}
      videoTrack.onended = () => {
        this.stopScreenShare(true);
      };
    }

    for (const [peerUserId, entry] of this.peers) {
      for (const track of stream.getTracks()) {
        const sender = entry.pc.addTrack(track, stream);
        entry.screenSenders.push(sender);
        if (track.kind === "video") {
          this.boostVideoSenderBitrate(sender, width, fps);
        }
      }
      this.sendStreamMeta(peerUserId);
      await this.renegotiatePeer(peerUserId);
    }

    this.sounds.playStreamStart();
    this.gateway.send("VOICE_UPDATE", {
      screenShare: true,
      screenAudio: stream.getAudioTracks().length > 0,
      screenQuality: label
    });
    this.notifyUI();
    return stream;
  }

  async boostVideoSenderBitrate(sender, width, fps) {
    try {
      if (!sender.getParameters) return;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const maxBitrate = width >= 2560 ? 8000000 : width >= 1920 ? 5500000 : 3000000;
      params.encodings[0].maxBitrate = maxBitrate;
      params.encodings[0].maxFramerate = fps;
      await sender.setParameters(params);
    } catch (_) {}
  }

  async stopScreenShare(notifyServer = true) {
    if (!this.screenShareEnabled && !this.screenStream) return;
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) track.stop();
      this.screenStream = null;
    }
    this.screenShareEnabled = false;

    for (const [peerUserId, entry] of this.peers) {
      for (const sender of entry.screenSenders) {
        try {
          entry.pc.removeTrack(sender);
        } catch (_) {}
      }
      entry.screenSenders = [];
      if (notifyServer) {
        await this.renegotiatePeer(peerUserId);
      }
    }

    if (notifyServer && this.activeChannelId) {
      this.sounds.playStreamStop();
      this.gateway.send("VOICE_UPDATE", {
        screenShare: false,
        screenAudio: false
      });
    }
    this.notifyUI();
  }

  sendStreamMeta(targetUserId) {
    const meta = {
      micStreamId: this.micStream ? this.micStream.id : null,
      cameraStreamId: this.cameraStream ? this.cameraStream.id : null,
      screenStreamId: this.screenStream ? this.screenStream.id : null,
      screenQuality: this.screenQuality.label
    };
    this.gateway.send("WEBRTC_SIGNAL", {
      targetUserId,
      channelId: this.activeChannelId,
      signalType: "stream-meta",
      meta
    });
  }

  async ensurePeerConnection(peerUserId, isInitiator = false) {
    if (this.peers.has(peerUserId)) {
      return this.peers.get(peerUserId);
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry = {
      userId: peerUserId,
      pc,
      makingOffer: false,
      ignoreOffer: false,
      polite: String(this.myUserId) > String(peerUserId),
      micSender: null,
      cameraSenders: [],
      screenSenders: [],
      remoteStreams: new Map(), // streamId -> MediaStream
      streamMeta: {
        micStreamId: null,
        cameraStreamId: null,
        screenStreamId: null,
        screenQuality: "1080p 60fps"
      },
      audioEl: null,
      gainNode: null,
      pannerNode: null
    };

    this.peers.set(peerUserId, entry);

    // Adiciona faixas locais atuais na conexão
    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) {
        entry.micSender = pc.addTrack(track, this.micStream);
      }
    }
    if (this.cameraStream) {
      for (const track of this.cameraStream.getVideoTracks()) {
        entry.cameraSenders.push(pc.addTrack(track, this.cameraStream));
      }
    }
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        const sender = pc.addTrack(track, this.screenStream);
        entry.screenSenders.push(sender);
        if (track.kind === "video") {
          this.boostVideoSenderBitrate(sender, this.screenQuality.width, this.screenQuality.fps);
        }
      }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.gateway.send("WEBRTC_SIGNAL", {
          targetUserId: peerUserId,
          channelId: this.activeChannelId,
          signalType: "ice-candidate",
          candidate: e.candidate
        });
      }
    };

    pc.ontrack = (e) => {
      const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      entry.remoteStreams.set(stream.id, stream);

      if (e.track.kind === "audio") {
        this.setupRemotePeerAudio(peerUserId, stream);
      }

      e.track.onended = () => {
        this.notifyUI();
      };

      this.notifyUI();
    };

    pc.onconnectionstatechange = () => {
      this.notifyUI();
    };

    this.sendStreamMeta(peerUserId);

    if (isInitiator) {
      await this.renegotiatePeer(peerUserId);
    }

    return entry;
  }

  async renegotiatePeer(peerUserId) {
    const entry = this.peers.get(peerUserId);
    if (!entry) return;
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.gateway.send("WEBRTC_SIGNAL", {
        targetUserId: peerUserId,
        channelId: this.activeChannelId,
        signalType: "offer",
        sdp: entry.pc.localDescription
      });
    } catch (err) {
      console.warn("[WebRTC] Erro ao renegociar oferta:", err.message);
    } finally {
      entry.makingOffer = false;
    }
  }

  async handleSignal({ fromUserId, signalType, sdp, candidate, meta }) {
    const entry = await this.ensurePeerConnection(fromUserId, false);
    const pc = entry.pc;

    if (signalType === "stream-meta" && meta) {
      entry.streamMeta = { ...entry.streamMeta, ...meta };
      this.notifyUI();
      return;
    }

    try {
      if (signalType === "offer" && sdp) {
        const offerCollision = entry.makingOffer || pc.signalingState !== "stable";
        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) return;

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.gateway.send("WEBRTC_SIGNAL", {
          targetUserId: fromUserId,
          channelId: this.activeChannelId,
          signalType: "answer",
          sdp: pc.localDescription
        });
      } else if (signalType === "answer" && sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      } else if (signalType === "ice-candidate" && candidate) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          if (!entry.ignoreOffer) console.warn("[WebRTC] ICE candidate warning:", err.message);
        }
      }
    } catch (err) {
      console.warn(`[WebRTC] Erro ao processar sinal (${signalType}):`, err.message);
    }
  }

  /**
   * Configura cadeia de áudio com Web Audio API para permitir ganho de 0% a 200% e Pan L/R
   */
  setupRemotePeerAudio(peerUserId, stream) {
    const entry = this.peers.get(peerUserId);
    if (!entry) return;

    // Elemento de áudio oculto (necessário no Chromium para ativar o fluxo WebRTC)
    if (!entry.audioEl) {
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = true; // Mutado no elemento pois o som sai pelo GainNode da Web Audio API
      document.body.appendChild(audioEl);
      entry.audioEl = audioEl;
    }
    entry.audioEl.srcObject = stream;
    entry.audioEl.play().catch(() => {});

    const ctx = this.ensureAudioContext();
    if (ctx) {
      try {
        const source = ctx.createMediaStreamSource(stream);
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        const gainNode = ctx.createGain();

        if (panner) {
          source.connect(panner);
          panner.connect(gainNode);
        } else {
          source.connect(gainNode);
        }
        gainNode.connect(ctx.destination);

        entry.gainNode = gainNode;
        entry.pannerNode = panner;
        this.applyPeerAudioGain(peerUserId);
      } catch (err) {
        // Fallback caso Web Audio falhe
        entry.audioEl.muted = false;
        this.applyPeerAudioGain(peerUserId);
      }
    } else {
      entry.audioEl.muted = false;
      this.applyPeerAudioGain(peerUserId);
    }
  }

  getUserVolume(userId) {
    return typeof this.userVolumes[userId] === "number" ? this.userVolumes[userId] : 100;
  }

  setUserVolume(userId, volumePercent) {
    const clamped = Math.max(0, Math.min(200, Number(volumePercent)));
    this.userVolumes[userId] = clamped;
    this.saveUserVolumes();
    this.applyPeerAudioGain(userId);
  }

  toggleLocalUserMute(userId) {
    if (this.userLocalMutes.has(userId)) {
      this.userLocalMutes.delete(userId);
    } else {
      this.userLocalMutes.add(userId);
    }
    this.applyPeerAudioGain(userId);
    return this.userLocalMutes.has(userId);
  }

  setUserPan(userId, panValue) {
    const clamped = Math.max(-1, Math.min(1, Number(panValue)));
    this.userStereoPan.set(userId, clamped);
    const entry = this.peers.get(userId);
    if (entry && entry.pannerNode) {
      entry.pannerNode.pan.value = clamped;
    }
  }

  applyPeerAudioGain(userId) {
    const entry = this.peers.get(userId);
    if (!entry) return;
    const isMuted = this.selfDeafened || this.userLocalMutes.has(userId);
    const volPercent = this.getUserVolume(userId);
    const gainValue = isMuted ? 0 : volPercent / 100; // 0.0 até 2.0 (200%)

    if (entry.gainNode) {
      entry.gainNode.gain.value = gainValue;
    } else if (entry.audioEl) {
      entry.audioEl.muted = isMuted;
      entry.audioEl.volume = Math.min(1, gainValue);
    }
  }

  destroyPeer(peerUserId) {
    const entry = this.peers.get(peerUserId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (_) {}
    if (entry.audioEl && entry.audioEl.parentNode) {
      entry.audioEl.srcObject = null;
      entry.audioEl.parentNode.removeChild(entry.audioEl);
    }
    this.peers.delete(peerUserId);
  }

  /**
   * Retorna todas as transmissões de vídeo e tela ativas (locais e remotas)
   * para renderizar no Palco (Modo Grade ou Modo Foco/Spotlight)
   */
  getActiveVideoTiles() {
    const tiles = [];

    if (this.screenShareEnabled && this.screenStream) {
      tiles.push({
        id: `local_screen_${this.myUserId}`,
        userId: this.myUserId,
        type: "screen",
        stream: this.screenStream,
        isLocal: true,
        quality: this.screenQuality.label
      });
    }

    if (this.cameraEnabled && this.cameraStream) {
      tiles.push({
        id: `local_cam_${this.myUserId}`,
        userId: this.myUserId,
        type: "camera",
        stream: this.cameraStream,
        isLocal: true
      });
    }

    for (const [peerUserId, entry] of this.peers) {
      let videoIndex = 0;
      for (const [streamId, stream] of entry.remoteStreams) {
        const videoTracks = stream.getVideoTracks().filter((t) => t.readyState === "live");
        if (videoTracks.length === 0) continue;

        let tileType = "camera";
        if (entry.streamMeta.screenStreamId === streamId) {
          tileType = "screen";
        } else if (entry.streamMeta.cameraStreamId === streamId) {
          tileType = "camera";
        } else if (videoIndex > 0) {
          tileType = "screen";
        }
        videoIndex++;

        tiles.push({
          id: `remote_${tileType}_${peerUserId}_${streamId}`,
          userId: peerUserId,
          type: tileType,
          stream,
          isLocal: false,
          quality: entry.streamMeta.screenQuality || "1080p 60fps"
        });
      }
    }

    return tiles;
  }

  notifyUI() {
    if (typeof this.onStreamsChanged === "function") {
      this.onStreamsChanged(this.getActiveVideoTiles());
    }
  }
}

window.ConcordWebRTCMesh = ConcordWebRTCMesh;
