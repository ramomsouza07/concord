"use strict";

/**
 * Concord Gateway & REST Client (Híbrido: WebSocket + Vercel Serverless Sync)
 * - Em servidores contínuos (Local / VPS / Render / Railway): usa WebSocket nativo (/ws)
 * - Na Vercel Serverless (*.vercel.app): usa Fast-Sync HTTP (/api/sync) com flush imediato
 *   para sinalização WebRTC P2P Mesh (offer/answer/ice-candidate), chat e presença!
 */
class ConcordGateway {
  constructor() {
    this.serverUrl = this.getStoredServerUrl();
    this.token = localStorage.getItem("concord_token") || "";
    this.ws = null;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.syncTimer = null;
    this.pingMs = 14;
    this.connected = false;

    // Estado para modo Vercel Serverless Fast-Sync (/api/sync)
    this.serverlessMode = /\.vercel\.app$/i.test(window.location.hostname);
    this.lastSeq = 0;
    this.outbox = [];
    this.syncInFlight = false;
    this.pendingImmediateSync = false;
  }

  getStoredServerUrl() {
    const saved = localStorage.getItem("concord_server_url");
    if (window.location.hostname.endsWith(".vercel.app")) {
      return window.location.origin;
    }
    if (saved && saved.trim()) {
      return saved.trim().replace(/\/+$/, "");
    }
    if (window.location.protocol === "http:" || window.location.protocol === "https:") {
      return window.location.origin;
    }
    return "http://localhost:3456";
  }

  setServerUrl(url) {
    let clean = String(url || "").trim().replace(/\/+$/, "");
    if (!clean) {
      clean = window.location.protocol.startsWith("http")
        ? window.location.origin
        : "http://localhost:3456";
    }
    if (!/^https?:\/\//i.test(clean)) {
      clean = `http://${clean}`;
    }
    this.serverUrl = clean;
    this.serverlessMode = /\.vercel\.app/i.test(clean);
    localStorage.setItem("concord_server_url", clean);
    return clean;
  }

  setToken(token) {
    this.token = token || "";
    if (token) {
      localStorage.setItem("concord_token", token);
    } else {
      localStorage.removeItem("concord_token");
    }
  }

  resolveAssetUrl(url) {
    if (!url) return "";
    if (url.startsWith("data:") || url.startsWith("blob:") || /^https?:\/\//i.test(url)) {
      return url;
    }
    if (url.startsWith("/")) {
      return `${this.serverUrl}${url}`;
    }
    return `${this.serverUrl}/${url}`;
  }

