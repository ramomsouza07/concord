"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

function resolveDataDir() {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return path.join(os.tmpdir(), "concord-data");
  }
  const localDir = path.join(__dirname, "..", "data");
  try {
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const testFile = path.join(localDir, ".write-test");
    fs.writeFileSync(testFile, "ok");
    fs.unlinkSync(testFile);
    return localDir;
  } catch (_) {
    return path.join(os.tmpdir(), "concord-data");
  }
}

const DATA_DIR = resolveDataDir();
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_JSON_PATH = path.join(DATA_DIR, "concord.db.json");
const DB_SQLITE_PATH = path.join(DATA_DIR, "concord.sqlite");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 10000, 64, "sha512").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, originalHash] = storedHash.split(":");
  const hash = crypto.pbkdf2Sync(String(password), salt, 10000, 64, "sha512").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(originalHash, "hex"));
}

function generateId(prefix = "") {
  const id = crypto.randomBytes(8).toString("hex");
  return prefix ? `${prefix}_${id}` : id;
}

function createInitialState() {
  const now = new Date().toISOString();
  const systemUserId = "usr_concord_bot";
  const defaultServerId = "srv_qg_amigos";

  return {
    meta: {
      version: "1.0.0",
      createdAt: now,
      masterInviteCode: process.env.CONCORD_INVITE_CODE || "CONCORD-AMIGOS-2026",
      maxUploadBytes: 100 * 1024 * 1024,
      eventSeq: 1
    },
    invites: [
      {
        code: "CONCORD-AMIGOS-2026",
        serverId: defaultServerId,
        createdBy: systemUserId,
        createdAt: now,
        uses: 0,
        maxUses: 0
      }
    ],
    users: [
      {
        id: systemUserId,
        username: "concord",
        displayName: "Concord Aviador",
        discriminator: "0001",
        passwordHash: "",
        avatar: "/assets/logo-concord.png",
        bannerColor: "#5865F2",
        status: "online",
        customStatus: "Pronto para decolar a 1080p 60fps ✈️",
        bio: "Bot oficial do sistema Concord. Áudio cristalino, vídeo e compartilhamento de tela P2P sem limites.",
        isAdmin: true,
        isSystem: true,
        createdAt: now
      }
    ],
    sessions: {},
    servers: [
      {
        id: defaultServerId,
        name: "QG dos Amigos",
        icon: "/assets/logo-concord.png",
        ownerId: systemUserId,
        inviteCode: "QG-AMIGOS",
        createdAt: now,
        categories: [
          { id: "cat_texto", name: "CANAIS DE TEXTO", position: 0 },
          { id: "cat_voz", name: "CANAIS DE VOZ & TELA", position: 1 }
        ],
        channels: [
          {
            id: "chn_boas_vindas",
            serverId: defaultServerId,
            categoryId: "cat_texto",
            name: "boas-vindas",
            type: "text",
            topic: "Bem-vindos ao Concord! Nosso servidor privado de voz, vídeo e tela.",
            position: 0
          },
          {
            id: "chn_geral",
            serverId: defaultServerId,
            categoryId: "cat_texto",
            name: "geral",
            type: "text",
            topic: "Bate-papo geral da galera, avisos e resenha.",
            position: 1
          },
          {
            id: "chn_clips_memes",
            serverId: defaultServerId,
            categoryId: "cat_texto",
            name: "clips-e-memes",
            type: "text",
            topic: "Envie clipes, imagens e vídeos de até 100 MB (sem trava de Nitro!).",
            position: 2
          },
          {
            id: "chn_links_jogos",
            serverId: defaultServerId,
            categoryId: "cat_texto",
            name: "links-e-jogos",
            type: "text",
            topic: "Links de partidas, servidores dedicados e downloads.",
            position: 3
          },
          {
            id: "chn_voz_geral",
            serverId: defaultServerId,
            categoryId: "cat_voz",
            name: "Call Geral",
            type: "voice",
            topic: "Canal de voz e vídeo principal",
            bitrate: 128000,
            userLimit: 0,
            position: 0
          },
          {
            id: "chn_voz_ranked",
            serverId: defaultServerId,
            categoryId: "cat_voz",
            name: "Jogando Ranked",
            type: "voice",
            topic: "Call focada para gameplay com latência P2P ultrabaixa",
            bitrate: 128000,
            userLimit: 6,
            position: 1
          },
          {
            id: "chn_voz_cinema",
            serverId: defaultServerId,
            categoryId: "cat_voz",
            name: "Cinema / Tela 60fps",
            type: "voice",
            topic: "Múltiplas telas simultâneas em 1080p/1440p 60fps com áudio do sistema",
            bitrate: 256000,
            userLimit: 0,
            position: 2
          },
          {
            id: "chn_voz_afk",
            serverId: defaultServerId,
            categoryId: "cat_voz",
            name: "AFK / Mutado",
            type: "voice",
            topic: "Canal para quem foi buscar água",
            bitrate: 64000,
            userLimit: 0,
            position: 3
          }
        ],
        memberIds: [systemUserId]
      }
    ],
    friendships: [],
    dmChannels: [],
    messages: {
      chn_boas_vindas: [
        {
          id: "msg_welcome_1",
          channelId: "chn_boas_vindas",
          authorId: systemUserId,
          content:
            "👋 **Bem-vindos ao Concord!**\n\nEste é o nosso aplicativo privado de comunicação, construído sob medida com todas as funcionalidades essenciais do Discord e melhorias destravadas para o nosso grupo:\n\n" +
            "- 🖥️ **Compartilhamento de Tela Múltiplo (1080p / 1440p a 60 FPS):** Vários amigos podem transmitir a tela e a câmera ao mesmo tempo, com **Áudio do Sistema/Jogo** e alternância entre **Modo Grade** e **Modo Palco (Foco)**.\n" +
            "- 🔊 **Controle de Volume Individual (0% a 200%) + Pan Estéreo:** Clique em qualquer amigo na call para ajustar o ganho de áudio dele até 200%.\n" +
            "- ⌨️ **Atalhos Globais no Desktop:** `Ctrl+Shift+M` (Mutar Microfone), `Ctrl+Shift+D` (Desativar Áudio) e **Push-to-Talk** funcionando mesmo dentro do jogo.\n" +
            "- 📦 **Uploads de até 100 MB:** Envie vídeos, imagens, áudios e arquivos direto no chat (`Ctrl+V` ou arrastando).\n" +
            "- 🔑 **Código de Convite do Grupo:** `CONCORD-AMIGOS-2026`",
          attachments: [
            {
              id: "att_welcome_logo",
              name: "concord-banner.jpg",
              url: "/assets/splash-lockup.jpg",
              contentType: "image/jpeg",
              size: 778935
            }
          ],
          reactions: {
            "✈️": [systemUserId],
            "🔥": [systemUserId],
            "🎮": [systemUserId]
          },
          replyToId: null,
          pinned: true,
          editedAt: null,
          createdAt: now
        }
      ],
      chn_geral: [
        {
          id: "msg_geral_1",
          channelId: "chn_geral",
          authorId: systemUserId,
          content: "Canal **#geral** pronto! Entre em **🔊 Call Geral** ou **🍿 Cinema / Tela 60fps** na barra lateral para iniciar uma chamada de voz, vídeo ou transmitir sua tela.",
          attachments: [],
          reactions: { "👍": [systemUserId] },
          replyToId: null,
          pinned: false,
          editedAt: null,
          createdAt: now
        }
      ]
    },
    // Estruturas de sincronização em tempo real (compatível com Vercel Serverless e WebSockets)
    realtime: {
      voiceStates: {}, // userId -> state
      heartbeats: {}, // userId -> epochMs
      signalQueues: {}, // targetUserId -> Array<{ id, fromUserId, channelId, signalType, sdp, candidate, meta, ts }>
      events: [] // Array<{ seq, t, d, ts }>
    }
  };
}

