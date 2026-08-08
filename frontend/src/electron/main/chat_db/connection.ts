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

import { resolveDataRoot } from '../db'

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
// (component + props + audit). Stamped when the tool
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
// v16 (M5b, 2026-06-30) — DROP agent_memory_kv。记忆层终态 = user.md(M3 恒注入) + mem0(M1/M2
// capture/召回)；agent_memory_kv KV 表物理退役，同时删 4 个显式 KV 工具 + Python KV 端点。
// 无 FK 依赖（无 REFERENCES agent_memory_kv），简单事务 DROP。ai_chat.db 自有 version ladder；
// NOT backend_lifecycle.EXPECTED_DB_VERSION。
// v17 (S1 R1, task 07-02 openness wave1) — ai_chat_messages_fts: FTS5 external-content index over
// ai_chat_messages.content (tokenize='trigram' → CJK substring search, ≥3-char queries; shorter
// queries fall back to LIKE on the Python read side) + INSERT/UPDATE/DELETE sync triggers + a
// 'rebuild' backfill of existing rows. `content` is the right index target for BOTH runtimes: the
// gateway persist path dual-writes content (extractTextFromUIMessage) next to ui_message_json, and
// legacy rows only ever had content. Consumed by src/chat/db.py search_sessions (SELECT-only —
// the 0-CREATE-TABLE invariant there is unchanged; this migration is the single schema owner).
// NOT flag-gated (additive, same discipline as every ladder step); the
// MAILAGENT_OPENNESS_SESSION_TOOLS flag gates the TOOLS, not the schema. 🔴 bump 同步刷
// src/chat/db.py 头注释；NOT backend_lifecycle.EXPECTED_DB_VERSION.
// v18 (S2 W1, task 07-02-s2-exec-skill-install) — chat_tool_call.whitelist_rule_id: the S2 exec
// whitelist audit. An exec tool (run_command / file_read / file_write) that executed WITHOUT an
// approval card because a structured PolicyRule matched records approval_status='auto_whitelist'
// (approval_status is a free-form TEXT column — v10 added it with NO CHECK, so the new value needs
// no enum migration) + whitelist_rule_id = the matched rule id. NULL for every card-approved /
// read / legacy row (additive ALTER default). Plain additive ALTER, same hasColumn idempotency
// guard as v5..v12. ai_chat.db has its own version ladder; this bump does NOT touch
// backend_lifecycle.EXPECTED_DB_VERSION. 🔴 bump 同步刷 src/chat/db.py 头注释 + append/update 写列。
// 07-16 approval-mode switcher (codex r1 P2-4, NO version bump — same free-form-TEXT precedent):
// card-skipped executions write three more approval_status values, 'auto_accept_edits' /
// 'auto_bypass' (owner-global mode skips, send included) / 'auto_reversible' (the pre-existing
// reversible-preview skip, previously indistinguishably audited 'approved') — 'approved'/'edited'
// now always mean a real human card decision.
// v19 (S4 W3, task 07-02-s4-custom-agent-core) — ai_chat_sessions.origin + agent_id + agent_job_id:
// a headless custom-agent run (cron/email-triggered, ADR-003 D3) persists into a first-class session
// so it's visible/auditable in the SAME history UI. origin='agent' marks it (NULL for every
// interactive session); agent_id/agent_job_id link back to report_agent + async_jobs (agent_job_id is
// the async_jobs.job_id as TEXT — cross-db, no FK). backend_kind CHECK is UNCHANGED (still 'ai-sdk' —
// the engine is the same, only the initiator differs). Three plain additive ALTERs, hasColumn
// idempotency guard (same discipline as v5..v12). ai_chat.db has its own version ladder; this bump
// does NOT touch backend_lifecycle.EXPECTED_DB_VERSION. 🔴 bump 同步刷 src/chat/db.py 头注释。
// v20 (harness-chat lane A B4, task 07-15) — ai_chat_sessions.last_read_at: the per-session read
// watermark behind the history-list unread badge. NULL (legacy rows / never-opened sessions) = no
// badge; the renderer marks a session read (serve-api PATCH /chat/sessions/{id}/read →
// src/chat/db.py update_session_last_read) whenever it seeds/reloads it, and unread derives as
// updated_at > last_read_at (appendMessage bumps updated_at on every persisted turn, incl. the
// paused-turn eager persist). Plain additive ALTER, hasColumn idempotency guard (same discipline as
// v5..v19). ai_chat.db has its own version ladder; this bump does NOT touch
// backend_lifecycle.EXPECTED_DB_VERSION. 🔴 bump 同步刷 src/chat/db.py 头注释。
// v21 (custom-agent epic W3, task 07-28) — ai_chat_sessions.pinned_at + starred: pinned_at is the
// nullable Unix-ms ordering key for the dedicated pinned group; starred is an independent icon state.
// Both mutations leave updated_at untouched so organizing history never fakes conversation recency.
// v22 (stage 2 PR-1, task 08-01 messenger) — origin value-domain registration, NO schema change:
// ai_chat_sessions.origin (v19, free-text no CHECK) gains the third value 'im' (飞书 IM
// conversations, written by createImSession; value domain now 'agent' | 'im' | NULL=interactive).
// A no-op ladder step — no ALTER — bumped so the ladder documents when 'im' rows may start
// appearing. The default history filter (COALESCE(origin,'interactive') <> 'agent') deliberately
// admits them (Q18=A — IM sessions are desktop-visible). ai_chat.db has its own version ladder;
// this bump does NOT touch backend_lifecycle.EXPECTED_DB_VERSION. 🔴 bump 同步刷 src/chat/db.py 头注释。
// v23 (WP-15 context 环, task 08-05) — ai_chat_messages.context_tokens: 本回合最后一次 provider
// 调用的 prompt token 数 = composer 右下 context 环显示的「上下文占用」。🔴 **不复用 tokens_input**：
// 那一列存的是 ai@7 的 `result.usage.inputTokens`，即**多 step 求和**（工具循环回合里同一段 prompt
// 被计好几遍，拿它画环会虚报数倍）；本列存的是末 step 的 inputTokens（取法与两段式回合归属见
// frontend/src/ai-gateway/chatRun.ts `lastStepContextTokens`）。两个语义不同的数值不能挤一列 ——
// 覆写 tokens_input 会静默改掉既有 metadata.tokensInput 的含义。NULL for 每条 legacy / pre-v23 行
// 与所有非 gateway 写入（additive ALTER default）→ 前端不渲染控件（= 引入本列之前的现状）。
// Plain additive ALTER, hasColumn idempotency guard (same discipline as v5..v21)。ai_chat.db 自有
// version ladder；this bump does NOT touch backend_lifecycle.EXPECTED_DB_VERSION。🔴 bump 同步刷
// src/chat/db.py 头注释（Python 侧 SELECT * 读，不建表、不写这一列）。
// v24 (harness optimization P1, task 08-07) — headless session provenance. Three nullable
// source columns plus two read indexes; parent/invocation columns intentionally remain P2.
// v25 (harness optimization P2, task 08-07) — child-session parent provenance.
// v26 (harness optimization P5, task 08-07) — queued-input persistence + dispatch indexes.
const CHAT_DB_VERSION = 26

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
  // a card is registered (rich cards always on since S3); NULL for read tools / legacy rows
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

  // v15 → v16 — M5b (2026-06-30) agent_memory_kv 物理退役。记忆终态 = user.md(M3) + mem0(M1/M2)；
  // KV 表无 FK 依赖（REFERENCES agent_memory_kv = 0 处），简单事务 DROP。历史 CREATE(v3)/ALTER(v8)
  // 保留不动（append-only 纪律；新库 create-then-drop OK）。NOT backend_lifecycle.EXPECTED_DB_VERSION。
  if (current < 16) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DROP TABLE IF EXISTS agent_memory_kv')
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '16')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v16 → v17 — S1 R1 (task 07-02 openness wave1) chat-session message FTS. External-content
  // FTS5 over ai_chat_messages.content with tokenize='trigram' (CJK substring search — the same
  // tokenizer sync_store's SEARCH_TRIGRAM path uses; queries shorter than 3 chars can't match a
  // trigram index and fall back to LIKE in src/chat/db.py). Column-name-matches-content-table
  // discipline as wiki_fts (v3). Sync triggers keep the index live for BOTH writers (gateway via
  // this module, remote serve-api via src/chat/db.py — triggers fire inside SQLite regardless of
  // who writes). The 'rebuild' command backfills every existing row from the content table and is
  // naturally idempotent, so the whole block is safe to re-enter (IF NOT EXISTS + rebuild) after
  // a crash-before-meta-write. Runs in one transaction (CREATE VIRTUAL TABLE inside BEGIN is fine
  // — the v3 wiki_fts block set the precedent). ai_chat.db has its own version ladder; this bump
  // does NOT touch backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 17) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ai_chat_messages_fts USING fts5(
          content,
          content='ai_chat_messages',
          content_rowid='id',
          tokenize='trigram'
        );

        CREATE TRIGGER IF NOT EXISTS ai_chat_messages_fts_ai AFTER INSERT ON ai_chat_messages BEGIN
          INSERT INTO ai_chat_messages_fts(rowid, content)
          VALUES (new.id, new.content);
        END;
        CREATE TRIGGER IF NOT EXISTS ai_chat_messages_fts_ad AFTER DELETE ON ai_chat_messages BEGIN
          INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
        END;
        CREATE TRIGGER IF NOT EXISTS ai_chat_messages_fts_au AFTER UPDATE ON ai_chat_messages BEGIN
          INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts, rowid, content)
          VALUES ('delete', old.id, old.content);
          INSERT INTO ai_chat_messages_fts(rowid, content)
          VALUES (new.id, new.content);
        END;

        INSERT INTO ai_chat_messages_fts(ai_chat_messages_fts) VALUES ('rebuild');
      `)
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '17')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v17 → v18 — S2 W1 (task 07-02-s2-exec-skill-install) exec whitelist audit. Add
  // chat_tool_call.whitelist_rule_id: the PolicyRule id that auto-allowed an exec tool run without a
  // card (approval_status='auto_whitelist'). NULL for every card-approved / read / legacy row
  // (additive ALTER default). approval_status stays free-form TEXT (v10 added it with NO CHECK), so
  // the new 'auto_whitelist' value needs no enum migration. Plain additive ALTER, same hasColumn
  // idempotency guard as v5..v12. ai_chat.db has its own version ladder; this bump does NOT touch
  // backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 18) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'chat_tool_call', 'whitelist_rule_id')) {
        db.exec('ALTER TABLE chat_tool_call ADD COLUMN whitelist_rule_id INTEGER')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '18')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v18 → v19 — S4 W3 (task 07-02-s4-custom-agent-core) headless custom-agent sessions. Add
  // ai_chat_sessions.origin ('agent' | NULL) + agent_id + agent_job_id so a cron/email-triggered
  // headless run's session is visible/auditable in the same history UI. NULL for every interactive
  // session (additive ALTER default). backend_kind CHECK unchanged (still 'ai-sdk' — same engine,
  // different initiator). Three plain additive ALTERs, hasColumn idempotency guard (same discipline
  // as v5..v12). ai_chat.db has its own version ladder; this bump does NOT touch
  // backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 19) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_sessions', 'origin')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN origin TEXT')
      }
      if (!hasColumn(db, 'ai_chat_sessions', 'agent_id')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN agent_id TEXT')
      }
      if (!hasColumn(db, 'ai_chat_sessions', 'agent_job_id')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN agent_job_id TEXT')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '19')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v19 → v20 — harness-chat lane A B4 (task 07-15) unread badge. Add ai_chat_sessions.last_read_at:
  // the per-session read watermark (NULL for legacy rows / never-opened sessions → no badge; unread
  // derives as updated_at > last_read_at). Written via serve-api PATCH /chat/sessions/{id}/read
  // (src/chat/db.py update_session_last_read — remote-web parity), deliberately NOT bumping
  // updated_at (a read must never reorder the history list). Plain additive ALTER, hasColumn
  // idempotency guard (same discipline as v5..v19). ai_chat.db has its own version ladder; this bump
  // does NOT touch backend_lifecycle.EXPECTED_DB_VERSION.
  if (current < 20) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_sessions', 'last_read_at')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN last_read_at INTEGER')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '20')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v20 → v21 — pin ordering timestamp + independent star marker. Plain additive, idempotent ALTERs.
  if (current < 21) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_sessions', 'pinned_at')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN pinned_at INTEGER')
      }
      if (!hasColumn(db, 'ai_chat_sessions', 'starred')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN starred INTEGER NOT NULL DEFAULT 0')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '21')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v21 → v22 — stage 2 PR-1 (task 08-01 messenger): NO-OP value-domain registration. The origin
  // column (v19, free text without a CHECK) gains the third value 'im' (飞书 IM conversations,
  // createImSession; domain now 'agent' | 'im' | NULL=interactive) — no ALTER is needed, the bump
  // only records in the ladder when 'im' rows may start appearing. Same idempotent transaction
  // discipline as every step (v21 样板) so a crash mid-step never leaves a torn version.
  if (current < 22) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '22')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  // v22 → v23 — WP-15 context 环 (task 08-05): ai_chat_messages.context_tokens (末 step 的
  // inputTokens = 上下文占用；见头注释里为什么不复用 tokens_input)。Plain additive ALTER,
  // hasColumn idempotency guard (v21 样板)。
  if (current < 23) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_messages', 'context_tokens')) {
        db.exec('ALTER TABLE ai_chat_messages ADD COLUMN context_tokens INTEGER')
      }
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '23')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (current < 24) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_sessions', 'trigger_id')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN trigger_id TEXT')
      }
      if (!hasColumn(db, 'ai_chat_sessions', 'trigger_kind')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN trigger_kind TEXT')
      }
      if (!hasColumn(db, 'ai_chat_sessions', 'trigger_fired_at')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN trigger_fired_at INTEGER')
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_updated
        ON ai_chat_sessions(agent_id, updated_at DESC)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_trigger_fired
        ON ai_chat_sessions(trigger_id, trigger_fired_at DESC)`)
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '24')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (current < 25) {
    db.exec('BEGIN IMMEDIATE')
    try {
      if (!hasColumn(db, 'ai_chat_sessions', 'parent_session_id')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN parent_session_id INTEGER')
      }
      if (!hasColumn(db, 'ai_chat_sessions', 'parent_tool_call_id')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN parent_tool_call_id TEXT')
      }
      if (!hasColumn(db, 'ai_chat_sessions', 'invoked_by')) {
        db.exec('ALTER TABLE ai_chat_sessions ADD COLUMN invoked_by TEXT')
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent
        ON ai_chat_sessions(parent_session_id, created_at ASC)`)
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '25')"
      ).run()
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  if (current < 26) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(`
CREATE TABLE IF NOT EXISTS chat_queued_input (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  run_id TEXT,
  mode TEXT NOT NULL DEFAULT 'follow_up',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  claimed_at INTEGER,
  delivered_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (mode IN ('follow_up', 'steering')),
  CHECK (status IN ('queued', 'claimed', 'sent', 'canceled', 'restored')),
  FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_queued_input_dispatch
  ON chat_queued_input(session_id, status, created_at ASC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_queued_input_delivery
  ON chat_queued_input(delivered_message_id)
  WHERE delivered_message_id IS NOT NULL;
      `)
      db.prepare(
        "INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '26')"
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
