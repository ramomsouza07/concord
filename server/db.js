"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { ConcordSupabase, TABLES, encodeValue, inList } = require("./supabase");
const { ConcordPrisma } = require("./prisma");

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const k = trimmed.slice(0, eqIdx).trim();
          const v = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
          if (!process.env[k]) {
            process.env[k] = v;
          }
        }
      }
    } catch (_) {}
  }
}
loadEnv();

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

// ---------------------------------------------------------------------------
// Conversores de modelo: JavaScript (camelCase) <-> Supabase SQL (snake_case)
// ---------------------------------------------------------------------------

function userToDb(u) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.displayName || u.username,
    discriminator: u.discriminator || "0000",
    password_hash: u.passwordHash || "",
    avatar: u.avatar || "",
    banner_color: u.bannerColor || "#5865F2",
    status: u.status || "online",
    custom_status: u.customStatus || "",
    bio: u.bio || "",
    is_admin: !!u.isAdmin,
    is_system: !!u.isSystem,
    created_at: u.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function dbToUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name || row.username,
    discriminator: row.discriminator || "0000",
    passwordHash: row.password_hash || "",
    avatar: row.avatar || "",
    bannerColor: row.banner_color || "#5865F2",
    status: row.status || "online",
    customStatus: row.custom_status || "",
    bio: row.bio || "",
    isAdmin: !!row.is_admin,
    isSystem: !!row.is_system,
    createdAt: row.created_at || new Date().toISOString()
  };
}

function serverToDb(s) {
  return {
    id: s.id,
    name: s.name,
    icon: s.icon || "",
    owner_id: s.ownerId || null,
    invite_code: s.inviteCode || null,
    categories: s.categories || [],
    created_at: s.createdAt || new Date().toISOString()
  };
}

function dbToServer(row, allChannels = [], allMembers = []) {
  const channels = allChannels.filter((c) => c.serverId === row.id);
  const memberIds = allMembers
    .filter((m) => m.server_id === row.id)
    .map((m) => m.user_id);
  return {
    id: row.id,
    name: row.name,
    icon: row.icon || "",
    ownerId: row.owner_id || "",
    inviteCode: row.invite_code || "",
    createdAt: row.created_at || new Date().toISOString(),
    categories: Array.isArray(row.categories) ? row.categories : [],
    channels,
    memberIds: Array.from(new Set(memberIds))
  };
}

function channelToDb(c) {
  return {
    id: c.id,
    server_id: c.serverId,
    category_id: c.categoryId || null,
    name: c.name,
    type: c.type === "voice" ? "voice" : "text",
    topic: c.topic || "",
    bitrate: typeof c.bitrate === "number" ? c.bitrate : (c.type === "voice" ? 128000 : null),
    user_limit: typeof c.userLimit === "number" ? c.userLimit : 0,
    position: typeof c.position === "number" ? c.position : 0,
    created_at: c.createdAt || new Date().toISOString()
  };
}

function dbToChannel(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    categoryId: row.category_id || "",
    name: row.name,
    type: row.type === "voice" ? "voice" : "text",
    topic: row.topic || "",
    bitrate: typeof row.bitrate === "number" ? row.bitrate : (row.type === "voice" ? 128000 : undefined),
    userLimit: row.user_limit || 0,
    position: row.position || 0,
    createdAt: row.created_at || new Date().toISOString()
  };
}

function inviteToDb(inv) {
  return {
    code: inv.code,
    server_id: inv.serverId || null,
    created_by: inv.createdBy || null,
    uses: inv.uses || 0,
    max_uses: inv.maxUses || 0,
    created_at: inv.createdAt || new Date().toISOString()
  };
}

function dbToInvite(row) {
  return {
    code: row.code,
    serverId: row.server_id,
    createdBy: row.created_by,
    uses: row.uses || 0,
    maxUses: row.max_uses || 0,
    createdAt: row.created_at
  };
}

function friendshipToDb(f) {
  return {
    id: f.id,
    user_a: f.userA,
    user_b: f.userB,
    status: f.status || "accepted",
    created_at: f.createdAt || new Date().toISOString()
  };
}

function dbToFriendship(row) {
  return {
    id: row.id,
    userA: row.user_a,
    userB: row.user_b,
    status: row.status || "accepted",
    createdAt: row.created_at
  };
}

function dmChannelToDb(d) {
  return {
    id: d.id,
    participant_ids: d.participantIds || [],
    created_at: d.createdAt || new Date().toISOString(),
    last_message_at: d.lastMessageAt || new Date().toISOString()
  };
}

function dbToDmChannel(row) {
  return {
    id: row.id,
    type: "dm",
    participantIds: Array.isArray(row.participant_ids) ? row.participant_ids : [],
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at || row.created_at
  };
}

function messageToDb(m) {
  return {
    id: m.id,
    channel_id: m.channelId,
    author_id: m.authorId || null,
    content: m.content || "",
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    reactions: m.reactions || {},
    reply_to_id: m.replyToId || null,
    pinned: !!m.pinned,
    edited_at: m.editedAt || null,
    created_at: m.createdAt || new Date().toISOString()
  };
}