class ConcordDatabase {
  constructor() {
    this.state = null;
    this.sqlite = null;
    this.load();
    this.initSqliteMirror();
  }

  load() {
    if (fs.existsSync(DB_JSON_PATH)) {
      try {
        const raw = fs.readFileSync(DB_JSON_PATH, "utf8");
        this.state = JSON.parse(raw);
        if (!this.state.realtime) {
          this.state.realtime = {
            voiceStates: {},
            heartbeats: {},
            signalQueues: {},
            events: []
          };
        }
        // Purga estados de voz, heartbeats e filas em tempo real de sessões anteriores
        this.state.realtime.voiceStates = {};
        this.state.realtime.heartbeats = {};
        this.state.realtime.signalQueues = {};
        this.state.realtime.events = [];
        if (!this.state.meta.eventSeq) {
          this.state.meta.eventSeq = 1;
        }

        // Remove canais duplicados criados por suítes de teste anteriores
        for (const srv of this.state.servers || []) {
          if (Array.isArray(srv.channels)) {
            const seen = new Set();
            srv.channels = srv.channels.filter((c) => {
              const key = `${c.type}:${c.name}`;
              if (seen.has(key) && c.name === "Transmissões 4K") {
                return false;
              }
              seen.add(key);
              return true;
            });
          }
        }
      } catch (err) {
        this.state = createInitialState();
        this.save();
      }
    } else {
      this.state = createInitialState();
      this.save();
    }
  }

