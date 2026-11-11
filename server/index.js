"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ConcordDatabase, UPLOADS_DIR, generateId } = require("./db");

const PORT = Number(process.env.PORT || 3456);
const HOST = process.env.HOST || "0.0.0.0";
// Resolve a raiz do projeto tanto localmente quanto na Vercel (/var/task)
const ROOT_DIR = [path.join(__dirname, ".."), process.cwd()].find((dir) =>
  fs.existsSync(path.join(dir, "logo-concord.png"))
) || path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

const db = new ConcordDatabase();

// Estado em memória de conexões WebSocket (quando em servidor contínuo)
const clients = new Set();
const voiceStates = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8"
};

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-File-Name, X-File-Type"
  );
}

function sendJson(res, status, payload) {
  setCorsHeaders(res);
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 15 * 1024 * 1024) {
  if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Payload excede o tamanho máximo permitido."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(new Error("JSON inválido no corpo da requisição."));
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req, maxBytes = 105 * 1024 * 1024) {
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body);
  }
  if (typeof req.body === "string") {
    return Promise.resolve(Buffer.from(req.body, "utf8"));
  }
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(Buffer.from(JSON.stringify(req.body), "utf8"));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Arquivo excede o limite de 100 MB."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getAuthenticatedUser(req) {
  const authHeader = req.headers["authorization"];
  return db.getUserByToken(authHeader);
}

function isUserOnline(userId) {
  if (userId === "usr_concord_bot") return true;
  for (const c of clients) {
    if (c.userId === userId) return true;
  }
  return db.isUserRecentlyActive(userId);
}

function getCombinedVoiceStates() {
  const combined = new Map();
  if (db.state.realtime && db.state.realtime.voiceStates) {
    for (const [uid, vs] of Object.entries(db.state.realtime.voiceStates)) {
      combined.set(uid, vs);
    }
  }
  for (const [uid, vs] of voiceStates.entries()) {
    combined.set(uid, vs);
  }
  return Array.from(combined.values());
}

function getPublicUsers() {
  return db.state.users.map((u) => {
    const safe = db.sanitizeUser(u);
    const connected = isUserOnline(u.id);
    return {
      ...safe,
      online: connected,
      effectiveStatus: connected ? safe.status || "online" : "offline"
    };
  });
}

function buildBootstrapPayload(user) {
  db.touchHeartbeat(user.id);
  return {
    me: db.sanitizeUser(user),
    serverInfo: {
      name: "Concord Private Server",
      version: db.state.meta.version,
      maxUploadBytes: db.state.meta.maxUploadBytes,
      inviteCode: db.state.meta.masterInviteCode,
      eventSeq: db.state.meta.eventSeq || 1,
      serverless: !!process.env.VERCEL
    },
    users: getPublicUsers(),
    servers: db.state.servers,
    dmChannels: db.state.dmChannels.filter((dm) => dm.participantIds.includes(user.id)),
    friendships: db.state.friendships.filter(
      (f) => f.userA === user.id || f.userB === user.id
    ),
    voiceStates: getCombinedVoiceStates(),
    invites: db.state.invites
  };
}

// ============================================================================
// Implementação Nativa RFC 6455 WebSocket + Sync Híbrido (Vercel Serverless)
// ============================================================================

