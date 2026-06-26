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
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

import { resolveDataRoot } from './db'

// ── types ───────────────────────────────────────────────────────────────
// V2.1 阶段 3：数据模型类型下沉到 shared/chat/model.ts（B-pure-unified —
// harness 在 UI 进程跑需要这些类型但不能引 better-sqlite3）。下方 import 供
// 本文件函数签名使用；re-export 保既有 importer（dispatcher / harness /
// kos_save / registry / handlers/chat）的 `from '../chat_db'` 路径不变。
import type {
  AgentMemoryEntry,
  AnchorType,
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
  AgentMemoryEntry,
  AnchorType,
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

// v7 (P2c, task 06-18-custom-ai-harness-agent) — chat session anchor: email_id
// becomes nullable, anchor_type/anchor_id added with a coupling CHECK so general
// (context-free) sessions never need an email_id sentinel.
// v8 (P2a, task 06-23 agent-experience-epic) — agent_memory_kv provenance +
// priority: source_session_id / source_message_id / source_tool_use_id (full
// turn+tool provenance, superseding the source_wiki_path='session:<id>' overload)
// + priority (user-explicit importance, drives the prompt-injection relevance
// rule). 🔴 bump 时同步刷新 src/chat/db.py 头注释的 CHAT_DB_VERSION（mirror，不建表）。
// 注意：ai_chat.db 自有版本梯，与 backend_lifecycle.EXPECTED_DB_VERSION（gate
// sync_store.db）无关 —— 不要因这次 bump 去动 EXPECTED_DB_VERSION。
// v9 (P4 Phase 02, task 06-23 chat-panel AI SDK Gateway) — ai_chat_messages.ui_message_json:
// the AI SDK v6 UIMessage canonical JSON for a turn. The AI SDK runtime path
// dual-writes this (canonical) alongside `content` (legacy extracted text) +
// usage/model metadata, so a session authored through the gateway round-trips
// losslessly on reload (protocol-contracts §2, architecture §6). NULL for every
// legacy-runtime row + all pre-v9 rows (additive ALTER default) → the reload
// converter falls back to synthesizing a UIMessage from `content`. Plain additive
// ALTER, hasColumn idempotency guard (same discipline as v5/v6/v8). 🔴 bump 同步
// 刷 src/chat/db.py 头注释 + append/update 写列；NOT backend_lifecycle.EXPECTED_DB_VERSION.
// v10 (P4 Phase 03b, task 06-23 chat-panel HITL write tools) — chat_tool_call.approval_status
// + approval_hash: the AI SDK Gateway write-tool approval audit. A write tool executes only
// after the user approves (two-call HITL); the executed row records approval_status
// ('approved'/'edited'/'rejected') + approval_hash (sha256 of the approved input, the domain
// ApprovalGuard binding). user_edited_input_json already exists (v3). NULL for every read-tool
// + legacy row (additive ALTER default). Plain additive ALTER, hasColumn idempotency guard.
// 🔴 bump 同步刷 src/chat/db.py 头注释 + test_chat.py seed DDL；NOT backend_lifecycle.EXPECTED_DB_VERSION.
// v11 (P4 Phase 04a, task 06-23 chat-panel A2UI tool cards) — chat_tool_call.ui_payload_json:
// the A2UI render payload (protocol-contracts §3) the rich tool card showed for this write
// (component + props + audit). Stamped only when MAILAGENT_A2UI_TOOL_CARDS is on AND the tool
// has a registered card; NULL for read tools / legacy rows / flag-off writes (additive ALTER
// default). UI/audit only — never enters the model-visible tool result (keeps 03b parity).
// Plain additive ALTER, hasColumn idempotency guard (same discipline as v5/v6/v8/v9/v10).
// 🔴 bump 同步刷 src/chat/db.py 头注释 + test_chat.py seed DDL；NOT backend_lifecycle.EXPECTED_DB_VERSION.
// v12 (P4 Phase 04b, task 06-23 chat-panel high-risk send) — chat_tool_call.content_hash +
// idempotency_key: the outbound-send (email_prepare_send) double-guard audit. content_hash is the
// sha256 of the canonical outbound payload that bound the approved content to what was sent (the
// gateway + Python both verify it); idempotency_key is the one-shot key the Python send ledger
// keyed on (so a replay never re-sends). Both NULL for every non-send tool / legacy row (additive
// ALTER default). Plain additive ALTER, hasColumn idempotency guard (same discipline as v5..v11).
// 🔴 bump 同步刷 src/chat/db.py 头注释 + test_chat.py seed DDL；NOT backend_lifecycle.EXPECTED_DB_VERSION.
// v13 (P4 Phase 06a, task 06-23 chat-panel cutover) — widen ai_chat_sessions.backend_kind CHECK to
// admit 'ai-sdk'. A chat authored through the AI SDK Gateway now persists as a first-class session
// kind so the panel routes the runtime PER SESSION by backend_kind ('ai-sdk' → AI SDK Gateway,
// legacy 'custom-api' → ExternalStore, 'notion-agent' → read-only). SQLite cannot ALTER a CHECK and
// the old CHECK actively REJECTS a backend_kind='ai-sdk' INSERT, so this is a table REBUILD (same
// FK-off discipline as v3→v4 / v6→v7 — DROP TABLE with foreign_keys=ON cascades through
// ai_chat_messages and wipes the log). Pure CHECK widening: every existing row re-inserts
// byte-identically (no value changes), so email/general anchoring + all history is unchanged.
// 🔴 bump 同步刷 src/chat/db.py 头注释 + test_chat.py seed DDL；NOT backend_lifecycle.EXPECTED_DB_VERSION.
// v14 (demo-fidelity Phase 10, task 06-23 chat-panel agent view) — ai_chat_sessions.title: an optional
// session title (auto-generated by a haiku call after the first turn via the gateway; user-renamable).
// NULL → the unified history list derives a title from the email subject / first user message. Plain
// additive ALTER, hasColumn idempotency guard (same discipline as v5..v12). 🔴 bump 同步刷
// src/chat/db.py 头注释 + test_chat.py seed DDL；NOT backend_lifecycle.EXPECTED_DB_VERSION.
// v15 (dogfood-2, session 归档) — ai_chat_sessions.archived: 0/1 软删标记(默认 0)。归档的会话从
// listAllSessions 过滤掉(WHERE archived=0)，行与消息保留。Plain additive ALTER, hasColumn idempotency
// guard (same discipline as v5..v14)。🔴 bump 同步刷 src/chat/db.py 头注释 + test_chat.py seed DDL；
// NOT backend_lifecycle.EXPECTED_DB_VERSION。
const CHAT_DB_VERSION = 15

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

/** task 06-08-chat (codex LOW-2) — column-existence probe for the additive
 *  ALTER segments. SQLite has no `ADD COLUMN IF NOT EXISTS`, so re-running an
 *  `ALTER TABLE … ADD COLUMN` against a table that already has the column
 *  throws "duplicate column name". Guarding the additive segments with this
 *  makes the migration ladder idempotent even if a prior run committed the
 *  physical column but crashed before persisting the matching schema_version
 *  (leaving "physical vN + meta v(N-1)"), so the next open won't hard-fail. */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return cols.some((c) => c.name === column)
}

