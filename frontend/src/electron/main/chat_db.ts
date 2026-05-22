// Sprint 4 — AI chat persistence (REVIEW-LOG C-05 / BACKEND-INTERFACES §4.5.1).
//
// Sprint 4 introduced per-email AI conversations (Notion Agent + Custom API
// backends). Persisting them in `data/sync_store.db` would violate the
// mail-sync DB_VERSION contract (the backend owns that schema and bumps it
// on its own cadence). The fix is a fully separate SQLite file owned by the
// frontend, with its own version counter and its own migration ladder.
//
//   Default path: ~/.mailagent/frontend/ai_chat.db
//   Override:     env $AI_CHAT_DB_PATH (tests pass `:memory:` here)
//   Schema:       ai_chat_sessions + ai_chat_messages (see CREATE statements below)
//
// The session row is uniqued on (email_id, backend_kind, backend_agent_page_id)
// so re-opening the same conversation (e.g. switching back to a previous
// email) lands on the existing row and the message log keeps growing. A
// switch-email abort flips any streaming message to `aborted` so the
// renderer doesn't try to resume the dropped stream on next mount.

import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

// ── types ───────────────────────────────────────────────────────────────

export type BackendKind = 'notion-agent' | 'custom-api'
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'
export type MessageStatus = 'pending' | 'streaming' | 'complete' | 'error' | 'aborted'

export interface ChatSession {
  id: number
  email_id: number
  backend_kind: BackendKind
  backend_model: string | null
  backend_agent_page_id: string | null
  created_at: number
  updated_at: number
}

export interface ChatMessage {
  id: number
  session_id: number
  role: MessageRole
  content: string
  tokens_input: number | null
  tokens_output: number | null
  cost_usd: number | null
  model: string | null
  status: MessageStatus
  error_message: string | null
  // schema_version=2 (Sprint 4 review opus L carry-forward): JSON blob
  // for backend-specific data that doesn't fit the shared columns. Used
  // today by notion_agent to persist thread_id without abusing the
  // `model` column. Null when no extras. NEVER store secrets here —
  // the field crosses the IPC boundary.
  metadata: string | null
  created_at: number
  updated_at: number
}

export interface OpenSessionInput {
  emailId: number
  backendKind: BackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
}

export interface AppendMessageInput {
  sessionId: number
  role: MessageRole
  content: string
  status: MessageStatus
  model?: string | null
  tokensInput?: number | null
  tokensOutput?: number | null
  costUsd?: number | null
  errorMessage?: string | null
  metadata?: string | null
}

export interface UpdateMessagePatch {
  content?: string
  status?: MessageStatus
  tokensInput?: number | null
  tokensOutput?: number | null
  costUsd?: number | null
  errorMessage?: string | null
  model?: string | null
  metadata?: string | null
}

// ── path resolution ─────────────────────────────────────────────────────

const CHAT_DB_VERSION = 2

export function resolveChatDbPath(): string {
  const fromEnv = process.env['AI_CHAT_DB_PATH']
  if (fromEnv) return fromEnv
  return join(homedir(), '.mailagent', 'frontend', 'ai_chat.db')
}

