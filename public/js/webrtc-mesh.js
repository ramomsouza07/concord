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
    this.bindAutoplayUnlock();
  }

  bindAutoplayUnlock() {
    const unlock = () => {
      this.ensureAudioContext();
    };
    window.addEventListener("click", unlock, { passive: true });
    window.addEventListener("keydown", unlock, { passive: true });
    window.addEventListener("touchstart", unlock, { passive: true });
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
      this.audioCtx
        .resume()
        .then(() => {
          this.applyAudioRouting();
        })
        .catch(() => {});
    }
    return this.audioCtx;
  }

  applyAudioRouting() {
    for (const [peerUserId] of this.peers) {
      this.applyPeerAudioGain(peerUserId);
    }
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

    // Inicia conexão P2P com quem já está na call usando desempate determinístico (evita colisão de oferta)
    const peersInChannel = currentVoiceStates.filter(
      (s) => s.channelId === channelId && s.userId !== myUserId
    );
    for (const p of peersInChannel) {
      const shouldInitiate = String(myUserId) < String(p.userId);
      await this.ensurePeerConnection(p.userId, shouldInitiate);
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
      this.sendStreamMeta(peerUserId);
      this.gateway.send("WEBRTC_SIGNAL", {
        targetUserId: peerUserId,
        channelId: this.activeChannelId,
        signalType: "track-stopped",
        meta: { kind: "camera" }
      });
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
      this.sendStreamMeta(peerUserId);
      this.gateway.send("WEBRTC_SIGNAL", {
        targetUserId: peerUserId,
        channelId: this.activeChannelId,
        signalType: "track-stopped",
        meta: { kind: "screen" }
      });
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
    const micTrack = this.micStream && this.micStream.getAudioTracks()[0];
    const camTrack = this.cameraStream && this.cameraStream.getVideoTracks()[0];
    const screenVidTrack = this.screenStream && this.screenStream.getVideoTracks()[0];
    const screenAudTrack = this.screenStream && this.screenStream.getAudioTracks()[0];

    const meta = {
      micTrackId: micTrack ? micTrack.id : null,
      cameraTrackId: camTrack ? camTrack.id : null,
      screenVideoTrackId: screenVidTrack ? screenVidTrack.id : null,
      screenAudioTrackId: screenAudTrack ? screenAudTrack.id : null,
      cameraActive: this.cameraEnabled,
      screenActive: this.screenShareEnabled,
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
      const existing = this.peers.get(peerUserId);
      if (
        existing &&
        existing.pc &&
        (existing.pc.connectionState === "closed" ||
          existing.pc.connectionState === "failed" ||
          existing.pc.iceConnectionState === "closed" ||
          existing.pc.iceConnectionState === "failed")
      ) {
        this.destroyPeer(peerUserId);
      } else {
        return existing;
      }
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const entry = {
      userId: peerUserId,
      pc,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      negotiationQueued: false,
      polite: String(this.myUserId) > String(peerUserId),
      micSender: null,
      cameraSenders: [],
      screenSenders: [],
      remoteStreams: new Map(), // streamId -> MediaStream
      remoteTracks: new Map(), // trackId -> { track, stream, kind: 'camera'|'screen'|'audio', quality }
      iceCandidateQueue: [],
      streamMeta: {
        micTrackId: null,
        cameraTrackId: null,
        screenVideoTrackId: null,
        screenAudioTrackId: null,
        cameraActive: false,
        screenActive: false,
        screenQuality: "1080p 60fps"
      },
      audioElements: new Map(), // trackId -> HTMLAudioElement
      audioSources: new Map(), // trackId -> MediaStreamAudioSourceNode
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
      const track = e.track;
      const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([track]);
      entry.remoteStreams.set(stream.id, stream);

      if (track.kind === "video") {
        let kind = "camera";
        if (track.id === entry.streamMeta.screenVideoTrackId) {
          kind = "screen";
        } else if (track.id === entry.streamMeta.cameraTrackId) {
          kind = "camera";
        } else if (entry.streamMeta.screenActive && !entry.streamMeta.cameraActive) {
          kind = "screen";
        } else if (entry.streamMeta.cameraActive && !entry.streamMeta.screenActive) {
          kind = "camera";
        } else {
          const hasCam = Array.from(entry.remoteTracks.values()).some((t) => t.kind === "camera");
          kind = hasCam ? "screen" : "camera";
        }

        const tileStream = new MediaStream([track]);
        entry.remoteTracks.set(track.id, {
          track,
          stream: tileStream,
          kind,
          quality: entry.streamMeta.screenQuality || "1080p 60fps"
        });

        track.onended = () => {
          entry.remoteTracks.delete(track.id);
          this.notifyUI();
        };
        track.onmute = () => {
          this.notifyUI();
        };
        track.onunmute = () => {
          this.notifyUI();
        };
      } else if (track.kind === "audio") {
        this.setupRemotePeerAudio(peerUserId, stream);
        track.onended = () => {
          this.notifyUI();
        };
      }

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
    if (!entry || !entry.pc) return;
    const pc = entry.pc;

    if (entry.makingOffer || pc.signalingState !== "stable") {
      entry.negotiationQueued = true;
      return;
    }

    try {
      entry.makingOffer = true;
      const offer = await pc.createOffer();
      if (pc.signalingState !== "stable") {
        entry.negotiationQueued = true;
        return;
      }
      await pc.setLocalDescription(offer);
      this.gateway.send("WEBRTC_SIGNAL", {
        targetUserId: peerUserId,
        channelId: this.activeChannelId,
        signalType: "offer",
        sdp: pc.localDescription
      });
    } catch (err) {
      console.warn("[WebRTC] Erro ao renegociar oferta:", err.message);
    } finally {
      entry.makingOffer = false;
    }
  }

  async drainCandidateQueue(entry) {
    if (!entry || !entry.pc || !entry.pc.remoteDescription) return;
    const queue = entry.iceCandidateQueue.splice(0, entry.iceCandidateQueue.length);
    for (const candidate of queue) {
      try {
        await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (_) {}
    }
  }

  async handleSignal({ fromUserId, signalType, sdp, candidate, meta }) {
    let entry = this.peers.get(fromUserId);
    if (signalType === "offer" && entry && entry.pc) {
      if (
        entry.pc.connectionState === "failed" ||
        entry.pc.connectionState === "closed" ||
        entry.pc.iceConnectionState === "failed" ||
        entry.pc.iceConnectionState === "disconnected"
      ) {
        this.destroyPeer(fromUserId);
        entry = null;
      }
    }
    if (!entry) {
      entry = await this.ensurePeerConnection(fromUserId, false);
    }
    const pc = entry.pc;

    if (signalType === "track-stopped") {
      const kind = meta && meta.kind;
      if (kind === "screen") {
        for (const [tId, tInfo] of entry.remoteTracks) {
          if (tInfo.kind === "screen") {
            entry.remoteTracks.delete(tId);
          }
        }
        entry.streamMeta.screenActive = false;
        entry.streamMeta.screenVideoTrackId = null;
        entry.streamMeta.screenAudioTrackId = null;
      } else if (kind === "camera") {
        for (const [tId, tInfo] of entry.remoteTracks) {
          if (tInfo.kind === "camera") {
            entry.remoteTracks.delete(tId);
          }
        }
        entry.streamMeta.cameraActive = false;
        entry.streamMeta.cameraTrackId = null;
      }
      this.notifyUI();
      return;
    }

    if (signalType === "stream-meta" && meta) {
      entry.streamMeta = { ...entry.streamMeta, ...meta };
      for (const [tId, tInfo] of entry.remoteTracks) {
        if (tId === entry.streamMeta.screenVideoTrackId) {
          tInfo.kind = "screen";
          tInfo.quality = entry.streamMeta.screenQuality || "1080p 60fps";
        } else if (tId === entry.streamMeta.cameraTrackId) {
          tInfo.kind = "camera";
        } else if (entry.streamMeta.cameraActive && !entry.streamMeta.screenActive) {
          tInfo.kind = "camera";
        } else if (entry.streamMeta.screenActive && !entry.streamMeta.cameraActive) {
          tInfo.kind = "screen";
        }
      }
      this.notifyUI();
      return;
    }

    try {
      if (signalType === "offer" && sdp) {
        const readyForOffer =
          !entry.makingOffer &&
          (pc.signalingState === "stable" || entry.isSettingRemoteAnswerPending);
        const offerCollision = !readyForOffer;
        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) {
          return;
        }

        if (offerCollision) {
          try {
            await pc.setLocalDescription({ type: "rollback" });
          } catch (_) {}
        }

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await this.drainCandidateQueue(entry);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.gateway.send("WEBRTC_SIGNAL", {
          targetUserId: fromUserId,
          channelId: this.activeChannelId,
          signalType: "answer",
          sdp: pc.localDescription
        });
      } else if (signalType === "answer" && sdp) {
        entry.isSettingRemoteAnswerPending = true;
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        } finally {
          entry.isSettingRemoteAnswerPending = false;
        }
        await this.drainCandidateQueue(entry);
        if (entry.negotiationQueued && pc.signalingState === "stable") {
          entry.negotiationQueued = false;
          await this.renegotiatePeer(fromUserId);
        }
        this.notifyUI();
      } else if (signalType === "ice-candidate" && candidate) {
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          entry.iceCandidateQueue.push(candidate);
          return;
        }
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
   * com fallback transparente e proteção contra o bug de autoplay/mute do Chromium.
   */
  setupRemotePeerAudio(peerUserId, stream) {
    const entry = this.peers.get(peerUserId);
    if (!entry) return;

    if (!entry.audioElements) entry.audioElements = new Map();
    if (!entry.audioSources) entry.audioSources = new Map();

    const audioTracks = stream.getAudioTracks();
    for (const track of audioTracks) {
      if (entry.audioElements.has(track.id)) continue;

      const singleTrackStream = new MediaStream([track]);
      const audioEl = document.createElement("audio");
      audioEl.autoplay = true;
      audioEl.playsInline = true;

      const isCtxRunning = !!(this.audioCtx && this.audioCtx.state === "running");
      const userGain = this.getUserVolume(peerUserId) / 100;
      audioEl.muted = false;
      audioEl.volume = isCtxRunning ? 0.0001 : Math.min(1, userGain);

      document.body.appendChild(audioEl);
      audioEl.srcObject = singleTrackStream;
      audioEl.play().catch(() => {});
      entry.audioElements.set(track.id, audioEl);

      const ctx = this.ensureAudioContext();
      if (ctx) {
        try {
          if (!entry.gainNode) {
            entry.gainNode = ctx.createGain();
            entry.pannerNode = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
            if (entry.pannerNode) {
              entry.gainNode.connect(entry.pannerNode);
              entry.pannerNode.connect(ctx.destination);
            } else {
              entry.gainNode.connect(ctx.destination);
            }
          }

          const source = ctx.createMediaStreamSource(singleTrackStream);
          source.connect(entry.gainNode);
          entry.audioSources.set(track.id, source);
          this.applyPeerAudioGain(peerUserId);
        } catch (_) {
          audioEl.muted = false;
          audioEl.volume = Math.min(1, userGain);
          this.applyPeerAudioGain(peerUserId);
        }
      } else {
        audioEl.muted = false;
        audioEl.volume = Math.min(1, userGain);
        this.applyPeerAudioGain(peerUserId);
      }
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
    }

    const isCtxRunning = !!(this.audioCtx && this.audioCtx.state === "running");
    if (entry.audioElements) {
      for (const [, el] of entry.audioElements) {
        el.muted = isMuted;
        if (isMuted) {
          el.volume = 0;
        } else if (isCtxRunning && entry.gainNode) {
          el.volume = 0.0001; // Inaudível pelo elemento HTML, amplificado com alta fidelidade pelo GainNode
        } else {
          el.volume = Math.min(1, gainValue); // Fallback direto audível quando o AudioContext ainda não foi destravado por gesto
        }
      }
    }
  }

  destroyPeer(peerUserId) {
    const entry = this.peers.get(peerUserId);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch (_) {}
    if (entry.audioElements) {
      for (const [, el] of entry.audioElements) {
        try {
          el.srcObject = null;
          if (el.parentNode) el.parentNode.removeChild(el);
        } catch (_) {}
      }
      entry.audioElements.clear();
    }
    if (entry.audioSources) {
      for (const [, src] of entry.audioSources) {
        try {
          src.disconnect();
        } catch (_) {}
      }
      entry.audioSources.clear();
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
      const liveTrack = this.screenStream.getVideoTracks().find((t) => t.readyState === "live");
      if (liveTrack) {
        tiles.push({
          id: `local_screen_${this.myUserId}`,
          userId: this.myUserId,
          type: "screen",
          stream: this.screenStream,
          isLocal: true,
          quality: this.screenQuality.label
        });
      }
    }

    if (this.cameraEnabled && this.cameraStream) {
      const liveTrack = this.cameraStream.getVideoTracks().find((t) => t.readyState === "live");
      if (liveTrack) {
        tiles.push({
          id: `local_cam_${this.myUserId}`,
          userId: this.myUserId,
          type: "camera",
          stream: this.cameraStream,
          isLocal: true
        });
      }
    }

    for (const [peerUserId, entry] of this.peers) {
      for (const [trackId, info] of entry.remoteTracks) {
        if (!info.track || info.track.readyState !== "live") continue;
        tiles.push({
          id: `remote_${info.kind}_${peerUserId}_${trackId}`,
          userId: peerUserId,
          type: info.kind,
          stream: info.stream,
          isLocal: false,
          quality: info.quality || entry.streamMeta.screenQuality || "1080p 60fps"
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
