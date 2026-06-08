// Sprint 4 — AI chat persistence (REVIEW-LOG C-05 / BACKEND-INTERFACES §4.5.1).
//
// Sprint 4 introduced per-email AI conversations (Notion Agent + Custom API
// backends). Persisting them in `data/sync_store.db` would violate the
// mail-sync DB_VERSION contract (the backend owns that schema and bumps it
// on its own cadence). The fix is a fully separate SQLite file owned by the
// frontend, with its own version counter and its own migration ladder.
//
//   Default path: <DATA_ROOT>/frontend/ai_chat.db — DATA_ROOT 经 db.ts resolveDataRoot()
//                 解析 (packaged = userData; dev = ~/Documents/MailAgent), 与 sync_store.db /
//                 .env 同根, 满足打包 epic「可写数据归集 userData」(随 userData 跨重装保留)。
//                 旧默认 ~/.mailagent/frontend/ai_chat.db 由 getChatDb() 首次打开时一次性
//                 搬迁 (含 -wal/-shm), 保住已装用户的 chat history。
//   Override:     env $AI_CHAT_DB_PATH (tests pass `:memory:` here)
//   Schema:       ai_chat_sessions + ai_chat_messages (see CREATE statements below)
//
// The session row is uniqued on (email_id, backend_kind, backend_agent_page_id)
// so re-opening the same conversation (e.g. switching back to a previous
// email) lands on the existing row and the message log keeps growing. A
// switch-email abort flips any streaming message to `aborted` so the
// renderer doesn't try to resume the dropped stream on next mount.