/** P2c (codex review MEDIUM) — is ai_chat_sessions already the FULL v7 shape?
 *  Presence of the anchor_type column alone is not proof: a half-built or tampered
 *  table could carry the column without anchor_id or the coupling CHECK. Verify
 *  both anchor columns AND that the table's CREATE SQL carries the `anchor_id =
 *  email_id` coupling CHECK (which only the v7 CREATE emits). Used by the v6→v7
 *  re-entry guard so a partial table is never mistaken for a completed migration. */
function isV7SessionShape(db: Database.Database): boolean {
  if (!hasColumn(db, 'ai_chat_sessions', 'anchor_type')) return false
  if (!hasColumn(db, 'ai_chat_sessions', 'anchor_id')) return false
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
    .get() as { sql?: string } | undefined
  return /anchor_id\s*=\s*email_id/.test(row?.sql ?? '')
}

/** Phase 06a — is ai_chat_sessions already the widened v13 shape (backend_kind
 *  CHECK admits 'ai-sdk')? The literal `'ai-sdk'` only appears in the v13 CREATE's
 *  backend_kind CHECK, so its presence in the table's CREATE SQL is the marker.
 *  Used by the v12→v13 re-entry guard (same discipline as isV7SessionShape) so the
 *  destructive rebuild is never re-run on a DB whose table was already widened —
 *  e.g. the artificial "meta rolled back after a committed rebuild" crash-resilience
 *  re-entry would otherwise rebuild a second time. */
function isV13SessionShape(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
    .get() as { sql?: string } | undefined
  return /'ai-sdk'/.test(row?.sql ?? '')
}

/** P2c — one-time .pre-v7.bak snapshot before the destructive v6→v7 rebuild.
 *  Best-effort: any failure is logged and swallowed (the rebuild itself is
 *  atomic + the version gate above guards a downgrade, so the backup is
 *  belt-and-suspenders, not a correctness dependency). Skips :memory: / unnamed
 *  DBs. We TRY a TRUNCATE checkpoint to fold the WAL into the main file, but
 *  `wal_checkpoint(TRUNCATE)` returns `{busy:1}` (does NOT throw) when a reader
 *  blocks it — leaving un-checkpointed pages only in `-wal` (codex review
 *  MEDIUM). So we ALWAYS copy `-wal` + `-shm` alongside the main file: the
 *  three together are a consistent restore set regardless of whether the
 *  checkpoint succeeded. Never overwrites an existing .pre-v7.bak — a prior
 *  partial-upgrade snapshot is more valuable than the current state. */