  initSqliteMirror() {
    if (process.env.VERCEL) return;
    try {
      const sqliteModule = require("node:sqlite");
      if (sqliteModule && sqliteModule.DatabaseSync) {
        this.sqlite = new sqliteModule.DatabaseSync(DB_SQLITE_PATH);
        this.sqlite.exec(`
          CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `);
        this.syncToSqlite();
      }
    } catch (_) {
      this.sqlite = null;
    }
  }

  syncToSqlite() {
    if (!this.sqlite) return;
    try {
      const stmt = this.sqlite.prepare(
        "INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      );
      stmt.run("state", JSON.stringify(this.state), new Date().toISOString());
    } catch (_) {}
  }

  save() {
    try {
      fs.writeFileSync(DB_JSON_PATH, JSON.stringify(this.state, null, 2), "utf8");
      this.syncToSqlite();
    } catch (_) {
      try {
        const tmpPath = `${DB_JSON_PATH}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), "utf8");
        if (fs.existsSync(DB_JSON_PATH)) {
          try { fs.unlinkSync(DB_JSON_PATH); } catch (e) {}
        }
        fs.renameSync(tmpPath, DB_JSON_PATH);
        this.syncToSqlite();
      } catch (_) {}
    }
  }

  appendRealtimeEvent(type, data) {
    if (!this.state.realtime) {
      this.state.realtime = { voiceStates: {}, heartbeats: {}, signalQueues: {}, events: [] };
    }
    const seq = (this.state.meta.eventSeq || 1) + 1;
    this.state.meta.eventSeq = seq;
    const evt = { seq, t: type, d: data, ts: Date.now() };
    this.state.realtime.events.push(evt);
    if (this.state.realtime.events.length > 250) {
      this.state.realtime.events = this.state.realtime.events.slice(-250);
    }
    return evt;
  }

  enqueueSignal(targetUserId, signalPayload) {
    if (!this.state.realtime.signalQueues[targetUserId]) {
      this.state.realtime.signalQueues[targetUserId] = [];
    }
    this.state.realtime.signalQueues[targetUserId].push({
      ...signalPayload,
      ts: Date.now()
    });
    if (this.state.realtime.signalQueues[targetUserId].length > 100) {
      this.state.realtime.signalQueues[targetUserId] =
        this.state.realtime.signalQueues[targetUserId].slice(-100);
    }
  }

  drainSignals(userId) {
    const queue = this.state.realtime.signalQueues[userId] || [];
    if (queue.length > 0) {
      this.state.realtime.signalQueues[userId] = [];
    }
    return queue;
  }

  touchHeartbeat(userId) {
    this.state.realtime.heartbeats[userId] = Date.now();
    // Expira estados de voz de usuários que caíram há mais de 35 segundos sem heartbeat
    const cutoff = Date.now() - 35000;
    let changedVoice = false;
    for (const [uid, vs] of Object.entries(this.state.realtime.voiceStates)) {
      const lastSeen = this.state.realtime.heartbeats[uid] || 0;
      if (lastSeen > 0 && lastSeen < cutoff) {
        delete this.state.realtime.voiceStates[uid];
        changedVoice = true;
      }
    }
    if (changedVoice) {
      this.appendRealtimeEvent("VOICE_STATE_UPDATE", {
        action: "timeout",
        voiceStates: Object.values(this.state.realtime.voiceStates)
      });
    }
  }

  isUserRecentlyActive(userId) {
    if (userId === "usr_concord_bot") return true;
    const last = this.state.realtime && this.state.realtime.heartbeats[userId];
    if (!last) return false;
    return Date.now() - last < 30000;
  }

  sanitizeUser(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
  }

  findUserByUsername(username) {
    const normalized = String(username || "").trim().toLowerCase();
    return this.state.users.find((u) => u.username.toLowerCase() === normalized) || null;
  }

  findUserById(userId) {
    return this.state.users.find((u) => u.id === userId) || null;
  }

  validateInviteCode(code) {
    const clean = String(code || "").trim().toUpperCase();
    if (!clean) return null;
    if (clean === String(this.state.meta.masterInviteCode).toUpperCase()) {
      return { code: clean, serverId: "srv_qg_amigos", valid: true };
    }
    const found = this.state.invites.find((inv) => inv.code.toUpperCase() === clean);
    if (!found) return null;
    if (found.maxUses > 0 && found.uses >= found.maxUses) return null;
    return found;
  }

  registerUser({ username, displayName, password, inviteCode, avatar }) {
    const cleanUsername = String(username || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, "");

    if (cleanUsername.length < 2 || cleanUsername.length > 32) {
      throw new Error("O nome de usuário deve ter entre 2 e 32 caracteres (letras, números, _, . ou -).");
    }
    if (!password || String(password).length < 4) {
      throw new Error("A senha deve ter pelo menos 4 caracteres.");
    }

    const invite = this.validateInviteCode(inviteCode);
    if (!invite) {
      throw new Error("Código de convite inválido ou expirado. Peça o código ao administrador do grupo.");
    }

    if (this.findUserByUsername(cleanUsername)) {
      throw new Error("Este nome de usuário já está em uso.");
    }

    const realUsersCount = this.state.users.filter((u) => !u.isSystem).length;
    const isFirstHumanUser = realUsersCount === 0;
    const discrim = String(1000 + ((realUsersCount + 1) % 8999));

    const palette = ["#5865F2", "#57F287", "#FEE75C", "#EB459E", "#ED4245", "#00B0F4", "#9B59B6"];
    const bannerColor = palette[realUsersCount % palette.length];

    const newUser = {
      id: generateId("usr"),
      username: cleanUsername,
      displayName: String(displayName || username).trim() || cleanUsername,
      discriminator: discrim,
      passwordHash: hashPassword(password),
      avatar: avatar || "",
      bannerColor,
      status: "online",
      customStatus: "",
      bio: "Membro do Concord",
      isAdmin: isFirstHumanUser,
      isSystem: false,
      createdAt: new Date().toISOString()
    };

    this.state.users.push(newUser);
    this.touchHeartbeat(newUser.id);

    for (const srv of this.state.servers) {
      if (!srv.memberIds.includes(newUser.id)) {
        srv.memberIds.push(newUser.id);
      }
      if (isFirstHumanUser && srv.ownerId === "usr_concord_bot") {
        srv.ownerId = newUser.id;
      }
    }

    for (const existing of this.state.users) {
      if (!existing.isSystem && existing.id !== newUser.id) {
        const existsFriendship = this.state.friendships.some(
          (f) =>
            (f.userA === existing.id && f.userB === newUser.id) ||
            (f.userA === newUser.id && f.userB === existing.id)
        );
        if (!existsFriendship) {
          this.state.friendships.push({
            id: generateId("frd"),
            userA: existing.id,
            userB: newUser.id,
            status: "accepted",
            createdAt: new Date().toISOString()
          });
        }
      }
    }

    const storedInvite = this.state.invites.find((i) => i.code.toUpperCase() === String(inviteCode).trim().toUpperCase());
    if (storedInvite) storedInvite.uses = (storedInvite.uses || 0) + 1;

    const token = this.createSession(newUser.id);
    this.save();
    return { user: this.sanitizeUser(newUser), token };
  }

  loginUser({ username, password }) {
    const user = this.findUserByUsername(username);
    if (!user || user.isSystem) {
      throw new Error("Usuário não encontrado.");
    }
    if (!verifyPassword(password, user.passwordHash)) {
      throw new Error("Senha incorreta.");
    }
    this.touchHeartbeat(user.id);
    const token = this.createSession(user.id);
    this.save();
    return { user: this.sanitizeUser(user), token };
  }

  getSecretKey() {
    return (
      process.env.CONCORD_SECRET ||
      (this.state && this.state.meta && this.state.meta.createdAt) ||
      "concord-secret-amigos-2026"
    );
  }

  signToken(payload) {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const hmac = crypto.createHmac("sha256", this.getSecretKey());
    hmac.update(`${header}.${body}`);
    const signature = hmac.digest("base64url");
    return `${header}.${body}.${signature}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    try {
      const hmac = crypto.createHmac("sha256", this.getSecretKey());
      hmac.update(`${header}.${body}`);
      const expectedSig = hmac.digest("base64url");
      if (signature.length !== expectedSig.length) return null;
      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) return null;
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return payload;
    } catch (_) {
      return null;
    }
  }

  createSession(userId) {
    const user = this.findUserById(userId);
    let token;
    if (user) {
      token = this.signToken({
        id: user.id,
        u: user.username,
        d: user.displayName,
        disc: user.discriminator,
        col: user.bannerColor,
        adm: !!user.isAdmin,
        iat: Date.now()
      });
    } else {
      token = crypto.randomBytes(32).toString("hex");
    }
    if (!this.state.sessions) this.state.sessions = {};
    this.state.sessions[token] = {
      userId,
      createdAt: new Date().toISOString()
    };
    return token;
  }

  getUserByToken(token) {
    if (!token) return null;
    const clean = String(token).replace(/^Bearer\s+/i, "").trim();
    if (!clean) return null;

    // 1. Tenta recuperar sessão existente em memória
    const session = this.state.sessions && this.state.sessions[clean];
    if (session) {
      const u = this.findUserById(session.userId);
      if (u) return u;
    }

    // 2. Se a sessão não está em memória (ex: reinício do servidor ou Lambda Serverless Vercel), valida o token assinado
    const payload = this.verifyToken(clean);
    if (!payload || !payload.id) return null;

    // 3. Procura o usuário pelo ID
    let user = this.findUserById(payload.id);
    if (!user && payload.u) {
      // Re-hidrata o usuário na memória do container caso tenha sido criado em outro nó serverless
      user = {
        id: payload.id,
        username: payload.u,
        displayName: payload.d || payload.u,
        discriminator: payload.disc || "1000",
        passwordHash: "",
        avatar: "",
        bannerColor: payload.col || "#5865F2",
        status: "online",
        customStatus: "",
        bio: "Membro do Concord",
        isAdmin: !!payload.adm,
        isSystem: false,
        createdAt: new Date(payload.iat || Date.now()).toISOString()
      };
      this.state.users.push(user);
      for (const srv of this.state.servers) {
        if (!srv.memberIds.includes(user.id)) {
          srv.memberIds.push(user.id);
        }
      }
      this.save();
    }

    if (user) {
      if (!this.state.sessions) this.state.sessions = {};
      this.state.sessions[clean] = {
        userId: user.id,
        createdAt: new Date().toISOString()
      };
      return user;
    }

    return null;
  }

  updateUserProfile(userId, updates) {
    const user = this.findUserById(userId);
    if (!user) throw new Error("Usuário não encontrado.");
    if (typeof updates.displayName === "string" && updates.displayName.trim()) {
      user.displayName = updates.displayName.trim().slice(0, 40);
    }
    if (typeof updates.customStatus === "string") {
      user.customStatus = updates.customStatus.trim().slice(0, 80);
    }
    if (typeof updates.bio === "string") {
      user.bio = updates.bio.trim().slice(0, 240);
    }
    if (typeof updates.status === "string" && ["online", "idle", "dnd", "offline"].includes(updates.status)) {
      user.status = updates.status;
    }
    if (typeof updates.avatar === "string") {
      user.avatar = updates.avatar;
    }
    if (typeof updates.bannerColor === "string") {
      user.bannerColor = updates.bannerColor;
    }
    this.save();
    return this.sanitizeUser(user);
  }

  createServer(ownerId, { name, icon }) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Informe o nome do servidor.");
    const serverId = generateId("srv");
    const inviteCode = cleanName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6) + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();

    const allHumanIds = this.state.users.filter((u) => !u.isSystem).map((u) => u.id);
    const memberIds = Array.from(new Set(["usr_concord_bot", ownerId, ...allHumanIds]));

    const server = {
      id: serverId,
      name: cleanName,
      icon: icon || "",
      ownerId,
      inviteCode,
      createdAt: new Date().toISOString(),
      categories: [
        { id: generateId("cat"), name: "CANAIS DE TEXTO", position: 0 },
        { id: generateId("cat"), name: "CANAIS DE VOZ", position: 1 }
      ],
      channels: [],
      memberIds
    };

    const textChannelId = generateId("chn");
    const voiceChannelId = generateId("chn");
    server.channels.push(
      {
        id: textChannelId,
        serverId,
        categoryId: server.categories[0].id,
        name: "geral",
        type: "text",
        topic: `Canal principal de ${cleanName}`,
        position: 0
      },
      {
        id: voiceChannelId,
        serverId,
        categoryId: server.categories[1].id,
        name: "Call Geral",
        type: "voice",
        topic: "Canal de voz, vídeo e compartilhamento de tela",
        bitrate: 128000,
        userLimit: 0,
        position: 0
      }
    );

    this.state.servers.push(server);
    this.state.invites.push({
      code: inviteCode,
      serverId,
      createdBy: ownerId,
      createdAt: new Date().toISOString(),
      uses: 0,
      maxUses: 0
    });
    this.state.messages[textChannelId] = [];
    this.appendRealtimeEvent("SERVER_CREATE", { server });
    this.save();
    return server;
  }

