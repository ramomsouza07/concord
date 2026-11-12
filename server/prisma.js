"use strict";

const path = require("path");
const fs = require("fs");

/**
 * Concord Prisma Database Adapter
 * - Conexão centralizada usando o Prisma ORM (@prisma/client)
 * - Mapeia todas as operações de banco: Usuários, Servidores, Canais, Mensagens,
 *   Amizades, Convites, DMs e o Estado Temporário dos Usuários (chamadas de voz e presença).
 */

let prismaInstance = null;
let isPrismaAvailable = false;

try {
  const { PrismaClient } = require("@prisma/client");
  prismaInstance = new PrismaClient();
  isPrismaAvailable = true;
} catch (e) {
  prismaInstance = null;
  isPrismaAvailable = false;
}

class ConcordPrisma {
  constructor() {
    this.prisma = prismaInstance;
    this.available = isPrismaAvailable && !!process.env.DATABASE_URL;
  }

  isConfigured() {
    const url = (process.env.DATABASE_URL || "").trim();
    if (!url || url.includes("[SUA-SENHA") || url.includes("SUA-SENHA-DO-SUPABASE")) {
      return false;
    }
    return !!(this.available && this.prisma && url);
  }

  get client() {
    return this.prisma;
  }

  // ---------------------------------------------------------------------------
  // CONTAS DE USUÁRIO
  // ---------------------------------------------------------------------------

