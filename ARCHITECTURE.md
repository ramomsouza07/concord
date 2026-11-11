# Engenharia Reversa do Discord (`app-1.0.9267`) & Arquitetura do Concord

Este documento consolida a análise de engenharia reversa da instalação local do Discord Desktop (`app-1.0.9267`) e a especificação técnica implementada no **Concord**.

---

## 1. Mapeamento da Engenharia Reversa do Discord (`app-1.0.9267`)

A inspeção dos pacotes ASAR (`resources/app.asar` e `modules/discord_desktop_core-1/discord_desktop_core/core.asar`) e dos módulos nativos (`discord_voice-1`, `discord_media-1`, `discord_utils-1`) revelou a seguinte arquitetura em 3 camadas:

### 1.1 Bootstrapper (`resources/app.asar` + `build_info.json`)
- **Função no Discord Original:** Carrega a janela de splash (`splashScreenPreload.js`), verifica atualizações de módulos e inicializa o `discord_desktop_core`.
- **Implementação no Concord (`electron/main.js` + `electron/splash.html`):**
  - Exibe a tela de splash animada com o mascote aviador (`logo-concord.png`) e wordmark (`concord.png`) enquanto verifica a disponibilidade do servidor local/remoto.
  - Inicializa a janela principal sem bordas nativas (*frameless window*) com barra de título customizada de `22px`.

### 1.2 Core Desktop & Bridge Nativa (`discord_desktop_core/core.asar`)
- **Função no Discord Original:**
  - `mainScreenPreload.js` injeta `window.DiscordNative` via `contextBridge`, expondo controles de janela (`minimize`, `maximize`, `close`), captura de tela (`desktopCapture`), atalhos globais (`shortcuts`), bandeja do sistema (`tray`) e botões na barra de tarefas do Windows (`thumbar` com ícones de `mute`, `deafen`, `video` e `disconnect`).
- **Implementação no Concord (`electron/preload.js`):**
  - Expõe tanto `window.ConcordNative` quanto `window.DiscordNative` (para compatibilidade direta):
    - `window.minimize()`, `window.maximize()`, `window.close()`, `window.isMaximized()`
    - `desktopCapture.getSources({ types: ['screen', 'window'] })` retornando miniaturas em base64 de todas as telas e janelas de jogos/aplicativos abertos.
    - `shortcuts.registerGlobal(accelerator, action)` para **Push-to-Talk**, **Toggle Mute** (`Ctrl+Shift+M`) e **Toggle Deafen** (`Ctrl+Shift+D`) funcionando mesmo com jogos em tela cheia.
    - `thumbar.setVoiceState({ connected, muted, deafened, video })` e `tray.setState(state)`.

### 1.3 Motor de Voz, Vídeo e Tela (`discord_voice-1/discord_voice/index.js`)
- **Função no Discord Original:**
  - Gerencia conexões de mídia em tempo real com métodos como `setSelfMute`, `setSelfDeafen`, `setLocalVolume(userId, volume)`, `setLocalPan(userId, left, right)`, `setOnSpeakingCallback`, `setVideoBroadcast`, `setDesktopSourceWithOptions({ id, width, height, fps, soundshare })` e `setPTTActive`.
- **Implementação no Concord (`public/js/webrtc-mesh.js`):**
  - **Topologia WebRTC P2P Mesh:** Cada participante em um canal de voz estabelece pares `RTCPeerConnection` diretos com os demais colegas da call (otimizado para grupos de até 6 amigos com latência mínima e sem compressão intermediária).
  - **Multi-Stream (Voz + Webcam + Compartilhamento de Tela c/ Áudio do Sistema):**
    - Suporta **múltiplas transmissões de tela simultâneas** no mesmo canal.
    - Seleção de qualidade destravada: **720p / 1080p / 1440p / Nativo** a **30 FPS ou 60 FPS**, com bitrate configurável até `8 Mbps` (sem trava de Nitro).
    - **Amplificação de Volume Individual (0% a 200%) e Pan Estéreo:** Utiliza um grafo `AudioContext -> MediaStreamSource -> StereoPannerNode -> GainNode -> Destination` por usuário remoto.
    - **Detecção de Atividade de Voz (VAD):** Analisador de espectro (`AnalyserNode`) em tempo real que acende o anel verde (`#23a55a`) ao redor do avatar de quem está falando e suporta modo **Detecção de Voz (Threshold configurável)** ou **Push-to-Talk (PTT)**.

---

## 2. Arquitetura de Backend, Banco de Dados e Rede

- **Protocolo Dual (REST API + Gateway WebSocket):**
  - `POST /api/auth/register` (protegido por `inviteCode` do grupo)
  - `POST /api/auth/login` & `GET /api/auth/me`
  - `GET /api/bootstrap` (retorna servidores, categorias, canais, amigos, DMs, estados de voz ativos e códigos de convite)
  - `POST /api/servers`, `POST /api/ servers/join`, `POST /api/channels`
  - `GET /api/channels/:id/messages`, `POST /api/channels/:id/messages`, `PATCH /api/messages/:id`, `DELETE /api/messages/:id`, `POST /api/messages/:id/reactions`, `POST /api/messages/:id/pin`
  - `POST /api/upload` (suporta envio de arquivos, imagens, vídeos e áudios de até **100 MB** salvos em `data/uploads/`)
  - `POST /api/friends/request`, `POST /api/friends/respond`, `POST /api/dms/open`
  - **Gateway WebSocket (`/ws`):** Eventos em tempo real (`READY`, `PRESENCE_UPDATE`, `MESSAGE_CREATE`, `MESSAGE_UPDATE`, `MESSAGE_DELETE`, `MESSAGE_REACTION_UPDATE`, `TYPING_START`, `VOICE_STATE_UPDATE`, `WEBRTC_SIGNAL`, `SERVER_UPDATE`, `CHANNEL_CREATE`, `FRIEND_UPDATE`).
- **Execução Híbrida (Node.js + Host Nativo Windows .NET):**
  - Se o Node.js estiver instalado, roda via `server/index.js` (com `node:sqlite` / persistência transacional em `data/concord.db.json` e `data/concord.sqlite`).
  - Caso o computador ainda não tenha Node.js instalado no `PATH`, o launcher `Iniciar-Concord.bat` compila e executa automaticamente `server/native-host.ps1` (servidor C# `HttpListener` + `WebSocket` nativo do Windows) e abre o aplicativo Desktop sem exigir nenhuma instalação prévia.
