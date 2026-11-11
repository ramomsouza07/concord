"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ConcordDatabase,
  hashPassword,
  verifyPassword,
  generateId
} = require("../server/db");

test("1. Autenticação e Hashing Seguro de Senhas", async (t) => {
  const pwd = "minha-senha-secreta-2026";
  const hashed = hashPassword(pwd);
  assert.ok(hashed.includes(":"), "Hash deve conter formato salt:hash");
  assert.equal(verifyPassword(pwd, hashed), true, "Senha correta deve verificar com sucesso");
  assert.equal(verifyPassword("senha-errada", hashed), false, "Senha incorreta deve ser rejeitada");
  assert.equal(verifyPassword("", hashed), false, "Senha vazia deve ser rejeitada");
});

test("2. Registro com Código de Convite Privado e Login", async (t) => {
  const db = new ConcordDatabase();
  const testUsername = `user_${Date.now()}`;

  // Tentativa com convite inválido deve falhar
  assert.throws(
    () => {
      db.registerUser({
        username: testUsername,
        password: "password123",
        displayName: "Teste Inválido",
        inviteCode: "CODIGO-FALSO"
      });
    },
    /Código de convite inválido/i,
    "Deve barrar registro sem o código de convite privado"
  );

  // Registro válido
  const regResult = db.registerUser({
    username: testUsername,
    password: "password123",
    displayName: "Amigo Gamer",
    inviteCode: "CONCORD-AMIGOS-2026"
  });

  assert.ok(regResult.user.id.startsWith("usr_"), "ID de usuário deve ter prefixo usr_");
  assert.equal(regResult.user.username, testUsername);
  assert.ok(regResult.token, "Deve retornar token na criação");

  // Login bem-sucedido
  const session = db.loginUser({ username: testUsername, password: "password123" });
  assert.ok(session.token, "Deve retornar token de autenticação");
  assert.equal(session.user.id, regResult.user.id);

  // Verificação de token
  const retrievedUser = db.getUserByToken(session.token);
  assert.equal(retrievedUser.id, regResult.user.id);

  // Tentativa de registro duplicado
  assert.throws(() => {
    db.registerUser({
      username: testUsername,
      password: "password123",
      displayName: "Duplicado",
      inviteCode: "CONCORD-AMIGOS-2026"
    });
  }, /já está em uso/i);
});

test("3. Servidores, Categorias e Canais de Voz/Texto", async (t) => {
  const db = new ConcordDatabase();
  const srv = db.state.servers[0];
  const adminUser = db.state.users[0];
  assert.ok(srv, "Deve existir servidor inicial QG dos Amigos");
  assert.ok(srv.channels.some((c) => c.type === "text"), "Deve ter canal de texto");
  assert.ok(srv.channels.some((c) => c.type === "voice"), "Deve ter canal de voz");

  // Cria canal de voz novo
  const newChannel = db.createChannel(adminUser.id, srv.id, {
    name: "Transmissões 4K",
    type: "voice",
    topic: "Canal para testes de tela 60fps"
  });

  assert.ok(newChannel.id.startsWith("chn_"));
  assert.equal(newChannel.type, "voice");

  // Limpa o canal de teste para não poluir a base de dados
  srv.channels = srv.channels.filter((c) => c.id !== newChannel.id);
  db.save();
});

test("4. Chat Rico: Envio, Reações, Pin e Exclusão", async (t) => {
  const db = new ConcordDatabase();
  const channel = db.state.servers[0].channels[0];
  const user = db.state.users[0];

  const msg = db.createMessage(user.id, channel.id, {
    content: "Fala galera! Testando Concord com **Markdown** e ||spoiler||",
    attachments: []
  });

  assert.ok(msg.id.startsWith("msg_"));
  assert.equal(msg.content.includes("||spoiler||"), true);

  // Adiciona reação 👍
  const updatedMsg = db.toggleReaction(user.id, channel.id, msg.id, "👍");
  assert.ok(updatedMsg.reactions["👍"].includes(user.id), "Usuário deve estar na reação");

  // Alterna reação (remove se clicar de novo)
  const toggledOffMsg = db.toggleReaction(user.id, channel.id, msg.id, "👍");
  assert.ok(!toggledOffMsg.reactions["👍"] || !toggledOffMsg.reactions["👍"].includes(user.id));

  // Fixar mensagem
  const pinned = db.togglePin(user.id, channel.id, msg.id);
  assert.equal(pinned.pinned, true);

  // Excluir mensagem
  const deleted = db.deleteMessage(user.id, channel.id, msg.id);
  assert.equal(deleted.id, msg.id);
});