function dbToMessage(row) {
  return {
    id: row.id,
    channelId: row.channel_id,
    authorId: row.author_id,
    content: row.content || "",
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    reactions: row.reactions || {},
    replyToId: row.reply_to_id || null,
    pinned: !!row.pinned,
    editedAt: row.edited_at || null,
    createdAt: row.created_at
  };
}

function voiceStateToDb(vs) {
  return {
    user_id: vs.userId,
    server_id: vs.serverId || null,
    channel_id: vs.channelId,
    muted: !!vs.muted,
    deafened: !!vs.deafened,
    video: !!vs.video,
    screen_share: !!vs.screenShare,
    screen_audio: !!vs.screenAudio,
    screen_quality: vs.screenQuality || "1080p60",
    speaking: !!vs.speaking,
    joined_at: vs.joinedAt || new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function dbToVoiceState(row) {
  return {
    userId: row.user_id,
    serverId: row.server_id,
    channelId: row.channel_id,
    muted: !!row.muted,
    deafened: !!row.deafened,
    video: !!row.video,
    screenShare: !!row.screen_share,
    screenAudio: !!row.screen_audio,
    screenQuality: row.screen_quality || "1080p60",
    speaking: !!row.speaking,
    joinedAt: row.joined_at
  };
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
          content:
            "Canal **#geral** pronto! Entre em **🔊 Call Geral** ou **🍿 Cinema / Tela 60fps** na barra lateral para iniciar uma chamada de voz, vídeo ou transmitir sua tela.",
          attachments: [],
          reactions: { "👍": [systemUserId] },
          replyToId: null,
          pinned: false,
          editedAt: null,
          createdAt: now
        }
      ]
    },
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
    this.prisma = new ConcordPrisma();
    this.supabase = new ConcordSupabase();
    this.lastSupabaseSync = 0;
    this.prismaReady = false;
    this.supabaseTablesReady = false;
    this.supabaseError = null;
    this.load();
    this.initSqliteMirror();
  }

  /**
   * Garante que os dados mais recentes estejam carregados.
   * Prioridade 1: Prisma ORM (via DATABASE_URL com PostgreSQL do Supabase).
   * Prioridade 2: Supabase REST API (via SUPABASE_URL + SUPABASE_KEY).
   * Fallback 3: Espelho local SQLite / JSON.
   */
  async ensureLoaded(force = false) {
    const now = Date.now();
    if (!force && now - this.lastSupabaseSync < 1500) return;

    // 1. Tenta carregar via Prisma ORM se estiver configurado
    if (this.prisma && this.prisma.isConfigured()) {
      try {
        const [cloudUsers, cloudServers, cloudInvites, cloudFriendships, cloudDmChannels, cloudVoiceStates] =
          await Promise.all([
            this.prisma.listUsers(),
            this.prisma.listServers(),
            this.prisma.listInvites(),
            this.prisma.listFriendships(),
            this.prisma.listDmChannels(),
            this.prisma.listVoiceStates()
          ]);

        this.prismaReady = true;

        if (!cloudUsers || cloudUsers.length === 0) {
          await this.seedPrismaFromLocalState();
          this.lastSupabaseSync = now;
          return;
        }

        this.state.users = cloudUsers.map((u) => ({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          discriminator: u.discriminator,
          passwordHash: u.passwordHash,
          avatar: u.avatar,
          bannerColor: u.bannerColor,
          status: u.status,
          customStatus: u.customStatus,
          bio: u.bio,
          isAdmin: u.isAdmin,
          isSystem: u.isSystem,
          createdAt: u.createdAt instanceof Date ? u.createdAt.toISOString() : u.createdAt
        }));

        this.state.servers = cloudServers;
        this.state.invites = cloudInvites.map((i) => ({
          code: i.code,
          serverId: i.serverId,
          createdBy: i.createdBy,
          uses: i.uses,
          maxUses: i.maxUses,
          createdAt: i.createdAt instanceof Date ? i.createdAt.toISOString() : i.createdAt
        }));
        this.state.friendships = cloudFriendships;
        this.state.dmChannels = cloudDmChannels;

        if (!this.state.realtime) {
          this.state.realtime = { voiceStates: {}, heartbeats: {}, signalQueues: {}, events: [] };
        }
        this.state.realtime.voiceStates = {};
        for (const vs of cloudVoiceStates) {
          this.state.realtime.voiceStates[vs.userId] = vs;
        }

        this.lastSupabaseSync = now;
        this.saveLocalMirror();
        return;
      } catch (err) {
        console.warn("[Prisma] Aviso ao carregar dados pelo Prisma:", err.message);
      }
    }

    if (!this.supabase || !this.supabase.isConfigured()) return;

    try {
      // 2. Tenta buscar todas as tabelas do Supabase via REST
      const [
        cloudUsers,
        cloudServers,
        cloudChannels,
        cloudMembers,
        cloudInvites,
        cloudFriendships,
        cloudDmChannels,
        cloudVoiceStates
      ] = await Promise.all([
        this.supabase.select(TABLES.users, "select=*"),
        this.supabase.select(TABLES.servers, "select=*"),
        this.supabase.select(TABLES.channels, "select=*&order=position.asc"),
        this.supabase.select(TABLES.members, "select=*"),
        this.supabase.select(TABLES.invites, "select=*"),
        this.supabase.select(TABLES.friendships, "select=*"),
        this.supabase.select(TABLES.dmChannels, "select=*"),
        this.supabase.select(TABLES.voiceStates, "select=*")
      ]);

      this.supabaseTablesReady = true;
      this.supabaseError = null;

      // 2. Se as tabelas existirem mas estiverem vazias, faz seed inicial
      if (!Array.isArray(cloudUsers) || cloudUsers.length === 0) {
        await this.seedSupabaseFromLocalState();
        this.lastSupabaseSync = now;
        return;
      }

      // 3. Monta o estado em memória a partir dos registros do Supabase
      const channelsList = Array.isArray(cloudChannels) ? cloudChannels.map(dbToChannel) : [];
      const membersList = Array.isArray(cloudMembers) ? cloudMembers : [];

      this.state.users = cloudUsers.map(dbToUser);
      this.state.servers = (cloudServers || []).map((s) => dbToServer(s, channelsList, membersList));
      this.state.invites = Array.isArray(cloudInvites) ? cloudInvites.map(dbToInvite) : [];
      this.state.friendships = Array.isArray(cloudFriendships) ? cloudFriendships.map(dbToFriendship) : [];
      this.state.dmChannels = Array.isArray(cloudDmChannels) ? cloudDmChannels.map(dbToDmChannel) : [];

      // 4. Carrega estado temporário das chamadas de voz do Supabase
      if (!this.state.realtime) {
        this.state.realtime = { voiceStates: {}, heartbeats: {}, signalQueues: {}, events: [] };
      }
      this.state.realtime.voiceStates = {};
      if (Array.isArray(cloudVoiceStates)) {
        for (const vsRow of cloudVoiceStates) {
          const vs = dbToVoiceState(vsRow);
          this.state.realtime.voiceStates[vs.userId] = vs;
        }
      }

      this.lastSupabaseSync = now;
      this.saveLocalMirror();
    } catch (err) {
      this.supabaseError = err.message;
      // Caso as novas tabelas ainda não existam no Supabase, tenta carregar do estado monolítico legado
      if (err.isMissingSchema && err.isMissingSchema()) {
        const legacy = await this.supabase.loadState().catch(() => null);
        if (legacy && Array.isArray(legacy.users)) {
          this.state = legacy;
          this.lastSupabaseSync = now;
        }
      }
    }
  }

  /**
   * Semeia o banco de dados via Prisma a partir do estado local
   */
  async seedPrismaFromLocalState() {
    const s = this.state || createInitialState();
    try {
      for (const u of s.users || []) {
        await this.prisma.createUser(u);
      }
      for (const srv of s.servers || []) {
        const inv = (s.invites || []).find((i) => i.serverId === srv.id);
        await this.prisma.createServer(srv, srv.channels || [], srv.memberIds || [], inv);
      }
      if (s.messages) {
        for (const chMsgs of Object.values(s.messages)) {
          if (Array.isArray(chMsgs)) {
            for (const m of chMsgs) {
              await this.prisma.createMessage(m);
            }
          }
        }
      }
    } catch (e) {
      console.warn("[Prisma] Aviso ao semear estado inicial no Prisma:", e.message);
    }
  }

  /**
   * Faz o seed ou migração inicial das tabelas do Supabase usando o estado inicial ou o JSON local
   */
  async seedSupabaseFromLocalState() {
    const s = this.state || createInitialState();
    try {
      // 1. Usuários
      const userRows = (s.users || []).map(userToDb);
      if (userRows.length > 0) {
        await this.supabase.insert(TABLES.users, userRows, { onConflict: "id", mode: "merge" });
      }

      // 2. Servidores
      const serverRows = (s.servers || []).map(serverToDb);
      if (serverRows.length > 0) {
        await this.supabase.insert(TABLES.servers, serverRows, { onConflict: "id", mode: "merge" });
      }

      // 3. Canais
      const channelRows = [];
      const memberRows = [];
      for (const srv of s.servers || []) {
        for (const ch of srv.channels || []) {
          channelRows.push(channelToDb(ch));
        }
        for (const uid of srv.memberIds || []) {
          memberRows.push({ server_id: srv.id, user_id: uid });
        }
      }
      if (channelRows.length > 0) {
        await this.supabase.insert(TABLES.channels, channelRows, { onConflict: "id", mode: "merge" });
      }
      if (memberRows.length > 0) {
        await this.supabase.insert(TABLES.members, memberRows, { mode: "ignore" });
      }

      // 4. Convites
      const inviteRows = (s.invites || []).map(inviteToDb);
      if (inviteRows.length > 0) {
        await this.supabase.insert(TABLES.invites, inviteRows, { onConflict: "code", mode: "merge" });
      }

      // 5. Mensagens iniciais
      const messageRows = [];
      if (s.messages) {
        for (const chMsgs of Object.values(s.messages)) {
          if (Array.isArray(chMsgs)) {
            for (const m of chMsgs) {
              messageRows.push(messageToDb(m));
            }
          }
        }
      }
      if (messageRows.length > 0) {
        await this.supabase.insert(TABLES.messages, messageRows, { onConflict: "id", mode: "merge" });
      }
    } catch (e) {
      console.warn("[Supabase] Aviso ao semear estado inicial no Supabase:", e.message);
    }
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
        this.state.realtime.voiceStates = {};
        this.state.realtime.heartbeats = {};
        this.state.realtime.signalQueues = {};
        this.state.realtime.events = [];
        if (!this.state.meta) {
          this.state.meta = { version: "1.0.0", masterInviteCode: "CONCORD-AMIGOS-2026", eventSeq: 1 };
        }
        if (!this.state.meta.eventSeq) {
          this.state.meta.eventSeq = 1;
        }
      } catch (_) {
        this.state = createInitialState();
        this.saveLocalMirror();
      }
    } else {
      this.state = createInitialState();
      this.saveLocalMirror();
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

  saveLocalMirror() {
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

  save() {
    this.saveLocalMirror();
    // Fallback legado de backup em JSON se tabelas dedicadas não estiverem prontas
    if (this.supabase && this.supabase.isConfigured() && !this.supabaseTablesReady) {
      this.supabase.saveState(this.state).catch(() => {});
    }
  }

  async saveAsync() {
    this.saveLocalMirror();
    if (this.supabase && this.supabase.isConfigured() && !this.supabaseTablesReady) {
      await this.supabase.saveState(this.state).catch(() => {});
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

    // Salva no Supabase para que todas as instâncias da Vercel recebam via /api/sync
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.insert(TABLES.events, { type, data, created_at: new Date().toISOString() }).catch(() => {});
    }

    return evt;
  }

  enqueueSignal(targetUserId, signalPayload) {
    if (!this.state.realtime.signalQueues[targetUserId]) {
      this.state.realtime.signalQueues[targetUserId] = [];
    }
    const sig = {
      ...signalPayload,
      ts: Date.now()
    };
    this.state.realtime.signalQueues[targetUserId].push(sig);
    if (this.state.realtime.signalQueues[targetUserId].length > 100) {
      this.state.realtime.signalQueues[targetUserId] =
        this.state.realtime.signalQueues[targetUserId].slice(-100);
    }

    // Persiste sinal WebRTC no Supabase para roteamento entre nós serverless
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.insert(TABLES.signals, {
        target_user_id: targetUserId,
        from_user_id: signalPayload.fromUserId || null,
        payload: sig,
        created_at: new Date().toISOString()
      }).catch(() => {});
    }
  }

  drainSignals(userId) {
    const queue = this.state.realtime.signalQueues[userId] || [];
    if (queue.length > 0) {
      this.state.realtime.signalQueues[userId] = [];
    }
    return queue;
  }

  async drainSignalsAsync(userId) {
    const memorySignals = this.drainSignals(userId);
    if (!this.supabase || !this.supabase.isConfigured() || !this.supabaseTablesReady) {
      return memorySignals;
    }
    try {
      const rows = await this.supabase.select(
        TABLES.signals,
        `target_user_id=eq.${encodeURIComponent(userId)}&order=id.asc&limit=100`
      );
      if (Array.isArray(rows) && rows.length > 0) {
        const ids = rows.map((r) => r.id).filter(Boolean);
        if (ids.length > 0) {
          this.supabase.delete(TABLES.signals, inList("id", ids)).catch(() => {});
        }
        const dbSignals = rows.map((r) => r.payload).filter(Boolean);
        return [...memorySignals, ...dbSignals];
      }
    } catch (_) {}
    return memorySignals;
  }

  touchHeartbeat(userId) {
    if (!this.state.realtime) {
      this.state.realtime = { voiceStates: {}, heartbeats: {}, signalQueues: {}, events: [] };
    }
    this.state.realtime.heartbeats[userId] = Date.now();

    // Atualiza presença no Prisma ou Supabase
    if (this.prisma && this.prisma.isConfigured()) {
      this.prisma.touchPresence(userId).catch(() => {});
    } else if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase
        .insert(
          TABLES.presence,
          { user_id: userId, last_seen: new Date().toISOString() },
          { onConflict: "user_id", mode: "merge" }
        )
        .catch(() => {});
    }

    // Expira chamadas de voz de usuários que caíram há mais de 35s sem heartbeat
    const cutoff = Date.now() - 35000;
    let changedVoice = false;
    for (const [uid, vs] of Object.entries(this.state.realtime.voiceStates)) {
      const lastSeen = this.state.realtime.heartbeats[uid] || 0;
      if (lastSeen > 0 && lastSeen < cutoff) {
        delete this.state.realtime.voiceStates[uid];
        this.removeVoiceState(uid);
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
    if (this.state.realtime && this.state.realtime.voiceStates && this.state.realtime.voiceStates[userId]) return true;
    const last = this.state.realtime && this.state.realtime.heartbeats[userId];
    if (!last) return false;
    return Date.now() - last < 45000;
  }

  sanitizeUser(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
  }

  findUserByUsername(username) {
    const raw = String(username || "").trim();
    if (!raw) return null;
    const normalized = raw.toLowerCase();
    const cleanNormalized = normalized.replace(/\s+/g, "_").replace(/[^a-z0-9_.-]/g, "");

    return (
      this.state.users.find(
        (u) =>
          u.username.toLowerCase() === normalized ||
          u.username.toLowerCase() === cleanNormalized ||
          u.displayName.toLowerCase() === normalized
      ) || null
    );
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

  // ---------------------------------------------------------------------------
  // CONTAS DE USUÁRIO (persistidas em concord_users no Supabase)
  // ---------------------------------------------------------------------------

  registerUser({ username, displayName, password, inviteCode, avatar }) {
    const rawName = String(username || displayName || "").trim();
    const cleanUsername = rawName
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_.-]/g, "");

    if (cleanUsername.length < 2 || cleanUsername.length > 32) {
      throw new Error("O nome de usuário deve ter entre 2 e 32 caracteres.");
    }
    if (!password || String(password).length < 4) {
      throw new Error("A senha deve ter pelo menos 4 caracteres.");
    }

    const invite = this.validateInviteCode(inviteCode || "CONCORD-AMIGOS-2026");
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
    const finalDisplayName = String(displayName || rawName || cleanUsername).trim();

    const newUser = {
      id: generateId("usr"),
      username: cleanUsername,
      displayName: finalDisplayName,
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

    // Adiciona automaticamente aos servidores padrão
    const memberRowsToInsert = [];
    for (const srv of this.state.servers) {
      if (!srv.memberIds.includes(newUser.id)) {
        srv.memberIds.push(newUser.id);
        memberRowsToInsert.push({ server_id: srv.id, user_id: newUser.id });
      }
      if (isFirstHumanUser && srv.ownerId === "usr_concord_bot") {
        srv.ownerId = newUser.id;
      }
    }

    // Cria amizades com outros membros
    const friendshipRowsToInsert = [];
    for (const existing of this.state.users) {
      if (!existing.isSystem && existing.id !== newUser.id) {
        const existsFriendship = this.state.friendships.some(
          (f) =>
            (f.userA === existing.id && f.userB === newUser.id) ||
            (f.userA === newUser.id && f.userB === existing.id)
        );
        if (!existsFriendship) {
          const frd = {
            id: generateId("frd"),
            userA: existing.id,
            userB: newUser.id,
            status: "accepted",
            createdAt: new Date().toISOString()
          };
          this.state.friendships.push(frd);
          friendshipRowsToInsert.push(friendshipToDb(frd));
        }
      }
    }

    const storedInvite = this.state.invites.find(
      (i) => i.code.toUpperCase() === String(inviteCode).trim().toUpperCase()
    );
    if (storedInvite) storedInvite.uses = (storedInvite.uses || 0) + 1;

    const token = this.createSession(newUser.id);
    this.save();

    // Persiste no Prisma ou no Supabase em background
    if (this.prisma && this.prisma.isConfigured()) {
      this.prisma.createUser(newUser).then(() => {
        for (const s of this.state.servers) {
          this.prisma.joinServer(s.id, newUser.id).catch(() => {});
        }
        for (const f of friendshipRowsToInsert) {
          this.prisma.createFriendship(f).catch(() => {});
        }
        if (storedInvite) {
          this.prisma.incrementInvite(storedInvite.code).catch(() => {});
        }
      }).catch((err) => {
        console.warn("[Prisma] Aviso ao registrar conta no Prisma:", err.message);
      });
    } else if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.insert(TABLES.users, userToDb(newUser), { onConflict: "id", mode: "merge" })
        .then(() => {
          return Promise.all([
            memberRowsToInsert.length > 0
              ? this.supabase.insert(TABLES.members, memberRowsToInsert, { mode: "ignore" })
              : Promise.resolve(),
            friendshipRowsToInsert.length > 0
              ? this.supabase.insert(TABLES.friendships, friendshipRowsToInsert, { mode: "ignore" })
              : Promise.resolve(),
            storedInvite
              ? this.supabase.update(TABLES.invites, `code=eq.${encodeValue(storedInvite.code)}`, {
                  uses: storedInvite.uses
                })
              : Promise.resolve()
          ]);
        })
        .catch((err) => {
          console.warn("[Supabase] Aviso ao registrar conta no banco em nuvem:", err.message);
        });
    }

    return { user: this.sanitizeUser(newUser), token };
  }

  async registerUserAsync(payload) {
    const result = this.registerUser(payload);
    if (this.prisma && this.prisma.isConfigured()) {
      const u = this.findUserById(result.user.id);
      if (u) await this.prisma.createUser(u).catch(() => {});
    } else if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      const u = this.findUserById(result.user.id);
      if (u) {
        await this.supabase.insert(TABLES.users, userToDb(u), { onConflict: "id", mode: "merge" }).catch(() => {});
      }
    }
    return result;
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

  async loginUserAsync(payload) {
    let user = this.findUserByUsername(payload.username);
    // Se não achou na memória (ex: nova lambda Vercel), tenta buscar direto no Supabase
    if (!user && this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      try {
        const rows = await this.supabase.select(
          TABLES.users,
          `username=eq.${encodeValue(String(payload.username).toLowerCase().trim())}`
        );
        if (Array.isArray(rows) && rows.length > 0) {
          user = dbToUser(rows[0]);
          this.state.users.push(user);
        }
      } catch (_) {}
    }
    return this.loginUser(payload);
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

    const session = this.state.sessions && this.state.sessions[clean];
    if (session) {
      const u = this.findUserById(session.userId);
      if (u) return u;
    }

    const payload = this.verifyToken(clean);
    if (!payload || !payload.id) return null;

    let user = this.findUserById(payload.id);
    if (!user && payload.u) {
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
    const patch = {};
    if (typeof updates.displayName === "string" && updates.displayName.trim()) {
      user.displayName = updates.displayName.trim().slice(0, 40);
      patch.display_name = user.displayName;
    }
    if (typeof updates.customStatus === "string") {
      user.customStatus = updates.customStatus.trim().slice(0, 80);
      patch.custom_status = user.customStatus;
    }
    if (typeof updates.bio === "string") {
      user.bio = updates.bio.trim().slice(0, 240);
      patch.bio = user.bio;
    }
    if (typeof updates.status === "string" && ["online", "idle", "dnd", "offline"].includes(updates.status)) {
      user.status = updates.status;
      patch.status = user.status;
    }
    if (typeof updates.avatar === "string") {
      user.avatar = updates.avatar;
      patch.avatar = user.avatar;
    }
    if (typeof updates.bannerColor === "string") {
      user.bannerColor = updates.bannerColor;
      patch.banner_color = user.bannerColor;
    }
    patch.updated_at = new Date().toISOString();
    this.save();

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.update(TABLES.users, `id=eq.${encodeValue(userId)}`, patch).catch(() => {});
    }

    return this.sanitizeUser(user);
  }

  async updateUserProfileAsync(userId, updates) {
    const user = this.updateUserProfile(userId, updates);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      const dbRow = userToDb(this.findUserById(userId));
      await this.supabase.update(TABLES.users, `id=eq.${encodeValue(userId)}`, dbRow).catch(() => {});
    }
    return user;
  }

  // ---------------------------------------------------------------------------
  // SERVIDORES E CANAIS (persistidos em concord_servers e concord_channels)
  // ---------------------------------------------------------------------------

  createServer(ownerId, { name, icon }) {
    const cleanName = String(name || "").trim();
    if (!cleanName) throw new Error("Informe o nome do servidor.");
    const serverId = generateId("srv");
    const inviteCode =
      cleanName
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6) +
      "-" +
      crypto.randomBytes(2).toString("hex").toUpperCase();

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
    const textChannel = {
      id: textChannelId,
      serverId,
      categoryId: server.categories[0].id,
      name: "geral",
      type: "text",
      topic: `Canal principal de ${cleanName}`,
      position: 0
    };
    const voiceChannel = {
      id: voiceChannelId,
      serverId,
      categoryId: server.categories[1].id,
      name: "Call Geral",
      type: "voice",
      topic: "Canal de voz, vídeo e compartilhamento de tela",
      bitrate: 128000,
      userLimit: 0,
      position: 0
    };

    server.channels.push(textChannel, voiceChannel);
    this.state.servers.push(server);

    const invite = {
      code: inviteCode,
      serverId,
      createdBy: ownerId,
      createdAt: new Date().toISOString(),
      uses: 0,
      maxUses: 0
    };
    this.state.invites.push(invite);
    this.state.messages[textChannelId] = [];

    this.appendRealtimeEvent("SERVER_CREATE", { server });
    this.save();

    // Persiste servidor, canais, membros e convite no Supabase
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      Promise.all([
        this.supabase.insert(TABLES.servers, serverToDb(server)),
        this.supabase.insert(TABLES.channels, [channelToDb(textChannel), channelToDb(voiceChannel)]),
        this.supabase.insert(
          TABLES.members,
          memberIds.map((uid) => ({ server_id: serverId, user_id: uid })),
          { mode: "ignore" }
        ),
        this.supabase.insert(TABLES.invites, inviteToDb(invite))
      ]).catch((err) => {
        console.warn("[Supabase] Aviso ao cadastrar servidor no Supabase:", err.message);
      });
    }

    return server;
  }

  async createServerAsync(ownerId, data) {
    const srv = this.createServer(ownerId, data);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await Promise.all([
        this.supabase.insert(TABLES.servers, serverToDb(srv), { mode: "merge" }),
        this.supabase.insert(TABLES.channels, srv.channels.map(channelToDb), { mode: "merge" })
      ]).catch(() => {});
    }
    return srv;
  }

  joinServer(userId, code) {
    const clean = String(code || "").trim().toUpperCase();
    const srv = this.state.servers.find(
      (s) => s.inviteCode.toUpperCase() === clean || clean === this.state.meta.masterInviteCode.toUpperCase()
    );
    if (!srv) {
      throw new Error("Código de convite de servidor não encontrado.");
    }
    if (!srv.memberIds.includes(userId)) {
      srv.memberIds.push(userId);
      this.appendRealtimeEvent("SERVER_UPDATE", { server: srv });
      this.save();

      if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
        this.supabase.insert(TABLES.members, { server_id: srv.id, user_id: userId }, { mode: "ignore" }).catch(() => {});
      }
    }
    return srv;
  }

  async joinServerAsync(userId, code) {
    const srv = this.joinServer(userId, code);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase.insert(TABLES.members, { server_id: srv.id, user_id: userId }, { mode: "ignore" }).catch(() => {});
    }
    return srv;
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

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.insert(TABLES.channels, channelToDb(channel)).catch((err) => {
        console.warn("[Supabase] Aviso ao criar canal no Supabase:", err.message);
      });
    }

    return channel;
  }

  async createChannelAsync(userId, serverId, data) {
    const ch = this.createChannel(userId, serverId, data);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase.insert(TABLES.channels, channelToDb(ch)).catch(() => {});
    }
    return ch;
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

      if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
        this.supabase.insert(TABLES.dmChannels, dmChannelToDb(dm)).catch(() => {});
      }
    }
    return dm;
  }

  async getOrCreateDmChannelAsync(userA, userB) {
    const dm = this.getOrCreateDmChannel(userA, userB);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase.insert(TABLES.dmChannels, dmChannelToDb(dm), { onConflict: "id", mode: "merge" }).catch(() => {});
    }
    return dm;
  }

  // ---------------------------------------------------------------------------
  // MENSAGENS DO CHAT (persistidas em concord_messages)
  // ---------------------------------------------------------------------------

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

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.insert(TABLES.messages, messageToDb(msg)).catch((err) => {
        console.warn("[Supabase] Aviso ao cadastrar mensagem no Supabase:", err.message);
      });
      if (dm) {
        this.supabase
          .update(TABLES.dmChannels, `id=eq.${encodeValue(dm.id)}`, { last_message_at: msg.createdAt })
          .catch(() => {});
      }
    }

    return msg;
  }

  async createMessageAsync(authorId, channelId, data) {
    const msg = this.createMessage(authorId, channelId, data);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase.insert(TABLES.messages, messageToDb(msg)).catch(() => {});
    }
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

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase
        .update(TABLES.messages, `id=eq.${encodeValue(messageId)}`, {
          content: msg.content,
          edited_at: msg.editedAt
        })
        .catch(() => {});
    }

    return msg;
  }

  async updateMessageAsync(userId, channelId, messageId, data) {
    const msg = this.updateMessage(userId, channelId, messageId, data);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase
        .update(TABLES.messages, `id=eq.${encodeValue(messageId)}`, {
          content: msg.content,
          edited_at: msg.editedAt
        })
        .catch(() => {});
    }
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

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.remove(TABLES.messages, `id=eq.${encodeValue(messageId)}`).catch(() => {});
    }

    return payload;
  }

  async deleteMessageAsync(userId, channelId, messageId) {
    const res = this.deleteMessage(userId, channelId, messageId);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase.remove(TABLES.messages, `id=eq.${encodeValue(messageId)}`).catch(() => {});
    }
    return res;
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

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase
        .update(TABLES.messages, `id=eq.${encodeValue(messageId)}`, { reactions: msg.reactions })
        .catch(() => {});
    }

    return msg;
  }

  async toggleReactionAsync(userId, channelId, messageId, emoji) {
    const msg = this.toggleReaction(userId, channelId, messageId, emoji);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase
        .update(TABLES.messages, `id=eq.${encodeValue(messageId)}`, { reactions: msg.reactions })
        .catch(() => {});
    }
    return msg;
  }

  togglePin(userId, channelId, messageId) {
    const list = this.state.messages[channelId] || [];
    const msg = list.find((m) => m.id === messageId);
    if (!msg) throw new Error("Mensagem não encontrada.");
    msg.pinned = !msg.pinned;
    this.appendRealtimeEvent("MESSAGE_UPDATE", { channelId, message: msg });
    this.save();

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase
        .update(TABLES.messages, `id=eq.${encodeValue(messageId)}`, { pinned: msg.pinned })
        .catch(() => {});
    }

    return msg;
  }

  async togglePinAsync(userId, channelId, messageId) {
    const msg = this.togglePin(userId, channelId, messageId);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase
        .update(TABLES.messages, `id=eq.${encodeValue(messageId)}`, { pinned: msg.pinned })
        .catch(() => {});
    }
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

    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      this.supabase.insert(TABLES.friendships, friendshipToDb(rel), { onConflict: "id", mode: "merge" }).catch(() => {});
    }

    return rel;
  }

  async sendFriendRequestAsync(fromUserId, targetUsername) {
    const rel = this.sendFriendRequest(fromUserId, targetUsername);
    if (this.supabase && this.supabase.isConfigured() && this.supabaseTablesReady) {
      await this.supabase.insert(TABLES.friendships, friendshipToDb(rel), { onConflict: "id", mode: "merge" }).catch(() => {});
    }
    return rel;
  }

  // ---------------------------------------------------------------------------
  // ESTADO TEMPORÁRIO DO USUÁRIO (em chamada / fora de chamada, presença)
  // ---------------------------------------------------------------------------

  setVoiceState(userId, state) {
    if (!this.state.realtime) {
      this.state.realtime = { voiceStates: {}, heartbeats: {}, signalQueues: {}, events: [] };
    }
    this.state.realtime.voiceStates[userId] = state;
    this.touchHeartbeat(userId);

    // Salva no Prisma ou no Supabase para que qualquer outra instância / Vercel saiba que ele está em chamada
    if (this.prisma && this.prisma.isConfigured()) {
      this.prisma.setVoiceState(state).catch((err) => {
        console.warn("[Prisma] Aviso ao persistir estado de chamada no Prisma:", err.message);
      });
    } else if (this.supabase && this.supabase.isConfigured()) {
      this.supabase
        .insert(TABLES.voiceStates, voiceStateToDb(state), { onConflict: "user_id", mode: "merge" })
        .catch((err) => {
          console.warn("[Supabase] Aviso ao persistir estado de chamada no Supabase:", err.message);
        });
    }
  }

  async setVoiceStateAsync(userId, state) {
    this.setVoiceState(userId, state);
    if (this.prisma && this.prisma.isConfigured()) {
      await this.prisma.setVoiceState(state).catch(() => {});
    } else if (this.supabase && this.supabase.isConfigured()) {
      await this.supabase
        .insert(TABLES.voiceStates, voiceStateToDb(state), { onConflict: "user_id", mode: "merge" })
        .catch(() => {});
    }
  }

  updateVoiceState(userId, updates) {
    if (!this.state.realtime || !this.state.realtime.voiceStates[userId]) return;
    const current = this.state.realtime.voiceStates[userId];
    const patch = {};

    if (typeof updates.muted === "boolean") { current.muted = updates.muted; patch.muted = updates.muted; }
    if (typeof updates.deafened === "boolean") { current.deafened = updates.deafened; patch.deafened = updates.deafened; }
    if (typeof updates.video === "boolean") { current.video = updates.video; patch.video = updates.video; }
    if (typeof updates.screenShare === "boolean") { current.screenShare = updates.screenShare; patch.screen_share = updates.screenShare; }
    if (typeof updates.screenAudio === "boolean") { current.screenAudio = updates.screenAudio; patch.screen_audio = updates.screenAudio; }
    if (typeof updates.screenQuality === "string") { current.screenQuality = updates.screenQuality; patch.screen_quality = updates.screenQuality; }
    if (typeof updates.speaking === "boolean") { current.speaking = updates.speaking; patch.speaking = updates.speaking; }
    patch.updated_at = new Date().toISOString();

    if (this.prisma && this.prisma.isConfigured()) {
      this.prisma.updateVoiceState(userId, updates).catch(() => {});
    } else if (this.supabase && this.supabase.isConfigured()) {
      this.supabase.update(TABLES.voiceStates, `user_id=eq.${encodeValue(userId)}`, patch).catch(() => {});
    }
  }

  async updateVoiceStateAsync(userId, updates) {
    this.updateVoiceState(userId, updates);
    if (this.prisma && this.prisma.isConfigured()) {
      await this.prisma.updateVoiceState(userId, updates).catch(() => {});
    } else if (this.supabase && this.supabase.isConfigured()) {
      const current = this.state.realtime && this.state.realtime.voiceStates[userId];
      if (current) {
        await this.supabase
          .update(TABLES.voiceStates, `user_id=eq.${encodeValue(userId)}`, voiceStateToDb(current))
          .catch(() => {});
      }
    }
  }

  removeVoiceState(userId) {
    if (!this.state.realtime) return;
    delete this.state.realtime.voiceStates[userId];

    // Remove do Prisma ou Supabase indicando que o usuário saiu de chamada
    if (this.prisma && this.prisma.isConfigured()) {
      this.prisma.removeVoiceState(userId).catch(() => {});
    } else if (this.supabase && this.supabase.isConfigured()) {
      this.supabase.remove(TABLES.voiceStates, `user_id=eq.${encodeValue(userId)}`).catch((err) => {
        console.warn("[Supabase] Aviso ao remover estado de chamada no Supabase:", err.message);
      });
    }
  }

  async removeVoiceStateAsync(userId) {
    this.removeVoiceState(userId);
    if (this.prisma && this.prisma.isConfigured()) {
      await this.prisma.removeVoiceState(userId).catch(() => {});
    } else if (this.supabase && this.supabase.isConfigured()) {
      await this.supabase.remove(TABLES.voiceStates, `user_id=eq.${encodeValue(userId)}`).catch(() => {});
    }
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
