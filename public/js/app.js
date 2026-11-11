"use strict";

/**
 * Concord Application Controller
 * Gerencia autenticação, servidores, canais de texto/voz, DMs, chat rico
 * e o Palco WebRTC P2P Mesh (múltiplas telas simultâneas 1080p/60fps + volume 0-200%).
 */
class ConcordApp {
  constructor() {
    this.gateway = window.concordGateway;
    this.sounds = window.concordSounds;
    this.rtc = new window.ConcordWebRTCMesh(this.gateway, this.sounds);

    // Estado de dados sincronizado com o servidor
    this.me = null;
    this.users = new Map(); // userId -> user
    this.servers = [];
    this.dmChannels = [];
    this.friendships = [];
    this.voiceStates = []; // lista global de quem está em cada canal de voz
    this.masterInviteCode = "CONCORD-AMIGOS-2026";

    // Estado de navegação da UI
    this.authMode = "login"; // 'login' | 'register'
    this.viewMode = "server"; // 'server' | 'home'
    this.activeServerId = "srv_qg_amigos";
    this.activeChannelId = "chn_geral";
    this.activeDmChannelId = null;
    this.friendsTab = "online";
    this.showOnlyPinned = false;

    // Estado do Chat
    this.messagesByChannel = new Map(); // channelId -> Message[]
    this.replyToMessage = null;
    this.editingMessageId = null;
    this.queuedFiles = [];
    this.typingUsers = new Map(); // channelId -> Map(userId -> timeout)
    this.lastTypingSentAt = 0;

    // Estado do Palco WebRTC
    this.stageLayout = "grid"; // 'grid' | 'spotlight'
    this.spotlightTileId = null;
    this.stageExpanded = false;
    this.selectedElectronSourceId = null;
    this.selectedScreenRes = { width: 1920, height: 1080, label: "1080p" };
    this.selectedScreenFps = 60;

    this.init();
  }

  async init() {
    this.bindTitlebarEvents();
    this.bindAuthEvents();
    this.bindNavigationEvents();
    this.bindChatEvents();
    this.bindVoiceAndStageEvents();
    this.bindModalEvents();
    this.bindGatewayEvents();
    this.bindShortcuts();

    const serverInput = document.getElementById("auth-server-url");
    if (serverInput) {
      serverInput.value = this.gateway.serverUrl;
    }

    if (this.gateway.token) {
      try {
        const data = await this.gateway.request("/api/bootstrap");
        this.applyBootstrap(data);
        this.showWorkspace();
        this.gateway.connect();
      } catch (err) {
        const isAuthError =
          err &&
          (err.message.includes("401") ||
            err.message.includes("Sessão expirada") ||
            err.message.includes("não autenticada"));
        if (isAuthError) {
          this.gateway.setToken("");
          localStorage.removeItem("concord_user_session");
          this.showAuthScreen();
        } else {
          // Mantém a sessão ativa e tenta restaurar os dados em cache enquanto reconecta
          const cached = localStorage.getItem("concord_user_session");
          if (cached) {
            try {
              const parsed = JSON.parse(cached);
              this.applyBootstrap(parsed);
              this.showWorkspace();
            } catch (_) {
              this.showAuthScreen();
            }
          } else {
            this.showAuthScreen();
          }
          this.gateway.connect();
        }
      }
    } else {
      this.showAuthScreen();
    }
  }

  // ==========================================================================
  // 1. BARRA DE TÍTULO E ATALHOS GLOBAIS
  // ==========================================================================
  bindTitlebarEvents() {
    document.getElementById("win-minimize").addEventListener("click", () => {
      if (window.ConcordNative && window.ConcordNative.window) {
        window.ConcordNative.window.minimize();
      }
    });

    document.getElementById("win-maximize").addEventListener("click", () => {
      if (window.ConcordNative && window.ConcordNative.window) {
        window.ConcordNative.window.maximize();
      } else if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });

    document.getElementById("win-close").addEventListener("click", () => {
      if (window.ConcordNative && window.ConcordNative.window) {
        window.ConcordNative.window.close();
      }
    });

    document.getElementById("btn-copy-master-invite").addEventListener("click", () => {
      navigator.clipboard.writeText(this.masterInviteCode).catch(() => {});
      const label = document.getElementById("master-invite-label");
      const prev = label.textContent;
      label.textContent = "Copiado!";
      setTimeout(() => {
        label.textContent = prev;
      }, 1500);
    });
  }

