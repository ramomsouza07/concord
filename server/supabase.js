"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Concord Supabase Cloud Database Client
 * - Cliente REST (PostgREST) sem dependências, usando o fetch global do Node.js 18+
 * - Cada entidade (usuários, servidores, canais, membros, convites, amizades, DMs, mensagens)
 *   possui sua PRÓPRIA tabela: escritas são por linha, então instâncias concorrentes
 *   (Vercel Serverless, Desktop, servidor local) nunca sobrescrevem o trabalho umas das outras.
 * - Estado temporário (presença, quem está em chamada, sinais WebRTC e eventos) também fica
 *   em tabelas próprias, compartilhadas por todas as instâncias.
 */

const TABLES = {
  meta: "concord_meta",
  users: "concord_users",
  servers: "concord_servers",
  channels: "concord_channels",
  members: "concord_server_members",
  invites: "concord_invites",
  friendships: "concord_friendships",
  dmChannels: "concord_dm_channels",
  messages: "concord_messages",
  presence: "concord_presence",
  voiceStates: "concord_voice_states",
  signals: "concord_signals",
  events: "concord_events"
};

class SupabaseError extends Error {
  constructor(status, body) {
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch (_) {}
    super(`Supabase HTTP ${status}: ${(parsed && parsed.message) || body || ""}`);
    this.status = status;
    this.code = parsed && parsed.code;
    this.details = parsed;
  }

  /** Tabela/função inexistente (script SQL ainda não executado) */
  isMissingSchema() {
    return (
      this.status === 404 ||
      this.code === "PGRST205" ||
      this.code === "PGRST202" ||
      this.code === "42P01" ||
      this.code === "42883"
    );
  }

  isUniqueViolation() {
    return this.status === 409 || this.code === "23505";
  }
}

function encodeValue(v) {
  return encodeURIComponent(String(v));
}

/** Monta filtro PostgREST `in.(...)` com valores entre aspas */
function inList(values) {
  const quoted = values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",");
  return `in.(${encodeURIComponent(quoted)})`;
}

class ConcordSupabase {
  constructor() {
    this.url = (
      process.env.SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      ""
    ).trim().replace(/\/+$/, "");

    this.key = (
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ""
    ).trim();

    this.enabled = !!(this.url && this.key);
    this.timeoutMs = 8000;
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

    let payload;
    if (body !== null && body !== undefined) {
      reqHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let res;
    try {
      res = await fetch(fullUrl, {
        method,
        headers: reqHeaders,
        body: payload,
        signal: controller ? controller.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new SupabaseError(res.status, text);
    }
    return text ? JSON.parse(text) : null;
  }

  // ---------------------------------------------------------------------------
  // Helpers genéricos de tabela
  // ---------------------------------------------------------------------------

  /** SELECT. `query` é a query string PostgREST (sem "?"), ex: "select=*&id=eq.x" */
  select(table, query = "select=*") {
    return this.request(`/${table}?${query}`);
  }

  /**
   * INSERT / UPSERT.
   * - onConflict: colunas da restrição única (ex: "id")
   * - mode: "strict" (erro em duplicata) | "merge" (atualiza) | "ignore" (mantém existente)
   */
  insert(table, rows, { onConflict = null, mode = "strict", returning = false } = {}) {
    const list = Array.isArray(rows) ? rows : [rows];
    if (list.length === 0) return Promise.resolve([]);
    const prefer = [returning ? "return=representation" : "return=minimal"];
    if (mode === "merge") prefer.push("resolution=merge-duplicates");
    if (mode === "ignore") prefer.push("resolution=ignore-duplicates");
    const qs = onConflict && mode !== "strict" ? `?on_conflict=${onConflict}` : "";
    return this.request(`/${table}${qs}`, {
      method: "POST",
      headers: { Prefer: prefer.join(",") },
      body: list
    });
  }

  /** UPDATE com filtro PostgREST (ex: "id=eq.abc") */
  update(table, filter, patch, { returning = false } = {}) {
    return this.request(`/${table}?${filter}`, {
      method: "PATCH",
      headers: { Prefer: returning ? "return=representation" : "return=minimal" },
      body: patch
    });
  }

  /** DELETE com filtro PostgREST. Com returning=true devolve as linhas removidas. */
  remove(table, filter, { returning = false } = {}) {
    return this.request(`/${table}?${filter}`, {
      method: "DELETE",
      headers: { Prefer: returning ? "return=representation" : "return=minimal" }
    });
  }

  rpc(fn, args = {}) {
    return this.request(`/rpc/${fn}`, { method: "POST", body: args });
  }

  /** Insere em lotes para evitar payloads gigantes (migração) */
  async insertChunked(table, rows, opts = {}, chunkSize = 400) {
    for (let i = 0; i < rows.length; i += chunkSize) {
      await this.insert(table, rows.slice(i, i + chunkSize), opts);
    }
  }

  // ---------------------------------------------------------------------------
  // Legado: estado único em JSON (usado APENAS para migrar dados antigos)
  // ---------------------------------------------------------------------------

  async loadState() {
    if (!this.isConfigured()) return null;
    try {
      const rows = await this.request("/concord_state?key=eq.main&select=data,updated_at");
      if (Array.isArray(rows) && rows.length > 0 && rows[0].data) {
        return rows[0].data;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  async saveState(state) {
    if (!this.isConfigured() || !state) return false;
    try {
      await this.insert(
        "concord_state",
        { key: "main", data: state, updated_at: new Date().toISOString() },
        { onConflict: "key", mode: "merge" }
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Script SQL que cria todas as tabelas (mesmo conteúdo de supabase-setup.sql) */
  static getMigrationSql() {
    const candidates = [
      path.join(__dirname, "..", "supabase-setup.sql"),
      path.join(process.cwd(), "supabase-setup.sql")
    ];
    for (const file of candidates) {
      try {
        if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
      } catch (_) {}
    }
    return "-- Arquivo supabase-setup.sql não encontrado. Copie-o da raiz do projeto Concord.";
  }
}

module.exports = { ConcordSupabase, SupabaseError, TABLES, inList, encodeValue };