function backupChatDbBeforeV7(db: Database.Database): void {
  const path = db.name
  if (!path || path === ':memory:') return
  const backupPath = path + '.pre-v7.bak'
  if (existsSync(backupPath)) return
  try {
    // Best-effort fold WAL into the main file; busy → falls through to the
    // sidecar copies below (we never trust the truncate succeeded).
    db.pragma('wal_checkpoint(TRUNCATE)')
    copyFileSync(path, backupPath)
    // Copy the WAL sidecars too so a busy checkpoint can't leave the snapshot
    // missing un-checkpointed pages. SQLite reads <main>-wal / <main>-shm next
    // to the restored main file on open.
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(path + suffix)) copyFileSync(path + suffix, backupPath + suffix)
    }
    console.log(`[chat_db] pre-v7 backup written to ${backupPath}`)
  } catch (err) {
    console.error('[chat_db] pre-v7 backup failed (continuing; rebuild is atomic)', err)
  }
}

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
    //
    // task 06-08-chat (codex LOW-2) — only write v3 when the DB is BELOW v4.
    // The previous unconditional INSERT OR REPLACE would, on a DB already at
    // v4/v5/v6 that re-enters migrate (e.g. meta lagging the physical schema
    // after a crash), roll schema_version BACK to 3 — then the v5/v6 blocks
    // below would re-run their ADD COLUMN and fail on duplicates. Gating on
    // `current < 4` leaves an already-migrated DB's version untouched here;
    // the additive blocks have their own per-column idempotency guards.
    if (current < 4) {
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '3')"
      ).run()
    }
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
      // task 06-08-chat (codex LOW-2) — skip the ADD COLUMN if the physical
      // column is already present (crash-after-ALTER-before-version-bump re-entry).
      // Still advances schema_version to 5 so the ladder converges.
      if (!hasColumn(db, 'chat_tool_call', 'content_offset')) {
        db.exec('ALTER TABLE chat_tool_call ADD COLUMN content_offset INTEGER')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '5')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v5 → v6 — task 06-08-chat 需求 5. Add ai_chat_messages.thinking: the Claude
  // extended-thinking summary streamed during a thinking-mode turn, rendered in a
  // collapsible block above the answer + reloaded from the DB. First-class column
  // (not metadata) since it's body-level content. Plain additive ALTER → safe in
  // its own transaction. NULL for all pre-v6 rows + non-thinking turns → renderer
  // simply doesn't render the thinking block. (chat is a frontend-owned DB with
  // its own version ladder — does NOT touch backend_lifecycle EXPECTED_DB_VERSION,
  // which gates sync_store.db only.)
  if (current < 6) {
    db.exec('BEGIN IMMEDIATE')
    try {
      // task 06-08-chat (codex LOW-2) — idempotent ADD COLUMN, same rationale as v5.
      if (!hasColumn(db, 'ai_chat_messages', 'thinking')) {
        db.exec('ALTER TABLE ai_chat_messages ADD COLUMN thinking TEXT')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '6')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v6 → v7 — task 06-18-custom-ai-harness-agent (P2c) chat session anchor.
  // Rebuild ai_chat_sessions so `email_id` becomes NULLABLE and add
  // anchor_type/anchor_id with a coupling CHECK. This lets "general"
  // (context-free, Cmd+O) agent sessions live in the same table WITHOUT an
  // email_id=0 sentinel (a sentinel would pollute every `WHERE email_id=` query
  // + the per-email sidebar). All pre-v7 rows backfill to anchor_type='email',
  // anchor_id=email_id, so the email-mode listSessionsForEmail / sidebar path is
  // byte-for-byte unchanged.
  //
  // Same 12-step rebuild discipline as v3→v4: DROP TABLE ai_chat_sessions needs
  // PRAGMA foreign_keys=OFF — otherwise the implicit per-row DELETE cascades
  // through ai_chat_messages's ON DELETE CASCADE FK and wipes the message log.
  // Runs out-of-transaction, opens its own transaction for the atomic swap, then
  // re-enables FK + runs foreign_key_check. A one-time .pre-v7.bak file snapshot
  // is taken first (best-effort; the swap is atomic + the version gate guards a
  // downgrade, so the backup is belt-and-suspenders).
  //
  // Idempotency guard (same discipline as the v5/v6 hasColumn guards): the
  // rebuild's meta write is INSIDE its transaction, so a natural crash can't
  // leave "physical v7 + meta v6". But the artificial "meta rolled back" re-entry
  // (crash-resilience test) would otherwise re-run the destructive rebuild and
  // clobber any general row to anchor_type='email' (→ CHECK violation). When the
  // table is ALREADY the full v7 shape the rebuild already happened — just advance
  // meta. codex review MEDIUM: validate the FULL shape (anchor_id + coupling CHECK),
  // not just the anchor_type column — a partial/tampered table must neither be
  // silently blessed as v7 nor destructively rebuilt (the rebuild would clobber
  // general rows), so fail loudly and point at the backup.
  if (current < 7 && hasColumn(db, 'ai_chat_sessions', 'anchor_type')) {
    if (!isV7SessionShape(db)) {
      throw new Error(
        'ai_chat_sessions carries an anchor_type column but not the full v7 shape ' +
          '(missing anchor_id and/or the anchor_id=email_id coupling CHECK). Refusing to ' +
          'advance schema_version — restore ai_chat.db from .pre-v7.bak or delete the file.'
      )
    }
    db.prepare(
      "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '7')"
    ).run()
  } else if (current < 7) {
    backupChatDbBeforeV7(db)
    db.pragma('foreign_keys = OFF')
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(`
          CREATE TABLE ai_chat_sessions_v7 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id INTEGER,
            anchor_type TEXT NOT NULL DEFAULT 'email'
              CHECK (anchor_type IN ('email', 'general')),
            anchor_id INTEGER,
            backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api')),
            backend_model TEXT,
            backend_agent_page_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK (
              -- email rows: anchor_id MUST equal email_id (codex review HIGH — the
              -- tier-1 invariant is anchor_id = email_id for email anchors, not just
              -- both non-null). general rows: both NULL (no sentinel).
              (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
              OR
              (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
            )
          );
          INSERT INTO ai_chat_sessions_v7
            (id, email_id, anchor_type, anchor_id, backend_kind, backend_model,
             backend_agent_page_id, created_at, updated_at)
            SELECT id, email_id, 'email', email_id, backend_kind, backend_model,
                   backend_agent_page_id, created_at, updated_at
            FROM ai_chat_sessions;
          DROP TABLE ai_chat_sessions;
          ALTER TABLE ai_chat_sessions_v7 RENAME TO ai_chat_sessions;
          DROP INDEX IF EXISTS idx_sessions_email;
          CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
          CREATE INDEX idx_sessions_anchor
            ON ai_chat_sessions(anchor_type, anchor_id, updated_at DESC);
        `)
        db.prepare(
          "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '7')"
        ).run()
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
      if (violations.length > 0) {
        throw new Error(`chat_db v6→v7 migration left FK violations: ${JSON.stringify(violations)}`)
      }
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  // v7 → v8 — task 06-23 (agent-experience-epic P2a) memory provenance +
  // relevance. Add four columns to agent_memory_kv:
  //   source_session_id / source_message_id / source_tool_use_id — full
  //     provenance of which chat turn + tool_use proposed the fact. The old
  //     source_wiki_path='session:<id>' overload only carried the session id
  //     (and abused a column named for wiki paths); these are first-class.
  //   priority — user-explicit importance (0 = default). The prompt-injection
  //     relevance rule (src/chat/db.py memory_summary) orders by priority DESC,
  //     updated_at DESC so a pinned preference survives the injection cap.
  // All pre-v8 rows backfill to source_* NULL + priority 0, so the injection
  // ORDER BY is byte-identical to the old `updated_at DESC` for existing data
  // (priority only re-orders once a user sets it > 0). Plain additive ALTERs
  // (no UNIQUE/FK drop) → safe in one transaction, with the same hasColumn
  // idempotency guard as v5/v6 (crash-after-ALTER-before-version-bump re-entry).
  // NOTE: ai_chat.db has its own version ladder; this bump does NOT touch
  // backend_lifecycle.EXPECTED_DB_VERSION (that gates sync_store.db only).
  if (current < 8) {
    db.exec('BEGIN IMMEDIATE')
    try {
      // agent_memory_kv is created in the v3 block, so any DB that climbed the
      // ladder normally has it by the time v8 runs. Guard defensively: a DB
      // that lacks the table (a hand-seeded partial DB, or some future manual
      // repair) has no memory rows to migrate — skip the ALTERs rather than
      // crash on "no such table". Same defensive idiom as the hasColumn /
      // isV7SessionShape guards above; harmless in production (table always present).
      const hasMemTable = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_memory_kv'")
        .get()
      if (hasMemTable) {
        if (!hasColumn(db, 'agent_memory_kv', 'source_session_id')) {
          db.exec('ALTER TABLE agent_memory_kv ADD COLUMN source_session_id INTEGER')
        }
        if (!hasColumn(db, 'agent_memory_kv', 'source_message_id')) {
          db.exec('ALTER TABLE agent_memory_kv ADD COLUMN source_message_id INTEGER')
        }
        if (!hasColumn(db, 'agent_memory_kv', 'source_tool_use_id')) {
          db.exec('ALTER TABLE agent_memory_kv ADD COLUMN source_tool_use_id TEXT')
        }
        if (!hasColumn(db, 'agent_memory_kv', 'priority')) {
          db.exec('ALTER TABLE agent_memory_kv ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
        }
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '8')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v8 → v9 — task 06-23 (chat-panel P4 Phase 02) AI SDK Gateway UIMessage
  // persistence. Add ai_chat_messages.ui_message_json: the AI SDK v6 UIMessage
  // canonical JSON for a turn. The gateway runtime dual-writes it next to the
  // legacy `content` (extracted text) so a gateway-authored session reloads
  // losslessly; legacy-runtime rows + all pre-v9 rows stay NULL and the reload
  // converter synthesizes a UIMessage from `content`. Plain additive ALTER (no
  // UNIQUE/FK drop) → safe in one transaction, same hasColumn idempotency guard
  // as v5/v6/v8 (crash-after-ALTER-before-version-bump re-entry). ai_chat.db has
  // its own version ladder; this bump does NOT touch backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 9) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_messages', 'ui_message_json')) {
        db.exec('ALTER TABLE ai_chat_messages ADD COLUMN ui_message_json TEXT')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '9')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v9 → v10 — task 06-23 (chat-panel P4 Phase 03b) HITL write-tool approval audit.
  // Add chat_tool_call.approval_status ('approved'/'edited'/'rejected') + approval_hash
  // (sha256 of the approved input — the domain ApprovalGuard binding). The AI SDK Gateway
  // write tools execute only after the user approves; the executed row records the outcome
  // so a write is auditable end-to-end. NULL for every read-tool / legacy row (additive
  // ALTER default). Plain additive ALTER, same hasColumn idempotency guard as v5/v6/v8/v9
  // (crash-after-ALTER-before-version-bump re-entry). ai_chat.db has its own version ladder;
  // this bump does NOT touch backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 10) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'chat_tool_call', 'approval_status')) {
        db.exec('ALTER TABLE chat_tool_call ADD COLUMN approval_status TEXT')
      }
      if (!hasColumn(db, 'chat_tool_call', 'approval_hash')) {
        db.exec('ALTER TABLE chat_tool_call ADD COLUMN approval_hash TEXT')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '10')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v10 → v11 — task 06-23 (chat-panel P4 Phase 04a) A2UI tool cards. Add
  // chat_tool_call.ui_payload_json: the A2UI render payload (component + props + audit) the
  // rich tool card showed for an AI SDK Gateway write tool. Stamped only when
  // MAILAGENT_A2UI_TOOL_CARDS is on; NULL for read tools / legacy rows / flag-off writes
  // (additive ALTER default). UI/audit only. Plain additive ALTER, same hasColumn idempotency
  // guard as v5/v6/v8/v9/v10. ai_chat.db has its own version ladder; this bump does NOT touch
  // backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 11) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'chat_tool_call', 'ui_payload_json')) {
        db.exec('ALTER TABLE chat_tool_call ADD COLUMN ui_payload_json TEXT')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '11')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v11 → v12 — task 06-23 (chat-panel P4 Phase 04b) high-risk outbound send audit. Add
  // chat_tool_call.content_hash (sha256 of the canonical outbound payload — the gateway↔Python
  // content binding) + idempotency_key (the one-shot key the Python send ledger keyed on, so a
  // replay never re-sends). Set only for email_prepare_send rows; NULL for every other tool /
  // legacy row (additive ALTER default). Plain additive ALTER, same hasColumn idempotency guard
  // as v5..v11. ai_chat.db has its own version ladder; this bump does NOT touch
  // backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 12) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'chat_tool_call', 'content_hash')) {
        db.exec('ALTER TABLE chat_tool_call ADD COLUMN content_hash TEXT')
      }
      if (!hasColumn(db, 'chat_tool_call', 'idempotency_key')) {
        db.exec('ALTER TABLE chat_tool_call ADD COLUMN idempotency_key TEXT')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '12')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v12 → v13 — task 06-23 (chat-panel P4 Phase 06a cutover) ai-sdk backend_kind.
  // Widen ai_chat_sessions.backend_kind CHECK to admit 'ai-sdk' (see the header note).
  // Same out-of-transaction FK-off rebuild discipline as v3→v4 / v6→v7: the outer
  // transaction opened at the top of migrate() always COMMITs before this point, and
  // every v8..v12 block runs its own BEGIN/COMMIT, so no transaction is open here —
  // PRAGMA foreign_keys can only change outside a transaction, and DROP TABLE with FK on
  // would cascade through ai_chat_messages and wipe the message log. Re-entry guard
  // (same discipline as the v6→v7 isV7SessionShape guard): a table that ALREADY carries
  // 'ai-sdk' in its CHECK has been rebuilt — just advance meta rather than rebuild again
  // (the artificial "meta rolled back" crash-resilience re-entry). ai_chat.db has its own
  // version ladder; this bump does NOT touch backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 13 && isV13SessionShape(db)) {
    db.prepare(
      "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '13')"
    ).run()
  } else if (current < 13) {
    db.pragma('foreign_keys = OFF')
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec(`
          CREATE TABLE ai_chat_sessions_v13 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email_id INTEGER,
            anchor_type TEXT NOT NULL DEFAULT 'email'
              CHECK (anchor_type IN ('email', 'general')),
            anchor_id INTEGER,
            backend_kind TEXT NOT NULL
              CHECK (backend_kind IN ('notion-agent', 'custom-api', 'ai-sdk')),
            backend_model TEXT,
            backend_agent_page_id TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK (
              -- unchanged v7 anchor coupling: email rows pin anchor_id = email_id,
              -- general rows keep both NULL (no sentinel).
              (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
              OR
              (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
            )
          );
          INSERT INTO ai_chat_sessions_v13
            (id, email_id, anchor_type, anchor_id, backend_kind, backend_model,
             backend_agent_page_id, created_at, updated_at)
            SELECT id, email_id, anchor_type, anchor_id, backend_kind, backend_model,
                   backend_agent_page_id, created_at, updated_at
            FROM ai_chat_sessions;
          DROP TABLE ai_chat_sessions;
          ALTER TABLE ai_chat_sessions_v13 RENAME TO ai_chat_sessions;
          DROP INDEX IF EXISTS idx_sessions_email;
          CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
          DROP INDEX IF EXISTS idx_sessions_anchor;
          CREATE INDEX idx_sessions_anchor
            ON ai_chat_sessions(anchor_type, anchor_id, updated_at DESC);
        `)
        db.prepare(
          "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '13')"
        ).run()
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
      const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
      if (violations.length > 0) {
        throw new Error(
          `chat_db v12→v13 migration left FK violations: ${JSON.stringify(violations)}`
        )
      }
    } finally {
      db.pragma('foreign_keys = ON')
    }
  }

  // v13 → v14 — demo-fidelity Phase 10 (auto-title + rename). ai_chat_sessions.title additive column
  // (haiku auto-title after the first turn; user-renamable; NULL = derive from subject / first message).
  // Plain additive ALTER, hasColumn idempotency guard (same discipline as v5..v12). ai_chat.db has its
  // own version ladder; this bump does NOT touch backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 14) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_sessions', 'title')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN title TEXT')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '14')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v14 → v15 — dogfood-2 session 归档。ai_chat_sessions.archived 软删标记(0/1，默认 0)；归档会话从
  // listAllSessions 过滤(WHERE archived=0)，行/消息保留。Plain additive ALTER, hasColumn idempotency
  // guard。ai_chat.db 自有 version ladder；NOT backend_lifecycle.EXPECTED_DB_VERSION。
  if (current < 15) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_sessions', 'archived')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '15')"
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

