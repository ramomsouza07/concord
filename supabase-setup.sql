-- ============================================================================
-- CONCORD — SCRIPT SQL DE CONFIGURAÇÃO DO SUPABASE
-- ============================================================================
-- Como usar:
-- 1. Acesse https://supabase.com/dashboard e abra o seu projeto.
-- 2. No menu lateral esquerdo, clique em "SQL Editor".
-- 3. Cole todo o código abaixo e clique em "Run" (Executar).
-- 4. Pronto! O banco está configurado.
-- ============================================================================

-- Cria a tabela central de sincronização do Concord
CREATE TABLE IF NOT EXISTS concord_state (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilita segurança por linha (Row Level Security)
ALTER TABLE concord_state ENABLE ROW LEVEL SECURITY;

-- Permite acesso de leitura e escrita pelo app Concord usando a chave pública (anon)
DROP POLICY IF EXISTS "Acesso livre concord_state" ON concord_state;
CREATE POLICY "Acesso livre concord_state" ON concord_state
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Notificação em tempo real
ALTER PUBLICATION supabase_realtime ADD TABLE concord_state;