  async findUserById(id) {
    if (!this.isConfigured()) return null;
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findUserByUsername(username) {
    if (!this.isConfigured()) return null;
    const clean = String(username || "").toLowerCase().trim();
    return this.prisma.user.findFirst({
      where: {
        OR: [
          { username: clean },
          { displayName: { equals: clean, mode: "insensitive" } }
        ]
      }
    });
  }

  async createUser(data) {
    if (!this.isConfigured()) return null;
    return this.prisma.user.upsert({
      where: { id: data.id },
      create: {
        id: data.id,
        username: data.username,
        displayName: data.displayName || data.username,
        discriminator: data.discriminator || "0000",
        passwordHash: data.passwordHash || "",
        avatar: data.avatar || "",
        bannerColor: data.bannerColor || "#5865F2",
        status: data.status || "online",
        customStatus: data.customStatus || "",
        bio: data.bio || "",
        isAdmin: !!data.isAdmin,
        isSystem: !!data.isSystem
      },
      update: {
        displayName: data.displayName,
        avatar: data.avatar,
        bannerColor: data.bannerColor,
        status: data.status,
        customStatus: data.customStatus,
        bio: data.bio
      }
    });
  }

  async updateUser(id, updates) {
    if (!this.isConfigured()) return null;
    const data = {};
    if (typeof updates.displayName === "string") data.displayName = updates.displayName;
    if (typeof updates.customStatus === "string") data.customStatus = updates.customStatus;
    if (typeof updates.bio === "string") data.bio = updates.bio;
    if (typeof updates.status === "string") data.status = updates.status;
    if (typeof updates.avatar === "string") data.avatar = updates.avatar;
    if (typeof updates.bannerColor === "string") data.bannerColor = updates.bannerColor;
    return this.prisma.user.update({
      where: { id },
      data
    });
  }

  async listUsers() {
    if (!this.isConfigured()) return [];
    return this.prisma.user.findMany({
      orderBy: { createdAt: "asc" }
    });
  }

  // ---------------------------------------------------------------------------
  // SERVIDORES E CANAIS
  // ---------------------------------------------------------------------------

  async listServers() {
    if (!this.isConfigured()) return [];
    const servers = await this.prisma.server.findMany({
      include: {
        channels: { orderBy: { position: "asc" } },
        members: true
      },
      orderBy: { createdAt: "asc" }
    });

    return servers.map((s) => ({
      id: s.id,
      name: s.name,
      icon: s.icon,
      ownerId: s.ownerId,
      inviteCode: s.inviteCode,
      createdAt: s.createdAt.toISOString(),
      categories: Array.isArray(s.categories) ? s.categories : [],
      channels: s.channels.map((c) => ({
        id: c.id,
        serverId: c.serverId,
        categoryId: c.categoryId || "",
        name: c.name,
        type: c.type,
        topic: c.topic || "",
        bitrate: c.bitrate || (c.type === "voice" ? 128000 : undefined),
        userLimit: c.userLimit || 0,
        position: c.position || 0,
        createdAt: c.createdAt.toISOString()
      })),
      memberIds: s.members.map((m) => m.userId)
    }));
  }

  async createServer(serverData, channelsData, memberIds = [], inviteData = null) {
    if (!this.isConfigured()) return null;
    return this.prisma.$transaction(async (tx) => {
      const server = await tx.server.create({
        data: {
          id: serverData.id,
          name: serverData.name,
          icon: serverData.icon || "",
          ownerId: serverData.ownerId,
          inviteCode: serverData.inviteCode,
          categories: serverData.categories || []
        }
      });

      if (channelsData && channelsData.length > 0) {
        await tx.channel.createMany({
          data: channelsData.map((c) => ({
            id: c.id,
            serverId: server.id,
            categoryId: c.categoryId || null,
            name: c.name,
            type: c.type,
            topic: c.topic || "",
            bitrate: c.bitrate || null,
            userLimit: c.userLimit || 0,
            position: c.position || 0
          }))
        });
      }

      if (memberIds && memberIds.length > 0) {
        await tx.serverMember.createMany({
          data: memberIds.map((uid) => ({
            serverId: server.id,
            userId: uid
          })),
          skipDuplicates: true
        });
      }

      if (inviteData) {
        await tx.invite.create({
          data: {
            code: inviteData.code,
            serverId: server.id,
            createdBy: inviteData.createdBy,
            uses: 0,
            maxUses: 0
          }
        });
      }

      return server;
    });
  }

  async joinServer(serverId, userId) {
    if (!this.isConfigured()) return null;
    return this.prisma.serverMember.upsert({
      where: {
        serverId_userId: { serverId, userId }
      },
      create: { serverId, userId },
      update: {}
    });
  }

  async createChannel(channelData) {
    if (!this.isConfigured()) return null;
    return this.prisma.channel.create({
      data: {
        id: channelData.id,
        serverId: channelData.serverId,
        categoryId: channelData.categoryId || null,
        name: channelData.name,
        type: channelData.type,
        topic: channelData.topic || "",
        bitrate: channelData.bitrate || null,
        userLimit: channelData.userLimit || 0,
        position: channelData.position || 0
      }
    });
  }

  // ---------------------------------------------------------------------------
  // CONVITES
  // ---------------------------------------------------------------------------

  async listInvites() {
    if (!this.isConfigured()) return [];
    return this.prisma.invite.findMany();
  }

  async incrementInvite(code) {
    if (!this.isConfigured()) return null;
    return this.prisma.invite.update({
      where: { code: code.toUpperCase() },
      data: { uses: { increment: 1 } }
    }).catch(() => null);
  }

  // ---------------------------------------------------------------------------
  // MENSAGENS DO CHAT
  // ---------------------------------------------------------------------------

  async listMessages(channelId, limit = 150) {
    if (!this.isConfigured()) return [];
    const msgs = await this.prisma.message.findMany({
      where: { channelId },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return msgs.reverse().map((m) => ({
      id: m.id,
      channelId: m.channelId,
      authorId: m.authorId,
      content: m.content,
      attachments: Array.isArray(m.attachments) ? m.attachments : [],
      reactions: m.reactions || {},
      replyToId: m.replyToId,
      pinned: m.pinned,
      editedAt: m.editedAt ? m.editedAt.toISOString() : null,
      createdAt: m.createdAt.toISOString()
    }));
  }

  async createMessage(data) {
    if (!this.isConfigured()) return null;
    return this.prisma.message.create({
      data: {
        id: data.id,
        channelId: data.channelId,
        authorId: data.authorId || null,
        content: data.content || "",
        attachments: data.attachments || [],
        reactions: data.reactions || {},
        replyToId: data.replyToId || null,
        pinned: !!data.pinned
      }
    });
  }

  async updateMessage(id, updates) {
    if (!this.isConfigured()) return null;
    return this.prisma.message.update({
      where: { id },
      data: {
        content: updates.content,
        editedAt: new Date()
      }
    });
  }

  async deleteMessage(id) {
    if (!this.isConfigured()) return null;
    return this.prisma.message.delete({
      where: { id }
    });
  }

  async toggleReaction(id, emoji, userId) {
    if (!this.isConfigured()) return null;
    const msg = await this.prisma.message.findUnique({ where: { id } });
    if (!msg) return null;
    const reactions = { ...(msg.reactions || {}) };
    const arr = Array.isArray(reactions[emoji]) ? [...reactions[emoji]] : [];
    const idx = arr.indexOf(userId);
    if (idx === -1) {
      arr.push(userId);
    } else {
      arr.splice(idx, 1);
    }
    if (arr.length === 0) {
      delete reactions[emoji];
    } else {
      reactions[emoji] = arr;
    }
    return this.prisma.message.update({
      where: { id },
      data: { reactions }
    });
  }

  async togglePin(id) {
    if (!this.isConfigured()) return null;
    const msg = await this.prisma.message.findUnique({ where: { id } });
    if (!msg) return null;
    return this.prisma.message.update({
      where: { id },
      data: { pinned: !msg.pinned }
    });
  }

  // ---------------------------------------------------------------------------
  // ESTADO TEMPORÁRIO DO USUÁRIO (em chamada / fora de chamada)
  // ---------------------------------------------------------------------------

  async listVoiceStates() {
    if (!this.isConfigured()) return [];
    const states = await this.prisma.voiceState.findMany();
    return states.map((s) => ({
      userId: s.userId,
      serverId: s.serverId,
      channelId: s.channelId,
      muted: s.muted,
      deafened: s.deafened,
      video: s.video,
      screenShare: s.screenShare,
      screenAudio: s.screenAudio,
      screenQuality: s.screenQuality,
      speaking: s.speaking,
      joinedAt: s.joinedAt.toISOString()
    }));
  }

  async setVoiceState(state) {
    if (!this.isConfigured()) return null;
    return this.prisma.voiceState.upsert({
      where: { userId: state.userId },
      create: {
        userId: state.userId,
        serverId: state.serverId || null,
        channelId: state.channelId,
        muted: !!state.muted,
        deafened: !!state.deafened,
        video: !!state.video,
        screenShare: !!state.screenShare,
        screenAudio: !!state.screenAudio,
        screenQuality: state.screenQuality || "1080p60",
        speaking: !!state.speaking
      },
      update: {
        serverId: state.serverId || null,
        channelId: state.channelId,
        muted: !!state.muted,
        deafened: !!state.deafened,
        video: !!state.video,
        screenShare: !!state.screenShare,
        screenAudio: !!state.screenAudio,
        screenQuality: state.screenQuality || "1080p60",
        speaking: !!state.speaking
      }
    });
  }

  async updateVoiceState(userId, updates) {
    if (!this.isConfigured()) return null;
    const data = {};
    if (typeof updates.muted === "boolean") data.muted = updates.muted;
    if (typeof updates.deafened === "boolean") data.deafened = updates.deafened;
    if (typeof updates.video === "boolean") data.video = updates.video;
    if (typeof updates.screenShare === "boolean") data.screenShare = updates.screenShare;
    if (typeof updates.screenAudio === "boolean") data.screenAudio = updates.screenAudio;
    if (typeof updates.screenQuality === "string") data.screenQuality = updates.screenQuality;
    if (typeof updates.speaking === "boolean") data.speaking = updates.speaking;
    return this.prisma.voiceState.update({
      where: { userId },
      data
    }).catch(() => null);
  }

  async removeVoiceState(userId) {
    if (!this.isConfigured()) return null;
    return this.prisma.voiceState.delete({
      where: { userId }
    }).catch(() => null);
  }

  // ---------------------------------------------------------------------------
  // PRESENÇA E AMIZADES
  // ---------------------------------------------------------------------------

  async touchPresence(userId) {
    if (!this.isConfigured()) return null;
    return this.prisma.presence.upsert({
      where: { userId },
      create: { userId, lastSeen: new Date() },
      update: { lastSeen: new Date() }
    }).catch(() => null);
  }

  async listFriendships() {
    if (!this.isConfigured()) return [];
    const rows = await this.prisma.friendship.findMany();
    return rows.map((f) => ({
      id: f.id,
      userA: f.userA,
      userB: f.userB,
      status: f.status,
      createdAt: f.createdAt.toISOString()
    }));
  }

  async createFriendship(rel) {
    if (!this.isConfigured()) return null;
    return this.prisma.friendship.upsert({
      where: { id: rel.id },
      create: {
        id: rel.id,
        userA: rel.userA,
        userB: rel.userB,
        status: rel.status || "accepted"
      },
      update: {
        status: rel.status || "accepted"
      }
    });
  }

  async listDmChannels() {
    if (!this.isConfigured()) return [];
    const rows = await this.prisma.dmChannel.findMany();
    return rows.map((d) => ({
      id: d.id,
      type: "dm",
      participantIds: d.participantIds,
      createdAt: d.createdAt.toISOString(),
      lastMessageAt: d.lastMessageAt.toISOString()
    }));
  }

  async createDmChannel(dm) {
    if (!this.isConfigured()) return null;
    return this.prisma.dmChannel.upsert({
      where: { id: dm.id },
      create: {
        id: dm.id,
        participantIds: dm.participantIds || [],
        lastMessageAt: new Date(dm.lastMessageAt || Date.now())
      },
      update: {
        lastMessageAt: new Date(dm.lastMessageAt || Date.now())
      }
    });
  }
}

module.exports = { ConcordPrisma, prisma: prismaInstance };