import Database from 'better-sqlite3'
import { existsSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

import { resolveDataRoot } from './db'

// ── types ───────────────────────────────────────────────────────────────
// V2.1 阶段 3：数据模型类型下沉到 shared/chat/model.ts（B-pure-unified —
// harness 在 UI 进程跑需要这些类型但不能引 better-sqlite3）。下方 import 供
// 本文件函数签名使用；re-export 保既有 importer（dispatcher / harness /
// kos_save / registry / handlers/chat）的 `from '../chat_db'` 路径不变。
import type {
  AppendMessageInput,
  AppendToolCallInput,
  BackendKind,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  ChatToolCall,
  ConfirmationTier,
  MessageRole,
  MessageStatus,
  OpenSessionInput,
  ToolCallStatus,
  UpdateMessagePatch,
  UpdateToolCallPatch
} from '@shared/chat/model'

export type {
  AppendMessageInput,
  AppendToolCallInput,
  BackendKind,
  ChatMessage,
  ChatSession,
  ChatSessionSummary,
  ChatToolCall,
  ConfirmationTier,
  MessageRole,
  MessageStatus,
  OpenSessionInput,
  ToolCallStatus,
  UpdateMessagePatch,
  UpdateToolCallPatch
}

// ── path resolution ─────────────────────────────────────────────────────

const CHAT_DB_VERSION = 5

export function resolveChatDbPath(): string {
  const fromEnv = process.env['AI_CHAT_DB_PATH']
  if (fromEnv) return fromEnv
  // DATA_ROOT/frontend/ai_chat.db — 与 sync_store.db / .env 同根 (packaged=userData,
  // dev=~/Documents/MailAgent)。打包 epic: 可写数据归集 userData, 卸载/重装随 userData 保留。
  return join(resolveDataRoot(), 'frontend', 'ai_chat.db')
}

/** 旧默认 ~/.mailagent/frontend/ai_chat.db (改用 DATA_ROOT 之前的落点) 的一次性搬迁。
 *  仅当「用新默认路径 + 新位置还没库 + 旧库存在」时把旧库整体 move 到新位置, 保住已装
 *  用户的 chat history。连 -wal/-shm 一起搬 (WAL 模式未 checkpoint 的数据在 -wal 里,
 *  单搬主文件会丢)。失败不阻断启动 (退化为新位置开空库)。env override / :memory: / 新旧
 *  恰好同路径 均跳过。仅 getChatDb() 首次打开前调用, 故不在 module-eval 期触发。 */
function migrateLegacyChatDbIfNeeded(targetPath: string): void {
  if (targetPath === ':memory:') return
  if (process.env['AI_CHAT_DB_PATH']) return // 自定义路径 → 不碰旧默认
  if (existsSync(targetPath)) return // 新位置已有库 (迁过了 / 已是新数据)
  const legacyPath = join(homedir(), '.mailagent', 'frontend', 'ai_chat.db')
  if (legacyPath === targetPath) return // 极端: 新旧解析到同一路径
  if (!existsSync(legacyPath)) return // 全新用户, 无旧库
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    for (const suffix of ['', '-wal', '-shm']) {
      const src = legacyPath + suffix
      if (existsSync(src)) renameSync(src, targetPath + suffix)
    }
    console.log(`[chat_db] 旧 ai_chat.db 已搬迁到 ${targetPath} (保留 chat history)`)
  } catch (err) {
    console.error('[chat_db] 旧 ai_chat.db 搬迁失败, 以空库继续 (history 未迁移)', err)
  }
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
    if (current < 3) {
      // Sprint 19 — agent harness foundation. Four new tables:
      //  1. chat_tool_call: per-tool-use audit (input/output/status/duration/
      //     confirmation_tier). One row per Anthropic `tool_use` block the
      //     LLM proposes. `tool_use_id` is the Anthropic toolu_xxx id and
      //     MUST be stable across history serialization (we round-trip it
      //     in the next-turn `tool_result.tool_use_id`).
      //  2. wiki_pages: LLM Wiki SSoT (one markdown page per concept).
      //     Schema landed at v3 even though only M2 tools start writing —
      //     keeps the migration ladder short, no second-bump pain.
      //  3. wiki_fts: FTS5 virtual + 3 triggers to mirror wiki_pages.body_markdown.
      //  4. agent_memory_kv: gbrain-style structured key/value Facts pulled
      //     out of wiki page metadata. Keyed by (scope, key).
      //
      // M1 ships only chat_tool_call writes. wiki_* tables sit idle until
      // M2 PR-2c wires the wiki_read / wiki_write tools.
      db.exec(`
        CREATE TABLE chat_tool_call (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
          tool_use_id TEXT NOT NULL,
          tool_name TEXT NOT NULL,
          input_json TEXT NOT NULL,
          user_edited_input_json TEXT,
          output_json TEXT,
          status TEXT NOT NULL
            CHECK (status IN ('pending', 'confirmed', 'running', 'ok', 'error', 'canceled')),
          duration_ms INTEGER,
          confirmation_tier TEXT NOT NULL
            CHECK (confirmation_tier IN ('silent', 'preview', 'edit')),
          confirmed_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (message_id, tool_use_id)
        );

        CREATE INDEX idx_tool_call_message ON chat_tool_call(message_id);
        CREATE INDEX idx_tool_call_status_inflight
          ON chat_tool_call(status)
          WHERE status IN ('pending', 'confirmed', 'running');

        CREATE TABLE wiki_pages (
          path TEXT PRIMARY KEY,
          scope TEXT NOT NULL,
          slug TEXT,
          body_markdown TEXT NOT NULL,
          refs_json TEXT,
          source_messages_json TEXT,
          updated_by TEXT NOT NULL DEFAULT 'agent',
          mtime_ns INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_wiki_scope_slug ON wiki_pages(scope, slug);

        -- FTS5 contentful mode: column names MUST match the underlying
        -- content table's columns so SQLite can auto-join on SELECT (see
        -- src/mail/sync_store.py:471 email_body_fts for the same pattern).
        -- If you rename FTS columns out-of-sync with wiki_pages, queries
        -- like SELECT body_markdown FROM wiki_fts will fail with
        -- "no such column" — FTS5 looks them up on the content table.
        CREATE VIRTUAL TABLE wiki_fts USING fts5(
          path UNINDEXED,
          body_markdown,
          content='wiki_pages',
          content_rowid='rowid',
          tokenize='porter unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
          INSERT INTO wiki_fts(rowid, path, body_markdown)
          VALUES (new.rowid, new.path, new.body_markdown);
        END;
        CREATE TRIGGER wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
          INSERT INTO wiki_fts(wiki_fts, rowid, path, body_markdown)
          VALUES ('delete', old.rowid, old.path, old.body_markdown);
        END;
        CREATE TRIGGER wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
          INSERT INTO wiki_fts(wiki_fts, rowid, path, body_markdown)
          VALUES ('delete', old.rowid, old.path, old.body_markdown);
          INSERT INTO wiki_fts(rowid, path, body_markdown)
          VALUES (new.rowid, new.path, new.body_markdown);
        END;

        CREATE TABLE agent_memory_kv (
          scope TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          source_wiki_path TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, key)
        );
      `)
    }
    // v1/v2/v3 are additive schema changes — safe in a single transaction.
    // v4 has to run OUTSIDE this transaction because it needs PRAGMA
    // foreign_keys=OFF (see block below for why). Bump to v3 here so the
    // v4 block sees the correct starting version even on fresh installs.
    db.prepare(
      "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '3')"
    ).run()
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // v3 → v4 — drop UNIQUE on ai_chat_sessions(email_id, backend_kind,
  // backend_agent_page_id) so chat.newSession() can INSERT a fresh row
  // instead of UNIQUE blocking + getOrCreateSession resurrecting the
  // latest one. Sprint 14 PR A's "多 session per email" sidebar was
  // missing this drop; bug surfaced 2026-05-23 dogfood.
  //
  // SQLite has no ALTER TABLE DROP CONSTRAINT — 12-step ALTER pattern:
  //   CREATE NEW (without UNIQUE) → INSERT SELECT old → DROP old → RENAME.
  //
  // Critical: PRAGMA foreign_keys=OFF before the transaction. DROP TABLE
  // ai_chat_sessions with foreign_keys=ON is documented as "implicit
  // DELETE for each row" — that DELETE then cascades through
  // ai_chat_messages's `ON DELETE CASCADE` FK and wipes all message rows.
  // PRAGMA defer_foreign_keys only defers VIOLATION checks; it does NOT
  // disable CASCADE actions, so it doesn't help here. And PRAGMA
  // foreign_keys can't change inside a transaction (SQLite silently
  // ignores it). So this block runs out-of-transaction, then opens its
  // own transaction for atomicity of the schema swap, then re-enables FK
  // checking + sanity-checks integrity via PRAGMA foreign_key_check.
  if (current < 4) {
    db.pragma('foreign_keys = OFF')
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(`
          CREATE TABLE ai_chat_sessions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id INTEGER NOT NULL,
            backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api')),
            backend_model TEXT,
            backend_agent_page_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          INSERT INTO ai_chat_sessions_new
            (id, email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
            SELECT id, email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at
            FROM ai_chat_sessions;
          DROP TABLE ai_chat_sessions;
          ALTER TABLE ai_chat_sessions_new RENAME TO ai_chat_sessions;
          DROP INDEX IF EXISTS idx_sessions_email;
          CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
        `)
        db.prepare(
          "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '4')"
        ).run()
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
      if (violations.length > 0) {
        throw new Error(`chat_db v3→v4 migration left FK violations: ${JSON.stringify(violations)}`)
      }
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  // v4 → v5 — task 06-08-chat Bug 2. Add chat_tool_call.content_offset: the
  // char offset into the parent assistant message's `content` where this tool
  // call was proposed. The renderer splits `content` at these offsets to
  // interleave tool chips in time order instead of stacking them all below the
  // body. Plain additive ALTER (no UNIQUE/FK drop) → safe in its own
  // transaction. NULL for all pre-v5 rows → renderer degrades to the legacy
  // "all chips after the body" layout for old conversations.
  if (current < 5) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('ALTER TABLE chat_tool_call ADD COLUMN content_offset INTEGER')
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '5')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
}