  createChannel(userId, serverId, { name, type, categoryId, topic }) {
    const server = this.state.servers.find((s) => s.id === serverId);
    if (!server) throw new Error("Servidor não encontrado.");
    const chType = type === "voice" ? "voice" : "text";
    const cleanName =
      chType === "text"
        ? String(name || "novo-canal")
            .trim()
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/[^a-z0-9-_]/g, "")
        : String(name || "Nova Call").trim();

    const defaultCat =
      categoryId ||
      (chType === "voice"
        ? (server.categories[1] && server.categories[1].id) || server.categories[0].id
        : server.categories[0].id);

    const channel = {
      id: generateId("chn"),
      serverId,
      categoryId: defaultCat,
      name: cleanName || (chType === "voice" ? "Nova Call" : "novo-canal"),
      type: chType,
      topic: String(topic || "").trim(),
      bitrate: chType === "voice" ? 128000 : undefined,
      userLimit: 0,
      position: server.channels.filter((c) => c.type === chType).length
    };

    server.channels.push(channel);
    if (chType === "text") {
      this.state.messages[channel.id] = [];
    }
    this.appendRealtimeEvent("CHANNEL_CREATE", { serverId, channel });
    this.save();
    return channel;
  }

  getOrCreateDmChannel(userA, userB) {
    let dm = this.state.dmChannels.find(
      (c) =>
        (c.participantIds[0] === userA && c.participantIds[1] === userB) ||
        (c.participantIds[0] === userB && c.participantIds[1] === userA)
    );
    if (!dm) {
      dm = {
        id: generateId("dm"),
        type: "dm",
        participantIds: [userA, userB],
        createdAt: new Date().toISOString(),
        lastMessageAt: new Date().toISOString()
      };
      this.state.dmChannels.push(dm);
      this.state.messages[dm.id] = [];
      this.appendRealtimeEvent("DM_OPEN", { dm });
      this.save();
    }
    return dm;
  }

  getMessages(channelId, limit = 100) {
    const list = this.state.messages[channelId] || [];
    return list.slice(-limit);
  }

  createMessage(authorId, channelId, { content, attachments = [], replyToId = null }) {
    const cleanContent = String(content || "").trim();
    if (!cleanContent && (!attachments || attachments.length === 0)) {
      throw new Error("A mensagem não pode estar vazia.");
    }
    if (!this.state.messages[channelId]) {
      this.state.messages[channelId] = [];
    }
    const msg = {
      id: generateId("msg"),
      channelId,
      authorId,
      content: cleanContent,
      attachments: Array.isArray(attachments) ? attachments : [],
      reactions: {},
      replyToId: replyToId || null,
      pinned: false,
      editedAt: null,
      createdAt: new Date().toISOString()
    };
    this.state.messages[channelId].push(msg);

    const dm = this.state.dmChannels.find((d) => d.id === channelId);
    if (dm) dm.lastMessageAt = msg.createdAt;

    this.appendRealtimeEvent("MESSAGE_CREATE", { channelId, message: msg });
    this.save();
    return msg;
  }

  updateMessage(userId, channelId, messageId, { content }) {
    const list = this.state.messages[channelId] || [];
    const msg = list.find((m) => m.id === messageId);
    if (!msg) throw new Error("Mensagem não encontrada.");
    const user = this.findUserById(userId);
    if (msg.authorId !== userId && (!user || !user.isAdmin)) {
      throw new Error("Sem permissão para editar esta mensagem.");
    }
    msg.content = String(content || "").trim();
    msg.editedAt = new Date().toISOString();
    this.appendRealtimeEvent("MESSAGE_UPDATE", { channelId, message: msg });
    this.save();
    return msg;
  }

  deleteMessage(userId, channelId, messageId) {
    const list = this.state.messages[channelId] || [];
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx === -1) throw new Error("Mensagem não encontrada.");
    const msg = list[idx];
    const user = this.findUserById(userId);
    if (msg.authorId !== userId && (!user || !user.isAdmin)) {
      throw new Error("Sem permissão para excluir esta mensagem.");
    }
    list.splice(idx, 1);
    const payload = { id: messageId, channelId };
    this.appendRealtimeEvent("MESSAGE_DELETE", payload);
    this.save();
    return payload;
  }

  toggleReaction(userId, channelId, messageId, emoji) {
    const list = this.state.messages[channelId] || [];
    const msg = list.find((m) => m.id === messageId);
    if (!msg) throw new Error("Mensagem não encontrada.");
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(userId);
    if (idx === -1) {
      msg.reactions[emoji].push(userId);
    } else {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) {
        delete msg.reactions[emoji];
      }
    }
    this.appendRealtimeEvent("MESSAGE_UPDATE", { channelId, message: msg });
    this.save();
    return msg;
  }

  togglePin(userId, channelId, messageId) {
    const list = this.state.messages[channelId] || [];
    const msg = list.find((m) => m.id === messageId);
    if (!msg) throw new Error("Mensagem não encontrada.");
    msg.pinned = !msg.pinned;
    this.appendRealtimeEvent("MESSAGE_UPDATE", { channelId, message: msg });
    this.save();
    return msg;
  }

  sendFriendRequest(fromUserId, targetUsername) {
    const target = this.findUserByUsername(targetUsername);
    if (!target || target.isSystem) {
      throw new Error("Usuário não encontrado.");
    }
    if (target.id === fromUserId) {
      throw new Error("Você não pode adicionar a si mesmo.");
    }
    let rel = this.state.friendships.find(
      (f) =>
        (f.userA === fromUserId && f.userB === target.id) ||
        (f.userA === target.id && f.userB === fromUserId)
    );
    if (rel) {
      rel.status = "accepted";
    } else {
      rel = {
        id: generateId("frd"),
        userA: fromUserId,
        userB: target.id,
        status: "accepted",
        createdAt: new Date().toISOString()
      };
      this.state.friendships.push(rel);
    }
    this.save();
    return rel;
  }
}

module.exports = {
  ConcordDatabase,
  DATA_DIR,
  UPLOADS_DIR,
  DB_JSON_PATH,
  generateId,
  hashPassword,
  verifyPassword
};
