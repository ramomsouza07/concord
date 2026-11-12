-- ============================================================================
-- CONCORD — SCRIPT SQL DE CONFIGURAÇÃO DO SUPABASE (v2: tabelas por entidade)
-- ============================================================================
-- Como usar:
-- 1. Acesse https://supabase.com/dashboard e abra o seu projeto.
-- 2. No menu lateral esquerdo, clique em "SQL Editor".
-- 3. Cole todo o código abaixo e clique em "Run" (Executar).
-- 4. Pronto! Na primeira requisição, o Concord migra automaticamente os dados
--    antigos (tabela concord_state ou data/concord.db.json) para as novas tabelas.
--
-- O script é idempotente: pode ser executado mais de uma vez sem perder dados.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- DADOS PERMANENTES
-- ----------------------------------------------------------------------------

-- Configurações globais (código de convite mestre, segredo dos tokens, etc.)
CREATE TABLE IF NOT EXISTS concord_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contas
CREATE TABLE IF NOT EXISTS concord_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  discriminator TEXT NOT NULL DEFAULT '0000',
  password_hash TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  banner_color TEXT NOT NULL DEFAULT '#5865F2',
  status TEXT NOT NULL DEFAULT 'online',
  custom_status TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Servidores (as categorias ficam em JSONB por serem poucas e fixas)
CREATE TABLE IF NOT EXISTS concord_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  owner_id TEXT,
  invite_code TEXT UNIQUE,
  categories JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Canais de texto e voz
CREATE TABLE IF NOT EXISTS concord_channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES concord_servers(id) ON DELETE CASCADE,
  category_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'voice')),
  topic TEXT NOT NULL DEFAULT '',
  bitrate INTEGER,
  user_limit INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS concord_channels_server_idx ON concord_channels (server_id);

-- Membros de cada servidor (uma linha por membro: entradas simultâneas não se sobrescrevem)
CREATE TABLE IF NOT EXISTS concord_server_members (
  server_id TEXT NOT NULL REFERENCES concord_servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES concord_users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (server_id, user_id)
);

-- Códigos de convite
CREATE TABLE IF NOT EXISTS concord_invites (
  code TEXT PRIMARY KEY,
  server_id TEXT REFERENCES concord_servers(id) ON DELETE CASCADE,
  created_by TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Amizades
CREATE TABLE IF NOT EXISTS concord_friendships (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_a, user_b)
);

-- Conversas privadas (DMs)
CREATE TABLE IF NOT EXISTS concord_dm_channels (
  id TEXT PRIMARY KEY,
  participant_ids TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Mensagens (canais de texto e DMs)
CREATE TABLE IF NOT EXISTS concord_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  reactions JSONB NOT NULL DEFAULT '{}'::jsonb,
  reply_to_id TEXT,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS concord_messages_channel_idx ON concord_messages (channel_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- ESTADO TEMPORÁRIO (tempo real) — compartilhado entre todas as instâncias
-- ----------------------------------------------------------------------------

-- Presença: último sinal de vida de cada usuário (online/offline)
CREATE TABLE IF NOT EXISTS concord_presence (
  user_id TEXT PRIMARY KEY,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Quem está em chamada (uma linha por usuário conectado em canal de voz)
CREATE TABLE IF NOT EXISTS concord_voice_states (
  user_id TEXT PRIMARY KEY,
  server_id TEXT,
  channel_id TEXT NOT NULL,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  deafened BOOLEAN NOT NULL DEFAULT FALSE,
  video BOOLEAN NOT NULL DEFAULT FALSE,
  screen_share BOOLEAN NOT NULL DEFAULT FALSE,
  screen_audio BOOLEAN NOT NULL DEFAULT FALSE,
  screen_quality TEXT NOT NULL DEFAULT '1080p60',
  speaking BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS concord_voice_states_channel_idx ON concord_voice_states (channel_id);

-- Fila de sinalização WebRTC (offer/answer/ice) — consumida e apagada pelo destinatário
CREATE TABLE IF NOT EXISTS concord_signals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_user_id TEXT NOT NULL,
  from_user_id TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS concord_signals_target_idx ON concord_signals (target_user_id, id);

-- Log de eventos em tempo real (modo Vercel /api/sync). Limpeza automática após 15 min.
CREATE TABLE IF NOT EXISTS concord_events (
  seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL,
  data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS concord_events_created_idx ON concord_events (created_at);

-- ----------------------------------------------------------------------------
-- FUNÇÕES ATÔMICAS (evitam condições de corrida entre instâncias)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION concord_toggle_reaction(p_message_id TEXT, p_emoji TEXT, p_user_id TEXT)
RETURNS SETOF concord_messages
LANGUAGE plpgsql
AS $$
DECLARE
  r JSONB;
  arr JSONB;
BEGIN
  SELECT reactions INTO r FROM concord_messages WHERE id = p_message_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  r := COALESCE(r, '{}'::jsonb);
  arr := COALESCE(r -> p_emoji, '[]'::jsonb);
  IF arr ? p_user_id THEN
    SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO arr
      FROM jsonb_array_elements_text(arr) AS e
      WHERE e <> p_user_id;
  ELSE
    arr := arr || to_jsonb(p_user_id);
  END IF;
  IF jsonb_array_length(arr) = 0 THEN
    r := r - p_emoji;
  ELSE
    r := jsonb_set(r, ARRAY[p_emoji], arr, TRUE);
  END IF;
  RETURN QUERY UPDATE concord_messages SET reactions = r WHERE id = p_message_id RETURNING *;
END;
$$;

CREATE OR REPLACE FUNCTION concord_increment_invite(p_code TEXT)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE concord_invites SET uses = uses + 1 WHERE UPPER(code) = UPPER(p_code);
$$;

-- ----------------------------------------------------------------------------
-- PERMISSÕES / ROW LEVEL SECURITY
-- ----------------------------------------------------------------------------
-- O servidor Concord acessa o banco pela API REST. As políticas abaixo liberam
-- acesso para a chave 'anon' (compatível com a configuração atual).
--
-- RECOMENDADO: use a chave 'service_role' em SUPABASE_SERVICE_ROLE_KEY (somente no
-- servidor/Vercel, nunca no navegador) e REMOVA as políticas "concord_full_access"
-- (DROP POLICY ...). Assim ninguém consegue ler hashes de senha com a chave pública.
-- ----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'concord_meta', 'concord_users', 'concord_servers', 'concord_channels',
    'concord_server_members', 'concord_invites', 'concord_friendships',
    'concord_dm_channels', 'concord_messages', 'concord_presence',
    'concord_voice_states', 'concord_signals', 'concord_events'
  ]
  LOOP
    EXECUTE format('GRANT ALL ON TABLE %I TO anon, authenticated, service_role', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS concord_full_access ON %I', t);
    EXECUTE format('CREATE POLICY concord_full_access ON %I FOR ALL USING (true) WITH CHECK (true)', t);
  END LOOP;
END;
$$;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION concord_toggle_reaction(TEXT, TEXT, TEXT) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION concord_increment_invite(TEXT) TO anon, authenticated, service_role;

-- Faz a API REST enxergar as novas tabelas imediatamente
NOTIFY pgrst, 'reload schema';