// ── singleton ───────────────────────────────────────────────────────────

let _db: Database.Database | null = null

export function getChatDb(): Database.Database {
  if (_db) return _db
  const path = resolveChatDbPath()
  if (path !== ':memory:') {
    // 旧默认 (~/.mailagent/frontend) → 新 DATA_ROOT 一次性搬迁, 必须在 open 前 —— 否则
    // new Database(path) 先在新位置建空库, existsSync(target) 转真, 搬迁条件不再满足。
    migrateLegacyChatDbIfNeeded(path)
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

/**
 * Sprint 19 — unconditionally INSERT a new ai_chat_sessions row, bypassing
 * the (email_id, backend_kind, backend_agent_page_id) reuse lookup. Used by
 * the `chat:newSession` IPC so the user clicking "+ 新建会话" actually gets
 * a fresh session row instead of reviving the latest one for the email
 * (the v3 UNIQUE was dropped in v4 migration so multi-session per email is
 * now legitimate).
 *
 * Call sites:
 *   - handlers/chat.ts chat:newSession IPC — explicit user intent
 *   - Tests — they can pre-create multiple sessions for an email to verify
 *     listSessionsForEmail ordering + deleteSession isolation
 *
 * NOT called by startChat — that path keeps `getOrCreateSession` so the
 * first user message on an email lands in the latest session by default
 * (preserves "open email → continue last conversation" UX).
 */
export function createNewSession(input: OpenSessionInput): ChatSession {
  const db = getChatDb()
  const now = Date.now()
  const backendAgentPageId = input.backendAgentPageId ?? null
  const backendModel = input.backendModel ?? null
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

// Cross-email session history for the global "AI 会话历史" page. Sessions with
// no messages at all (a "+ 新建会话" click the user never sent into) are
// excluded — they'd be noise in a history list. The first-user-message
// preview is substr'd to 500 chars so an enormous prompt doesn't bloat the
// IPC payload; the renderer truncates further for display. `limit` caps the
// list so an account with thousands of conversations doesn't ship them all at
// once (newest-first, so the cap drops the least-recently-touched).
export function listAllSessions(limit = 300): ChatSessionSummary[] {
  return getChatDb()
    .prepare(
      `SELECT
         s.id, s.email_id, s.backend_kind, s.backend_model, s.backend_agent_page_id,
         s.created_at, s.updated_at,
         (SELECT substr(m.content, 1, 500) FROM ai_chat_messages m
            WHERE m.session_id = s.id AND m.role = 'user'
            ORDER BY m.created_at ASC LIMIT 1) AS first_user_message,
         (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count
       FROM ai_chat_sessions s
       WHERE EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)
       ORDER BY s.updated_at DESC
       LIMIT ?`
    )
    .all(limit) as ChatSessionSummary[]
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

/**
 * Sprint 19 P1 — sliding window history loader. Returns the last N messages
 * in chronological order (oldest → newest), used by the harness to cap
 * per-turn input tokens. Without this the harness sees full history and
 * a 100-turn session bills ~$0.6/turn (vs $0.015 for a 1-turn fresh session).
 *
 * Algorithm: SELECT … ORDER BY created_at DESC LIMIT N (newest first) →
 * .reverse() into chronological order for the LLM. id is the secondary
 * sort key to break created_at ties deterministically.
 *
 * Caller passes the window size (dispatcher uses HISTORY_WINDOW_SIZE
 * const so tuning is one place). limit <= 0 returns all messages (same
 * as listMessages — escape hatch for debugging / tests that want full
 * history without changing the call site).
 */
export function listLastNMessages(sessionId: number, limit: number): ChatMessage[] {
  if (limit <= 0) return listMessages(sessionId)
  const rows = getChatDb()
    .prepare(
      'SELECT * FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    )
    .all(sessionId, limit) as ChatMessage[]
  // Reverse in-place so LLM sees chronological order (oldest → newest).
  return rows.reverse()
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

// ── chat_tool_call (Sprint 19) ──────────────────────────────────────────

export function appendToolCall(input: AppendToolCallInput): ChatToolCall {
  const db = getChatDb()
  const now = Date.now()
  const contentOffset = input.contentOffset ?? null
  const result = db
    .prepare(
      `INSERT INTO chat_tool_call
        (message_id, tool_use_id, tool_name, input_json,
         user_edited_input_json, output_json,
         status, duration_ms, confirmation_tier, confirmed_at,
         content_offset, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL, ?, ?, ?)`
    )
    .run(
      input.messageId,
      input.toolUseId,
      input.toolName,
      input.inputJson,
      input.status,
      input.confirmationTier,
      contentOffset,
      now,
      now
    )
  return {
    id: Number(result.lastInsertRowid),
    message_id: input.messageId,
    tool_use_id: input.toolUseId,
    tool_name: input.toolName,
    input_json: input.inputJson,
    user_edited_input_json: null,
    output_json: null,
    status: input.status,
    duration_ms: null,
    confirmation_tier: input.confirmationTier,
    confirmed_at: null,
    content_offset: contentOffset,
    created_at: now,
    updated_at: now
  }
}

export function updateToolCall(toolCallId: number, patch: UpdateToolCallPatch): void {
  const db = getChatDb()
  const now = Date.now()
  const fields: string[] = []
  const params: unknown[] = []
  if (patch.status !== undefined) {
    fields.push('status = ?')
    params.push(patch.status)
  }
  if (patch.outputJson !== undefined) {
    fields.push('output_json = ?')
    params.push(patch.outputJson)
  }
  if (patch.durationMs !== undefined) {
    fields.push('duration_ms = ?')
    params.push(patch.durationMs)
  }
  if (patch.userEditedInputJson !== undefined) {
    fields.push('user_edited_input_json = ?')
    params.push(patch.userEditedInputJson)
  }
  if (patch.confirmedAt !== undefined) {
    fields.push('confirmed_at = ?')
    params.push(patch.confirmedAt)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  params.push(now)
  params.push(toolCallId)
  db.prepare(`UPDATE chat_tool_call SET ${fields.join(', ')} WHERE id = ?`).run(...params)
}

export function listToolCallsForMessage(messageId: number): ChatToolCall[] {
  return getChatDb()
    .prepare('SELECT * FROM chat_tool_call WHERE message_id = ? ORDER BY created_at ASC, id ASC')
    .all(messageId) as ChatToolCall[]
}

export function getToolCallByUseId(messageId: number, toolUseId: string): ChatToolCall | null {
  const row = getChatDb()
    .prepare('SELECT * FROM chat_tool_call WHERE message_id = ? AND tool_use_id = ?')
    .get(messageId, toolUseId) as ChatToolCall | undefined
  return row ?? null
}