// ── schema migration ────────────────────────────────────────────────────

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const row = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined
  const current = row ? parseInt(row.value, 10) : 0

  if (current === CHAT_DB_VERSION) return
  if (current > CHAT_DB_VERSION) {
    // Future-self protection. If the user downgrades the app and the DB
    // is from a newer build, refuse to mutate it rather than silently
    // truncate. Renderer surfaces this as "AI chat history needs upgrade".
    throw new Error(
      `ai_chat.db schema is at v${current}, this build only supports v${CHAT_DB_VERSION}. ` +
        `Reinstall the matching frontend or delete the file.`
    )
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    if (current < 1) {
      db.exec(`
        CREATE TABLE ai_chat_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email_id INTEGER NOT NULL,
          backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api')),
          backend_model TEXT,
          backend_agent_page_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (email_id, backend_kind, backend_agent_page_id)
        );

        CREATE TABLE ai_chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL,
          tokens_input INTEGER,
          tokens_output INTEGER,
          cost_usd REAL,
          model TEXT,
          status TEXT NOT NULL
            CHECK (status IN ('pending', 'streaming', 'complete', 'error', 'aborted')),
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX idx_messages_session ON ai_chat_messages(session_id, created_at);
        CREATE INDEX idx_messages_status
          ON ai_chat_messages(status)
          WHERE status IN ('pending', 'streaming');

        CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
      `)
    }
    if (current < 2) {
      // Sprint 4 review (opus L carry-forward): drop the `model = 'notion-agent:<id>'`
      // hack used by Sprint 4 ship to encode thread_id, and store it in a
      // structured JSON column instead. Existing rows keep their `model`
      // value for backward read in `notion_agent.extractTurn()` — the
      // backend prefers metadata when present, falls back to the prefix
      // hack for v1-written rows.
      db.exec('ALTER TABLE ai_chat_messages ADD COLUMN metadata TEXT')
    }
    db.prepare("INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', ?)").run(
      String(CHAT_DB_VERSION)
    )
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// ── singleton ───────────────────────────────────────────────────────────

let _db: Database.Database | null = null

export function getChatDb(): Database.Database {
  if (_db) return _db
  const path = resolveChatDbPath()
  if (path !== ':memory:') {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  _db = new Database(path)
  _db.pragma('journal_mode = WAL')
  _db.pragma('busy_timeout = 2000')
  _db.pragma('foreign_keys = ON')
  migrate(_db)
  return _db
}

export function closeChatDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ── sessions ────────────────────────────────────────────────────────────

export function getOrCreateSession(input: OpenSessionInput): ChatSession {
  const db = getChatDb()
  const now = Date.now()
  const backendAgentPageId = input.backendAgentPageId ?? null
  const backendModel = input.backendModel ?? null

  // SQLite treats UNIQUE NULL columns as always-distinct, so we can't lean
  // on `UNIQUE(email_id, backend_kind, backend_agent_page_id)` alone when
  // backend_agent_page_id is null. Branch by null to keep the lookup well-defined.
  const select =
    backendAgentPageId === null
      ? db.prepare(
          `SELECT * FROM ai_chat_sessions
            WHERE email_id = ? AND backend_kind = ? AND backend_agent_page_id IS NULL`
        )
      : db.prepare(
          `SELECT * FROM ai_chat_sessions
            WHERE email_id = ? AND backend_kind = ? AND backend_agent_page_id = ?`
        )
  const existing = (
    backendAgentPageId === null
      ? select.get(input.emailId, input.backendKind)
      : select.get(input.emailId, input.backendKind, backendAgentPageId)
  ) as ChatSession | undefined

  if (existing) {
    // The conversation's effective model can change between turns (user
    // swaps via BackendSelector) — refresh on touch.
    if (backendModel && backendModel !== existing.backend_model) {
      db.prepare('UPDATE ai_chat_sessions SET backend_model = ?, updated_at = ? WHERE id = ?').run(
        backendModel,
        now,
        existing.id
      )
      return { ...existing, backend_model: backendModel, updated_at: now }
    }
    return existing
  }

  const result = db
    .prepare(
      `INSERT INTO ai_chat_sessions
        (email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.emailId, input.backendKind, backendModel, backendAgentPageId, now, now)

  return {
    id: Number(result.lastInsertRowid),
    email_id: input.emailId,
    backend_kind: input.backendKind,
    backend_model: backendModel,
    backend_agent_page_id: backendAgentPageId,
    created_at: now,
    updated_at: now
  }
}

export function listSessionsForEmail(emailId: number): ChatSession[] {
  return getChatDb()
    .prepare('SELECT * FROM ai_chat_sessions WHERE email_id = ? ORDER BY updated_at DESC')
    .all(emailId) as ChatSession[]
}

export function getSession(sessionId: number): ChatSession | null {
  const row = getChatDb().prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(sessionId) as
    | ChatSession
    | undefined
  return row ?? null
}

export function deleteSession(sessionId: number): void {
  // Message rows go via the CASCADE foreign key — pragma foreign_keys is
  // set ON in getChatDb().
  getChatDb().prepare('DELETE FROM ai_chat_sessions WHERE id = ?').run(sessionId)
}

// ── messages ────────────────────────────────────────────────────────────

export function appendMessage(input: AppendMessageInput): ChatMessage {
  const db = getChatDb()
  const now = Date.now()
  const result = db
    .prepare(
      `INSERT INTO ai_chat_messages
        (session_id, role, content, tokens_input, tokens_output, cost_usd,
         model, status, error_message, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.sessionId,
      input.role,
      input.content,
      input.tokensInput ?? null,
      input.tokensOutput ?? null,
      input.costUsd ?? null,
      input.model ?? null,
      input.status,
      input.errorMessage ?? null,
      input.metadata ?? null,
      now,
      now
    )
  // Bump session updated_at so list ordering reflects fresh activity.
  db.prepare('UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?').run(now, input.sessionId)

  return {
    id: Number(result.lastInsertRowid),
    session_id: input.sessionId,
    role: input.role,
    content: input.content,
    tokens_input: input.tokensInput ?? null,
    tokens_output: input.tokensOutput ?? null,
    cost_usd: input.costUsd ?? null,
    model: input.model ?? null,
    status: input.status,
    error_message: input.errorMessage ?? null,
    metadata: input.metadata ?? null,
    created_at: now,
    updated_at: now
  }
}

export function updateMessage(messageId: number, patch: UpdateMessagePatch): void {
  const db = getChatDb()
  const now = Date.now()
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.content !== undefined) {
    fields.push('content = ?')
    params.push(patch.content)
  }
  if (patch.status !== undefined) {
    fields.push('status = ?')
    params.push(patch.status)
  }
  if (patch.tokensInput !== undefined) {
    fields.push('tokens_input = ?')
    params.push(patch.tokensInput)
  }
  if (patch.tokensOutput !== undefined) {
    fields.push('tokens_output = ?')
    params.push(patch.tokensOutput)
  }
  if (patch.costUsd !== undefined) {
    fields.push('cost_usd = ?')
    params.push(patch.costUsd)
  }
  if (patch.errorMessage !== undefined) {
    fields.push('error_message = ?')
    params.push(patch.errorMessage)
  }
  if (patch.model !== undefined) {
    fields.push('model = ?')
    params.push(patch.model)
  }
  if (patch.metadata !== undefined) {
    fields.push('metadata = ?')
    params.push(patch.metadata)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  params.push(now)
  params.push(messageId)
  db.prepare(`UPDATE ai_chat_messages SET ${fields.join(', ')} WHERE id = ?`).run(...params)
}

export function listMessages(sessionId: number): ChatMessage[] {
  return getChatDb()
    .prepare('SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC')
    .all(sessionId) as ChatMessage[]
}

export function getMessage(messageId: number): ChatMessage | null {
  const row = getChatDb().prepare('SELECT * FROM ai_chat_messages WHERE id = ?').get(messageId) as
    | ChatMessage
    | undefined
  return row ?? null
}

/**
 * Sprint 14 PR B — delete `fromMessageId` and every message in the same
 * session that came after it (inclusive of `fromMessageId`). Used by
 * inline edit: editing a user message truncates the conversation back
 * to that turn so the dispatcher can re-stream a fresh assistant reply.
 *
 * Returns the number of rows removed. Idempotent — calling on an empty
 * range silently returns 0 instead of throwing.
 *
 * Why `>= ?` rather than `> ?`: the caller appends a fresh user message
 * via `appendMessage` after this returns; keeping the old user row would
 * leave duplicate user turns in the history. We delete the whole tail
 * and recreate the edit as a new row to keep `created_at` ordering
 * truthful.
 */
export function deleteMessagesFromId(sessionId: number, fromMessageId: number): number {
  const db = getChatDb()
  const result = db
    .prepare('DELETE FROM ai_chat_messages WHERE session_id = ? AND id >= ?')
    .run(sessionId, fromMessageId)
  return result.changes
}

/**
 * Mark any in-flight (streaming / pending) message in this session as
 * aborted. Called when the renderer switches the active email or the
 * panel is closed mid-stream. Returns the number of rows flipped (used
 * by tests + by the IPC handler to know whether an abort actually had
 * something to abort).
 */
export function abortStreamingMessages(sessionId: number): number {
  const db = getChatDb()
  const now = Date.now()
  const result = db
    .prepare(
      `UPDATE ai_chat_messages
         SET status = 'aborted', updated_at = ?
       WHERE session_id = ?
         AND status IN ('pending', 'streaming')`
    )
    .run(now, sessionId)
  return result.changes
}
