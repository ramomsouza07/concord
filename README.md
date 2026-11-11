# ✈️ Concord — Plataforma Privada de Voz, Vídeo e Tela P2P

O **Concord** é uma aplicação completa de comunicação (Desktop Electron + Web App + Servidor Privado) criada a partir da engenharia reversa funcional e arquitetural do Discord (`app-1.0.9267`), projetada especificamente para uso privado entre você e seus amigos — sem limitações de Nitro, com compartilhamento de tela múltiplo em **1080p/1440p a 60 FPS**, áudio do sistema e baixíssima latência via **WebRTC P2P Mesh**.

---

## 🚀 Como Iniciar em 1 Clique (Windows)

Você pode rodar o **Concord** imediatamente clicando duas vezes em:

- **`Iniciar-Concord.bat`**: Inicia o servidor local na porta `3456` e abre a janela Desktop do Concord automaticamente (funciona tanto com **Node.js / Electron** quanto com o **Host Nativo .NET do Windows**, sem exigir instalações prévias).
- **`Iniciar-Apenas-Servidor.bat`**: Inicia somente o servidor backend caso você queira deixá-lo aberto em segundo plano para seus amigos conectarem.

### Rodando com Electron Desktop / Gerando Instalador `.exe` (Opcional)
Caso tenha Node.js instalado e queira rodar o shell Electron completo com captura nativa de janelas e atalhos globais em segundo plano ou gerar o instalador `.exe`:
```bash
npm install
npm run desktop   # Abre o Concord no Electron Desktop
npm run dist      # Gera o instalador .exe na pasta dist/
```

---

## 🔑 Acesso Privado do Grupo e Conectando Seus Amigos

1. **Código de Convite Padrão do Grupo:**
   ```
   CONCORD-AMIGOS-2026
   ```
   *(Somente quem possuir este código consegue criar conta na tela de registro).*

2. **Como seus amigos se conectam ao seu servidor:**
   - **Via Radmin VPN / Tailscale / ZeroTier (Recomendado para Jogos):**
     1. Você abre o `Iniciar-Concord.bat` no seu PC.
     2. Seus amigos abrem o Concord (ou acessam pelo navegador) e colocam no campo **"Servidor Concord"** o seu IP da VPN: `http://SEU_IP_TAILSCALE_OU_RADMIN:3456`.
   - **Via Cloudflare Tunnel / VPS:**
     - Aponte um túnel HTTP para `http://localhost:3456` e informe a URL `https://seu-tunel.trycloudflare.com` no campo **"Servidor Concord"** na tela de login.

---

## ✨ Funcionalidades Implementadas

- **Layout Clássico de 4 Colunas do Discord + Identidade Visual Concord (`logo-concord.png` & `concord.png`):**
  - Barra de título customizada sem bordas (*frameless*) com medidor de ping em tempo real (`ms`) e botão rápido para copiar o código de convite.
  - Lista de servidores com pílula lateral animada, categorias expansíveis, canais de texto (`#`) e canais de voz (`🔊`).
  - Participantes visíveis em tempo real abaixo do canal de voz com **anel verde piscando ao falar**, badge vermelho **`AO VIVO`** quando compartilhando a tela e ícones de câmera/mute/deafen.
- **Voz, Vídeo e Compartilhamento de Tela Múltiplo (WebRTC P2P Mesh):**
  - **Múltiplas Telas Simultâneas:** Vários amigos podem compartilhar a tela e abrir a câmera ao mesmo tempo.
  - **Modo Grade (`⊞ Grade`) e Modo Palco/Foco (`▣ Palco / Foco`):** Clique em qualquer transmissão para destacá-la em tamanho grande enquanto os demais amigos ficam na faixa inferior, ou abra em **Tela Cheia (Fullscreen)**.
  - **Qualidade Destravada ("Go Live"):** Escolha entre **720p, 1080p FHD, 1440p QHD ou 4K/Nativo** a **30 FPS ou 60 FPS**, com **Áudio do Sistema / Jogo**.
  - **Controle de Volume Individual (0% a 200%):** Slider de volume em cada card de amigo na call amplificado via *Web Audio API (`GainNode`)* até **200%**, além de botão de Mute Local.
  - **Detecção de Voz (VAD) e Push-to-Talk (PTT):** Configurável no menu `⚙️ Configurações`, além dos atalhos `Ctrl+Shift+M` (Mutar Microfone) e `Ctrl+Shift+D` (Desativar Áudio).
- **Chat de Texto Rico & Mensagens Diretas (DMs):**
  - Formatação Markdown (`**negrito**`, `*itálico*`, `` `código` ``, ` ```bloco``` `, `||spoiler||`, links clicáveis).
  - **Uploads de até 100 MB:** Envie imagens (com Lightbox), vídeos (player nativo), áudios e arquivos arrastando para o chat, clicando no botão `+` ou colando prints com `Ctrl+V`.
  - **Respostas (Replies), Edição, Exclusão, Mensagens Fixadas (`📌`) e Reações com Emojis (`👍`, `❤️`, `🔥`).**