/** P2c — resolve an OpenSessionInput to its concrete anchor columns. Email
 *  (the default): email_id is a required non-negative int and anchor_id mirrors
 *  it. General: both NULL — NEVER accept an emailId here (no sentinel). Throws
 *  E_INVALID_ARG-shaped Error for a missing/invalid email anchor so the caller
 *  doesn't silently insert a row that the v7 CHECK would reject. */
function resolveAnchor(input: OpenSessionInput): {
  anchorType: AnchorType
  emailId: number | null
  anchorId: number | null
} {
  const anchorType: AnchorType = input.anchorType ?? 'email'
  if (anchorType === 'general') {
    // codex review HIGH — a general anchor carrying ANY non-null emailId (incl. 0)
    // is rejected, never silently dropped: that's exactly the sentinel we banned.
    if (input.emailId != null) {
      throw new Error(
        `getOrCreateSession: general anchor must not carry an emailId (got ${input.emailId})`
      )
    }
    return { anchorType: 'general', emailId: null, anchorId: null }
  }
  // codex review NIT — reject any anchorType that's neither 'general' nor 'email'
  // (parity with router/runtime/dispatcher/db.py) instead of silently treating it
  // as email. input is wire-sourced, so a bad string can reach here at runtime.
  if (anchorType !== 'email') {
    throw new Error(`getOrCreateSession: invalid anchorType ${String(anchorType)}`)
  }
  const emailId = input.emailId
  if (typeof emailId !== 'number' || !Number.isInteger(emailId) || emailId < 0) {
    throw new Error(
      `getOrCreateSession: anchor_type='email' requires a non-negative integer emailId, got ${String(emailId)}`
    )
  }
  return { anchorType: 'email', emailId, anchorId: emailId }
}

