# ✈️ Concord — Plataforma Privada de Voz, Vídeo e Tela P2P

O **Concord** é uma aplicação completa de comunicação (Desktop Electron + Web App + Servidor Privado) criada a partir da engenharia reversa funcional e arquitetural do Discord (`app-1.0.9267`), projetada especificamente para uso privado entre você e seus amigos — sem limitações de Nitro, com compartilhamento de tela múltiplo em **1080p/1440p a 60 FPS**, áudio do sistema e baixíssima latência via **WebRTC P2P Mesh**.

---

## ⚡ Conexão com Banco de Dados via Prisma ORM + Supabase

Toda a camada de conexão com o banco de dados agora utiliza o **Prisma ORM** (`@prisma/client`), garantindo tipagem estrita, performance nativa e sincronização total com o banco de dados PostgreSQL do **Supabase**.

### 📦 Modelos Gerenciados pelo Prisma (`prisma/schema.prisma`):
- 👥 **`User` (`concord_users`):** Contas de usuários, credenciais criptografadas via PBKDF2, avatares, banners, bio e status.
- 🏰 **`Server` (`concord_servers`):** Servidores do grupo, categorias e dono.
- 🏷️ **`Channel` (`concord_channels`):** Canais de texto e canais de voz/vídeo/tela.
- 🤝 **`ServerMember` (`concord_server_members`):** Relação atômica de membros em cada servidor.
- 💬 **`Message` (`concord_messages`):** Mensagens do chat com reações de emojis, pins, edições e anexos.
- 🔒 **`Invite` (`concord_invites`):** Códigos de convite com contador de usos.
- 👥 **`Friendship` & `DmChannel`:** Amizades e conversas privadas.
- 🎙️ **`VoiceState` (`concord_voice_states`):** **Estado temporário do usuário (em chamada e fora de chamada).** Registra em tempo real se o usuário está conectado em um canal de voz, se está mutado, ensurdecido, transmitindo câmera ou compartilhando tela com áudio do sistema/jogo. Ao sair da call, o registro é removido.
- 🟢 **`Presence` (`concord_presence`):** Timestamp de último sinal de vida para presença online/offline.

---

### ⚙️ Como Conectar o Prisma ao seu Supabase

1. **Obtenha a String de Conexão no Supabase:**
   - Acesse o [Dashboard do Supabase](https://supabase.com/dashboard).
   - Vá em **Project Settings > Database > Connection string > URI**.
   - Copie a URL do **Mode: Transaction** (porta 6543) ou **Session** (porta 5432).

2. **Configure o arquivo [`.env`](file:///C:/Users/Ramom%20Souza/Documents/concord/.env):**
   ```env
   # Substitua [SUA-SENHA-DO-SUPABASE] pela senha do banco cadastrada no Supabase
   DATABASE_URL="postgresql://postgres.ehahgvcvvjwopqcpohhq:[SUA-SENHA-DO-SUPABASE]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
   DIRECT_URL="postgresql://postgres:[SUA-SENHA-DO-SUPABASE]@db.ehahgvcvvjwopqcpohhq.supabase.co:5432/postgres"

   # Credenciais da API REST (para fallback de alta disponibilidade)
   SUPABASE_URL=https://ehahgvcvvjwopqcpohhq.supabase.co
   SUPABASE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
   CONCORD_INVITE_CODE=CONCORD-AMIGOS-2026
   ```

3. **Sincronize o Banco com o Prisma:**
   - Execute no terminal:
     ```bash
     npx prisma db push
     ```
   - Ou execute o script [`supabase-setup.sql`](file:///C:/Users/Ramom%20Souza/Documents/concord/supabase-setup.sql) diretamente no SQL Editor do Supabase.

---

## 🚀 Como Iniciar em 1 Clique (Windows)

Você pode rodar o **Concord** imediatamente clicando duas vezes em:

- **`Iniciar-Concord.bat`**: Inicia o servidor local na porta `3456` e abre a janela Desktop do Concord automaticamente.
- **`Iniciar-Apenas-Servidor.bat`**: Inicia somente o servidor backend caso queira deixá-lo aberto em segundo plano para seus amigos conectarem.

---

## 🔑 Acesso Privado do Grupo

- **Código de Convite Padrão do Grupo:**
  ```
  CONCORD-AMIGOS-2026
  ```
  *(Somente quem possuir este código consegue criar conta na tela de registro).*

---

## ✨ Funcionalidades Principais

- **Voz, Vídeo e Compartilhamento de Tela Múltiplo (WebRTC P2P Mesh):**
  - Múltiplas telas simultâneas em 1080p/1440p a 60 FPS com áudio do jogo/sistema.
  - Alternância entre Modo Grade (`⊞ Grade`) e Modo Palco (`▣ Palco / Foco`).
  - Controle de volume individual por amigo (0% a 200%) com amplificação via GainNode.
  - Detecção de atividade de voz (VAD) com anel verde e Push-to-Talk (PTT).
- **Chat Rico & Uploads de até 100 MB:**
  - Envio de vídeos, prints (`Ctrl+V`), clipes e arquivos sem travamento de Nitro.
  - Reações em mensagens, edição, fixação e respostas.