function encodeWsFrame(dataStr, opcode = 0x01) {
  const payload = Buffer.from(dataStr, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsSend(client, eventType, data) {
  if (!client || !client.socket || client.socket.destroyed) return;
  try {
    const frame = encodeWsFrame(JSON.stringify({ t: eventType, d: data, ts: Date.now() }));
    client.socket.write(frame);
  } catch (_) {}
}

function wsBroadcast(eventType, data, excludeClient = null) {
  const frame = encodeWsFrame(JSON.stringify({ t: eventType, d: data, ts: Date.now() }));
  for (const client of clients) {
    if (client === excludeClient) continue;
    if (client.socket && !client.socket.destroyed) {
      try {
        client.socket.write(frame);
      } catch (_) {}
    }
  }
}

function wsSendToUser(targetUserId, eventType, data, excludeClient = null) {
  const frame = encodeWsFrame(JSON.stringify({ t: eventType, d: data, ts: Date.now() }));
  for (const client of clients) {
    if (client === excludeClient) continue;
    if (client.userId === targetUserId && client.socket && !client.socket.destroyed) {
      try {
        client.socket.write(frame);
      } catch (_) {}
    }
  }
}

function processRealtimeClientAction(userId, t, d, excludeWsClient = null) {
  if (!userId || !t) return;

  if (t === "TYPING_START") {
    const user = db.findUserById(userId);
    if (user && d && d.channelId) {
      const payload = {
        channelId: d.channelId,
        userId: user.id,
        displayName: user.displayName
      };
      db.appendRealtimeEvent("TYPING_START", payload);
      wsBroadcast("TYPING_START", payload, excludeWsClient);
    }
    return;
  }

  if (t === "VOICE_JOIN") {
    const { serverId, channelId, muted, deafened, video } = d || {};
    if (!channelId) return;
    const prev =
      voiceStates.get(userId) ||
      (db.state.realtime && db.state.realtime.voiceStates[userId]);
    const state = {
      userId,
      serverId: serverId || "srv_qg_amigos",
      channelId,
      muted: !!muted,
      deafened: !!deafened,
      video: !!video,
      screenShare: false,
      screenAudio: false,
      screenQuality: "1080p60",
      speaking: false,
      joinedAt: (prev && prev.channelId === channelId && prev.joinedAt) || new Date().toISOString()
    };
    voiceStates.set(userId, state);
    db.state.realtime.voiceStates[userId] = state;
    const updatePayload = {
      action: "join",
      userId,
      state,
      voiceStates: getCombinedVoiceStates()
    };
    db.appendRealtimeEvent("VOICE_STATE_UPDATE", updatePayload);
    db.save();
    wsBroadcast("VOICE_STATE_UPDATE", updatePayload);
    return;
  }

  if (t === "VOICE_LEAVE") {
    const prev =
      voiceStates.get(userId) ||
      (db.state.realtime && db.state.realtime.voiceStates[userId]);
    voiceStates.delete(userId);
    if (db.state.realtime && db.state.realtime.voiceStates) {
      delete db.state.realtime.voiceStates[userId];
    }
    const updatePayload = {
      action: "leave",
      userId,
      previousChannelId: prev ? prev.channelId : null,
      voiceStates: getCombinedVoiceStates()
    };
    db.appendRealtimeEvent("VOICE_STATE_UPDATE", updatePayload);
    db.save();
    wsBroadcast("VOICE_STATE_UPDATE", updatePayload);
    return;
  }

  if (t === "VOICE_UPDATE") {
    const current =
      voiceStates.get(userId) ||
      (db.state.realtime && db.state.realtime.voiceStates[userId]);
    if (!current || !d) return;
    if (typeof d.muted === "boolean") current.muted = d.muted;
    if (typeof d.deafened === "boolean") current.deafened = d.deafened;
    if (typeof d.video === "boolean") current.video = d.video;
    if (typeof d.screenShare === "boolean") current.screenShare = d.screenShare;
    if (typeof d.screenAudio === "boolean") current.screenAudio = d.screenAudio;
    if (typeof d.screenQuality === "string") current.screenQuality = d.screenQuality;
    if (typeof d.speaking === "boolean") current.speaking = d.speaking;

    voiceStates.set(userId, current);
    db.state.realtime.voiceStates[userId] = current;
    const updatePayload = {
      action: "update",
      userId,
      state: current,
      voiceStates: getCombinedVoiceStates()
    };
    db.appendRealtimeEvent("VOICE_STATE_UPDATE", updatePayload);
    db.save();
    wsBroadcast("VOICE_STATE_UPDATE", updatePayload);
    return;
  }

  if (t === "WEBRTC_SIGNAL") {
    const { targetUserId, channelId, signalType, sdp, candidate, meta } = d || {};
    if (!targetUserId) return;
    const sig = {
      fromUserId: userId,
      channelId,
      signalType,
      sdp,
      candidate,
      meta
    };
    db.enqueueSignal(targetUserId, sig);
    db.save();
    wsSendToUser(targetUserId, "WEBRTC_SIGNAL", sig);
  }
}

function handleWsMessage(client, rawText) {
  let msg;
  try {
    msg = JSON.parse(rawText);
  } catch (_) {
    return;
  }

  const { op, t, d } = msg;

  if (op === "PING" || t === "PING") {
    if (client.userId) db.touchHeartbeat(client.userId);
    wsSend(client, "PONG", { ts: (d && d.ts) || Date.now() });
    return;
  }

  if (t === "IDENTIFY") {
    const user = db.getUserByToken(d && d.token);
    if (!user) {
      wsSend(client, "AUTH_ERROR", { message: "Token de sessão inválido." });
      return;
    }
    client.userId = user.id;
    db.touchHeartbeat(user.id);
    wsSend(client, "READY", buildBootstrapPayload(user));
    wsBroadcast("PRESENCE_UPDATE", { users: getPublicUsers() });
    return;
  }

  if (!client.userId) return;
  db.touchHeartbeat(client.userId);
  processRealtimeClientAction(client.userId, t, d, client);
}

function handleWebSocketUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "binary")
    .digest("base64");

  const headers = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey}`,
    "\r\n"
  ];
  socket.write(headers.join("\r\n"));

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const token = urlObj.searchParams.get("token");
  const initialUser = token ? db.getUserByToken(token) : null;

  const client = {
    id: generateId("ws"),
    socket,
    userId: initialUser ? initialUser.id : null,
    alive: true
  };
  clients.add(client);

  if (initialUser) {
    db.touchHeartbeat(initialUser.id);
    wsSend(client, "READY", buildBootstrapPayload(initialUser));
    wsBroadcast("PRESENCE_UPDATE", { users: getPublicUsers() });
  }

  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) return;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) return;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLength = isMasked ? 4 : 0;
      const totalFrameLength = offset + maskLength + payloadLength;
      if (buffer.length < totalFrameLength) return;

      let payload = buffer.subarray(offset + maskLength, totalFrameLength);
      if (isMasked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      buffer = buffer.subarray(totalFrameLength);

      if (opcode === 0x08) {
        socket.end();
        return;
      } else if (opcode === 0x09) {
        socket.write(encodeWsFrame(payload.toString("utf8"), 0x0a));
      } else if (opcode === 0x01) {
        handleWsMessage(client, payload.toString("utf8"));
      }
    }
  });

  const cleanup = () => {
    if (!clients.has(client)) return;
    clients.delete(client);
    if (client.userId) {
      const stillConnected = Array.from(clients).some((c) => c.userId === client.userId);
      if (!stillConnected) {
        if (voiceStates.has(client.userId)) {
          const prev = voiceStates.get(client.userId);
          voiceStates.delete(client.userId);
          if (db.state.realtime && db.state.realtime.voiceStates) {
            delete db.state.realtime.voiceStates[client.userId];
          }
          wsBroadcast("VOICE_STATE_UPDATE", {
            action: "leave",
            userId: client.userId,
            previousChannelId: prev.channelId,
            voiceStates: getCombinedVoiceStates()
          });
        }
        wsBroadcast("PRESENCE_UPDATE", { users: getPublicUsers() });
      }
    }
  };

  socket.on("close", cleanup);
  socket.on("end", cleanup);
  socket.on("error", cleanup);
}

// ============================================================================
// Servidor de Arquivos Estáticos e Uploads com Suporte a Range
// ============================================================================

function serveFileWithRange(req, res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Arquivo não encontrado." });
    return;
  }

  setCorsHeaders(res);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// ============================================================================
// Request Handler Principal (Compatível com Node HTTP Server e Vercel Serverless)
// ============================================================================

async function requestHandler(req, res) {
  try {
    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(urlObj.pathname);

    if (req.method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        name: "Concord Server",
        version: db.state.meta.version,
        serverless: !!process.env.VERCEL,
        usersCount: db.state.users.filter((u) => !u.isSystem).length,
        onlineCount: getPublicUsers().filter((u) => !u.isSystem && u.online).length
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/register") {
      const body = await readJsonBody(req);
      const result = db.registerUser(body);
      wsBroadcast("PRESENCE_UPDATE", { users: getPublicUsers() });
      sendJson(res, 201, result);
      return;
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await readJsonBody(req);
      const result = db.loginUser(body);
      wsBroadcast("PRESENCE_UPDATE", { users: getPublicUsers() });
      sendJson(res, 200, result);
      return;
    }

    if (pathname.startsWith("/api/")) {
      const user = getAuthenticatedUser(req);
      if (!user) {
        sendJson(res, 401, { error: "Sessão expirada ou não autenticada." });
        return;
      }

      db.touchHeartbeat(user.id);

      if (req.method === "GET" && pathname === "/api/bootstrap") {
        sendJson(res, 200, buildBootstrapPayload(user));
        return;
      }

      // Endpoint de Sincronização em Tempo Real para Vercel Serverless (Substitui/Complementa WebSocket)
      if (req.method === "POST" && pathname === "/api/sync") {
        const body = await readJsonBody(req);
        const lastSeq = Number(body.lastSeq || 0);
        const outbox = Array.isArray(body.outbox) ? body.outbox : [];

        for (const item of outbox) {
          if (item && item.t) {
            processRealtimeClientAction(user.id, item.t, item.d || {});
          }
        }

        const allEvents = (db.state.realtime && db.state.realtime.events) || [];
        const newEvents = lastSeq > 0 ? allEvents.filter((e) => e.seq > lastSeq) : [];
        const signals = db.drainSignals(user.id);
        if (signals.length > 0 || outbox.length > 0) {
          db.save();
        }

        sendJson(res, 200, {
          seq: db.state.meta.eventSeq || 1,
          events: newEvents,
          signals,
          voiceStates: getCombinedVoiceStates(),
          users: getPublicUsers(),
          ts: Date.now()
        });
        return;
      }

      if (req.method === "PATCH" && pathname === "/api/users/me") {
        const body = await readJsonBody(req);
        const updated = db.updateUserProfile(user.id, body);
        wsBroadcast("PRESENCE_UPDATE", { users: getPublicUsers() });
        sendJson(res, 200, { user: updated });
        return;
      }

      if (req.method === "POST" && pathname === "/api/servers") {
        const body = await readJsonBody(req);
        const srv = db.createServer(user.id, body);
        wsBroadcast("SERVER_CREATE", { server: srv });
        sendJson(res, 201, { server: srv });
        return;
      }

      if (req.method === "POST" && pathname === "/api/servers/join") {
        const body = await readJsonBody(req);
        const code = String(body.inviteCode || "").trim().toUpperCase();
        const srv = db.state.servers.find(
          (s) => s.inviteCode.toUpperCase() === code || code === db.state.meta.masterInviteCode.toUpperCase()
        );
        if (!srv) {
          sendJson(res, 404, { error: "Código de convite de servidor não encontrado." });
          return;
        }
        if (!srv.memberIds.includes(user.id)) {
          srv.memberIds.push(user.id);
          db.appendRealtimeEvent("SERVER_UPDATE", { server: srv });
          db.save();
        }
        wsBroadcast("SERVER_UPDATE", { server: srv });
        sendJson(res, 200, { server: srv });
        return;
      }

      const createChannelMatch = pathname.match(/^\/api\/servers\/([^/]+)\/channels$/);
      if (req.method === "POST" && createChannelMatch) {
        const serverId = createChannelMatch[1];
        const body = await readJsonBody(req);
        const channel = db.createChannel(user.id, serverId, body);
        wsBroadcast("CHANNEL_CREATE", { serverId, channel });
        sendJson(res, 201, { channel });
        return;
      }

      const channelMsgsMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages$/);
      if (channelMsgsMatch) {
        const channelId = channelMsgsMatch[1];
        if (req.method === "GET") {
          const messages = db.getMessages(channelId, 150);
          sendJson(res, 200, { messages });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          const message = db.createMessage(user.id, channelId, body);
          wsBroadcast("MESSAGE_CREATE", { channelId, message });
          sendJson(res, 201, { message });
          return;
        }
      }

      const singleMsgMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)$/);
      if (singleMsgMatch) {
        const [, channelId, messageId] = singleMsgMatch;
        if (req.method === "PATCH") {
          const body = await readJsonBody(req);
          const message = db.updateMessage(user.id, channelId, messageId, body);
          wsBroadcast("MESSAGE_UPDATE", { channelId, message });
          sendJson(res, 200, { message });
          return;
        }
        if (req.method === "DELETE") {
          const result = db.deleteMessage(user.id, channelId, messageId);
          wsBroadcast("MESSAGE_DELETE", result);
          sendJson(res, 200, result);
          return;
        }
      }

      const reactionMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)\/reactions$/);
      if (req.method === "POST" && reactionMatch) {
        const [, channelId, messageId] = reactionMatch;
        const body = await readJsonBody(req);
        const message = db.toggleReaction(user.id, channelId, messageId, body.emoji || "👍");
        wsBroadcast("MESSAGE_UPDATE", { channelId, message });
        sendJson(res, 200, { message });
        return;
      }

      const pinMatch = pathname.match(/^\/api\/channels\/([^/]+)\/messages\/([^/]+)\/pin$/);
      if (req.method === "POST" && pinMatch) {
        const [, channelId, messageId] = pinMatch;
        const message = db.togglePin(user.id, channelId, messageId);
        wsBroadcast("MESSAGE_UPDATE", { channelId, message });
        sendJson(res, 200, { message });
        return;
      }

      if (req.method === "POST" && pathname === "/api/friends/request") {
        const body = await readJsonBody(req);
        const friendship = db.sendFriendRequest(user.id, body.username);
        wsBroadcast("FRIEND_UPDATE", { friendship, users: getPublicUsers() });
        sendJson(res, 200, { friendship });
        return;
      }

      if (req.method === "POST" && pathname === "/api/dms/open") {
        const body = await readJsonBody(req);
        const dm = db.getOrCreateDmChannel(user.id, body.targetUserId);
        wsSendToUser(user.id, "DM_OPEN", { dm });
        wsSendToUser(body.targetUserId, "DM_OPEN", { dm });
        sendJson(res, 200, { dm });
        return;
      }

      if (req.method === "POST" && pathname === "/api/upload") {
        const contentTypeHeader = req.headers["content-type"] || "";
        let fileBuffer;
        let originalName;
        let fileMime;

        if (contentTypeHeader.includes("application/json")) {
          const body = await readJsonBody(req, 140 * 1024 * 1024);
          originalName = body.name || "arquivo.bin";
          fileMime = body.contentType || "application/octet-stream";
          const base64Data = String(body.data || "").replace(/^data:[^;]+;base64,/, "");
          fileBuffer = Buffer.from(base64Data, "base64");
        } else {
          originalName = decodeURIComponent(req.headers["x-file-name"] || "arquivo.bin");
          fileMime = req.headers["x-file-type"] || contentTypeHeader || "application/octet-stream";
          fileBuffer = await readRawBody(req, 105 * 1024 * 1024);
        }

        const safeExt = path.extname(originalName).replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
        const baseSlug = path
          .basename(originalName, path.extname(originalName))
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 40);
        const storedFileName = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${baseSlug}${safeExt}`;
        const destPath = path.join(UPLOADS_DIR, storedFileName);
        fs.writeFileSync(destPath, fileBuffer);

        // Na Vercel Serverless, arquivos até 2 MB também podem usar data URL inline para não expirar entre lambdas
        let url = `/uploads/${storedFileName}`;
        if (process.env.VERCEL && fileBuffer.length <= 2 * 1024 * 1024) {
          url = `data:${fileMime};base64,${fileBuffer.toString("base64")}`;
        }

        const attachment = {
          id: generateId("att"),
          name: originalName,
          url,
          contentType: fileMime,
          size: fileBuffer.length
        };
        sendJson(res, 201, { attachment });
        return;
      }

      sendJson(res, 404, { error: "Endpoint da API não encontrado." });
      return;
    }

    // Logos e Imagens oficiais do Concord
    if (pathname === "/assets/concord.png" || pathname === "/concord.png") {
      serveFileWithRange(req, res, path.join(ROOT_DIR, "concord.png"));
      return;
    }
    if (pathname === "/assets/logo-concord.png" || pathname === "/logo-concord.png" || pathname === "/favicon.ico") {
      serveFileWithRange(req, res, path.join(ROOT_DIR, "logo-concord.png"));
      return;
    }
    if (
      pathname === "/assets/splash-lockup.jpg" ||
      pathname === "/Gemini_Generated_Image_nh6wb4nh6wb4nh6w.jpg"
    ) {
      serveFileWithRange(req, res, path.join(ROOT_DIR, "Gemini_Generated_Image_nh6wb4nh6wb4nh6w.jpg"));
      return;
    }

    if (pathname.startsWith("/uploads/")) {
      const fileName = path.basename(pathname);
      serveFileWithRange(req, res, path.join(UPLOADS_DIR, fileName));
      return;
    }

    let staticPath = pathname === "/" ? "/index.html" : pathname;
    const resolvedPath = path.normalize(path.join(PUBLIC_DIR, staticPath));
    if (resolvedPath.startsWith(PUBLIC_DIR) && fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
      serveFileWithRange(req, res, resolvedPath);
      return;
    }

    serveFileWithRange(req, res, path.join(PUBLIC_DIR, "index.html"));
  } catch (err) {
    sendJson(res, 400, { error: err.message || "Erro interno no servidor Concord." });
  }
}

const server = http.createServer(requestHandler);

server.on("upgrade", (req, socket) => {
  if (req.url && req.url.startsWith("/ws")) {
    handleWebSocketUpgrade(req, socket);
  } else {
    socket.destroy();
  }
});

function getLocalIpAddresses() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push({ interface: name, address: net.address });
      }
    }
  }
  return ips;
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const ips = getLocalIpAddresses();
    console.log("==============================================================");
    console.log("  ✈️  CONCORD SERVER INICIADO COM SUCESSO!");
    console.log("==============================================================");
    console.log(`  Local:             http://localhost:${PORT}`);
    for (const ip of ips) {
      console.log(`  Rede (${ip.interface}):   http://${ip.address}:${PORT}`);
    }
    console.log(`  Código de Convite: ${db.state.meta.masterInviteCode}`);
    console.log("==============================================================");
  });
}

module.exports = { server, db, PORT, requestHandler };