  bindShortcuts() {
    if (window.ConcordNative && window.ConcordNative.shortcuts) {
      window.ConcordNative.shortcuts.onTriggered(({ action }) => {
        if (action === "TOGGLE_MUTE") this.handleToggleMute();
        if (action === "TOGGLE_DEAFEN") this.handleToggleDeafen();
      });
    }

    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyM") {
        e.preventDefault();
        this.handleToggleMute();
      } else if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        this.handleToggleDeafen();
      }
    });
  }

  // ==========================================================================
  // 2. AUTENTICAÇÃO E CONFIGURAÇÃO DE SERVIDOR
  // ==========================================================================
  bindAuthEvents() {
    const toggleBtn = document.getElementById("auth-toggle-mode");
    toggleBtn.addEventListener("click", () => {
      this.authMode = this.authMode === "login" ? "register" : "login";
      this.renderAuthMode();
    });

    document.getElementById("btn-test-server").addEventListener("click", async () => {
      const urlInput = document.getElementById("auth-server-url");
      const cleanUrl = this.gateway.setServerUrl(urlInput.value);
      urlInput.value = cleanUrl;
      const btn = document.getElementById("btn-test-server");
      btn.textContent = "Testando...";
      try {
        const res = await this.gateway.request("/api/health");
        btn.textContent = `✅ Online (${res.onlineCount || 0})`;
      } catch (err) {
        btn.textContent = "❌ Offline";
        this.showAuthError(`Não foi possível conectar a ${cleanUrl}: ${err.message}`);
      }
      setTimeout(() => {
        btn.textContent = "Testar";
      }, 2500);
    });

    document.getElementById("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      this.hideAuthError();

      const serverUrlInput = document.getElementById("auth-server-url");
      this.gateway.setServerUrl(serverUrlInput.value);

      const username = document.getElementById("auth-username").value.trim();
      const password = document.getElementById("auth-password").value;
      const displayName = document.getElementById("auth-displayname").value.trim();
      const inviteCode = document.getElementById("auth-invite-code").value.trim();

      const submitBtn = document.getElementById("auth-submit-btn");
      submitBtn.disabled = true;

      try {
        const endpoint =
          this.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
        const result = await this.gateway.request(endpoint, {
          method: "POST",
          body: { username, password, displayName, inviteCode }
        });

        this.gateway.setToken(result.token);
        const bootstrap = await this.gateway.request("/api/bootstrap");
        this.applyBootstrap(bootstrap);
        this.showWorkspace();
        this.gateway.connect();
      } catch (err) {
        this.showAuthError(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  renderAuthMode() {
    const isReg = this.authMode === "register";
    document.getElementById("auth-title").textContent = isReg
      ? "Criar Conta no Grupo"
      : "Boas-vindas de volta!";
    document.getElementById("auth-subtitle").textContent = isReg
      ? "Use o código de convite privado para entrar no Concord dos seus amigos."
      : "Que bom ver você novamente no Concord!";
    document.getElementById("register-fields").classList.toggle("hidden", !isReg);
    document.getElementById("auth-submit-btn").textContent = isReg
      ? "Criar Conta e Entrar"
      : "Entrar no Concord";
    document.getElementById("auth-switch-label").textContent = isReg
      ? "Já possui uma conta?"
      : "Precisa de uma conta para entrar no grupo?";
    document.getElementById("auth-toggle-mode").textContent = isReg
      ? "Fazer Login"
      : "Criar conta com Convite";
    this.hideAuthError();
  }

  showAuthError(msg) {
    const box = document.getElementById("auth-error-box");
    box.textContent = msg;
    box.classList.remove("hidden");
  }

  hideAuthError() {
    document.getElementById("auth-error-box").classList.add("hidden");
  }

  showAuthScreen() {
    document.getElementById("auth-screen").classList.remove("hidden");
    document.getElementById("app-workspace").classList.add("hidden");
  }

  showWorkspace() {
    document.getElementById("auth-screen").classList.add("hidden");
    document.getElementById("app-workspace").classList.remove("hidden");
    this.renderAll();
    this.loadActiveChannelMessages();
  }

  // ==========================================================================
  // 3. BOOTSTRAP & EVENTOS EM TEMPO REAL DO GATEWAY WEBSOCKET
  // ==========================================================================
  applyBootstrap(data) {
    if (!data) return;
    try {
      localStorage.setItem("concord_user_session", JSON.stringify(data));
    } catch (_) {}
    this.me = data.me;
    this.users.clear();
    for (const u of data.users || []) {
      this.users.set(u.id, u);
    }
    this.servers = data.servers || [];
    this.dmChannels = data.dmChannels || [];
    this.friendships = data.friendships || [];
    this.voiceStates = data.voiceStates || [];

    if (data.serverInfo && data.serverInfo.inviteCode) {
      this.masterInviteCode = data.serverInfo.inviteCode;
      document.getElementById("master-invite-label").textContent = this.masterInviteCode;
    }

    if (this.servers.length > 0 && !this.servers.some((s) => s.id === this.activeServerId)) {
      this.activeServerId = this.servers[0].id;
    }
    const srv = this.getActiveServer();
    if (srv) {
      const textChannels = srv.channels.filter((c) => c.type === "text");
      if (textChannels.length > 0 && !srv.channels.some((c) => c.id === this.activeChannelId)) {
        this.activeChannelId = textChannels[0].id;
      }
    }
  }

  bindGatewayEvents() {
    this.gateway.on("GATEWAY_STATUS", ({ connected, pingMs }) => {
      const pill = document.getElementById("gateway-ping-pill");
      const text = document.getElementById("gateway-ping-text");
      if (connected) {
        pill.classList.remove("disconnected");
        text.textContent = `${pingMs} ms`;
      } else {
        pill.classList.add("disconnected");
        text.textContent = "Reconectando...";
      }
    });

    this.gateway.on("PING_UPDATE", ({ pingMs }) => {
      document.getElementById("gateway-ping-text").textContent = `${pingMs} ms`;
      document.getElementById("voice-ping-badge").textContent = `${pingMs} ms`;
    });

    this.gateway.on("READY", (payload) => {
      this.applyBootstrap(payload);
      this.renderAll();
      this.loadActiveChannelMessages();
    });

    this.gateway.on("PRESENCE_UPDATE", ({ users }) => {
      if (Array.isArray(users)) {
        for (const u of users) {
          this.users.set(u.id, u);
          if (this.me && u.id === this.me.id) {
            this.me = u;
          }
        }
        this.renderMePanel();
        this.renderMembersSidebar();
        if (this.viewMode === "home") {
          this.renderChannelsSidebar();
          this.renderFriendsView();
        }
      }
    });

    this.gateway.on("MESSAGE_CREATE", ({ channelId, message }) => {
      const list = this.messagesByChannel.get(channelId) || [];
      if (!list.some((m) => m.id === message.id)) {
        list.push(message);
        this.messagesByChannel.set(channelId, list);
      }
      if (message.authorId !== (this.me && this.me.id)) {
        this.sounds.playMessage();
      }
      if (this.getCurrentTextChannelId() === channelId) {
        this.renderMessages();
      }
    });

    this.gateway.on("MESSAGE_UPDATE", ({ channelId, message }) => {
      const list = this.messagesByChannel.get(channelId) || [];
      const idx = list.findIndex((m) => m.id === message.id);
      if (idx !== -1) {
        list[idx] = message;
        this.messagesByChannel.set(channelId, list);
      }
      if (this.getCurrentTextChannelId() === channelId) {
        this.renderMessages();
      }
    });

    this.gateway.on("MESSAGE_DELETE", ({ channelId, id }) => {
      const list = this.messagesByChannel.get(channelId) || [];
      this.messagesByChannel.set(
        channelId,
        list.filter((m) => m.id !== id)
      );
      if (this.getCurrentTextChannelId() === channelId) {
        this.renderMessages();
      }
    });

    this.gateway.on("TYPING_START", ({ channelId, userId, displayName }) => {
      if (userId === (this.me && this.me.id)) return;
      if (!this.typingUsers.has(channelId)) {
        this.typingUsers.set(channelId, new Map());
      }
      const chMap = this.typingUsers.get(channelId);
      if (chMap.has(userId)) clearTimeout(chMap.get(userId).timer);
      const timer = setTimeout(() => {
        chMap.delete(userId);
        this.renderTypingIndicator();
      }, 3500);
      chMap.set(userId, { displayName, timer });
      this.renderTypingIndicator();
    });

    this.gateway.on("VOICE_STATE_UPDATE", ({ voiceStates }) => {
      this.voiceStates = voiceStates || [];
      this.renderChannelsSidebar();
      this.renderVoiceStage();
      this.renderMembersSidebar();
    });

    this.gateway.on("SERVER_CREATE", ({ server }) => {
      if (!this.servers.some((s) => s.id === server.id)) {
        this.servers.push(server);
      }
      this.renderServersRail();
    });

    this.gateway.on("SERVER_UPDATE", ({ server }) => {
      const idx = this.servers.findIndex((s) => s.id === server.id);
      if (idx !== -1) this.servers[idx] = server;
      else this.servers.push(server);
      this.renderAll();
    });

    this.gateway.on("CHANNEL_CREATE", ({ serverId, channel }) => {
      const srv = this.servers.find((s) => s.id === serverId);
      if (srv && !srv.channels.some((c) => c.id === channel.id)) {
        srv.channels.push(channel);
        this.renderChannelsSidebar();
      }
    });

    this.gateway.on("DM_OPEN", ({ dm }) => {
      if (!this.dmChannels.some((d) => d.id === dm.id)) {
        this.dmChannels.push(dm);
      }
      this.renderChannelsSidebar();
    });

    this.gateway.on("FRIEND_UPDATE", ({ friendship, users }) => {
      if (Array.isArray(users)) {
        for (const u of users) this.users.set(u.id, u);
      }
      if (friendship && !this.friendships.some((f) => f.id === friendship.id)) {
        this.friendships.push(friendship);
      }
      if (this.viewMode === "home") {
        this.renderFriendsView();
      }
    });
  }

  // ==========================================================================
  // 4. NAVEGAÇÃO ENTRE SERVIDORES, CANAIS, AMIGOS E DMS
  // ==========================================================================
  getActiveServer() {
    return this.servers.find((s) => s.id === this.activeServerId) || this.servers[0] || null;
  }

  getCurrentTextChannelId() {
    if (this.viewMode === "home") {
      return this.activeDmChannelId;
    }
    return this.activeChannelId;
  }

  bindNavigationEvents() {
    document.getElementById("btn-home-dms").addEventListener("click", () => {
      this.viewMode = "home";
      this.activeDmChannelId = null;
      this.renderAll();
    });

    document.getElementById("btn-toggle-members").addEventListener("click", () => {
      document.getElementById("members-sidebar").classList.toggle("hidden");
    });

    document.getElementById("btn-header-pinned").addEventListener("click", () => {
      this.showOnlyPinned = !this.showOnlyPinned;
      document
        .getElementById("btn-header-pinned")
        .classList.toggle("danger-active", this.showOnlyPinned);
      this.renderMessages();
    });

    document.getElementById("btn-header-join-voice").addEventListener("click", () => {
      const srv = this.getActiveServer();
      if (!srv) return;
      const firstVoice = srv.channels.find((c) => c.type === "voice");
      if (firstVoice) {
        this.joinVoiceChannel(srv.id, firstVoice.id);
      }
    });

    // Abas de Amigos
    document.querySelectorAll(".friend-tab-btn[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.friendsTab = btn.dataset.tab;
        document.querySelectorAll(".friend-tab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("add-friend-panel").classList.add("hidden");
        this.renderFriendsView();
      });
    });

    document.getElementById("btn-tab-add-friend").addEventListener("click", () => {
      document.getElementById("add-friend-panel").classList.toggle("hidden");
    });

    document.getElementById("btn-send-friend-req").addEventListener("click", async () => {
      const input = document.getElementById("input-add-friend");
      const username = input.value.trim();
      if (!username) return;
      try {
        await this.gateway.request("/api/friends/request", {
          method: "POST",
          body: { username }
        });
        input.value = "";
        document.getElementById("add-friend-panel").classList.add("hidden");
        this.renderFriendsView();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  renderAll() {
    this.renderServersRail();
    this.renderChannelsSidebar();
    this.renderMePanel();
    this.renderMainArea();
    this.renderVoiceConnectionPanel();
    this.renderVoiceStage();
    this.renderMembersSidebar();
  }

  renderServersRail() {
    const homeItem = document.getElementById("rail-home-item");
    homeItem.classList.toggle("active", this.viewMode === "home");

    const listEl = document.getElementById("servers-list");
    listEl.innerHTML = "";

    for (const srv of this.servers) {
      const item = document.createElement("div");
      const isActive = this.viewMode === "server" && this.activeServerId === srv.id;
      item.className = `server-item${isActive ? " active" : ""}`;
      item.title = `${srv.name} (Convite: ${srv.inviteCode})`;

      const initials = srv.name
        .split(/\s+/)
        .map((w) => w[0])
        .join("")
        .slice(0, 3)
        .toUpperCase();

      const iconHtml = srv.icon
        ? `<img src="${this.gateway.resolveAssetUrl(srv.icon)}" alt="${this.escapeHtml(srv.name)}" />`
        : `<span>${this.escapeHtml(initials)}</span>`;

      item.innerHTML = `
        <span class="server-pill"></span>
        <button class="server-icon-btn">${iconHtml}</button>
      `;

      item.addEventListener("click", () => {
        this.viewMode = "server";
        this.activeServerId = srv.id;
        const firstText = srv.channels.find((c) => c.type === "text");
        if (firstText) this.activeChannelId = firstText.id;
        this.renderAll();
        this.loadActiveChannelMessages();
      });

      listEl.appendChild(item);
    }
  }

  renderChannelsSidebar() {
    const titleEl = document.getElementById("sidebar-title");
    const addBtn = document.getElementById("btn-add-channel-top");
    const scrollEl = document.getElementById("channels-scroll");
    scrollEl.innerHTML = "";

    if (this.viewMode === "home") {
      titleEl.textContent = "Mensagens Diretas";
      addBtn.classList.add("hidden");

      const friendsRow = document.createElement("div");
      friendsRow.className = `channel-row${!this.activeDmChannelId ? " active" : ""}`;
      friendsRow.innerHTML = `
        <div class="channel-row-left">
          <span class="channel-symbol">👋</span>
          <span class="channel-name">Amigos</span>
        </div>
      `;
      friendsRow.addEventListener("click", () => {
        this.activeDmChannelId = null;
        this.renderAll();
      });
      scrollEl.appendChild(friendsRow);

      const catTitle = document.createElement("div");
      catTitle.className = "category-header";
      catTitle.style.marginTop = "14px";
      catTitle.textContent = "MENSAGENS DIRETAS";
      scrollEl.appendChild(catTitle);

      for (const dm of this.dmChannels) {
        const otherId = dm.participantIds.find((id) => id !== (this.me && this.me.id)) || dm.participantIds[0];
        const otherUser = this.users.get(otherId) || { displayName: "Amigo", effectiveStatus: "offline" };
        const row = document.createElement("div");
        row.className = `channel-row${this.activeDmChannelId === dm.id ? " active" : ""}`;
        row.innerHTML = `
          <div class="channel-row-left">
            <div class="avatar-wrapper" style="width:28px;height:28px;">
              ${this.renderAvatarHtml(otherUser)}
              <span class="status-dot ${otherUser.effectiveStatus || "offline"}"></span>
            </div>
            <span class="channel-name">${this.escapeHtml(otherUser.displayName)}</span>
          </div>
        `;
        row.addEventListener("click", () => {
          this.activeDmChannelId = dm.id;
          this.renderAll();
          this.loadActiveChannelMessages();
        });
        scrollEl.appendChild(row);
      }
      return;
    }

    const srv = this.getActiveServer();
    if (!srv) return;
    titleEl.textContent = srv.name;
    addBtn.classList.remove("hidden");

    const renderChannelRow = (ch, container) => {
      const isText = ch.type === "text";
      const isActive = isText
        ? this.activeChannelId === ch.id
        : this.rtc.activeChannelId === ch.id || this.activeChannelId === ch.id;

      const row = document.createElement("div");
      row.className = `channel-row${isActive ? " active" : ""}`;
      row.innerHTML = `
        <div class="channel-row-left">
          <span class="channel-symbol">${isText ? "#" : "🔊"}</span>
          <span class="channel-name">${this.escapeHtml(ch.name)}</span>
        </div>
      `;

      row.addEventListener("click", () => {
        this.activeChannelId = ch.id;
        this.showOnlyPinned = false;
        this.renderAll();
        this.loadActiveChannelMessages();
        if (!isText && this.rtc.activeChannelId !== ch.id) {
          this.joinVoiceChannel(srv.id, ch.id);
        }
      });

      container.appendChild(row);

      // Se for canal de voz, lista abaixo dele todos os amigos conectados em tempo real
      if (!isText) {
        const connectedInVoice = this.voiceStates.filter((vs) => vs.channelId === ch.id);
        if (connectedInVoice.length > 0) {
          const membersWrap = document.createElement("div");
          membersWrap.className = "voice-channel-members";

          for (const vs of connectedInVoice) {
            const u = this.users.get(vs.userId) || { displayName: "Amigo" };
            const mItem = document.createElement("div");
            mItem.className = "voice-member-item";
            const isSpeaking =
              vs.userId === (this.me && this.me.id) ? this.rtc.isSpeaking : vs.speaking;

            mItem.innerHTML = `
              <div class="voice-member-left">
                <div class="voice-member-avatar${isSpeaking ? " speaking" : ""}">
                  ${this.renderAvatarInner(u)}
                </div>
                <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${this.escapeHtml(u.displayName)}
                </span>
              </div>
              <div class="voice-member-badges">
                ${vs.screenShare ? `<span class="badge-live">AO VIVO</span>` : ""}
                ${vs.video ? `<span title="Câmera Ligada">📷</span>` : ""}
                ${vs.muted ? `<span title="Microfone Mutado" style="color:var(--status-red);">🔇</span>` : ""}
                ${vs.deafened ? `<span title="Áudio Desativado" style="color:var(--status-red);">🙉</span>` : ""}
              </div>
            `;

            mItem.addEventListener("click", (e) => {
              e.stopPropagation();
              this.activeChannelId = ch.id;
              this.renderAll();
              if (this.rtc.activeChannelId !== ch.id) {
                this.joinVoiceChannel(srv.id, ch.id);
              }
            });

            membersWrap.appendChild(mItem);
          }
          container.appendChild(membersWrap);
        }
      }
    };

    const renderedChannelIds = new Set();
    for (const cat of srv.categories || []) {
      const block = document.createElement("div");
      block.className = "category-block";

      const catHeader = document.createElement("div");
      catHeader.className = "category-header";
      catHeader.innerHTML = `
        <span>▾ ${this.escapeHtml(cat.name)}</span>
      `;
      block.appendChild(catHeader);

      const catChannels = (srv.channels || []).filter((c) => c.categoryId === cat.id);
      for (const ch of catChannels) {
        renderedChannelIds.add(ch.id);
        renderChannelRow(ch, block);
      }

      scrollEl.appendChild(block);
    }

    // Renderiza canais sem categoria associada (evita canais invisíveis)
    const uncategorized = (srv.channels || []).filter((c) => !renderedChannelIds.has(c.id));
    if (uncategorized.length > 0) {
      const block = document.createElement("div");
      block.className = "category-block";

      const catHeader = document.createElement("div");
      catHeader.className = "category-header";
      catHeader.innerHTML = `
        <span>▾ OUTROS CANAIS</span>
      `;
      block.appendChild(catHeader);

      for (const ch of uncategorized) {
        renderChannelRow(ch, block);
      }

      scrollEl.appendChild(block);
    }
  }

  renderMePanel() {
    if (!this.me) return;
    document.getElementById("me-avatar").innerHTML = this.renderAvatarInner(this.me);
    const dot = document.getElementById("me-status-dot");
    dot.className = `status-dot ${this.me.status || "online"}`;
    document.getElementById("me-display-name").textContent = this.me.displayName;
    document.getElementById("me-sub-status").textContent =
      this.me.customStatus || `@${this.me.username}#${this.me.discriminator}`;

    const muteBtn = document.getElementById("btn-self-mute");
    const deafBtn = document.getElementById("btn-self-deafen");
    muteBtn.classList.toggle("danger-active", this.rtc.selfMuted);
    muteBtn.textContent = this.rtc.selfMuted ? "🔇" : "🎙️";
    deafBtn.classList.toggle("danger-active", this.rtc.selfDeafened);
    deafBtn.textContent = this.rtc.selfDeafened ? "🙉" : "🎧";
  }

  renderMainArea() {
    const friendsView = document.getElementById("friends-view");
    const chatArea = document.getElementById("chat-area");
    const symbolEl = document.getElementById("main-channel-symbol");
    const titleEl = document.getElementById("main-channel-title");
    const topicEl = document.getElementById("main-channel-topic");
    const chatInput = document.getElementById("chat-input");

    if (this.viewMode === "home" && !this.activeDmChannelId) {
      friendsView.classList.remove("hidden");
      chatArea.classList.add("hidden");
      symbolEl.textContent = "👋";
      titleEl.textContent = "Amigos";
      topicEl.textContent = `Código de Convite do Grupo: ${this.masterInviteCode}`;
      this.renderFriendsView();
      return;
    }

    friendsView.classList.add("hidden");
    chatArea.classList.remove("hidden");

    if (this.viewMode === "home" && this.activeDmChannelId) {
      const dm = this.dmChannels.find((d) => d.id === this.activeDmChannelId);
      const otherId =
        dm && dm.participantIds.find((id) => id !== (this.me && this.me.id));
      const otherUser = this.users.get(otherId) || { displayName: "Amigo", customStatus: "" };
      symbolEl.textContent = "@";
      titleEl.textContent = otherUser.displayName;
      topicEl.textContent = otherUser.customStatus || "Conversa Direta Privada";
      chatInput.placeholder = `Conversar com @${otherUser.displayName}`;
      this.renderMessages();
      return;
    }

    const srv = this.getActiveServer();
    const channel =
      srv && srv.channels.find((c) => c.id === this.activeChannelId);
    if (channel) {
      const isVoice = channel.type === "voice";
      symbolEl.textContent = isVoice ? "🔊" : "#";
      titleEl.textContent = channel.name;
      topicEl.textContent =
        channel.topic ||
        (isVoice ? "Canal de Voz, Vídeo e Compartilhamento de Tela P2P" : "");
      chatInput.placeholder = `Conversar em ${isVoice ? "🔊" : "#"}${channel.name} (Markdown, ||spoiler|| ou cole imagens com Ctrl+V)`;
    }
    this.renderMessages();
  }

  renderFriendsView() {
    const container = document.getElementById("friends-list-container");
    if (!container) return;
    container.innerHTML = "";

    const humanUsers = Array.from(this.users.values()).filter(
      (u) => !u.isSystem && u.id !== (this.me && this.me.id)
    );
    const filtered =
      this.friendsTab === "online"
        ? humanUsers.filter((u) => u.online)
        : humanUsers;

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:48px 20px;color:var(--text-muted);">
          <img src="/assets/logo-concord.png" alt="Concord" style="width:92px;height:92px;opacity:0.85;margin-bottom:12px;border-radius:50%;" />
          <h3 style="color:var(--text-Header);margin-bottom:6px;">
            ${this.friendsTab === "online" ? "Nenhum amigo online no momento" : "Convide seus amigos para o Concord!"}
          </h3>
          <p style="font-size:13.5px;max-width:440px;margin:0 auto;">
            Envie o link do servidor e o código de convite <strong>${this.escapeHtml(this.masterInviteCode)}</strong> para seus amigos criarem conta e entrarem automaticamente na lista.
          </p>
        </div>
      `;
      return;
    }

    for (const u of filtered) {
      const item = document.createElement("div");
      item.className = "friend-item";
      item.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;">
          <div class="avatar-wrapper" style="width:40px;height:40px;">
            ${this.renderAvatarHtml(u)}
            <span class="status-dot ${u.effectiveStatus || "offline"}"></span>
          </div>
          <div>
            <div style="font-weight:700;color:var(--text-Header);">${this.escapeHtml(u.displayName)} <span style="font-size:12px;color:var(--text-muted);">@${this.escapeHtml(u.username)}</span></div>
            <div style="font-size:12.5px;color:var(--text-muted);">${this.escapeHtml(u.customStatus || (u.online ? "Online" : "Offline"))}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-secondary btn-open-dm" style="height:34px;font-size:12.5px;">💬 Mensagem</button>
          <button class="btn-primary btn-call-friend" style="width:auto;height:34px;padding:0 14px;font-size:12.5px;">🔊 Call</button>
        </div>
      `;

      item.querySelector(".btn-open-dm").addEventListener("click", () => {
        this.openDmWithUser(u.id);
      });

      item.querySelector(".btn-call-friend").addEventListener("click", async () => {
        await this.openDmWithUser(u.id);
        const srv = this.getActiveServer();
        const firstVoice = srv && srv.channels.find((c) => c.type === "voice");
        if (firstVoice) {
          this.joinVoiceChannel(srv.id, firstVoice.id);
        }
      });

      container.appendChild(item);
    }
  }

  async openDmWithUser(targetUserId) {
    try {
      const res = await this.gateway.request("/api/dms/open", {
        method: "POST",
        body: { targetUserId }
      });
      if (!this.dmChannels.some((d) => d.id === res.dm.id)) {
        this.dmChannels.push(res.dm);
      }
      this.viewMode = "home";
      this.activeDmChannelId = res.dm.id;
      this.renderAll();
      this.loadActiveChannelMessages();
    } catch (err) {
      alert(err.message);
    }
  }

  // ==========================================================================
  // 5. CHAT DE TEXTO RICO, MARKDOWN, REAÇÕES, RESPOSTAS E UPLOADS (100 MB)
  // ==========================================================================
  async loadActiveChannelMessages() {
    const channelId = this.getCurrentTextChannelId();
    if (!channelId) return;
    try {
      const res = await this.gateway.request(`/api/channels/${channelId}/messages`);
      this.messagesByChannel.set(channelId, res.messages || []);
      this.renderMessages();
    } catch (_) {}
  }

  bindChatEvents() {
    const form = document.getElementById("chat-form");
    const input = document.getElementById("chat-input");
    const fileInput = document.getElementById("file-upload-input");

    input.addEventListener("input", () => {
      const channelId = this.getCurrentTextChannelId();
      if (!channelId) return;
      const now = Date.now();
      if (now - this.lastTypingSentAt > 2200) {
        this.lastTypingSentAt = now;
        this.gateway.send("TYPING_START", { channelId });
      }
    });

    // Colar imagens direto da área de transferência (Ctrl+V)
    input.addEventListener("paste", (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) {
            this.queuedFiles.push(file);
            this.renderAttachmentQueue();
          }
        }
      }
    });

    // Drag and Drop de arquivos no chat
    const chatArea = document.getElementById("chat-area");
    chatArea.addEventListener("dragover", (e) => {
      e.preventDefault();
    });
    chatArea.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      for (const f of files) {
        this.queuedFiles.push(f);
      }
      this.renderAttachmentQueue();
    });

    document.getElementById("btn-upload-file").addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      for (const f of fileInput.files || []) {
        this.queuedFiles.push(f);
      }
      fileInput.value = "";
      this.renderAttachmentQueue();
    });

    document.getElementById("btn-clear-attachments").addEventListener("click", () => {
      this.queuedFiles = [];
      this.renderAttachmentQueue();
    });

    document.getElementById("btn-cancel-reply").addEventListener("click", () => {
      this.replyToMessage = null;
      this.editingMessageId = null;
      document.getElementById("reply-banner").classList.add("hidden");
    });

    document.getElementById("btn-quick-emoji").addEventListener("click", () => {
      const emojis = ["🔥", "✈️", "😂", "🎮", "❤️", "👍", "🚀"];
      const pick = emojis[Math.floor(Math.random() * emojis.length)];
      input.value += (input.value ? " " : "") + pick;
      input.focus();
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const channelId = this.getCurrentTextChannelId();
      if (!channelId) return;

      const content = input.value.trim();
      if (!content && this.queuedFiles.length === 0) return;

      // Se estiver editando mensagem existente
      if (this.editingMessageId) {
        const msgId = this.editingMessageId;
        this.editingMessageId = null;
        input.value = "";
        document.getElementById("reply-banner").classList.add("hidden");
        try {
          await this.gateway.request(`/api/channels/${channelId}/messages/${msgId}`, {
            method: "PATCH",
            body: { content }
          });
        } catch (err) {
          alert(err.message);
        }
        return;
      }

      const filesToUpload = [...this.queuedFiles];
      const replyId = this.replyToMessage ? this.replyToMessage.id : null;

      input.value = "";
      this.queuedFiles = [];
      this.replyToMessage = null;
      this.renderAttachmentQueue();
      document.getElementById("reply-banner").classList.add("hidden");

      try {
        const uploadedAttachments = [];
        for (const file of filesToUpload) {
          const att = await this.gateway.uploadFile(file);
          uploadedAttachments.push(att);
        }

        await this.gateway.request(`/api/channels/${channelId}/messages`, {
          method: "POST",
          body: {
            content,
            attachments: uploadedAttachments,
            replyToId: replyId
          }
        });
      } catch (err) {
        alert(err.message);
      }
    });

    // Fechar lightbox
    document.getElementById("image-lightbox").addEventListener("click", () => {
      document.getElementById("image-lightbox").classList.add("hidden");
    });
  }

  renderAttachmentQueue() {
    const banner = document.getElementById("attachment-queue-banner");
    const text = document.getElementById("attachment-queue-text");
    if (this.queuedFiles.length === 0) {
      banner.classList.add("hidden");
      return;
    }
    banner.classList.remove("hidden");
    const names = this.queuedFiles.map((f) => f.name).join(", ");
    text.textContent = `📎 ${this.queuedFiles.length} arquivo(s) na fila: ${names}`;
  }

  renderMessages() {
    const container = document.getElementById("messages-scroll");
    if (!container) return;
    const channelId = this.getCurrentTextChannelId();
    let list = this.messagesByChannel.get(channelId) || [];
    if (this.showOnlyPinned) {
      list = list.filter((m) => m.pinned);
    }

    container.innerHTML = "";

    let prevAuthorId = null;
    let prevTime = 0;

    for (const msg of list) {
      const author = this.users.get(msg.authorId) || {
        id: msg.authorId,
        displayName: "Membro",
        username: "membro"
      };
      const createdMs = new Date(msg.createdAt).getTime();
      const isCompact =
        !msg.replyToId &&
        prevAuthorId === msg.authorId &&
        createdMs - prevTime < 5 * 60 * 1000;

      prevAuthorId = msg.authorId;
      prevTime = createdMs;

      const item = document.createElement("div");
      item.className = `message-item${isCompact ? " compact" : ""}`;

      // Reply preview
      let replyHtml = "";
      if (msg.replyToId) {
        const orig = list.find((m) => m.id === msg.replyToId);
        const origAuthor = orig ? this.users.get(orig.authorId) : null;
        replyHtml = `
          <div class="message-reply-preview">
            <strong>@${this.escapeHtml((origAuthor && origAuthor.displayName) || "mensagem")}</strong>
            <span>${this.escapeHtml(orig ? orig.content.slice(0, 70) : "Mensagem original")}</span>
          </div>
        `;
      }

      // Attachments
      let attachmentsHtml = "";
      if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
        const parts = msg.attachments.map((att) => {
          const url = this.gateway.resolveAssetUrl(att.url);
          const mime = String(att.contentType || "").toLowerCase();
          if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(att.name)) {
            return `<img class="att-image" src="${url}" alt="${this.escapeHtml(att.name)}" data-lightbox="${url}" />`;
          }
          if (mime.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(att.name)) {
            return `<video class="att-video" src="${url}" controls preload="metadata"></video>`;
          }
          if (mime.startsWith("audio/") || /\.(mp3|wav|ogg)$/i.test(att.name)) {
            return `<audio src="${url}" controls style="margin-top:4px;"></audio>`;
          }
          const kb = Math.max(1, Math.round((att.size || 0) / 1024));
          return `
            <a class="att-file-card" href="${url}" target="_blank" rel="noopener" style="text-decoration:none;">
              <span style="font-size:24px;">📄</span>
              <div style="min-width:0;">
                <div style="color:var(--text-link);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this.escapeHtml(att.name)}</div>
                <div style="font-size:11.5px;color:var(--text-muted);">${kb} KB</div>
              </div>
            </a>
          `;
        });
        attachmentsHtml = `<div class="message-attachments">${parts.join("")}</div>`;
      }

      // Reactions
      let reactionsHtml = "";
      const reactionEntries = Object.entries(msg.reactions || {});
      if (reactionEntries.length > 0) {
        const pills = reactionEntries.map(([emoji, userIds]) => {
          const iReacted = userIds.includes(this.me && this.me.id);
          return `
            <button class="reaction-pill${iReacted ? " me" : ""}" data-react-emoji="${this.escapeHtml(emoji)}">
              <span>${ emoji }</span>
              <span>${userIds.length}</span>
            </button>
          `;
        });
        reactionsHtml = `<div class="message-reactions">${pills.join("")}</div>`;
      }

      const canModify =
        (this.me && msg.authorId === this.me.id) || (this.me && this.me.isAdmin);

      item.innerHTML = `
        ${replyHtml}
        ${
          !isCompact
            ? `<div class="message-avatar">${this.renderAvatarInner(author)}</div>
               <div class="message-header">
                 <span class="message-author">${this.escapeHtml(author.displayName)}</span>
                 ${author.isSystem ? `<span class="bot-tag">APP</span>` : ""}
                 <span class="message-timestamp">${this.formatTimestamp(msg.createdAt)}</span>
                 ${msg.pinned ? `<span title="Mensagem Fixada" style="font-size:12px;">📌</span>` : ""}
               </div>`
            : ""
        }
        <div class="message-body">${this.formatMarkdown(msg.content)}${
        msg.editedAt ? ` <span style="font-size:11px;color:var(--text-muted);">(editado)</span>` : ""
      }</div>
        ${attachmentsHtml}
        ${reactionsHtml}
        <div class="message-toolbar">
          <button class="toolbar-btn" data-quick-react="👍" title="Reagir 👍">👍</button>
          <button class="toolbar-btn" data-quick-react="❤️" title="Reagir ❤️">❤️</button>
          <button class="toolbar-btn" data-quick-react="🔥" title="Reagir 🔥">🔥</button>
          <button class="toolbar-btn" data-action="reply" title="Responder">↩️</button>
          <button class="toolbar-btn" data-action="pin" title="Fixar/Desafixar">📌</button>
          ${
            canModify
              ? `<button class="toolbar-btn" data-action="edit" title="Editar">✏️</button>
                 <button class="toolbar-btn" data-action="delete" title="Excluir" style="color:var(--status-red);">🗑️</button>`
              : ""
          }
        </div>
      `;

      // Eventos de reação, spoiler, lightbox e ações
      item.querySelectorAll("[data-quick-react], [data-react-emoji]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const emoji = btn.dataset.quickReact || btn.dataset.reactEmoji;
          this.gateway.request(
            `/api/channels/${channelId}/messages/${msg.id}/reactions`,
            { method: "POST", body: { emoji } }
          );
        });
      });

      item.querySelectorAll(".spoiler-span").forEach((sp) => {
        sp.addEventListener("click", () => sp.classList.toggle("revealed"));
      });

      item.querySelectorAll("[data-lightbox]").forEach((img) => {
        img.addEventListener("click", () => {
          document.getElementById("lightbox-img").src = img.dataset.lightbox;
          document.getElementById("image-lightbox").classList.remove("hidden");
        });
      });

      const replyBtn = item.querySelector('[data-action="reply"]');
      if (replyBtn) {
        replyBtn.addEventListener("click", () => {
          this.replyToMessage = msg;
          this.editingMessageId = null;
          document.getElementById("reply-target-author").textContent = author.displayName;
          document.getElementById("reply-banner").classList.remove("hidden");
          document.getElementById("chat-input").focus();
        });
      }

      const pinBtn = item.querySelector('[data-action="pin"]');
      if (pinBtn) {
        pinBtn.addEventListener("click", () => {
          this.gateway.request(`/api/channels/${channelId}/messages/${msg.id}/pin`, {
            method: "POST"
          });
        });
      }

      const editBtn = item.querySelector('[data-action="edit"]');
      if (editBtn) {
        editBtn.addEventListener("click", () => {
          this.editingMessageId = msg.id;
          this.replyToMessage = null;
          document.getElementById("reply-target-author").textContent = "Editando mensagem";
          document.getElementById("reply-banner").classList.remove("hidden");
          const input = document.getElementById("chat-input");
          input.value = msg.content;
          input.focus();
        });
      }

      const delBtn = item.querySelector('[data-action="delete"]');
      if (delBtn) {
        delBtn.addEventListener("click", () => {
          this.gateway.request(`/api/channels/${channelId}/messages/${msg.id}`, {
            method: "DELETE"
          });
        });
      }

      container.appendChild(item);
    }

    container.scrollTop = container.scrollHeight;
  }

  renderTypingIndicator() {
    const el = document.getElementById("typing-indicator");
    const channelId = this.getCurrentTextChannelId();
    const chMap = this.typingUsers.get(channelId);
    if (!chMap || chMap.size === 0) {
      el.textContent = "";
      return;
    }
    const names = Array.from(chMap.values()).map((v) => v.displayName);
    el.textContent = `💬 ${names.join(", ")} está digitando...`;
  }

  // ==========================================================================
  // 6. VOZ, VÍDEO E COMPARTILHAMENTO DE TELA MÚLTIPLO (PALCO WEBRTC P2P MESH)
  // ==========================================================================
  bindVoiceAndStageEvents() {
    this.rtc.onStreamsChanged = () => {
      this.renderVoiceConnectionPanel();
      this.renderVoiceStage();
      this.renderChannelsSidebar();
    };

    this.rtc.onSpeakingChanged = () => {
      this.renderChannelsSidebar();
      this.renderVoiceStage();
    };

    document.getElementById("btn-self-mute").addEventListener("click", () => {
      this.handleToggleMute();
    });

    document.getElementById("btn-self-deafen").addEventListener("click", () => {
      this.handleToggleDeafen();
    });

    document.getElementById("dock-btn-mute").addEventListener("click", () => {
      this.handleToggleMute();
    });

    document.getElementById("dock-btn-deafen").addEventListener("click", () => {
      this.handleToggleDeafen();
    });

    document.getElementById("btn-side-camera").addEventListener("click", () => {
      this.handleToggleCamera();
    });

    document.getElementById("dock-btn-camera").addEventListener("click", () => {
      this.handleToggleCamera();
    });

    document.getElementById("btn-side-screenshare").addEventListener("click", () => {
      this.openScreenShareModal();
    });

    document.getElementById("dock-btn-screen").addEventListener("click", () => {
      if (this.rtc.screenShareEnabled) {
        this.rtc.stopScreenShare(true);
      } else {
        this.openScreenShareModal();
      }
    });

    document.getElementById("btn-voice-disconnect-side").addEventListener("click", () => {
      if (this.me) {
        this.voiceStates = this.voiceStates.filter((vs) => vs.userId !== this.me.id);
      }
      this.rtc.leaveVoiceChannel(true);
      this.renderChannelsSidebar();
      this.renderVoiceConnectionPanel();
      this.renderVoiceStage();
    });

    document.getElementById("dock-btn-leave").addEventListener("click", () => {
      if (this.me) {
        this.voiceStates = this.voiceStates.filter((vs) => vs.userId !== this.me.id);
      }
      this.rtc.leaveVoiceChannel(true);
      this.renderChannelsSidebar();
      this.renderVoiceConnectionPanel();
      this.renderVoiceStage();
    });

    // Alternância de Layout do Palco: Grade vs. Palco/Foco (Spotlight)
    document.getElementById("btn-layout-grid").addEventListener("click", () => {
      this.stageLayout = "grid";
      document.getElementById("btn-layout-grid").classList.add("active");
      document.getElementById("btn-layout-spotlight").classList.remove("active");
      this.renderVoiceStage();
    });

    document.getElementById("btn-layout-spotlight").addEventListener("click", () => {
      this.stageLayout = "spotlight";
      document.getElementById("btn-layout-spotlight").classList.add("active");
      document.getElementById("btn-layout-grid").classList.remove("active");
      this.renderVoiceStage();
    });

    document.getElementById("btn-stage-expand").addEventListener("click", () => {
      this.stageExpanded = !this.stageExpanded;
      document.getElementById("voice-stage").classList.toggle("expanded", this.stageExpanded);
    });
  }

  async joinVoiceChannel(serverId, channelId) {
    if (!this.me) return;
    this.activeChannelId = channelId;

    // Atualiza imediatamente o estado de voz local para feedback instantâneo na UI
    const existingIdx = this.voiceStates.findIndex((vs) => vs.userId === this.me.id);
    const myState = {
      userId: this.me.id,
      channelId,
      serverId,
      muted: this.rtc.selfMuted,
      deafened: this.rtc.selfDeafened,
      video: this.rtc.cameraEnabled,
      speaking: false
    };
    if (existingIdx !== -1) {
      this.voiceStates[existingIdx] = myState;
    } else {
      this.voiceStates.push(myState);
    }

    this.renderAll();
    this.loadActiveChannelMessages();

    await this.rtc.joinVoiceChannel(serverId, channelId, this.me.id, this.voiceStates);
    this.renderVoiceConnectionPanel();
    this.renderVoiceStage();
    this.renderChannelsSidebar();
  }

  handleToggleMute() {
    this.rtc.toggleMute();
    this.renderMePanel();
    this.renderVoiceStage();
  }

  handleToggleDeafen() {
    this.rtc.toggleDeafen();
    this.renderMePanel();
    this.renderVoiceStage();
  }

  async handleToggleCamera() {
    try {
      await this.rtc.toggleCamera();
      this.renderVoiceConnectionPanel();
      this.renderVoiceStage();
    } catch (err) {
      alert(err.message);
    }
  }

  renderVoiceConnectionPanel() {
    const panel = document.getElementById("voice-connection-panel");
    const stage = document.getElementById("voice-stage");

    if (!this.rtc.activeChannelId) {
      panel.classList.add("hidden");
      stage.classList.add("hidden");
      return;
    }

    panel.classList.remove("hidden");
    stage.classList.remove("hidden");

    const srv = this.servers.find((s) => s.id === this.rtc.activeServerId) || this.getActiveServer();
    const ch = srv && srv.channels.find((c) => c.id === this.rtc.activeChannelId);
    const chName = ch ? ch.name : "Call";

    document.getElementById("voice-conn-channel-name").textContent = `${chName} / ${srv ? srv.name : "Concord"}`;
    document.getElementById("stage-channel-label").textContent = chName;

    document.getElementById("btn-side-camera").classList.toggle("active", this.rtc.cameraEnabled);
    document.getElementById("btn-side-screenshare").classList.toggle("active", this.rtc.screenShareEnabled);

    document.getElementById("dock-btn-mute").classList.toggle("danger", this.rtc.selfMuted);
    document.getElementById("dock-btn-mute").textContent = this.rtc.selfMuted ? "🔇 Mutado" : "🎙️ Microfone";

    document.getElementById("dock-btn-deafen").classList.toggle("danger", this.rtc.selfDeafened);
    document.getElementById("dock-btn-deafen").textContent = this.rtc.selfDeafened ? "🙉 Ensurdecido" : "🎧 Áudio";

    document.getElementById("dock-btn-camera").classList.toggle("active", this.rtc.cameraEnabled);
    document.getElementById("dock-btn-screen").classList.toggle("active", this.rtc.screenShareEnabled);
    document.getElementById("dock-btn-screen").textContent = this.rtc.screenShareEnabled
      ? "🛑 Parar Tela"
      : "🖥️ Compartilhar Tela";
  }

  renderVoiceStage() {
    const gridEl = document.getElementById("stage-grid");
    if (!gridEl || !this.rtc.activeChannelId) return;

    const videoTiles = this.rtc.getActiveVideoTiles();
    const participantsInCall = this.voiceStates.filter(
      (vs) => vs.channelId === this.rtc.activeChannelId
    );

    // Garante que eu mesmo apareça na lista imediatamente
    if (this.me && !participantsInCall.some((p) => p.userId === this.me.id)) {
      participantsInCall.unshift({
        userId: this.me.id,
        channelId: this.rtc.activeChannelId,
        muted: this.rtc.selfMuted,
        deafened: this.rtc.selfDeafened,
        video: this.rtc.cameraEnabled,
        screenShare: this.rtc.screenShareEnabled,
        speaking: this.rtc.isSpeaking
      });
    }

    const allStageCards = [];

    // 1. Adiciona todos os tiles de vídeo ativo (Telas Compartilhadas e Câmeras)
    for (const vt of videoTiles) {
      allStageCards.push({
        id: vt.id,
        userId: vt.userId,
        kind: vt.type, // 'screen' | 'camera'
        stream: vt.stream,
        isLocal: vt.isLocal,
        quality: vt.quality || "1080p 60fps"
      });
    }

    // 2. Adiciona cards de avatar para os participantes na call (para quem não está com câmera aberta ou além da tela)
    for (const p of participantsInCall) {
      const hasCamTile = videoTiles.some((vt) => vt.userId === p.userId && vt.type === "camera");
      if (!hasCamTile) {
        allStageCards.push({
          id: `voice_avatar_${p.userId}`,
          userId: p.userId,
          kind: "avatar",
          stream: null,
          isLocal: p.userId === (this.me && this.me.id),
          voiceState: p
        });
      }
    }

    // Auto-seleciona a primeira transmissão de tela se estivermos em modo spotlight
    if (
      this.stageLayout === "spotlight" &&
      (!this.spotlightTileId || !allStageCards.some((c) => c.id === this.spotlightTileId))
    ) {
      const firstScreen = allStageCards.find((c) => c.kind === "screen");
      this.spotlightTileId = firstScreen
        ? firstScreen.id
        : allStageCards[0] && allStageCards[0].id;
    }

    gridEl.classList.toggle("spotlight-mode", this.stageLayout === "spotlight");

    if (this.stageLayout === "spotlight" && allStageCards.length > 0) {
      const primaryCard =
        allStageCards.find((c) => c.id === this.spotlightTileId) || allStageCards[0];
      const secondaryCards = allStageCards.filter((c) => c.id !== primaryCard.id);

      let primaryWrap = gridEl.querySelector(".spotlight-primary");
      if (!primaryWrap) {
        gridEl.innerHTML = "";
        primaryWrap = document.createElement("div");
        primaryWrap.className = "spotlight-primary";
        gridEl.appendChild(primaryWrap);
      }

      this.syncContainerTiles(primaryWrap, [primaryCard]);

      let stripWrap = gridEl.querySelector(".spotlight-strip");
      if (secondaryCards.length > 0) {
        if (!stripWrap) {
          stripWrap = document.createElement("div");
          stripWrap.className = "spotlight-strip";
          gridEl.appendChild(stripWrap);
        }
        this.syncContainerTiles(stripWrap, secondaryCards);
      } else if (stripWrap) {
        stripWrap.remove();
      }
    } else {
      // Modo grade normal
      const pWrap = gridEl.querySelector(".spotlight-primary");
      if (pWrap) {
        gridEl.innerHTML = "";
      }
      this.syncContainerTiles(gridEl, allStageCards);
    }
  }

  syncContainerTiles(container, cards) {
    const desiredIds = new Set(cards.map((c) => c.id));

    // Remove tiles obsoletos
    for (const child of Array.from(container.children)) {
      if (!desiredIds.has(child.dataset.tileId)) {
        child.remove();
      }
    }

    // Adiciona novos ou atualiza existentes sem reconstruir o elemento de vídeo
    for (const card of cards) {
      let tile = container.querySelector(`[data-tile-id="${card.id}"]`);
      const user = this.users.get(card.userId) || { displayName: "Amigo" };
      const vs = this.voiceStates.find((s) => s.userId === card.userId);
      const isSpeaking = card.isLocal ? this.rtc.isSpeaking : vs && vs.speaking;

      if (!tile) {
        tile = this.createStageTileDom(card);
        container.appendChild(tile);
      } else {
        // Atualiza apenas classes de animação e estados dinâmicos
        tile.classList.toggle("speaking", !!isSpeaking);
        const avatarBox = tile.querySelector(".stage-tile-avatar-placeholder");
        if (avatarBox) {
          avatarBox.classList.toggle("avatar-speaking-ring", !!isSpeaking);
        }
        const videoEl = tile.querySelector("video");
        if (videoEl && card.stream && videoEl.srcObject !== card.stream) {
          videoEl.srcObject = card.stream;
          videoEl.play().catch(() => {});
        }
        const volLabel = tile.querySelector(".vol-label");
        const slider = tile.querySelector(".tile-vol-slider");
        if (volLabel && slider) {
          const cur = this.rtc.getUserVolume(card.userId);
          if (document.activeElement !== slider) {
            slider.value = cur;
            volLabel.textContent = `${cur}%`;
          }
        }
      }
    }
  }

  createStageTileDom(card) {
    const user = this.users.get(card.userId) || { displayName: "Amigo" };
    const vs = this.voiceStates.find((s) => s.userId === card.userId);
    const isSpeaking = card.isLocal ? this.rtc.isSpeaking : vs && vs.speaking;

    const tile = document.createElement("div");
    tile.className = `stage-tile${isSpeaking ? " speaking" : ""}`;
    tile.dataset.tileId = card.id;

    if (card.stream) {
      const videoEl = document.createElement("video");
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.muted = true; // O áudio já é reproduzido e amplificado pela cadeia Web Audio API
      videoEl.srcObject = card.stream;
      videoEl.onloadedmetadata = () => {
        videoEl.play().catch(() => {});
      };
      tile.appendChild(videoEl);
      videoEl.play().catch(() => {});
    } else {
      const avatarBox = document.createElement("div");
      avatarBox.className = `stage-tile-avatar-placeholder${isSpeaking ? " avatar-speaking-ring" : ""}`;
      avatarBox.innerHTML = this.renderAvatarInner(user);
      tile.appendChild(avatarBox);
    }

    // Topo: Badge AO VIVO + Resolução/FPS
    const topOverlay = document.createElement("div");
    topOverlay.className = "stage-tile-overlay-top";
    topOverlay.innerHTML = `
      <div>
        ${
          card.kind === "screen"
            ? `<span class="badge-live">🔴 AO VIVO • ${this.escapeHtml(card.quality)}</span>`
            : card.kind === "camera"
            ? `<span class="auth-badge">📷 Câmera</span>`
            : ""
        }
      </div>
      <div></div>
    `;
    tile.appendChild(topOverlay);

    // Rodapé: Nome do amigo + Controle de Volume Individual (0% a 200%) + Tela Cheia
    const bottomOverlay = document.createElement("div");
    bottomOverlay.className = "stage-tile-overlay-bottom";

    const currentVol = this.rtc.getUserVolume(card.userId);
    const isLocalMuted = this.rtc.userLocalMutes.has(card.userId);

    bottomOverlay.innerHTML = `
      <div class="tile-name-tag">
        <span>${this.escapeHtml(user.displayName)}${card.isLocal ? " (Você)" : ""}</span>
        ${card.kind === "screen" ? "<span>🖥️</span>" : ""}
      </div>
      <div class="tile-quick-actions">
        ${
          !card.isLocal
            ? `<button class="icon-btn btn-local-mute" style="width:24px;height:24px;font-size:13px;" title="Mutar/Desmutar para mim">
                 ${isLocalMuted ? "🔇" : "🔊"}
               </button>
               <input type="range" class="tile-vol-slider" min="0" max="200" value="${currentVol}" title="Volume de ${this.escapeHtml(user.displayName)}: ${currentVol}% (0% a 200%)" />
               <span class="vol-label" style="font-size:11px;min-width:34px;color:#fff;">${currentVol}%</span>`
            : ""
        }
        ${
          card.stream
            ? `<button class="icon-btn btn-fullscreen-tile" style="width:24px;height:24px;font-size:13px;" title="Tela Cheia">⛶</button>`
            : ""
        }
      </div>
    `;

    // Impede que clique no slider ou botões troque o modo de foco
    const qa = bottomOverlay.querySelector(".tile-quick-actions");
    if (qa) {
      qa.addEventListener("click", (e) => {
        e.stopPropagation();
      });
    }

    const slider = bottomOverlay.querySelector(".tile-vol-slider");
    const volLabel = bottomOverlay.querySelector(".vol-label");
    if (slider) {
      slider.addEventListener("input", () => {
        const val = Number(slider.value);
        this.rtc.setUserVolume(card.userId, val);
        if (volLabel) volLabel.textContent = `${val}%`;
      });
    }

    const localMuteBtn = bottomOverlay.querySelector(".btn-local-mute");
    if (localMuteBtn) {
      localMuteBtn.addEventListener("click", () => {
        const mutedNow = this.rtc.toggleLocalUserMute(card.userId);
        localMuteBtn.textContent = mutedNow ? "🔇" : "🔊";
      });
    }

    const fsBtn = bottomOverlay.querySelector(".btn-fullscreen-tile");
    if (fsBtn) {
      fsBtn.addEventListener("click", () => {
        const vid = tile.querySelector("video");
        if (vid && vid.requestFullscreen) {
          vid.requestFullscreen().catch(() => {});
        }
      });
    }

    // Clicar no card foca nele no Modo Palco (Spotlight)
    tile.addEventListener("click", () => {
      if (this.stageLayout === "spotlight" && this.spotlightTileId === card.id) {
        this.stageLayout = "grid";
        document.getElementById("btn-layout-grid").classList.add("active");
        document.getElementById("btn-layout-spotlight").classList.remove("active");
      } else {
        this.stageLayout = "spotlight";
        this.spotlightTileId = card.id;
        document.getElementById("btn-layout-spotlight").classList.add("active");
        document.getElementById("btn-layout-grid").classList.remove("active");
      }
      this.renderVoiceStage();
    });

    tile.appendChild(bottomOverlay);
    return tile;
  }

  // ==========================================================================
  // 7. LISTA DE MEMBROS DA BARRA LATERAL DIREITA
  // ==========================================================================
  renderMembersSidebar() {
    const container = document.getElementById("members-list-container");
    if (!container) return;
    container.innerHTML = "";

    const allUsers = Array.from(this.users.values());
    const onlineUsers = allUsers.filter((u) => u.online);
    const offlineUsers = allUsers.filter((u) => !u.online);

    const renderGroup = (title, list, isOffline) => {
      if (list.length === 0) return;
      const header = document.createElement("div");
      header.className = "members-group-title";
      header.textContent = `${title} — ${list.length}`;
      container.appendChild(header);

      for (const u of list) {
        const vs = this.voiceStates.find((s) => s.userId === u.id);
        const row = document.createElement("div");
        row.className = `member-row${isOffline ? " offline" : ""}`;
        row.innerHTML = `
          <div class="avatar-wrapper">
            ${this.renderAvatarHtml(u)}
            <span class="status-dot ${u.effectiveStatus || "offline"}"></span>
          </div>
          <div style="min-width:0;flex:1;">
            <div style="display:flex;align-items:center;gap:5px;">
              <span style="font-weight:600;color:var(--text-Header);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${this.escapeHtml(u.displayName)}
              </span>
              ${u.isSystem ? `<span class="bot-tag">APP</span>` : ""}
              ${vs && vs.screenShare ? `<span class="badge-live">AO VIVO</span>` : ""}
            </div>
            <div style="font-size:11.5px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${this.escapeHtml(u.customStatus || (vs ? "🔊 Em canal de voz" : ""))}
            </div>
          </div>
        `;

        row.addEventListener("click", () => {
          if (!u.isSystem && this.me && u.id !== this.me.id) {
            this.openDmWithUser(u.id);
          }
        });

        container.appendChild(row);
      }
    };

    renderGroup("ONLINE", onlineUsers, false);
    renderGroup("OFFLINE", offlineUsers, true);
  }

  // ==========================================================================
  // 8. MODAIS (COMPARTILHAR TELA "GO LIVE", SERVIDOR, CANAL, CONFIGURAÇÕES)
  // ==========================================================================
  bindModalEvents() {
    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.getElementById(btn.dataset.closeModal).classList.add("hidden");
      });
    });

    // Seleção de Resolução e FPS do Compartilhamento de Tela
    document.querySelectorAll("#screen-res-selector .quality-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document
          .querySelectorAll("#screen-res-selector .quality-pill")
          .forEach((p) => p.classList.remove("selected"));
        pill.classList.add("selected");
        this.selectedScreenRes = {
          width: Number(pill.dataset.width),
          height: Number(pill.dataset.height),
          label: pill.dataset.label
        };
      });
    });

    document.querySelectorAll("#screen-fps-selector .quality-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        document
          .querySelectorAll("#screen-fps-selector .quality-pill")
          .forEach((p) => p.classList.remove("selected"));
        pill.classList.add("selected");
        this.selectedScreenFps = Number(pill.dataset.fps);
      });
    });

    document.getElementById("btn-confirm-screenshare").addEventListener("click", async () => {
      const includeAudio = document.getElementById("screen-include-audio").checked;
      document.getElementById("modal-screenshare").classList.add("hidden");
      try {
        await this.rtc.startScreenShare({
          sourceId: this.selectedElectronSourceId,
          width: this.selectedScreenRes.width,
          height: this.selectedScreenRes.height,
          fps: this.selectedScreenFps,
          includeAudio,
          label: `${this.selectedScreenRes.label} ${this.selectedScreenFps}fps`
        });
      } catch (err) {
        if (!/Permission denied|cancelled/i.test(err.message)) {
          alert(err.message);
        }
      }
    });

    // Modal de Servidor
    document.getElementById("btn-open-server-modal").addEventListener("click", () => {
      document.getElementById("modal-server").classList.remove("hidden");
    });

    document.getElementById("btn-create-server").addEventListener("click", async () => {
      const input = document.getElementById("input-new-server-name");
      const name = input.value.trim();
      if (!name) return;
      try {
        const res = await this.gateway.request("/api/servers", {
          method: "POST",
          body: { name }
        });
        input.value = "";
        document.getElementById("modal-server").classList.add("hidden");
        this.viewMode = "server";
        this.activeServerId = res.server.id;
        this.activeChannelId = res.server.channels[0].id;
        this.renderAll();
        this.loadActiveChannelMessages();
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById("btn-join-server").addEventListener("click", async () => {
      const input = document.getElementById("input-join-server-code");
      const inviteCode = input.value.trim();
      if (!inviteCode) return;
      try {
        const res = await this.gateway.request("/api/servers/join", {
          method: "POST",
          body: { inviteCode }
        });
        input.value = "";
        document.getElementById("modal-server").classList.add("hidden");
        this.viewMode = "server";
        this.activeServerId = res.server.id;
        this.renderAll();
      } catch (err) {
        alert(err.message);
      }
    });

    // Modal de Canal
    document.getElementById("btn-add-channel-top").addEventListener("click", () => {
      document.getElementById("modal-channel").classList.remove("hidden");
    });

    document.getElementById("btn-confirm-create-channel").addEventListener("click", async () => {
      const srv = this.getActiveServer();
      if (!srv) return;
      const type = document.getElementById("select-channel-type").value;
      const name = document.getElementById("input-channel-name").value.trim();
      const topic = document.getElementById("input-channel-topic").value.trim();
      if (!name) return;
      try {
        await this.gateway.request(`/api/servers/${srv.id}/channels`, {
          method: "POST",
          body: { name, type, topic }
        });
        document.getElementById("input-channel-name").value = "";
        document.getElementById("input-channel-topic").value = "";
        document.getElementById("modal-channel").classList.add("hidden");
      } catch (err) {
        alert(err.message);
      }
    });

    // Modal de Configurações
    document.getElementById("btn-open-settings").addEventListener("click", () => {
      this.openSettingsModal();
    });

    document.getElementById("user-panel-profile").addEventListener("click", () => {
      this.openSettingsModal();
    });

    document.getElementById("set-vad-threshold").addEventListener("input", (e) => {
      document.getElementById("vad-val-label").textContent = e.target.value;
    });

    document.getElementById("btn-save-settings").addEventListener("click", async () => {
      const displayName = document.getElementById("set-display-name").value.trim();
      const status = document.getElementById("set-status").value;
      const customStatus = document.getElementById("set-custom-status").value.trim();
      const inputMode = document.getElementById("set-input-mode").value;
      const pttKey = document.getElementById("set-ptt-key").value;
      const vadThreshold = Number(document.getElementById("set-vad-threshold").value);
      const audioIn = document.getElementById("set-audio-input").value;
      const videoIn = document.getElementById("set-video-input").value;

      this.rtc.inputMode = inputMode;
      this.rtc.pttKey = pttKey;
      this.rtc.vadThreshold = vadThreshold;
      this.rtc.selectedAudioInput = audioIn;
      this.rtc.selectedVideoInput = videoIn;

      localStorage.setItem("concord_input_mode", inputMode);
      localStorage.setItem("concord_ptt_key", pttKey);
      localStorage.setItem("concord_vad_threshold", String(vadThreshold));
      localStorage.setItem("concord_audio_input", audioIn);
      localStorage.setItem("concord_video_input", videoIn);

      this.rtc.updateMicTrackEnabled();

      try {
        const res = await this.gateway.request("/api/users/me", {
          method: "PATCH",
          body: { displayName, status, customStatus }
        });
        this.me = res.user;
        this.users.set(this.me.id, { ...this.users.get(this.me.id), ...this.me });
        this.renderMePanel();
        this.renderMembersSidebar();
        document.getElementById("modal-settings").classList.add("hidden");
      } catch (err) {
        alert(err.message);
      }
    });

    document.getElementById("btn-logout").addEventListener("click", async () => {
      await this.rtc.leaveVoiceChannel(false);
      this.gateway.disconnect();
      this.gateway.setToken("");
      document.getElementById("modal-settings").classList.add("hidden");
      this.showAuthScreen();
    });
  }

  async openScreenShareModal() {
    if (!this.rtc.activeChannelId) {
      const srv = this.getActiveServer();
      const firstVoice = srv && srv.channels.find((c) => c.type === "voice");
      if (firstVoice) {
        await this.joinVoiceChannel(srv.id, firstVoice.id);
      }
    }

    const electronSection = document.getElementById("electron-sources-section");
    const grid = document.getElementById("electron-sources-grid");
    this.selectedElectronSourceId = null;

    if (window.ConcordNative && window.ConcordNative.desktopCapture) {
      try {
        const sources = await window.ConcordNative.desktopCapture.getSources({
          types: ["screen", "window"]
        });
        if (sources && sources.length > 0) {
          electronSection.classList.remove("hidden");
          grid.innerHTML = "";
          sources.forEach((src, index) => {
            const card = document.createElement("div");
            card.className = `source-card${index === 0 ? " selected" : ""}`;
            if (index === 0) this.selectedElectronSourceId = src.id;
            card.innerHTML = `
              ${src.thumbnailDataUrl ? `<img src="${src.thumbnailDataUrl}" alt="${this.escapeHtml(src.name)}" />` : ""}
              <div class="source-card-title">${this.escapeHtml(src.name)}</div>
            `;
            card.addEventListener("click", () => {
              grid.querySelectorAll(".source-card").forEach((c) => c.classList.remove("selected"));
              card.classList.add("selected");
              this.selectedElectronSourceId = src.id;
            });
            grid.appendChild(card);
          });
        }
      } catch (_) {
        electronSection.classList.add("hidden");
      }
    } else {
      electronSection.classList.add("hidden");
    }

    document.getElementById("modal-screenshare").classList.remove("hidden");
  }

  async openSettingsModal() {
    if (!this.me) return;
    document.getElementById("set-display-name").value = this.me.displayName || "";
    document.getElementById("set-status").value = this.me.status || "online";
    document.getElementById("set-custom-status").value = this.me.customStatus || "";
    document.getElementById("set-input-mode").value = this.rtc.inputMode;
    document.getElementById("set-ptt-key").value = this.rtc.pttKey;
    document.getElementById("set-vad-threshold").value = this.rtc.vadThreshold;
    document.getElementById("vad-val-label").textContent = this.rtc.vadThreshold;

    // Lista microfones e câmeras conectados
    if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioSel = document.getElementById("set-audio-input");
        const videoSel = document.getElementById("set-video-input");
        audioSel.innerHTML = `<option value="default">Padrão do Sistema</option>`;
        videoSel.innerHTML = `<option value="default">Padrão do Sistema</option>`;

        for (const d of devices) {
          if (d.kind === "audioinput") {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || `Microfone (${d.deviceId.slice(0, 5)})`;
            if (d.deviceId === this.rtc.selectedAudioInput) opt.selected = true;
            audioSel.appendChild(opt);
          } else if (d.kind === "videoinput") {
            const opt = document.createElement("option");
            opt.value = d.deviceId;
            opt.textContent = d.label || `Câmera (${d.deviceId.slice(0, 5)})`;
            if (d.deviceId === this.rtc.selectedVideoInput) opt.selected = true;
            videoSel.appendChild(opt);
          }
        }
      } catch (_) {}
    }

    document.getElementById("modal-settings").classList.remove("hidden");
  }

  // ==========================================================================
  // 9. UTILITÁRIOS DE FORMATAÇÃO (AVATAR, MARKDOWN, TIMESTAMPS)
  // ==========================================================================
  renderAvatarInner(user) {
    if (user && user.avatar) {
      return `<img src="${this.gateway.resolveAssetUrl(user.avatar)}" alt="${this.escapeHtml(user.displayName)}" />`;
    }
    const initial = ((user && user.displayName) || "U")[0].toUpperCase();
    return `<span>${this.escapeHtml(initial)}</span>`;
  }

  renderAvatarHtml(user) {
    const bg = (user && user.bannerColor) || "#5865F2";
    return `<div class="avatar-circle" style="background:${bg};">${this.renderAvatarInner(user)}</div>`;
  }

  formatTimestamp(isoStr) {
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
      return "";
    }
  }

  escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  formatMarkdown(text) {
    let html = this.escapeHtml(text || "");

    // Blocos de código ```...```
    html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre>${code.trim()}</pre>`);
    // Código inline `...`
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    // Negrito **...**
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Itálico *...*
    html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    // Spoiler ||...||
    html = html.replace(/\|\|([^|]+)\|\|/g, `<span class="spoiler-span" title="Clique para revelar spoiler">$1</span>`);
    // Links clicáveis
    html = html.replace(
      /(https?:\/\/[^\s<]+)/g,
      `<a href="$1" target="_blank" rel="noopener" style="color:var(--text-link);">$1</a>`
    );

    return html;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  window.concordApp = new ConcordApp();
});