export function getOrCreateSession(input: OpenSessionInput): ChatSession {
  const db = getChatDb()
  const now = Date.now()
  const backendAgentPageId = input.backendAgentPageId ?? null
  const backendModel = input.backendModel ?? null
  const { anchorType, emailId, anchorId } = resolveAnchor(input)

  // SQLite treats UNIQUE NULL columns as always-distinct, so we can't lean
  // on `UNIQUE(email_id, backend_kind, backend_agent_page_id)` alone when
  // backend_agent_page_id is null. Branch by null to keep the lookup well-defined.
  const pageClause =
    backendAgentPageId === null ? 'backend_agent_page_id IS NULL' : 'backend_agent_page_id = ?'
  const pageParams = backendAgentPageId === null ? [] : [backendAgentPageId]

  // Reuse lookup. Email: keyed on email_id — byte-identical to pre-v7 (email_id
  // is non-null only for email rows per the CHECK, so this naturally excludes
  // general rows; zero regression for the per-email sidebar). General: keyed on
  // anchor_type + email_id IS NULL, reusing the most-recently-touched general
  // session (no anchor_id to dedupe on → "latest" is the contract; an explicit
  // fresh general session goes through createNewSession).
  let existing: ChatSession | undefined
  if (anchorType === 'email') {
    existing = db
      .prepare(
        `SELECT * FROM ai_chat_sessions
          WHERE email_id = ? AND backend_kind = ? AND ${pageClause}`
      )
      .get(emailId, input.backendKind, ...pageParams) as ChatSession | undefined
  } else {
    existing = db
      .prepare(
        `SELECT * FROM ai_chat_sessions
          WHERE anchor_type = 'general' AND email_id IS NULL
            AND backend_kind = ? AND ${pageClause}
          ORDER BY updated_at DESC LIMIT 1`
      )
      .get(input.backendKind, ...pageParams) as ChatSession | undefined
  }

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
        (email_id, anchor_type, anchor_id, backend_kind, backend_model,
         backend_agent_page_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      emailId,
      anchorType,
      anchorId,
      input.backendKind,
      backendModel,
      backendAgentPageId,
      now,
      now
    )

  return {
    id: Number(result.lastInsertRowid),
    email_id: emailId,
    anchor_type: anchorType,
    anchor_id: anchorId,
    backend_kind: input.backendKind,
    backend_model: backendModel,
    backend_agent_page_id: backendAgentPageId,
    title: null,
    archived: false,
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
  const { anchorType, emailId, anchorId } = resolveAnchor(input)
  const result = db
    .prepare(
      `INSERT INTO ai_chat_sessions
        (email_id, anchor_type, anchor_id, backend_kind, backend_model,
         backend_agent_page_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      emailId,
      anchorType,
      anchorId,
      input.backendKind,
      backendModel,
      backendAgentPageId,
      now,
      now
    )
  return {
    id: Number(result.lastInsertRowid),
    email_id: emailId,
    anchor_type: anchorType,
    anchor_id: anchorId,
    backend_kind: input.backendKind,
    backend_model: backendModel,
    backend_agent_page_id: backendAgentPageId,
    title: null,
    archived: false,
    created_at: now,
    updated_at: now
  }
}

export function listSessionsForEmail(emailId: number): ChatSession[] {
  return getChatDb()
    .prepare('SELECT * FROM ai_chat_sessions WHERE email_id = ? ORDER BY updated_at DESC')
    .all(emailId) as ChatSession[]
}

/** P2c — list general (context-free) sessions, newest-first. The per-email
 *  sidebar uses listSessionsForEmail (anchor_type='email' via email_id=?); this
 *  is its general-anchor counterpart for the Cmd+O surface (P3). Kept separate
 *  so a general session never leaks into a specific email's sidebar. */
export function listGeneralSessions(): ChatSession[] {
  return getChatDb()
    .prepare(
      "SELECT * FROM ai_chat_sessions WHERE anchor_type = 'general' ORDER BY updated_at DESC"
    )
    .all() as ChatSession[]
}

// Cross-email session history for the global "AI 会话历史" page. Sessions with
// no messages at all (a "+ 新建会话" click the user never sent into) are
// excluded — they'd be noise in a history list. The first-user-message
// preview is substr'd to 500 chars so an enormous prompt doesn't bloat the
// IPC payload; the renderer truncates further for display. `limit` caps the
// list so an account with thousands of conversations doesn't ship them all at
// once (newest-first, so the cap drops the least-recently-touched).
export function listAllSessions(limit = 300, includeArchived = false): ChatSessionSummary[] {
  // dogfood-3 — includeArchived (default false → only active sessions, byte-identical to before; the
  // agent view passes true to also pull archived rows for its bottom "归档" group). SELECT now carries
  // s.archived so the renderer can split active vs archived. The archived branch is a fixed boolean (no
  // user input), so inlining it in the WHERE is injection-safe.
  return getChatDb()
    .prepare(
      `SELECT
         s.id, s.email_id, s.anchor_type, s.anchor_id, s.backend_kind, s.backend_model,
         s.backend_agent_page_id, s.title, s.archived, s.created_at, s.updated_at,
         (SELECT substr(m.content, 1, 500) FROM ai_chat_messages m
            WHERE m.session_id = s.id AND m.role = 'user'
            ORDER BY m.created_at ASC LIMIT 1) AS first_user_message,
         (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.session_id = s.id) AS message_count
       FROM ai_chat_sessions s
       WHERE ${includeArchived ? '1 = 1' : 's.archived = 0'}
         AND EXISTS (SELECT 1 FROM ai_chat_messages m WHERE m.session_id = s.id)
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

/** Phase 10 — set a session's title (manual rename, or the gateway's haiku auto-title). Deliberately
 *  does NOT bump updated_at so a rename never reorders the history list. Safe on a missing id (UPDATE
 *  matches 0 rows). The gateway (electron main) calls this directly; the renderer rename goes through
 *  serve-api → src/chat/db.py.update_session_title (same ai_chat.db file). */
export function updateSessionTitle(sessionId: number, title: string): void {
  getChatDb().prepare('UPDATE ai_chat_sessions SET title = ? WHERE id = ?').run(title, sessionId)
}

/** dogfood-3 (follow-ups) — the last completed turn's text: the most-recent non-empty user message +
 *  the most-recent non-empty assistant message for a session. The gateway feeds these to a small model
 *  to generate next-question suggestions. Returns null when either side is missing (no turn yet). */
export function getLastTurnTexts(
  sessionId: number
): { userText: string; assistantText: string } | null {
  const db = getChatDb()
  const pick = (role: 'user' | 'assistant'): string | undefined =>
    (
      db
        .prepare(
          `SELECT content FROM ai_chat_messages
             WHERE session_id = ? AND role = ? AND content <> ''
             ORDER BY created_at DESC LIMIT 1`
        )
        .get(sessionId, role) as { content: string } | undefined
    )?.content
  const userText = pick('user')
  const assistantText = pick('assistant')
  if (!userText || !assistantText) return null
  return { userText, assistantText }
}

/** dogfood-2 — 归档 / 取消归档一个 session（软删：archived=1 从 listAllSessions 过滤，行保留）。
 *  不 bump updated_at（与 updateSessionTitle 同纪律，归档不该重排历史）。Safe on missing id。 */
export function updateSessionArchived(sessionId: number, archived: boolean): void {
  getChatDb()
    .prepare('UPDATE ai_chat_sessions SET archived = ? WHERE id = ?')
    .run(archived ? 1 : 0, sessionId)
}

/** Phase 10b — the first user message's text for a session (the auto-title generation input). Null
 *  when the session has no user message yet. Mirrors the listAllSessions first_user_message subquery
 *  (oldest user row by created_at, id tiebreak). */
export function getFirstUserText(sessionId: number): string | null {
  const row = getChatDb()
    .prepare(
      `SELECT content FROM ai_chat_messages
         WHERE session_id = ? AND role = 'user'
         ORDER BY created_at ASC, id ASC LIMIT 1`
    )
    .get(sessionId) as { content: string } | undefined
  return row?.content ?? null
}

// ── messages ────────────────────────────────────────────────────────────

export function appendMessage(input: AppendMessageInput): ChatMessage {
  const db = getChatDb()
  const now = Date.now()
  const result = db
    .prepare(
      `INSERT INTO ai_chat_messages
        (session_id, role, content, tokens_input, tokens_output, cost_usd,
         model, status, error_message, metadata, ui_message_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      // v9 — AI SDK UIMessage canonical JSON (gateway runtime dual-writes it;
      // legacy runtime omits → NULL → reload synthesizes from `content`).
      input.uiMessageJson ?? null,
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
    ui_message_json: input.uiMessageJson ?? null,
    // task 06-08-chat 需求 5 — appendMessage never seeds thinking (finalizeMessage
    // writes it on终态 via updateMessage); the inserted row column defaults to NULL.
    thinking: null,
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
  // task 06-08-chat 需求 5 — thinking summary (finalizeMessage on a thinking turn).
  if (patch.thinking !== undefined) {
    fields.push('thinking = ?')
    params.push(patch.thinking)
  }
  // v9 (P4 Phase 02) — AI SDK UIMessage canonical JSON, finalized on turn end
  // (the gateway onFinish writes the streamed assistant text's UIMessage here).
  if (patch.uiMessageJson !== undefined) {
    fields.push('ui_message_json = ?')
    params.push(patch.uiMessageJson)
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
    approval_status: null,
    approval_hash: null,
    // v11 — A2UI render payload, set on update (like approval_*); insert default NULL.
    ui_payload_json: null,
    // v12 — outbound-send content hash + idempotency key, set on update; insert default NULL.
    content_hash: null,
    idempotency_key: null,
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
  // v10 (Phase 03b) — write-tool approval audit.
  if (patch.approvalStatus !== undefined) {
    fields.push('approval_status = ?')
    params.push(patch.approvalStatus)
  }
  if (patch.approvalHash !== undefined) {
    fields.push('approval_hash = ?')
    params.push(patch.approvalHash)
  }
  // v11 (Phase 04a) — A2UI render payload (ui_payload_json).
  if (patch.uiPayloadJson !== undefined) {
    fields.push('ui_payload_json = ?')
    params.push(patch.uiPayloadJson)
  }
  // v12 (Phase 04b) — outbound-send content hash + idempotency key.
  if (patch.contentHash !== undefined) {
    fields.push('content_hash = ?')
    params.push(patch.contentHash)
  }
  if (patch.idempotencyKey !== undefined) {
    fields.push('idempotency_key = ?')
    params.push(patch.idempotencyKey)
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

// ── agent_memory_kv (P2f — Custom AI memory WAL) ──────────────────────────
// The table landed in v3 (idle until now). One row per (scope, key); scope
// namespaces the fact ('user' / 'skill:<name>'). value_json is the serialized
// fact. These power the memory_* tools + the system-prompt memory summary.

/** List memory entries, newest-first. Optional scope filter. */
export function listMemoryEntries(scope?: string): AgentMemoryEntry[] {
  const db = getChatDb()
  if (scope) {
    return db
      .prepare('SELECT * FROM agent_memory_kv WHERE scope = ? ORDER BY updated_at DESC')
      .all(scope) as AgentMemoryEntry[]
  }
  return db
    .prepare('SELECT * FROM agent_memory_kv ORDER BY updated_at DESC')
    .all() as AgentMemoryEntry[]
}

export function getMemoryEntry(scope: string, key: string): AgentMemoryEntry | null {
  const row = getChatDb()
    .prepare('SELECT * FROM agent_memory_kv WHERE scope = ? AND key = ?')
    .get(scope, key) as AgentMemoryEntry | undefined
  return row ?? null
}

/** UPSERT a memory entry (PRIMARY KEY (scope,key)). created_at is preserved on
 *  update. v8 (P2a) — provenance (source_session_id / source_message_id /
 *  source_tool_use_id) updates to the latest writer's turn+tool on conflict.
 *  `priority` is COALESCE-preserved: a write that omits priority (e.g. the agent
 *  just refreshing a fact's value) keeps the user's existing pin instead of
 *  silently resetting it to 0; an explicit priority overrides. A brand-new row
 *  with no priority defaults to 0. */
export function upsertMemoryEntry(input: {
  scope: string
  key: string
  valueJson: string
  sourceWikiPath?: string | null
  sourceSessionId?: number | null
  sourceMessageId?: number | null
  sourceToolUseId?: string | null
  priority?: number | null
}): AgentMemoryEntry {
  const db = getChatDb()
  const now = Date.now()
  const priority = input.priority ?? null
  db.prepare(
    `INSERT INTO agent_memory_kv
       (scope, key, value_json, source_wiki_path, source_session_id,
        source_message_id, source_tool_use_id, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET
       value_json = excluded.value_json,
       source_wiki_path = excluded.source_wiki_path,
       source_session_id = excluded.source_session_id,
       source_message_id = excluded.source_message_id,
       source_tool_use_id = excluded.source_tool_use_id,
       priority = COALESCE(?, agent_memory_kv.priority),
       updated_at = excluded.updated_at`
  ).run(
    input.scope,
    input.key,
    input.valueJson,
    input.sourceWikiPath ?? null,
    input.sourceSessionId ?? null,
    input.sourceMessageId ?? null,
    input.sourceToolUseId ?? null,
    priority,
    now,
    now,
    priority
  )
  // Non-null: we just inserted/updated this exact (scope,key).
  return getMemoryEntry(input.scope, input.key) as AgentMemoryEntry
}

export function deleteMemoryEntry(scope: string, key: string): number {
  return getChatDb()
    .prepare('DELETE FROM agent_memory_kv WHERE scope = ? AND key = ?')
    .run(scope, key).changes
}