test("5. Sinalização WebRTC e Gerenciamento de Canais de Voz", async (t) => {
  const db = new ConcordDatabase();
  const aliceId = "usr_alice";
  const bobId = "usr_bob";

  // Sinalização de stream-meta com identificação explícita de faixas de câmera e tela
  const metaSignal = {
    fromUserId: aliceId,
    channelId: "chn_voz_cinema",
    signalType: "stream-meta",
    meta: {
      cameraTrackId: "track_cam_123",
      screenVideoTrackId: "track_screen_456",
      screenAudioTrackId: "track_screen_aud_789",
      cameraActive: true,
      screenActive: true,
      screenQuality: "1080p 60fps"
    }
  };

  db.enqueueSignal(bobId, metaSignal);
  const queued = db.drainSignals(bobId);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].signalType, "stream-meta");
  assert.equal(queued[0].meta.screenVideoTrackId, "track_screen_456");

  // Fila esvazia após leitura
  const emptyQueue = db.drainSignals(bobId);
  assert.equal(emptyQueue.length, 0);

  // Sinal de encerramento de compartilhamento (track-stopped)
  const stopSignal = {
    fromUserId: aliceId,
    channelId: "chn_voz_cinema",
    signalType: "track-stopped",
    meta: { kind: "screen" }
  };
  db.enqueueSignal(bobId, stopSignal);
  const stopQueued = db.drainSignals(bobId);
  assert.equal(stopQueued[0].signalType, "track-stopped");
  assert.equal(stopQueued[0].meta.kind, "screen");
});

test("6. Simulação do Algoritmo Perfect Negotiation & Detecção de Glare WebRTC", async (t) => {
  // Simula dois participantes negociando oferta concorrente
  const userA = "usr_alice";
  const userB = "usr_bob";

  // userA é lex menor -> initiator / impolite
  // userB é lex maior -> polite
  const isPoliteA = String(userA) > String(userB); // false
  const isPoliteB = String(userB) > String(userA); // true

  assert.equal(isPoliteA, false, "Alice deve ser impolite");
  assert.equal(isPoliteB, true, "Bob deve ser polite");

  // Quando Bob (polite) sofre colisão de oferta (glare):
  const bobMakingOffer = true;
  const bobSignalingState = "have-local-offer";
  const bobReadyForOffer = !bobMakingOffer && (bobSignalingState === "stable");
  const offerCollisionOnBob = !bobReadyForOffer;

  const bobIgnoreOffer = !isPoliteB && offerCollisionOnBob;
  assert.equal(bobIgnoreOffer, false, "Bob (polite) NÃO deve ignorar a oferta; deve efetuar rollback");

  // Quando Alice (impolite) sofre colisão de oferta (glare):
  const aliceMakingOffer = true;
  const aliceSignalingState = "have-local-offer";
  const aliceReadyForOffer = !aliceMakingOffer && (aliceSignalingState === "stable");
  const offerCollisionOnAlice = !aliceReadyForOffer;

  const aliceIgnoreOffer = !isPoliteA && offerCollisionOnAlice;
  assert.equal(aliceIgnoreOffer, true, "Alice (impolite) deve ignorar a oferta conflitante para desempatar");
});