  async request(endpoint, { method = "GET", body = null, headers = {} } = {}) {
    const url = `${this.serverUrl}${endpoint}`;
    const reqHeaders = { ...headers };
    if (this.token) {
      reqHeaders["Authorization"] = `Bearer ${this.token}`;
    }
    let payload = undefined;
    if (body !== null && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      reqHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    } else if (body !== null) {
      payload = body;
    }

    const res = await fetch(url, {
      method,
      headers: reqHeaders,
      body: payload
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Erro HTTP ${res.status}`);
    }
    if (endpoint === "/api/bootstrap" && data.serverInfo) {
      if (data.serverInfo.eventSeq) {
        this.lastSeq = Number(data.serverInfo.eventSeq);
      }
      if (data.serverInfo.serverless) {
        this.serverlessMode = true;
      }
    }
    return data;
  }

  async uploadFile(file) {
    if (file.size > 100 * 1024 * 1024) {
      throw new Error("O arquivo excede o limite de 100 MB.");
    }
    const url = `${this.serverUrl}/api/upload`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        "X-File-Type": file.type || "application/octet-stream"
      },
      body: file
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || "Falha ao enviar arquivo.");
    }
    return data.attachment;
  }

  connect() {
    this.disconnect();
    if (!this.token) return;

    if (this.serverlessMode) {
      this.startServerlessSyncLoop();
      return;
    }

    const wsBase = this.serverUrl.replace(/^http/i, "ws");
    const wsUrl = `${wsBase}/ws?token=${encodeURIComponent(this.token)}`;

    let opened = false;
    try {
      this.ws = new WebSocket(wsUrl);
    } catch (_) {
      this.startServerlessSyncLoop();
      return;
    }

    this.ws.onopen = () => {
      opened = true;
      this.connected = true;
      this.emit("GATEWAY_STATUS", { connected: true, pingMs: this.pingMs });
      if (this.token) {
        this.send("IDENTIFY", { token: this.token });
      }
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const packet = JSON.parse(event.data);
        if (packet.t === "PONG" && packet.d && packet.d.ts) {
          this.pingMs = Math.max(1, Date.now() - Number(packet.d.ts));
          this.emit("PING_UPDATE", { pingMs: this.pingMs });
          return;
        }
        this.emit(packet.t, packet.d);
      } catch (_) {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeat();
      // Se nunca conseguiu abrir WebSocket (ex: rodando na Vercel com domínio customizado), ativa o modo Serverless Sync automaticamente
      if (!opened && this.token) {
        this.serverlessMode = true;
        this.startServerlessSyncLoop();
        return;
      }
      this.emit("GATEWAY_STATUS", { connected: false, pingMs: this.pingMs });
      if (this.token) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {};
  }

  startServerlessSyncLoop() {
    this.stopServerlessSyncLoop();
    this.connected = true;
    this.emit("GATEWAY_STATUS", { connected: true, pingMs: this.pingMs });
    this.runSyncTick();
    this.syncTimer = setInterval(() => {
      this.runSyncTick();
    }, 950);
  }

  stopServerlessSyncLoop() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async runSyncTick() {
    if (!this.token) return;
    if (this.syncInFlight) {
      this.pendingImmediateSync = true;
      return;
    }
    this.syncInFlight = true;
    const batch = this.outbox.splice(0, this.outbox.length);
    const startTs = Date.now();

    try {
      const res = await this.request("/api/sync", {
        method: "POST",
        body: {
          lastSeq: this.lastSeq,
          outbox: batch
        }
      });

      this.pingMs = Math.max(5, Date.now() - startTs);
      this.connected = true;
      this.emit("PING_UPDATE", { pingMs: this.pingMs });

      if (typeof res.seq === "number" && res.seq > this.lastSeq) {
        this.lastSeq = res.seq;
      }

      if (Array.isArray(res.events)) {
        for (const evt of res.events) {
          this.emit(evt.t, evt.d);
        }
      }

      if (Array.isArray(res.signals)) {
        for (const sig of res.signals) {
          this.emit("WEBRTC_SIGNAL", sig);
        }
      }

      if (Array.isArray(res.voiceStates)) {
        this.emit("VOICE_STATE_UPDATE", {
          action: "sync",
          voiceStates: res.voiceStates
        });
      }

      if (Array.isArray(res.users)) {
        this.emit("PRESENCE_UPDATE", { users: res.users });
      }
    } catch (_) {
      // Se falhou temporariamente, recoloca ações críticas na fila
      if (batch.length > 0) {
        this.outbox.unshift(...batch);
      }
    } finally {
      this.syncInFlight = false;
      if (this.pendingImmediateSync && this.outbox.length > 0) {
        this.pendingImmediateSync = false;
        this.runSyncTick();
      }
    }
  }

  disconnect() {
    this.stopHeartbeat();
    this.stopServerlessSyncLoop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.token) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2500);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.send("PING", { ts: Date.now() });
    this.pingTimer = setInterval(() => {
      this.send("PING", { ts: Date.now() });
    }, 8000);
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  send(eventType, data = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: eventType, d: data }));
      return;
    }
    if (this.serverlessMode && eventType !== "PING") {
      this.outbox.push({ t: eventType, d: data });
      this.runSyncTick();
    }
  }

  on(eventType, callback) {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }
    this.listeners.get(eventType).add(callback);
    return () => {
      const set = this.listeners.get(eventType);
      if (set) set.delete(callback);
    };
  }

  emit(eventType, payload) {
    const set = this.listeners.get(eventType);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(payload);
      } catch (err) {
        console.error(`[Gateway] Erro no listener ${eventType}:`, err);
      }
    }
  }
}

window.concordGateway = new ConcordGateway();
