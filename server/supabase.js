"use strict";

/**
 * Concord Supabase Cloud Database Client
 * - Sincronização centralizada de alta disponibilidade para Vercel Serverless, Desktop e Mobile
 * - Elimina problemas de perda de dados e instâncias isoladas (Lambdas efêmeras na Vercel)
 * - Usa API REST nativa do Supabase (PostgREST) com fetch global do Node.js (Zero dependências externas)
 */
class ConcordSupabase {
  constructor() {
    this.url = (
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      ""
    ).replace(/\/+$/, "");

    this.key = (
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_KEY ||
      ""
    ).trim();

    this.enabled = !!(this.url && this.key);
    this.lastFetchedAt = 0;
    this.cacheTtlMs = 1200; // 1.2s de cache para evitar sobrecarga de requisições em rajada
  }

  isConfigured() {
    return !!(this.url && this.key);
  }

  async request(endpoint, { method = "GET", body = null, headers = {} } = {}) {
    if (!this.isConfigured()) return null;
    const fullUrl = `${this.url}/rest/v1${endpoint}`;
    const reqHeaders = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      Accept: "application/json",
      ...headers
    };

    let payload = undefined;
    if (body !== null) {
      reqHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const res = await fetch(fullUrl, {
      method,
      headers: reqHeaders,
      body: payload
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Supabase HTTP ${res.status}: ${errText}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  /**
   * Carrega o estado global compartilhado do Concord salvo no Supabase
   */
  async loadState() {
    if (!this.isConfigured()) return null;
    try {
      const rows = await this.request(
        "/concord_state?key=eq.main&select=data,updated_at"
      );
      if (Array.isArray(rows) && rows.length > 0 && rows[0].data) {
        return rows[0].data;
      }
      return null;
    } catch (err) {
      console.warn("[Supabase] Aviso ao carregar estado da nuvem:", err.message);
      return null;
    }
  }

  /**
   * Salva e sincroniza o estado global com resolução de conflitos (upsert atômico)
   */
  async saveState(state) {
    if (!this.isConfigured() || !state) return false;
    try {
      await this.request("/concord_state", {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates"
        },
        body: {
          key: "main",
          data: state,
          updated_at: new Date().toISOString()
        }
      });
      return true;
    } catch (err) {
      console.warn("[Supabase] Aviso ao persistir estado na nuvem:", err.message);
      return false;
    }
  }

  /**
   * Retorna o script SQL que o usuário precisa executar no Supabase SQL Editor
   */
  static getMigrationSql() {
    return `-- ============================================================================
-- CONCORD - TABELA CENTRAL DE ESTADO NUVEM (SUPABASE)
-- Execute este script no SQL Editor do seu projeto Supabase (https://supabase.com/dashboard)
-- ============================================================================

CREATE TABLE IF NOT EXISTS concord_state (
  key TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Habilita Row Level Security e cria política de acesso total para o app Concord
ALTER TABLE concord_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acesso livre concord_state" ON concord_state;
CREATE POLICY "Acesso livre concord_state" ON concord_state
  FOR ALL
  USING (true)
  WITH CHECK (true);
`;
  }
}

module.exports = { ConcordSupabase };