test("7. Endpoints HTTP REST: Health, Auth, Bootstrap e Upload", async (t) => {
  const http = require("node:http");
  const { requestHandler } = require("../server/index");
  const server = http.createServer(requestHandler);
  
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health check
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.equal(healthData.ok, true);
    assert.equal(typeof healthData.onlineCount, "number");

    // 2. Registro via HTTP
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `http_user_${Date.now()}`,
        password: "password123",
        displayName: "HTTP Test User",
        inviteCode: "CONCORD-AMIGOS-2026"
      })
    });
    assert.equal(regRes.status, 201);
    const regData = await regRes.json();
    assert.ok(regData.token, "Deve retornar token no registro HTTP");
    const authToken = regData.token;

    // 3. Bootstrap com autenticação
    const bootRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assert.equal(bootRes.status, 200);
    const bootData = await bootRes.json();
    assert.ok(bootData.me);
    assert.ok(Array.isArray(bootData.servers));
    assert.ok(Array.isArray(bootData.users));

    // 4. Upload de arquivo dentro do limite
    const fileBytes = Buffer.from("Concord audio-video clip test data 2026", "utf8");
    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "text/plain",
        "X-File-Name": "clip-teste.txt",
        "X-File-Type": "text/plain"
      },
      body: fileBytes
    });
    assert.equal(uploadRes.status, 201);
    const uploadData = await uploadRes.json();
    assert.ok(uploadData.attachment.url, "Upload deve retornar URL do anexo");
    assert.equal(uploadData.attachment.name, "clip-teste.txt");

    // 5. Fast-Sync endpoint (/api/sync) para WebRTC e presença
    const syncRes = await fetch(`${baseUrl}/api/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        lastSeq: 0,
        outbox: [
          {
            t: "WEBRTC_SIGNAL",
            d: {
              targetUserId: "usr_concord_bot",
              channelId: "chn_voz_geral",
              signalType: "stream-meta",
              meta: { screenActive: true, screenQuality: "1080p 60fps" }
            }
          }
        ]
      })
    });
    assert.equal(syncRes.status, 200);
    const syncData = await syncRes.json();
    assert.ok(typeof syncData.seq === "number");
    assert.ok(Array.isArray(syncData.voiceStates));

    // 6. Teste de saída limpa no reload (/api/voice/leave com sendBeacon body { token })
    const leaveRes = await fetch(`${baseUrl}/api/voice/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: authToken })
    });
    assert.equal(leaveRes.status, 200);
    const leaveData = await leaveRes.json();
    assert.equal(leaveData.ok, true);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("8. Persistência de Conta com Tokens Assinados e Re-hidratação Stateless", async (t) => {
  const dbA = new ConcordDatabase();
  const testUser = `stateless_${Date.now()}`;
  const reg = dbA.registerUser({
    username: testUser,
    password: "securePassword2026",
    displayName: "Amigo Stateless",
    inviteCode: "CONCORD-AMIGOS-2026"
  });

  assert.ok(reg.token, "Deve gerar token");
  assert.equal(reg.token.split(".").length, 3, "Token deve ter formato JWT assinado (3 partes)");

  // Simula um container cold start / nova instância sem o cache em memória de sessions
  const dbB = new ConcordDatabase();
  dbB.state.sessions = {}; // Zera o cache de sessões em memória

  // O getUserByToken deve validar a assinatura criptográfica e reidratar o usuário mesmo sem o cache
  const rehydrated = dbB.getUserByToken(reg.token);
  assert.ok(rehydrated, "Usuário deve ser reconhecido através da assinatura criptográfica do token");
  assert.equal(rehydrated.username, testUser);
  assert.equal(rehydrated.id, reg.user.id);

  // Token forjado ou adulterado deve ser rejeitado imediatamente
  const forgedToken = reg.token.slice(0, -6) + "000000";
  assert.equal(dbB.getUserByToken(forgedToken), null, "Token com assinatura violada deve ser rejeitado");
});

test("9. Integração com Banco em Nuvem Supabase e Migração Centralizada", async (t) => {
  const { ConcordSupabase } = require("../server/supabase");
  const sql = ConcordSupabase.getMigrationSql();

  assert.ok(sql.includes("CREATE TABLE IF NOT EXISTS concord_state"), "Deve conter script DDL da tabela concord_state");
  assert.ok(sql.includes("data JSONB NOT NULL"), "Estado deve ser armazenado como JSONB para sincronização de alta velocidade");
  assert.ok(sql.includes("ROW LEVEL SECURITY"), "Deve configurar RLS para segurança no Supabase");

  const client = new ConcordSupabase();
  // Quando desconfigurado, isConfigured() é false e métodos retornam null com segurança sem quebrar o app
  assert.equal(client.isConfigured(), false);
  const state = await client.loadState();
  assert.equal(state, null);
  const saved = await client.saveState({ test: 1 });
  assert.equal(saved, false);
});
