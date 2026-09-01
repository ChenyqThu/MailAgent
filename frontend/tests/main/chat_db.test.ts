// Sprint 4 — chat_db.ts behavioural contract (REVIEW-LOG C-05 carry-forward).
//
// Verified scenarios:
//   - Schema migration runs cleanly on a fresh DB and is idempotent on re-open.
//   - getOrCreateSession returns the same id for the same (email, backend, agent)
//     triple, including when backend_agent_page_id is NULL (SQLite quirk).
//   - appendMessage / listMessages preserve insertion order + bump session
//     updated_at so the panel's "recent first" ordering stays truthful.
//   - updateMessage patches only the named fields.
//   - abortStreamingMessages flips both 'pending' and 'streaming' rows and
//     returns the affected row count.
//   - deleteSession cascades to messages via the FK.
//
// Tests use a unique tmp file per test (not :memory: — schema migration
// runs INSIDE a transaction, which better-sqlite3 supports against on-disk
// DBs identically to :memory: but the migration test wants to verify the
// post-close re-open path).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  abortStreamingMessages,
  appendMessage,
  appendToolCall,
  closeChatDb,
  createAgentSession,
  createNewSession,
  deleteMessagesFromId,
  deleteSession,
  getChatDb,
  findSessionByParentToolCall,
  getMessage,
  getOrCreateSession,
  getSession,
  getToolCallByUseId,
  listAllSessions,
  listGeneralSessions,
  listLastNMessages,
  listMessages,
  listSessionsForEmail,
  listSessionsForItem,
  listSessionsForMatter,
  listToolCallsForMessage,
  markToolCallApprovalExpired,
  markCompactInvalid,
  resolveChatDbPath,
  updateMessage,
  updateSessionPausedMarker,
  updateSessionPinned,
  updateSessionStarred,
  setAgentSessionJobId,
  updateToolCall
} from '../../src/electron/main/chat_db'

// chat_db 现在 import db.resolveDataRoot() (→ import electron app), 故碰 chat_db 的测试都需
// mock electron。默认 isPackaged=false (env-override 用例不碰它); packaged 用例临时翻 true
// + 注入 getPath('userData')。仿 backend_lifecycle.test.ts。
// vi.hoisted: vi.mock 被 hoist 到文件顶, factory 引用的 appMock 必须在那之前初始化,
// 否则 TDZ "Cannot access 'appMock' before initialization"。
const { appMock } = vi.hoisted(() => ({
  appMock: { isPackaged: false, getPath: (_k: string) => '/tmp' } as {
    isPackaged: boolean
    getPath: (key: string) => string
  }
}))
vi.mock('electron', () => ({ app: appMock }))

let tmpDir: string
let dbPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-db-'))
  dbPath = join(tmpDir, 'ai_chat.db')
  process.env['AI_CHAT_DB_PATH'] = dbPath
  closeChatDb()
})

afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function seedV26ChatDb(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
  const seed = new BetterSqlite3(dbPath)
  seed.exec(`
    CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ai_chat_sessions (
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
      title TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      origin TEXT,
      agent_id TEXT,
      agent_job_id TEXT,
      last_read_at INTEGER,
      pinned_at INTEGER,
      starred INTEGER NOT NULL DEFAULT 0,
      trigger_id TEXT,
      trigger_kind TEXT,
      trigger_fired_at INTEGER,
      parent_session_id INTEGER,
      parent_tool_call_id TEXT,
      invoked_by TEXT,
      CHECK (
        (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
        OR
        (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
      )
    );
    CREATE TABLE ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
    CREATE INDEX idx_sessions_anchor
      ON ai_chat_sessions(anchor_type, anchor_id, updated_at DESC);
    CREATE INDEX idx_chat_sessions_agent_updated
      ON ai_chat_sessions(agent_id, updated_at DESC);
    CREATE INDEX idx_chat_sessions_trigger_fired
      ON ai_chat_sessions(trigger_id, trigger_fired_at DESC);
    CREATE INDEX idx_chat_sessions_parent
      ON ai_chat_sessions(parent_session_id, created_at ASC);
    INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '26');
    INSERT INTO ai_chat_sessions
      (id, email_id, anchor_type, anchor_id, backend_kind, backend_model,
       backend_agent_page_id, created_at, updated_at, title, archived, origin,
       agent_id, agent_job_id, last_read_at, pinned_at, starred, trigger_id,
       trigger_kind, trigger_fired_at, parent_session_id, parent_tool_call_id, invoked_by)
      VALUES
      (7, NULL, 'general', NULL, 'ai-sdk', 'openai/gpt-5', NULL,
       1000, 2000, 'legacy v26', 1, 'interactive', NULL, NULL, 1500, 1400, 1,
       'trigger-1', 'manual', 1300, 3, 'toolu_parent', 'user');
    INSERT INTO ai_chat_messages
      (session_id, role, content, status, created_at, updated_at)
      VALUES (7, 'user', 'preserve me', 'complete', 1000, 1000);
  `)
  seed.close()
}

describe('chat_db — path + schema bootstrap', () => {
  test('resolveChatDbPath honours $AI_CHAT_DB_PATH', () => {
    expect(resolveChatDbPath()).toBe(dbPath)
  })

  test('resolveChatDbPath (no env, packaged app) → under userData/frontend', () => {
    // 打包态无 AI_CHAT_DB_PATH: 经 db.resolveDataRoot() (app.isPackaged → getPath userData)
    // 拼 frontend/ai_chat.db, 与 sync_store.db / .env 同根 (打包 epic 数据归集 userData)。
    const prevDataRoot = process.env['MAILAGENT_DATA_ROOT']
    delete process.env['AI_CHAT_DB_PATH']
    delete process.env['MAILAGENT_DATA_ROOT'] // 优先级高于 packaged getPath, 清掉
    const userData = join(tmpDir, 'userData-root')
    appMock.isPackaged = true
    appMock.getPath = (k: string) => (k === 'userData' ? userData : '/tmp')
    try {
      expect(resolveChatDbPath()).toBe(join(userData, 'frontend', 'ai_chat.db'))
    } finally {
      appMock.isPackaged = false
      appMock.getPath = () => '/tmp'
      if (prevDataRoot !== undefined) process.env['MAILAGENT_DATA_ROOT'] = prevDataRoot
      process.env['AI_CHAT_DB_PATH'] = dbPath // 还原 beforeEach, 不污染后续用例
    }
  })

  test('opening a fresh DB creates the file + tables', () => {
    const db = getChatDb()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('ai_chat_sessions')
    expect(names).toContain('ai_chat_messages')
    expect(names).toContain('chat_db_meta')
    // Sprint 19 — agent harness foundation (PR-1a).
    expect(names).toContain('chat_tool_call')
    expect(names).toContain('wiki_pages')
    // agent_memory_kv was created in v3 and physically dropped in v16 (M5b).
    expect(names).not.toContain('agent_memory_kv')
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    // Sprint 19 (PR-1a): bumped to 3 — chat_tool_call + wiki_pages + wiki_fts + agent_memory_kv.
    // Sprint 19 (bug-fix): bumped to 4 — drop UNIQUE on ai_chat_sessions so
    // newSession() can INSERT a fresh row instead of resurrecting old.
    // task 06-08-chat Bug 2: bumped to 5 — chat_tool_call.content_offset.
    // task 06-08-chat 需求 5: bumped to 6 — ai_chat_messages.thinking.
    // P2c (06-18-custom-ai-harness-agent): bumped to 7 — session anchor
    // (email_id nullable + anchor_type/anchor_id + coupling CHECK).
    // P2a (06-23 agent-experience-epic): bumped to 8 — agent_memory_kv provenance + priority.
    // P4 Phase 02 (06-23 chat-panel AI SDK Gateway): bumped to 9 — ai_chat_messages.ui_message_json.
    // P4 Phase 03b (06-23 chat-panel HITL write tools): bumped to 10 — chat_tool_call.approval_status + approval_hash.
    // P4 Phase 04a (06-23 chat-panel A2UI tool cards): bumped to 11 — chat_tool_call.ui_payload_json.
    // P4 Phase 04b (06-23 chat-panel high-risk send): bumped to 12 — chat_tool_call.content_hash + idempotency_key.
    // P4 Phase 06a (06-23 chat-panel cutover): bumped to 13 — ai_chat_sessions.backend_kind CHECK admits 'ai-sdk'.
    // demo-fidelity Phase 10 (06-23 chat-panel agent view): bumped to 14 — ai_chat_sessions.title.
    // M5b (2026-06-30): bumped to 16 — DROP agent_memory_kv.
    // S1 R1 (07-02 openness wave1): bumped to 17 — ai_chat_messages_fts.
    // S2 W1 (07-02-s2-exec-skill-install): bumped to 18 — chat_tool_call.whitelist_rule_id.
    // S4 W3 (07-02-s4-custom-agent-core): bumped to 19 — ai_chat_sessions.origin/agent_id/agent_job_id.
    // harness-chat lane A B4 (07-15): bumped to 20 — ai_chat_sessions.last_read_at (unread badge).
    // custom-agent epic W3 (07-28): bumped to 21 — pinned_at + starred.
    // messenger stage 2 PR-1 (08-01): bumped to 22 — origin value-domain registers 'im'
    // ('agent' | 'im' | NULL=interactive; no-op ladder step, no ALTER).
    // WP-15 context 环 (08-05): bumped to 23 — ai_chat_messages.context_tokens (末 step 的
    // inputTokens = 上下文占用；≠ tokens_input 的多 step 求和).
    // harness optimization P1 (08-07): v24 — trigger provenance columns + query indexes.
    // Matters MVP P3 (08-10): v27 — matter anchor CHECK + coupling branch.
    // L4 P4b 团队对话 (08-27): v29 — origin value-domain registers 'team' (no-op ladder step).
    // L4 群聊: v30 — members_json + speaker_agent_id; origin value-domain registers 'group'.
    expect(ver.value).toBe('30')
  })

  test('v26 DB rebuilds to v27 with matter CHECK, rows, FKs, and all session indexes intact', () => {
    closeChatDb()
    seedV26ChatDb()

    const db = getChatDb()
    const version = db
      .prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(version.value).toBe('30')

    const legacy = db.prepare('SELECT * FROM ai_chat_sessions WHERE id = 7').get() as Record<
      string,
      unknown
    >
    expect(legacy).toMatchObject({
      anchor_type: 'general',
      title: 'legacy v26',
      archived: 1,
      starred: 1,
      trigger_id: 'trigger-1',
      parent_tool_call_id: 'toolu_parent'
    })
    expect(db.prepare('SELECT content FROM ai_chat_messages WHERE session_id = 7').get()).toEqual({
      content: 'preserve me'
    })
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_chat_sessions'"
      )
      .all() as Array<{ name: string }>
    expect(new Set(indexes.map((row) => row.name))).toEqual(
      new Set([
        'idx_sessions_email',
        'idx_sessions_anchor',
        'idx_chat_sessions_agent_updated',
        'idx_chat_sessions_trigger_fired',
        'idx_chat_sessions_parent',
        // v28 (L4 批次3) — the 行动项 reverse-lookup index, created after the v27 rebuild.
        'idx_chat_sessions_item'
      ])
    )

    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_chat_sessions
          (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at)
         VALUES (NULL, 'matter', 42, 'ai-sdk', 3000, 3000)`
        )
        .run()
    ).not.toThrow()
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_chat_sessions
          (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at)
         VALUES (42, 'matter', 42, 'ai-sdk', 3000, 3000)`
        )
        .run()
    ).toThrow()
  })

  test('v27 shape with meta rolled back to 26 re-enters by advancing meta only', () => {
    const db = getChatDb()
    db.exec('CREATE INDEX idx_v27_reentry_probe ON ai_chat_sessions(title)')
    db.prepare("UPDATE chat_db_meta SET value = '26' WHERE key = 'schema_version'").run()
    closeChatDb()

    const reopened = getChatDb()
    const version = reopened
      .prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(version.value).toBe('30')
    expect(
      reopened
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_v27_reentry_probe'"
        )
        .get()
    ).toEqual({ name: 'idx_v27_reentry_probe' })
  })

  // L4 批次3 (task 08-25) — v27 → v28: two additive session columns + one index. Same DROP COLUMN
  // + meta-rollback shape as the v23 → v24 test above (this ladder step is additive, so an existing
  // DB really does climb by ALTER, not by rebuild).
  test('v27 database upgrades to v28 with item_id + paused_marker_json and the item index', () => {
    const db = getChatDb()
    const session = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    db.exec('DROP INDEX IF EXISTS idx_chat_sessions_item')
    db.exec('ALTER TABLE ai_chat_sessions DROP COLUMN item_id')
    db.exec('ALTER TABLE ai_chat_sessions DROP COLUMN paused_marker_json')
    db.prepare("UPDATE chat_db_meta SET value='27' WHERE key='schema_version'").run()
    closeChatDb()

    const migrated = getChatDb()
    const columns = (
      migrated.prepare('PRAGMA table_info(ai_chat_sessions)').all() as Array<{ name: string }>
    ).map((column) => column.name)
    expect(columns).toEqual(expect.arrayContaining(['item_id', 'paused_marker_json']))
    expect(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_sessions_item'"
        )
        .get()
    ).toEqual({ name: 'idx_chat_sessions_item' })
    expect(
      (
        migrated.prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'").get() as {
          value: string
        }
      ).value
    ).toBe('30')
    // The pre-v28 row survives the ALTERs and reads the new columns as NULL.
    const row = migrated.prepare('SELECT * FROM ai_chat_sessions WHERE id = ?').get(session.id) as {
      item_id: number | null
      paused_marker_json: string | null
    }
    expect(row.item_id).toBeNull()
    expect(row.paused_marker_json).toBeNull()

    // Re-opening at head must not re-run the ALTERs ("duplicate column name" would throw).
    closeChatDb()
    expect(() => getChatDb()).not.toThrow()
  })

  test('fresh DB schema includes the v2 metadata column', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('metadata')
  })

  test('markCompactInvalid defensively flips metadata.valid without changing content', () => {
    const session = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    const message = appendMessage({
      sessionId: session.id,
      role: 'system',
      content: 'summary',
      status: 'complete',
      metadata: JSON.stringify({ kind: 'compact', version: 1, valid: true }),
      uiMessageJson: JSON.stringify({
        id: 'compact-test',
        role: 'system',
        metadata: { kind: 'compact', version: 1, valid: true },
        parts: [
          {
            type: 'data-compact',
            data: { metadata: { kind: 'compact', version: 1, valid: true }, summary: 'summary' }
          }
        ]
      })
    })
    markCompactInvalid(message.id)
    const updated = getMessage(message.id)
    expect(updated?.content).toBe('summary')
    expect(JSON.parse(updated?.metadata ?? '{}').valid).toBe(false)
    const canonical = JSON.parse(updated?.ui_message_json ?? '{}')
    expect(canonical.metadata.valid).toBe(false)
    expect(canonical.parts[0].data.metadata.valid).toBe(false)
  })

  test('fresh DB schema includes the v5 chat_tool_call.content_offset column', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('content_offset')
  })

  test('fresh DB schema includes the v10 chat_tool_call.approval_status + approval_hash columns', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('approval_status')
    expect(names).toContain('approval_hash')
  })

  test('fresh DB schema includes the v11 chat_tool_call.ui_payload_json column', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('ui_payload_json')
  })

  test('fresh DB schema includes the v12 chat_tool_call.content_hash + idempotency_key columns', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('content_hash')
    expect(names).toContain('idempotency_key')
  })

  test('fresh DB v13 — ai_chat_sessions.backend_kind CHECK admits ai-sdk + a session can be created', () => {
    const db = getChatDb()
    // The widened CHECK literal only appears in the v13 CREATE.
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
        .get() as { sql: string }
    ).sql
    expect(sql).toMatch(/'ai-sdk'/)
    // The old narrow CHECK rejected backend_kind='ai-sdk'; the v13 rebuild unblocks it.
    const session = getOrCreateSession({ emailId: 4242, backendKind: 'ai-sdk' })
    expect(session.backend_kind).toBe('ai-sdk')
    expect(session.email_id).toBe(4242)
    expect(getSession(session.id)?.backend_kind).toBe('ai-sdk')
  })

  test('fresh DB schema includes the v6 ai_chat_messages.thinking column', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('thinking')
  })

  test('fresh DB v19 — ai_chat_sessions gains origin/agent_id/agent_job_id (backend_kind CHECK unchanged)', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(ai_chat_sessions)').all() as Array<{ name: string }>
    const names = cols.map((c) => c.name)
    expect(names).toContain('origin')
    expect(names).toContain('agent_id')
    expect(names).toContain('agent_job_id')
    // The v13 backend_kind CHECK is untouched — still admits exactly the three kinds.
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
        .get() as { sql: string }
    ).sql
    expect(sql).toMatch(/'ai-sdk'/)
    expect(sql).toMatch(/'notion-agent'/)
  })

  test('createAgentSession — inserts an origin=agent general session linked to the job', () => {
    const id = createAgentSession({ agentId: 'dms', jobId: 42, title: 'DMS · 2026-07-03 09:00' })
    const session = getSession(id)
    expect(session).not.toBeNull()
    expect(session?.origin).toBe('agent')
    expect(session?.agent_id).toBe('dms')
    // async_jobs.job_id is stored as TEXT (cross-db, no FK).
    expect(session?.agent_job_id).toBe('42')
    // A headless run is a general (context-free) 'ai-sdk' session — no email anchor.
    expect(session?.anchor_type).toBe('general')
    expect(session?.email_id).toBeNull()
    expect(session?.backend_kind).toBe('ai-sdk')
    expect(session?.title).toBe('DMS · 2026-07-03 09:00')
  })

  test('v24 provenance — createAgentSession persists trigger event time and keeps trigger_id null', () => {
    const firedAt = Date.parse('2026-08-07T12:34:56Z')
    const id = createAgentSession({
      agentId: 'digest',
      jobId: 84,
      title: 'Digest',
      triggerId: null,
      triggerKind: 'schedule',
      triggerFiredAt: firedAt
    })
    const session = getSession(id)
    expect(session?.trigger_id).toBeNull()
    expect(session?.trigger_kind).toBe('schedule')
    expect(session?.trigger_fired_at).toBe(firedAt)
    const indexes = getChatDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(['idx_chat_sessions_agent_updated', 'idx_chat_sessions_trigger_fired'])
    )
  })

  test('P4 anchor — createAgentSession can anchor a follow-up run to its Matter', () => {
    const id = createAgentSession({
      agentId: 'matter:MAT-000042',
      jobId: 91,
      title: '跟进 · Atlas rollout',
      triggerKind: 'matter_followup',
      anchor: { type: 'matter', id: 42 }
    })
    const session = getSession(id)
    expect(session?.anchor_type).toBe('matter')
    expect(session?.anchor_id).toBe(42)
    expect(session?.email_id).toBeNull()
    expect(session?.origin).toBe('agent')
    expect(session?.trigger_kind).toBe('matter_followup')
    // 🔴 the run's session must NOT leak into the P3 matter chat panel (origin='agent' filter).
    expect(listSessionsForMatter(42).map((row) => row.id)).not.toContain(id)
  })

  test('P4 anchor — omitting it is byte-identical to the pre-P4 general row', () => {
    const id = createAgentSession({ agentId: 'dms', jobId: 92, title: 'DMS' })
    const session = getSession(id)
    expect(session?.anchor_type).toBe('general')
    expect(session?.anchor_id).toBeNull()
    expect(session?.email_id).toBeNull()
  })

  test('P4 anchor — a non-positive/non-integer matter id is rejected, never written dangling', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createAgentSession({
          agentId: 'matter:x',
          jobId: 93,
          title: 't',
          anchor: { type: 'matter', id: bad }
        })
      ).toThrow(/positive integer id/)
    }
  })

  test('v25 parent provenance supports eager create + replay lookup + later job linkage', () => {
    const id = createAgentSession({
      agentId: 'child',
      title: 'Child',
      parentSessionId: 7,
      parentToolCallId: 'tool-1',
      invokedBy: 'main_agent'
    })
    expect(findSessionByParentToolCall(7, 'tool-1')).toBe(id)
    expect(findSessionByParentToolCall(7, 'missing')).toBeNull()
    setAgentSessionJobId(id, 99)
    const session = getSession(id)
    expect(session?.parent_session_id).toBe(7)
    expect(session?.parent_tool_call_id).toBe('tool-1')
    expect(session?.invoked_by).toBe('main_agent')
    expect(session?.agent_job_id).toBe('99')
  })

  test('v23 database upgrades to v24 with the three nullable provenance columns', () => {
    const db = getChatDb()
    db.exec('DROP INDEX IF EXISTS idx_chat_sessions_trigger_fired')
    db.exec('DROP INDEX IF EXISTS idx_chat_sessions_agent_updated')
    db.exec('ALTER TABLE ai_chat_sessions DROP COLUMN trigger_fired_at')
    db.exec('ALTER TABLE ai_chat_sessions DROP COLUMN trigger_kind')
    db.exec('ALTER TABLE ai_chat_sessions DROP COLUMN trigger_id')
    db.prepare("UPDATE chat_db_meta SET value='23' WHERE key='schema_version'").run()
    closeChatDb()

    const migrated = getChatDb()
    const columns = migrated.prepare('PRAGMA table_info(ai_chat_sessions)').all() as Array<{
      name: string
    }>
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['trigger_id', 'trigger_kind', 'trigger_fired_at'])
    )
    const version = migrated
      .prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'")
      .get() as { value: string }
    expect(version.value).toBe('30')
  })

  test('createAgentSession — an interactive session reads origin as null/undefined (not agent)', () => {
    const interactive = getOrCreateSession({ emailId: 7, backendKind: 'ai-sdk' })
    // origin is absent for every interactive session (additive column default NULL).
    expect(getSession(interactive.id)?.origin ?? null).toBeNull()
  })

  // agent_memory_kv was created in v3 and physically dropped in v16 (M5b, 2026-06-30).
  // The v8 provenance columns no longer exist post-DROP. Test removed.

  test('re-opening an existing DB does not re-run migrations (idempotent)', () => {
    getChatDb()
    closeChatDb()
    // Second open must succeed without throwing.
    const db = getChatDb()
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(ver.value).toBe('30')
  })

  test('fresh DB v23 — ai_chat_messages.context_tokens 与 tokens_input 是两列两语义', () => {
    // WP-15 context 环：环读的是**末 step** 的 inputTokens；tokens_input 是 ai@7 的多 step
    // **求和**。硬把两者挤一列 = 静默改掉既有 metadata.tokensInput 的含义，故必须两列并存。
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('context_tokens')
    expect(cols.map((c) => c.name)).toContain('tokens_input')
    const session = getOrCreateSession({ emailId: 6162, backendKind: 'ai-sdk' })
    // 省略 contextTokens 的调用方（legacy runtime / 非 gateway 写入）→ NULL = 前端不渲染环。
    const legacy = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'legacy',
      status: 'complete',
      tokensInput: 350
    })
    expect(legacy.context_tokens).toBeNull()
    // gateway 路径：两列独立存（350 是三个 step 的求和，250 是末 step）。
    const gateway = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'gateway',
      status: 'complete',
      tokensInput: 350,
      contextTokens: 250
    })
    const row = db
      .prepare('SELECT tokens_input, context_tokens FROM ai_chat_messages WHERE id = ?')
      .get(gateway.id) as { tokens_input: number | null; context_tokens: number | null }
    expect(row).toEqual({ tokens_input: 350, context_tokens: 250 })
    // 审批暂停的行先落库时没有占用，resume 用 updateMessage 补写（updateMessage 必须能写这一列）。
    updateMessage(legacy.id, { contextTokens: 4_100 })
    expect(getMessage(legacy.id)?.context_tokens).toBe(4_100)
  })

  test('fresh DB v21 — ai_chat_sessions has read, pin, and star organization metadata', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(ai_chat_sessions)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('last_read_at')
    expect(cols.map((c) => c.name)).toContain('pinned_at')
    expect(cols.map((c) => c.name)).toContain('starred')
    // NULL for a fresh session (never marked read → no badge); listAllSessions carries it.
    const session = getOrCreateSession({ emailId: 6161, backendKind: 'ai-sdk' })
    const row = db
      .prepare('SELECT last_read_at FROM ai_chat_sessions WHERE id = ?')
      .get(session.id) as { last_read_at: number | null }
    expect(row.last_read_at).toBeNull()
  })

  test('v20→v21 forward migration is idempotent (crash-after-ALTER re-entry converges)', () => {
    // Build the fully-migrated DB, then roll ONLY the meta back to 20 — the hasColumn guard must
    // skip duplicate ALTERs and still advance schema_version to the ladder top (v23 — the 08-01
    // messenger no-op 'im' value-domain step + the 08-05 context_tokens ALTER ride on top of the
    // v21 ALTERs).
    const db = getChatDb()
    db.prepare("UPDATE chat_db_meta SET value = '20' WHERE key = 'schema_version'").run()
    closeChatDb()
    const reopened = getChatDb()
    const ver = reopened
      .prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'")
      .get() as { value: string }
    expect(ver.value).toBe('30')
    const cols = reopened.prepare('PRAGMA table_info(ai_chat_sessions)').all() as Array<{
      name: string
    }>
    expect(cols.filter((c) => c.name === 'pinned_at')).toHaveLength(1)
    expect(cols.filter((c) => c.name === 'starred')).toHaveLength(1)
    // v22→v23 的 ALTER 同样只加一次（hasColumn 幂等闸）。
    const msgCols = reopened.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{
      name: string
    }>
    expect(msgCols.filter((c) => c.name === 'context_tokens')).toHaveLength(1)
  })

  test('v1-version DB ALTERs in the metadata column on first open (forward migration)', () => {
    // Hand-build a v1 DB that the Sprint 4 ship would have created, then
    // let getChatDb() upgrade it. Verifies that an installed user with
    // pre-Sprint 5 ai_chat.db doesn't lose data on first launch.
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id INTEGER NOT NULL,
        backend_kind TEXT NOT NULL,
        backend_model TEXT,
        backend_agent_page_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (email_id, backend_kind, backend_agent_page_id)
      );
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        cost_usd REAL,
        model TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '1');
      INSERT INTO ai_chat_sessions
        (email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
        VALUES (101, 'notion-agent', NULL, 'agent-1', 0, 0);
      INSERT INTO ai_chat_messages
        (session_id, role, content, status, model, created_at, updated_at)
        VALUES (1, 'assistant', 'hi', 'complete', 'notion-agent:thr-old', 0, 0);
    `)
    seed.close()

    const db = getChatDb()
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    // Sprint 19 (PR-1a → bug-fix): v1 DB jumped to v4; task 06-08-chat Bug 2
    // bumped to v5; 需求 5 bumped to v6; P2a → v8; P4 Phase 02 → v9 → a v1 DB now
    // climbs the whole ladder to v17.
    expect(ver.value).toBe('30')
    const cols = db.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('metadata')
    // v6 column present after climbing from v1.
    expect(cols.map((c) => c.name)).toContain('thinking')
    // v9 column present after climbing from v1.
    expect(cols.map((c) => c.name)).toContain('ui_message_json')
    // v5 + v10 columns present after climbing from v1.
    const toolCols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{
      name: string
    }>
    expect(toolCols.map((c) => c.name)).toContain('content_offset')
    expect(toolCols.map((c) => c.name)).toContain('approval_status')
    expect(toolCols.map((c) => c.name)).toContain('approval_hash')
    // Old data preserved verbatim — the v1-stored thread_id encoding stays
    // in `model`, where notion_agent.extractTurn's backcompat reader picks
    // it up.
    const row = db
      .prepare("SELECT model, metadata FROM ai_chat_messages WHERE role = 'assistant'")
      .get() as { model: string; metadata: string | null }
    expect(row.model).toBe('notion-agent:thr-old')
    expect(row.metadata).toBeNull()
    // Sprint 19 — v3 tables exist post-migration (agent_memory_kv created in v3, dropped in v16).
    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((t) => t.name)
    expect(tableNames).toContain('chat_tool_call')
    expect(tableNames).toContain('wiki_pages')
    // agent_memory_kv physically dropped in v16 (M5b).
    expect(tableNames).not.toContain('agent_memory_kv')
  })

  // P4 Phase 06a (cutover) — a v12 DB (post-v7 anchor shape, narrow backend_kind
  // CHECK) forward-migrates to v13: the sessions table is rebuilt with the widened
  // CHECK, every existing row + its messages survive the FK-off rebuild, and an
  // 'ai-sdk' session becomes insertable (the regression the cutover unblocks).
  test('v12 DB forward-migrates to v13 — sessions rebuilt with widened CHECK, rows + messages preserved', () => {
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    seed.pragma('foreign_keys = ON')
    // The v12 ai_chat_sessions shape == the v7 anchor table (v8..v12 were all
    // additive on messages / tool_call / memory), with the OLD narrow CHECK.
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id INTEGER,
        anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email', 'general')),
        anchor_id INTEGER,
        backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api')),
        backend_model TEXT,
        backend_agent_page_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
          OR (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
        )
      );
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ui_message_json TEXT
      );
      -- A real v12 DB carries chat_tool_call (created at v3 + additive columns through v12);
      -- include it so the v18 whitelist_rule_id ALTER has a table to extend.
      CREATE TABLE chat_tool_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
        duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
        content_offset INTEGER, approval_status TEXT, approval_hash TEXT, ui_payload_json TEXT,
        content_hash TEXT, idempotency_key TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (message_id, tool_use_id)
      );
      CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
      CREATE INDEX idx_sessions_anchor ON ai_chat_sessions(anchor_type, anchor_id, updated_at DESC);
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '12');
      INSERT INTO ai_chat_sessions
        (id, email_id, anchor_type, anchor_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
        VALUES (7, 555, 'email', 555, 'custom-api', 'claude-sonnet-4-6', NULL, 0, 0);
      INSERT INTO ai_chat_messages
        (session_id, role, content, status, created_at, updated_at)
        VALUES (7, 'user', 'hello pre-cutover', 'complete', 0, 0);
    `)
    seed.close()

    const db = getChatDb()
    expect(
      (
        db.prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'").get() as {
          value: string
        }
      ).value
    ).toBe('30')
    // Narrow CHECK gone, widened CHECK in place.
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
        .get() as { sql: string }
    ).sql
    expect(sql).toMatch(/'ai-sdk'/)
    // Pre-existing session preserved verbatim through the rebuild (pure copy).
    const preserved = getSession(7)
    expect(preserved?.backend_kind).toBe('custom-api')
    expect(preserved?.email_id).toBe(555)
    expect(preserved?.anchor_type).toBe('email')
    // Its message survived the sessions-table rebuild (FK-off discipline — DROP
    // TABLE with FK on would have cascade-deleted it).
    const msgs = listMessages(7)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content).toBe('hello pre-cutover')
    // The regression the cutover unblocks: an ai-sdk session is now insertable.
    const aiSdk = getOrCreateSession({ emailId: 999, backendKind: 'ai-sdk' })
    expect(aiSdk.backend_kind).toBe('ai-sdk')
  })

  test('opening a future-version DB refuses to load', () => {
    const db = getChatDb()
    db.prepare("UPDATE chat_db_meta SET value = '99' WHERE key = 'schema_version'").run()
    closeChatDb()
    expect(() => getChatDb()).toThrow(/schema is at v99/)
  })

  // task 06-08-chat (codex LOW-2) — crash-resilience. A migration that committed
  // the physical v5/v6 columns but crashed before persisting the matching
  // schema_version would leave the DB at "physical v6 columns + meta v3". On the
  // next open the old code re-ran ADD COLUMN content_offset/thinking and threw
  // "duplicate column name". The per-column idempotency guards + the gated v3
  // meta-write must now climb such a DB to v6 cleanly without re-adding columns.
  test('re-entry with physical v6 columns but a lagging meta v3 converges to v6 without throwing', () => {
    // First build a fully-migrated v6 DB.
    const db = getChatDb()
    expect(
      (
        db.prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'").get() as {
          value: string
        }
      ).value
    ).toBe('30')
    // Simulate the crash window: roll the meta back to v3 while the physical
    // schema (content_offset + thinking columns, v4 table shape) stays at v6.
    db.prepare("UPDATE chat_db_meta SET value = '3' WHERE key = 'schema_version'").run()
    closeChatDb()

    // Re-open: must NOT throw on duplicate ADD COLUMN, and must re-converge to v17.
    expect(() => getChatDb()).not.toThrow()
    const reopened = getChatDb()
    const ver = reopened
      .prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'")
      .get() as { value: string }
    expect(ver.value).toBe('30')
    // Columns are still present exactly once (no duplication, no loss).
    const msgCols = reopened.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{
      name: string
    }>
    expect(msgCols.filter((c) => c.name === 'thinking').length).toBe(1)
    const toolCols = reopened.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{
      name: string
    }>
    expect(toolCols.filter((c) => c.name === 'content_offset').length).toBe(1)
  })
})

describe('chat_db — sessions', () => {
  test('getOrCreateSession inserts a new row on first call', () => {
    const session = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendModel: 'claude-sonnet-4-6',
      backendAgentPageId: '2e115375-830d-8184-bf4d-f427d847c6bc'
    })
    expect(session.id).toBeGreaterThan(0)
    expect(session.email_id).toBe(101)
    expect(session.backend_kind).toBe('notion-agent')
    expect(session.backend_model).toBe('claude-sonnet-4-6')
    expect(session.backend_agent_page_id).toBe('2e115375-830d-8184-bf4d-f427d847c6bc')
  })

  test('getOrCreateSession returns the same id for the same triple', () => {
    const a = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-1'
    })
    const b = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-1'
    })
    expect(b.id).toBe(a.id)
  })

  test('getOrCreateSession with NULL agent_page_id is well-defined (SQLite NULL quirk)', () => {
    const a = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const b = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    expect(b.id).toBe(a.id)
    expect(a.backend_agent_page_id).toBeNull()
  })

  test('different agent_page_id → different session', () => {
    const a = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-1'
    })
    const b = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-2'
    })
    expect(b.id).not.toBe(a.id)
  })

  test('model swap on the same triple updates backend_model + updated_at', async () => {
    const a = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendModel: 'claude-sonnet-4-6',
      backendAgentPageId: 'agent-1'
    })
    await new Promise((r) => setTimeout(r, 5))
    const b = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendModel: 'gpt-5.4',
      backendAgentPageId: 'agent-1'
    })
    expect(b.id).toBe(a.id)
    expect(b.backend_model).toBe('gpt-5.4')
    expect(b.updated_at).toBeGreaterThanOrEqual(a.updated_at)
  })

  test('listSessionsForEmail returns most-recently-touched first', async () => {
    const a = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    await new Promise((r) => setTimeout(r, 5))
    const b = getOrCreateSession({
      emailId: 101,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-1'
    })
    const rows = listSessionsForEmail(101)
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id])
  })

  test('getSession returns null for unknown id', () => {
    expect(getSession(9999)).toBeNull()
  })
})

describe('chat_db — messages', () => {
  test('appendMessage preserves all optional fields', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const msg = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'hi there',
      status: 'complete',
      model: 'claude-sonnet-4-6',
      tokensInput: 12,
      tokensOutput: 4,
      costUsd: 0.00018
    })
    expect(msg.session_id).toBe(session.id)
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('hi there')
    expect(msg.tokens_input).toBe(12)
    expect(msg.tokens_output).toBe(4)
    expect(msg.cost_usd).toBeCloseTo(0.00018, 6)
    expect(msg.model).toBe('claude-sonnet-4-6')
    expect(msg.status).toBe('complete')
  })

  test('appendMessage with no optional fields uses NULLs not zeros', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const msg = appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'hi',
      status: 'complete'
    })
    expect(msg.tokens_input).toBeNull()
    expect(msg.cost_usd).toBeNull()
    expect(msg.model).toBeNull()
  })

  test('listMessages returns rows in insertion order', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    appendMessage({ sessionId: session.id, role: 'user', content: 'one', status: 'complete' })
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'two',
      status: 'complete'
    })
    appendMessage({ sessionId: session.id, role: 'user', content: 'three', status: 'complete' })
    const rows = listMessages(session.id)
    expect(rows.map((r) => r.content)).toEqual(['one', 'two', 'three'])
  })

  test('appendMessage bumps session updated_at', async () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const initialUpdatedAt = session.updated_at
    await new Promise((r) => setTimeout(r, 5))
    appendMessage({ sessionId: session.id, role: 'user', content: 'hi', status: 'complete' })
    const refreshed = getSession(session.id)!
    expect(refreshed.updated_at).toBeGreaterThan(initialUpdatedAt)
  })

  test('updateMessage patches only named fields', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const msg = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '',
      status: 'streaming'
    })
    updateMessage(msg.id, { content: 'streamed body', tokensOutput: 16 })
    const fresh = getMessage(msg.id)!
    expect(fresh.content).toBe('streamed body')
    expect(fresh.tokens_output).toBe(16)
    expect(fresh.status).toBe('streaming') // unchanged
  })

  test('updateMessage with empty patch is a no-op', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const msg = appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'hi',
      status: 'complete'
    })
    expect(() => updateMessage(msg.id, {})).not.toThrow()
    expect(getMessage(msg.id)?.content).toBe('hi')
  })

  test('appendMessage + updateMessage round-trip the metadata blob (v2)', () => {
    // Sprint 5 Day 1 (opus L carry-forward): notion_agent backend writes
    // its thread_id here so future turns can read it back without abusing
    // the `model` column.
    const session = getOrCreateSession({ emailId: 101, backendKind: 'notion-agent' })
    const msg = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'hi',
      status: 'complete',
      metadata: JSON.stringify({ thread_id: 'thr-abc' })
    })
    expect(msg.metadata).toBe('{"thread_id":"thr-abc"}')
    const fresh = getMessage(msg.id)!
    expect(fresh.metadata).toBe('{"thread_id":"thr-abc"}')
    updateMessage(msg.id, { metadata: JSON.stringify({ thread_id: 'thr-renamed' }) })
    expect(getMessage(msg.id)!.metadata).toBe('{"thread_id":"thr-renamed"}')
    // Clearing metadata is supported via explicit null patch.
    updateMessage(msg.id, { metadata: null })
    expect(getMessage(msg.id)!.metadata).toBeNull()
  })

  // Sprint 14 PR B — inline edit truncate helper.
  test('deleteMessagesFromId removes the named id + everything after it', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const m1 = appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'first user',
      status: 'complete'
    })
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'first reply',
      status: 'complete'
    })
    const m3 = appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'second user',
      status: 'complete'
    })
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'second reply',
      status: 'complete'
    })

    // Truncate from the second user message — should remove m3 + m4
    // (the second user + its assistant reply) but leave m1 + m2 intact.
    const removed = deleteMessagesFromId(session.id, m3.id)
    expect(removed).toBe(2)

    const survivors = listMessages(session.id)
    expect(survivors.map((m) => m.id)).toEqual([m1.id, m1.id + 1])
    expect(survivors.map((m) => m.content)).toEqual(['first user', 'first reply'])
  })

  test('deleteMessagesFromId is scoped to the session — sibling sessions untouched', () => {
    const sessionA = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const sessionB = getOrCreateSession({ emailId: 102, backendKind: 'custom-api' })
    const aUser = appendMessage({
      sessionId: sessionA.id,
      role: 'user',
      content: 'A1',
      status: 'complete'
    })
    appendMessage({
      sessionId: sessionB.id,
      role: 'user',
      content: 'B1',
      status: 'complete'
    })

    // Deleting from sessionA's user msg id MUST NOT also delete the
    // numerically-equal-or-greater row in sessionB (the SQL ROWID space
    // is shared across sessions; without the session_id filter, the
    // helper would scorched-earth other sessions).
    const removed = deleteMessagesFromId(sessionA.id, aUser.id)
    expect(removed).toBe(1)
    expect(listMessages(sessionA.id)).toEqual([])
    expect(listMessages(sessionB.id)).toHaveLength(1)
  })

  test('deleteMessagesFromId on an unknown id is a 0-row no-op', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    appendMessage({
      sessionId: session.id,
      role: 'user',
      content: 'lone',
      status: 'complete'
    })
    const removed = deleteMessagesFromId(session.id, 999_999)
    expect(removed).toBe(0)
    expect(listMessages(session.id)).toHaveLength(1)
  })
})

describe('chat_db — abort + cascade', () => {
  test('abortStreamingMessages flips streaming + pending and reports count', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    appendMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming' })
    appendMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'pending' })
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'done',
      status: 'complete'
    })

    const aborted = abortStreamingMessages(session.id)
    expect(aborted).toBe(2)

    const rows = listMessages(session.id)
    expect(rows.find((r) => r.status === 'streaming')).toBeUndefined()
    expect(rows.find((r) => r.status === 'pending')).toBeUndefined()
    expect(rows.find((r) => r.status === 'aborted' && r.content === '')).toBeTruthy()
    expect(rows.find((r) => r.status === 'complete' && r.content === 'done')).toBeTruthy()
  })

  test('abortStreamingMessages on an empty / clean session returns 0', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    expect(abortStreamingMessages(session.id)).toBe(0)
  })

  test('deleteSession cascades to messages', () => {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    appendMessage({ sessionId: session.id, role: 'user', content: 'hi', status: 'complete' })
    appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: 'hello',
      status: 'complete'
    })

    deleteSession(session.id)

    expect(getSession(session.id)).toBeNull()
    expect(listMessages(session.id)).toEqual([])
  })

  test('aborts scoped to the session — sibling sessions untouched', () => {
    const a = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const b = getOrCreateSession({
      emailId: 102,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-1'
    })
    appendMessage({ sessionId: a.id, role: 'assistant', content: '', status: 'streaming' })
    appendMessage({ sessionId: b.id, role: 'assistant', content: '', status: 'streaming' })

    abortStreamingMessages(a.id)

    expect(listMessages(a.id).find((r) => r.status === 'streaming')).toBeUndefined()
    expect(listMessages(b.id).find((r) => r.status === 'streaming')).toBeTruthy()
  })
})

// Sprint 19 PR-1a — chat_tool_call CRUD round-trip + v3 schema integrity.
describe('chat_db — chat_tool_call (Sprint 19)', () => {
  function seedAssistantMessage(): { sessionId: number; messageId: number } {
    const session = getOrCreateSession({ emailId: 101, backendKind: 'custom-api' })
    const msg = appendMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '',
      status: 'streaming'
    })
    return { sessionId: session.id, messageId: msg.id }
  }

  test('appendToolCall persists the LLM-proposed input + status', () => {
    const { messageId } = seedAssistantMessage()
    const row = appendToolCall({
      messageId,
      toolUseId: 'toolu_test_001',
      toolName: 'email_search',
      inputJson: JSON.stringify({ subject_contains: 'q3 okr', limit: 10 }),
      confirmationTier: 'silent',
      status: 'running'
    })
    expect(row.id).toBeGreaterThan(0)
    expect(row.message_id).toBe(messageId)
    expect(row.tool_use_id).toBe('toolu_test_001')
    expect(row.tool_name).toBe('email_search')
    expect(JSON.parse(row.input_json)).toEqual({ subject_contains: 'q3 okr', limit: 10 })
    expect(row.status).toBe('running')
    expect(row.confirmation_tier).toBe('silent')
    expect(row.output_json).toBeNull()
    expect(row.user_edited_input_json).toBeNull()
  })

  test('updateToolCall fills output + duration on completion', () => {
    const { messageId } = seedAssistantMessage()
    const row = appendToolCall({
      messageId,
      toolUseId: 'toolu_test_002',
      toolName: 'email_get',
      inputJson: JSON.stringify({ internal_id: 53675 }),
      confirmationTier: 'silent',
      status: 'running'
    })
    updateToolCall(row.id, {
      status: 'ok',
      outputJson: JSON.stringify({ subject: 'hello', sender: 'bob@acme.com' }),
      durationMs: 42
    })
    const fresh = getToolCallByUseId(messageId, 'toolu_test_002')!
    expect(fresh.status).toBe('ok')
    expect(JSON.parse(fresh.output_json!)).toEqual({ subject: 'hello', sender: 'bob@acme.com' })
    expect(fresh.duration_ms).toBe(42)
  })

  test('updateToolCall persists user_edited_input_json + confirmed_at for tier=edit', () => {
    const { messageId } = seedAssistantMessage()
    const row = appendToolCall({
      messageId,
      toolUseId: 'toolu_draft_001',
      toolName: 'email_draft_reply',
      inputJson: JSON.stringify({ internal_id: 1, body_markdown: 'See you Tuesday.' }),
      confirmationTier: 'edit',
      status: 'pending'
    })
    const confirmedAt = Date.now()
    updateToolCall(row.id, {
      status: 'confirmed',
      userEditedInputJson: JSON.stringify({
        internal_id: 1,
        body_markdown: 'See you Wednesday — Tuesday no longer works.'
      }),
      confirmedAt
    })
    const fresh = getToolCallByUseId(messageId, 'toolu_draft_001')!
    expect(fresh.status).toBe('confirmed')
    expect(fresh.confirmed_at).toBe(confirmedAt)
    expect(JSON.parse(fresh.user_edited_input_json!).body_markdown).toContain('Wednesday')
  })

  test('approval expiry marks only the latest matching tool-use row', () => {
    const older = seedAssistantMessage()
    const newer = seedAssistantMessage()
    appendToolCall({
      messageId: older.messageId,
      toolUseId: 'toolu_reused',
      toolName: 'email_archive',
      inputJson: '{}',
      confirmationTier: 'edit',
      status: 'pending'
    })
    appendToolCall({
      messageId: newer.messageId,
      toolUseId: 'toolu_reused',
      toolName: 'email_archive',
      inputJson: '{}',
      confirmationTier: 'edit',
      status: 'pending'
    })
    markToolCallApprovalExpired('toolu_reused')
    expect(getToolCallByUseId(older.messageId, 'toolu_reused')?.approval_status).toBeNull()
    expect(getToolCallByUseId(newer.messageId, 'toolu_reused')?.approval_status).toBe(
      'approval_expired'
    )
  })

  test('listToolCallsForMessage returns rows in insertion order', () => {
    const { messageId } = seedAssistantMessage()
    appendToolCall({
      messageId,
      toolUseId: 'toolu_001',
      toolName: 'email_search',
      inputJson: '{}',
      confirmationTier: 'silent',
      status: 'running'
    })
    appendToolCall({
      messageId,
      toolUseId: 'toolu_002',
      toolName: 'email_body',
      inputJson: '{"internal_id":42}',
      confirmationTier: 'silent',
      status: 'running'
    })
    const rows = listToolCallsForMessage(messageId)
    expect(rows.map((r) => r.tool_use_id)).toEqual(['toolu_001', 'toolu_002'])
  })

  test('appendToolCall round-trips content_offset (task 06-08-chat Bug 2)', () => {
    const { messageId } = seedAssistantMessage()
    const row = appendToolCall({
      messageId,
      toolUseId: 'toolu_offset',
      toolName: 'email_search',
      inputJson: '{}',
      confirmationTier: 'silent',
      status: 'running',
      contentOffset: 17
    })
    expect(row.content_offset).toBe(17)
    const fresh = getToolCallByUseId(messageId, 'toolu_offset')!
    expect(fresh.content_offset).toBe(17)
  })

  test('appendToolCall without contentOffset persists NULL (degrade path)', () => {
    const { messageId } = seedAssistantMessage()
    const row = appendToolCall({
      messageId,
      toolUseId: 'toolu_no_offset',
      toolName: 'email_get',
      inputJson: '{}',
      confirmationTier: 'silent',
      status: 'running'
    })
    expect(row.content_offset).toBeNull()
    const fresh = getToolCallByUseId(messageId, 'toolu_no_offset')!
    expect(fresh.content_offset).toBeNull()
  })

  test('appendToolCall accepts contentOffset of 0 (chip before any text)', () => {
    const { messageId } = seedAssistantMessage()
    const row = appendToolCall({
      messageId,
      toolUseId: 'toolu_zero',
      toolName: 'email_get',
      inputJson: '{}',
      confirmationTier: 'silent',
      status: 'running',
      contentOffset: 0
    })
    // 0 must persist as 0, not coerce to NULL (?? guards only null/undefined).
    expect(row.content_offset).toBe(0)
    expect(getToolCallByUseId(messageId, 'toolu_zero')!.content_offset).toBe(0)
  })

  test('UNIQUE (message_id, tool_use_id) — duplicate toolUseId on same message throws', () => {
    const { messageId } = seedAssistantMessage()
    appendToolCall({
      messageId,
      toolUseId: 'toolu_dup',
      toolName: 'email_search',
      inputJson: '{}',
      confirmationTier: 'silent',
      status: 'running'
    })
    expect(() =>
      appendToolCall({
        messageId,
        toolUseId: 'toolu_dup',
        toolName: 'email_search',
        inputJson: '{}',
        confirmationTier: 'silent',
        status: 'running'
      })
    ).toThrow()
  })

  test('CASCADE — deleting the assistant message removes its tool calls', () => {
    const { sessionId, messageId } = seedAssistantMessage()
    appendToolCall({
      messageId,
      toolUseId: 'toolu_cascade',
      toolName: 'email_get',
      inputJson: '{}',
      confirmationTier: 'silent',
      status: 'ok'
    })
    expect(listToolCallsForMessage(messageId)).toHaveLength(1)
    deleteSession(sessionId)
    expect(listToolCallsForMessage(messageId)).toHaveLength(0)
  })

  test('getToolCallByUseId returns null for unknown id', () => {
    const { messageId } = seedAssistantMessage()
    expect(getToolCallByUseId(messageId, 'toolu_does_not_exist')).toBeNull()
  })
})

// Sprint 19 PR-1a — v3 schema additions integrity (wiki_pages + wiki_fts triggers).
// agent_memory_kv was also created in v3 but physically dropped in v16 (M5b, 2026-06-30).
describe('chat_db — v3 schema (wiki)', () => {
  test('wiki_pages PRIMARY KEY (path) + wiki_fts trigger keeps body in sync on INSERT/UPDATE/DELETE', () => {
    const db = getChatDb()
    const now = Date.now()
    db.prepare(
      `INSERT INTO wiki_pages
        (path, scope, slug, body_markdown, refs_json, source_messages_json,
         updated_by, mtime_ns, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 'user', ?, ?, ?)`
    ).run('user/preferences.md', 'user', null, 'I prefer concise replies.', now, now, now)

    const ftsRow = db
      .prepare(`SELECT body_markdown FROM wiki_fts WHERE path = 'user/preferences.md'`)
      .get() as { body_markdown: string } | undefined
    expect(ftsRow?.body_markdown).toBe('I prefer concise replies.')

    // FTS5 MATCH path verifies tokenizer reaches into the body. `concise` lives
    // in the seeded body, so it must surface.
    const hits = db
      .prepare(`SELECT path FROM wiki_fts WHERE wiki_fts MATCH 'concise'`)
      .all() as Array<{ path: string }>
    expect(hits.map((h) => h.path)).toContain('user/preferences.md')

    // UPDATE → FTS row must reflect new body.
    db.prepare(`UPDATE wiki_pages SET body_markdown = ?, updated_at = ? WHERE path = ?`).run(
      'I prefer brief replies with code samples.',
      now + 1,
      'user/preferences.md'
    )
    const updated = db
      .prepare(`SELECT body_markdown FROM wiki_fts WHERE path = 'user/preferences.md'`)
      .get() as { body_markdown: string }
    expect(updated.body_markdown).toBe('I prefer brief replies with code samples.')

    // DELETE → FTS row must be gone.
    db.prepare(`DELETE FROM wiki_pages WHERE path = ?`).run('user/preferences.md')
    const gone = db
      .prepare(`SELECT body_markdown FROM wiki_fts WHERE path = 'user/preferences.md'`)
      .get() as { body_markdown: string } | undefined
    expect(gone).toBeUndefined()
  })

  test('wiki_pages PRIMARY KEY rejects duplicate path', () => {
    const db = getChatDb()
    const now = Date.now()
    const stmt = db.prepare(
      `INSERT INTO wiki_pages
        (path, scope, body_markdown, updated_by, mtime_ns, created_at, updated_at)
       VALUES (?, 'user', ?, 'user', ?, ?, ?)`
    )
    stmt.run('user/preferences.md', 'first', now, now, now)
    expect(() => stmt.run('user/preferences.md', 'second', now, now, now)).toThrow()
  })

  // agent_memory_kv composite PRIMARY KEY test removed — table physically dropped in v16 (M5b).
})

// Sprint 19 bug-fix — v3 → v4 migration drops UNIQUE on ai_chat_sessions
// (email_id, backend_kind, backend_agent_page_id). Sprint 14 PR A sidebar
// design intended multi-session per email but v1 schema's UNIQUE was
// never dropped → newSession() couldn't INSERT a fresh row and
// getOrCreateSession kept resurrecting the latest one (user-visible bug).

describe('chat_db — v3 → v4 migration (drop UNIQUE on ai_chat_sessions)', () => {
  test('v3-version DB upgrades to v4 + new schema has no UNIQUE constraint', () => {
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    // Hand-build v3 schema: ai_chat_sessions WITH UNIQUE (the pre-fix bug).
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
      CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        cost_usd REAL,
        model TEXT,
        status TEXT NOT NULL,
        error_message TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- A real v3 DB also has chat_tool_call (created by the v3 migration); the
      -- v4→v5 ALTER targets it, so the seed must include it (task 06-08-chat).
      CREATE TABLE chat_tool_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        user_edited_input_json TEXT,
        output_json TEXT,
        status TEXT NOT NULL,
        duration_ms INTEGER,
        confirmation_tier TEXT NOT NULL,
        confirmed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (message_id, tool_use_id)
      );
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '3');
      INSERT INTO ai_chat_sessions
        (email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
        VALUES (500, 'custom-api', 'sonnet', NULL, 1000, 1000);
      INSERT INTO ai_chat_messages
        (session_id, role, content, status, created_at, updated_at)
        VALUES (1, 'user', 'pre-migration chat', 'complete', 1000, 1000);
    `)
    seed.close()

    const db = getChatDb()
    // Schema climbs v3 → v4 → … → v17.
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(ver.value).toBe('30')
    // UNIQUE gone — CREATE TABLE SQL no longer contains UNIQUE clause on
    // (email_id, backend_kind, backend_agent_page_id).
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
        .get() as { sql: string }
    ).sql
    expect(tableSql).not.toMatch(/UNIQUE\s*\(\s*email_id\s*,\s*backend_kind/i)
    // Session data preserved (id, model).
    const rows = db.prepare('SELECT id, backend_model FROM ai_chat_sessions').all() as Array<{
      id: number
      backend_model: string
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(1)
    expect(rows[0].backend_model).toBe('sonnet')
    // CRITICAL — ai_chat_messages rows survived (the bug we just fixed
    // would CASCADE-delete this via DROP TABLE with foreign_keys=ON).
    const msgs = db
      .prepare('SELECT content FROM ai_chat_messages WHERE session_id = 1')
      .all() as Array<{ content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('pre-migration chat')
    // After UNIQUE drop, second INSERT with same (email, backend, NULL)
    // is now allowed — this is what enables newSession() multi-session.
    // P2c — post-v7 the table has the anchor coupling CHECK; an email row must
    // carry anchor_type='email' + anchor_id (= email_id), else IntegrityError.
    db.prepare(
      `INSERT INTO ai_chat_sessions
         (email_id, anchor_type, anchor_id, backend_kind, backend_model,
          backend_agent_page_id, created_at, updated_at)
       VALUES (500, 'email', 500, 'custom-api', 'sonnet', NULL, 2000, 2000)`
    ).run()
    const after = (
      db.prepare('SELECT COUNT(*) as c FROM ai_chat_sessions WHERE email_id = 500').get() as {
        c: number
      }
    ).c
    expect(after).toBe(2)
    // FK integrity still holds (foreign_keys=ON re-enabled in finally).
    const fkViolations = db.prepare('PRAGMA foreign_key_check').all()
    expect(fkViolations).toHaveLength(0)
  })

  test('v3 → v4 migration preserves idx_sessions_email index', () => {
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id INTEGER NOT NULL,
        backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api')),
        backend_model TEXT, backend_agent_page_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (email_id, backend_kind, backend_agent_page_id)
      );
      CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id),
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
        metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      -- chat_tool_call must exist for the v4→v5 ALTER (task 06-08-chat Bug 2).
      CREATE TABLE chat_tool_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
        duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (message_id, tool_use_id)
      );
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '3');
    `)
    seed.close()

    const db = getChatDb()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ai_chat_sessions'")
      .all() as Array<{ name: string }>
    expect(indexes.map((i) => i.name)).toContain('idx_sessions_email')
  })
})

// task 06-08-chat Bug 2 — v4 → v5 migration adds chat_tool_call.content_offset
// so the renderer can interleave tool chips at their proposal position in the
// assistant message body instead of stacking them all below it.

describe('chat_db — v4 → v5 migration (chat_tool_call.content_offset)', () => {
  test('v4-version DB ALTERs in content_offset (NULL for existing rows) + climbs to v5', () => {
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    // Hand-build a v4 DB (no UNIQUE on sessions; chat_tool_call WITHOUT
    // content_offset) with one pre-existing tool-call row.
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id INTEGER NOT NULL,
        backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api')),
        backend_model TEXT, backend_agent_page_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
        metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE chat_tool_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
        duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (message_id, tool_use_id)
      );
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '4');
      INSERT INTO ai_chat_sessions
        (email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
        VALUES (600, 'custom-api', 'sonnet', NULL, 1000, 1000);
      INSERT INTO ai_chat_messages
        (session_id, role, content, status, created_at, updated_at)
        VALUES (1, 'assistant', 'pre-v5 reply', 'complete', 1000, 1000);
      INSERT INTO chat_tool_call
        (message_id, tool_use_id, tool_name, input_json, status, confirmation_tier, created_at, updated_at)
        VALUES (1, 'toolu_legacy', 'email_search', '{"q":"x"}', 'ok', 'silent', 1000, 1000);
    `)
    seed.close()

    const db = getChatDb()
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    // v4 DB now climbs the whole ladder to v17 (content_offset added at v5).
    expect(ver.value).toBe('30')
    // Column present, pre-existing row reads NULL (degrade path in renderer).
    const cols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('content_offset')
    const legacy = db
      .prepare("SELECT content_offset FROM chat_tool_call WHERE tool_use_id = 'toolu_legacy'")
      .get() as { content_offset: number | null }
    expect(legacy.content_offset).toBeNull()
  })
})

// task 06-08-chat 需求 5 — v5 → v6 migration adds ai_chat_messages.thinking so
// the renderer can show the Claude extended-thinking summary in a collapsible
// block. Plain additive ALTER; pre-v6 rows read NULL (no thinking block rendered).

describe('chat_db — v5 → v6 migration (ai_chat_messages.thinking)', () => {
  test('v5-version DB ALTERs in thinking (NULL for existing rows) + climbs to v6', () => {
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    // Hand-build a v5 DB (chat_tool_call WITH content_offset; ai_chat_messages
    // WITHOUT thinking) carrying one pre-existing assistant message.
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id INTEGER NOT NULL,
        backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api')),
        backend_model TEXT, backend_agent_page_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL,
        metadata TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE chat_tool_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
        duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
        content_offset INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (message_id, tool_use_id)
      );
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '5');
      INSERT INTO ai_chat_sessions
        (email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
        VALUES (700, 'custom-api', 'sonnet', NULL, 1000, 1000);
      INSERT INTO ai_chat_messages
        (session_id, role, content, status, created_at, updated_at)
        VALUES (1, 'assistant', 'pre-v6 reply', 'complete', 1000, 1000);
    `)
    seed.close()

    const db = getChatDb()
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(ver.value).toBe('30')
    // Column present, pre-existing row reads NULL (no thinking block in renderer).
    const cols = db.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('thinking')
    const legacy = db
      .prepare("SELECT thinking FROM ai_chat_messages WHERE content = 'pre-v6 reply'")
      .get() as { thinking: string | null }
    expect(legacy.thinking).toBeNull()
  })
})

// Sprint 19 bug-fix — createNewSession() is the explicit "INSERT a fresh
// ai_chat_sessions row" path used by the chat:newSession IPC. Unlike
// getOrCreateSession (find-or-create-latest), it always inserts.

describe('chat_db — createNewSession (multi-session per email)', () => {
  test('returns a fresh row each call, distinct ids', () => {
    const s1 = createNewSession({
      emailId: 999,
      backendKind: 'custom-api',
      backendModel: 'sonnet'
    })
    const s2 = createNewSession({
      emailId: 999,
      backendKind: 'custom-api',
      backendModel: 'sonnet'
    })
    const s3 = createNewSession({
      emailId: 999,
      backendKind: 'custom-api',
      backendModel: 'opus'
    })
    expect(s1.id).not.toBe(s2.id)
    expect(s2.id).not.toBe(s3.id)
    expect(s1.email_id).toBe(999)
    expect(s3.backend_model).toBe('opus')
  })

  test('listSessionsForEmail sees all rows created', () => {
    createNewSession({ emailId: 1234, backendKind: 'custom-api' })
    createNewSession({ emailId: 1234, backendKind: 'custom-api' })
    createNewSession({ emailId: 1234, backendKind: 'custom-api' })
    const sessions = listSessionsForEmail(1234)
    expect(sessions).toHaveLength(3)
  })

  test('does NOT collide with getOrCreateSession on same key', () => {
    // After createNewSession populates rows, getOrCreateSession still
    // returns a row (any matching row) for the legacy "open-email
    // continue-latest" path — both functions coexist, neither throws on
    // the multi-row state v4 schema now allows.
    createNewSession({
      emailId: 5555,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-x'
    })
    const found = getOrCreateSession({
      emailId: 5555,
      backendKind: 'notion-agent',
      backendAgentPageId: 'agent-x'
    })
    expect(found.email_id).toBe(5555)
    expect(found.backend_kind).toBe('notion-agent')
    expect(found.backend_agent_page_id).toBe('agent-x')
  })

  test('null backend_agent_page_id (custom-api default) does not block multi-session', () => {
    // Custom AI backend leaves backend_agent_page_id NULL. Pre-fix the
    // UNIQUE on (email, backend, NULL) was the exact path that bit
    // dogfood. Verify multi-INSERT with NULL key now works.
    const a = createNewSession({ emailId: 7777, backendKind: 'custom-api' })
    const b = createNewSession({ emailId: 7777, backendKind: 'custom-api' })
    expect(a.id).not.toBe(b.id)
    expect(a.backend_agent_page_id).toBeNull()
    expect(b.backend_agent_page_id).toBeNull()
  })

  // P4b (v29 value domain) — a TEAM session: agentId stamps origin='team' + agent_id, and
  // the row stays OUT of both interactive listings (its home is the team page).
  test('P4b — agentId stamps origin=team + agent_id; excluded from general/interactive lists', () => {
    const team = createNewSession({
      anchorType: 'general',
      backendKind: 'ai-sdk',
      agentId: 'daily_email_digest'
    })
    expect(team.origin).toBe('team')
    expect(team.agent_id).toBe('daily_email_digest')
    const persisted = getSession(team.id)
    expect(persisted?.origin).toBe('team')
    expect(persisted?.agent_id).toBe('daily_email_digest')
    // 无 agentId 的 INSERT 字节级不变（origin NULL）。
    const plain = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    expect(getSession(plain.id)?.origin ?? null).toBeNull()
    // 排除集（与 src/chat/db.py 逐字镜像，闸见 test_chat_type_mirror_parity.py）。
    const generalIds = new Set(listGeneralSessions().map((s) => s.id))
    expect(generalIds.has(plain.id)).toBe(true)
    expect(generalIds.has(team.id)).toBe(false)
    // listAllSessions 只收有消息的行 → 给两行各塞一条消息再查。
    appendMessage({ sessionId: team.id, role: 'user', content: 'hi', status: 'complete' })
    appendMessage({ sessionId: plain.id, role: 'user', content: 'hi', status: 'complete' })
    const interactiveIds = new Set(listAllSessions({ origin: 'interactive' }).map((s) => s.id))
    expect(interactiveIds.has(plain.id)).toBe(true)
    expect(interactiveIds.has(team.id)).toBe(false)
    const teamIds = new Set(listAllSessions({ origin: 'team' }).map((s) => s.id))
    expect(teamIds.has(team.id)).toBe(true)
    expect(teamIds.has(plain.id)).toBe(false)
  })

  test('P4b — agentId rejects non-general anchors and empty strings', () => {
    expect(() => createNewSession({ emailId: 1, backendKind: 'ai-sdk', agentId: 'x' })).toThrow(
      /general anchor/
    )
    expect(() =>
      createNewSession({ anchorType: 'general', backendKind: 'ai-sdk', agentId: '  ' })
    ).toThrow(/non-empty/)
  })
})

describe('chat_db — matter anchors', () => {
  test('rejects missing/non-positive matterId and matter anchors carrying emailId', () => {
    expect(() => getOrCreateSession({ anchorType: 'matter', backendKind: 'ai-sdk' })).toThrow(
      /positive integer matterId/
    )
    expect(() =>
      getOrCreateSession({ anchorType: 'matter', matterId: 0, backendKind: 'ai-sdk' })
    ).toThrow(/positive integer matterId/)
    expect(() =>
      getOrCreateSession({ anchorType: 'matter', matterId: 1.5, backendKind: 'ai-sdk' })
    ).toThrow(/positive integer matterId/)
    expect(() =>
      getOrCreateSession({
        anchorType: 'matter',
        matterId: 5,
        emailId: 5,
        backendKind: 'ai-sdk'
      })
    ).toThrow(/must not carry an emailId/)
  })

  test('getOrCreateSession reuses only the interactive matter session, never an agent row', () => {
    const db = getChatDb()
    const now = Date.now()
    const agent = db
      .prepare(
        `INSERT INTO ai_chat_sessions
          (email_id, anchor_type, anchor_id, backend_kind, backend_model,
           backend_agent_page_id, title, created_at, updated_at, origin)
         VALUES (NULL, 'matter', 77, 'ai-sdk', NULL, NULL, 'agent run', ?, ?, 'agent')`
      )
      .run(now, now)

    const interactive = getOrCreateSession({
      anchorType: 'matter',
      matterId: 77,
      backendKind: 'ai-sdk',
      title: 'Matter 77'
    })
    const reused = getOrCreateSession({
      anchorType: 'matter',
      matterId: 77,
      backendKind: 'ai-sdk'
    })

    expect(interactive.id).not.toBe(Number(agent.lastInsertRowid))
    expect(reused.id).toBe(interactive.id)
    expect(interactive).toMatchObject({
      email_id: null,
      anchor_type: 'matter',
      anchor_id: 77,
      title: 'Matter 77'
    })
  })

  test('createNewSession allows multiple matter sessions and list excludes agent origin', () => {
    const first = createNewSession({
      anchorType: 'matter',
      matterId: 88,
      backendKind: 'ai-sdk',
      title: 'First matter chat'
    })
    const second = createNewSession({
      anchorType: 'matter',
      matterId: 88,
      backendKind: 'ai-sdk',
      title: 'Second matter chat'
    })
    const now = Date.now()
    const agent = getChatDb()
      .prepare(
        `INSERT INTO ai_chat_sessions
          (email_id, anchor_type, anchor_id, backend_kind, backend_model,
           backend_agent_page_id, title, created_at, updated_at, origin)
         VALUES (NULL, 'matter', 88, 'ai-sdk', NULL, NULL, 'headless', ?, ?, 'agent')`
      )
      .run(now, now)

    expect(first.id).not.toBe(second.id)
    expect(first.title).toBe('First matter chat')
    expect(second.title).toBe('Second matter chat')
    expect(listSessionsForMatter(88).map((session) => session.id)).toEqual(
      expect.arrayContaining([first.id, second.id])
    )
    expect(listSessionsForMatter(88).map((session) => session.id)).not.toContain(
      Number(agent.lastInsertRowid)
    )
  })
})

// L4 批次3 (task 08-25) — 行动项执行历史 (item_id) + R7「曾暂停」marker, both ai_chat.db v28.
describe('chat_db — item sessions + paused marker (v28)', () => {
  test('createAgentSession stamps item_id; listSessionsForItem scopes to that item, newest-first', () => {
    const runA = createAgentSession({
      agentId: 'matter_followup',
      title: 'item run A',
      anchor: { type: 'matter', id: 12 },
      itemId: 5
    })
    const runB = createAgentSession({
      agentId: 'matter_followup',
      title: 'item run B',
      anchor: { type: 'matter', id: 12 },
      itemId: 5
    })
    // Same Matter, DIFFERENT 行动项 — must not leak into item 5's execution history.
    const other = createAgentSession({
      agentId: 'matter_followup',
      title: 'other item',
      anchor: { type: 'matter', id: 12 },
      itemId: 6
    })
    // No itemId at all (a plain follow-up run) — item_id stays NULL.
    const plain = createAgentSession({
      agentId: 'matter_followup',
      title: 'matter run',
      anchor: { type: 'matter', id: 12 }
    })

    expect(getSession(runA)?.item_id).toBe(5)
    expect(getSession(plain)?.item_id).toBeNull()
    // newest-first (created_at DESC, id DESC) — same-ms creations tie-break on id.
    expect(listSessionsForItem(5).map((s) => s.id)).toEqual([runB, runA])
    expect(listSessionsForItem(5).map((s) => s.id)).not.toContain(other)
  })

  test('createAgentSession rejects a non-positive itemId instead of writing a dangling row', () => {
    expect(() =>
      createAgentSession({ agentId: 'matter_followup', title: 'bad', itemId: 0 })
    ).toThrow(/positive integer/)
    expect(() =>
      createAgentSession({ agentId: 'matter_followup', title: 'bad', itemId: 1.5 })
    ).toThrow(/positive integer/)
  })

  test('updateSessionPausedMarker: keep-latest write, null clears, updated_at untouched', () => {
    const session = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    const updatedAtBefore = getSession(session.id)?.updated_at

    updateSessionPausedMarker(session.id, {
      toolCallId: 'toolu_1',
      approvalId: 'ap_1',
      toolName: 'email_prepare_send',
      destructive: false,
      pausedAt: 1000
    })
    expect(JSON.parse(getSession(session.id)?.paused_marker_json ?? 'null')).toEqual({
      toolCallId: 'toolu_1',
      approvalId: 'ap_1',
      toolName: 'email_prepare_send',
      destructive: false,
      pausedAt: 1000
    })

    // A re-pause overwrites (keep-latest), it never accumulates.
    updateSessionPausedMarker(session.id, {
      toolCallId: 'toolu_2',
      approvalId: 'ap_2',
      toolName: 'run_command',
      destructive: true,
      pausedAt: 2000
    })
    expect(JSON.parse(getSession(session.id)?.paused_marker_json ?? 'null')).toMatchObject({
      approvalId: 'ap_2',
      destructive: true
    })

    updateSessionPausedMarker(session.id, null)
    expect(getSession(session.id)?.paused_marker_json).toBeNull()
    // 🔴 the marker is derived run state — bumping updated_at would reorder history + fake unread.
    expect(getSession(session.id)?.updated_at).toBe(updatedAtBefore)
  })
})

// Sprint 19 P1 — sliding window history loader. Caps per-turn input
// tokens so 100-turn session doesn't bill $0.6/turn (design doc §3.1 A).

describe('chat_db — listLastNMessages (sliding window)', () => {
  test('returns last N rows in chronological order (oldest → newest)', () => {
    const sess = createNewSession({ emailId: 8888, backendKind: 'custom-api' })
    // Append 7 messages with strictly increasing created_at via sleep.
    // (better-sqlite3 is sync so Date.now() at each call differs by ms.)
    for (let i = 1; i <= 7; i++) {
      appendMessage({
        sessionId: sess.id,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `msg ${i}`,
        status: 'complete'
      })
      // Tiny busy-wait to ensure distinct created_at (1ms granularity is
      // already enough but tests run fast — explicit nano-spin to be safe).
      const t = Date.now()
      while (Date.now() === t) {
        /* spin until next ms tick */
      }
    }
    const last3 = listLastNMessages(sess.id, 3)
    expect(last3).toHaveLength(3)
    expect(last3.map((m) => m.content)).toEqual(['msg 5', 'msg 6', 'msg 7'])
    // chronological — created_at must be strictly increasing.
    expect(last3[0].created_at).toBeLessThan(last3[1].created_at)
    expect(last3[1].created_at).toBeLessThan(last3[2].created_at)
  })

  test('limit larger than row count returns everything', () => {
    const sess = createNewSession({ emailId: 8889, backendKind: 'custom-api' })
    appendMessage({ sessionId: sess.id, role: 'user', content: 'only', status: 'complete' })
    const all = listLastNMessages(sess.id, 100)
    expect(all).toHaveLength(1)
    expect(all[0].content).toBe('only')
  })

  test('limit <= 0 returns everything (escape hatch for debugging)', () => {
    const sess = createNewSession({ emailId: 8890, backendKind: 'custom-api' })
    appendMessage({ sessionId: sess.id, role: 'user', content: 'a', status: 'complete' })
    appendMessage({ sessionId: sess.id, role: 'assistant', content: 'b', status: 'complete' })
    expect(listLastNMessages(sess.id, 0)).toHaveLength(2)
    expect(listLastNMessages(sess.id, -1)).toHaveLength(2)
  })

  test('empty session returns []', () => {
    const sess = createNewSession({ emailId: 8891, backendKind: 'custom-api' })
    expect(listLastNMessages(sess.id, 20)).toEqual([])
  })

  test('scoped to session — sibling sessions untouched', () => {
    const a = createNewSession({ emailId: 9001, backendKind: 'custom-api' })
    const b = createNewSession({ emailId: 9001, backendKind: 'custom-api' })
    appendMessage({ sessionId: a.id, role: 'user', content: 'a-only', status: 'complete' })
    appendMessage({ sessionId: b.id, role: 'user', content: 'b-only', status: 'complete' })
    const fromA = listLastNMessages(a.id, 20)
    const fromB = listLastNMessages(b.id, 20)
    expect(fromA.map((m) => m.content)).toEqual(['a-only'])
    expect(fromB.map((m) => m.content)).toEqual(['b-only'])
  })
})

describe('listAllSessions — global cross-email history', () => {
  test('returns sessions across emails, newest-first', async () => {
    const a = createNewSession({ emailId: 201, backendKind: 'custom-api' })
    appendMessage({ sessionId: a.id, role: 'user', content: 'on email 201', status: 'complete' })
    await new Promise((r) => setTimeout(r, 5))
    const b = createNewSession({ emailId: 202, backendKind: 'notion-agent' })
    appendMessage({ sessionId: b.id, role: 'user', content: 'on email 202', status: 'complete' })

    const rows = listAllSessions()
    // newest-touched (b) first; both emails present in one list.
    expect(rows.map((r) => r.id)).toEqual([b.id, a.id])
    expect(rows.map((r) => r.email_id)).toEqual([202, 201])
  })

  test('excludes empty sessions (no messages)', () => {
    const withMsg = createNewSession({ emailId: 301, backendKind: 'custom-api' })
    appendMessage({ sessionId: withMsg.id, role: 'user', content: 'hi', status: 'complete' })
    createNewSession({ emailId: 302, backendKind: 'custom-api' }) // empty → excluded

    const rows = listAllSessions()
    expect(rows.map((r) => r.id)).toEqual([withMsg.id])
  })

  test('first_user_message preview + message_count are aggregated', () => {
    const s = createNewSession({ emailId: 401, backendKind: 'custom-api' })
    appendMessage({ sessionId: s.id, role: 'user', content: 'first question', status: 'complete' })
    appendMessage({ sessionId: s.id, role: 'assistant', content: 'an answer', status: 'complete' })
    appendMessage({ sessionId: s.id, role: 'user', content: 'follow-up', status: 'complete' })

    const [row] = listAllSessions()
    expect(row.first_user_message).toBe('first question')
    expect(row.message_count).toBe(3)
  })

  test('preview falls back to null when only non-user messages exist', () => {
    const s = createNewSession({ emailId: 501, backendKind: 'notion-agent' })
    appendMessage({ sessionId: s.id, role: 'assistant', content: 'seeded', status: 'complete' })

    const [row] = listAllSessions()
    expect(row.first_user_message).toBeNull()
    expect(row.message_count).toBe(1)
  })

  test('respects the limit (newest-first)', async () => {
    for (let i = 0; i < 4; i++) {
      const s = createNewSession({ emailId: 600 + i, backendKind: 'custom-api' })
      appendMessage({ sessionId: s.id, role: 'user', content: `msg ${i}`, status: 'complete' })
      await new Promise((r) => setTimeout(r, 2))
    }
    const rows = listAllSessions({ limit: 2 })
    expect(rows).toHaveLength(2)
    // newest two emails (603, 602)
    expect(rows.map((r) => r.email_id)).toEqual([603, 602])
  })

  test('defaults to interactive sessions and supports explicit agent/all origin scopes', () => {
    const interactive = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    appendMessage({
      sessionId: interactive.id,
      role: 'user',
      content: 'interactive',
      status: 'complete'
    })
    const agentId = createAgentSession({ agentId: 'digest', jobId: 77, title: 'Digest run' })
    appendMessage({ sessionId: agentId, role: 'user', content: 'headless', status: 'complete' })

    expect(listAllSessions().map((row) => row.id)).toContain(interactive.id)
    expect(listAllSessions().map((row) => row.id)).not.toContain(agentId)
    expect(listAllSessions({ origin: 'agent' }).map((row) => row.id)).toEqual([agentId])
    expect(listAllSessions({ origin: 'all' }).map((row) => row.id)).toEqual(
      expect.arrayContaining([interactive.id, agentId])
    )
  })

  test('pin and star persist independently without bumping updated_at', () => {
    const session = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    const before = getSession(session.id)!.updated_at

    updateSessionPinned(session.id, true)
    updateSessionStarred(session.id, true)
    const organized = getSession(session.id)!
    expect(organized.pinned_at).toEqual(expect.any(Number))
    expect(organized.starred).toBe(1)
    expect(organized.updated_at).toBe(before)

    updateSessionPinned(session.id, false)
    updateSessionStarred(session.id, false)
    const cleared = getSession(session.id)!
    expect(cleared.pinned_at).toBeNull()
    expect(cleared.starred).toBe(0)
    expect(cleared.updated_at).toBe(before)
  })
})

// S1 R1 (task 07-02 openness wave1) — v16 → v17: ai_chat_messages_fts (FTS5 external-content,
// tokenize='trigram') + sync triggers + 'rebuild' backfill. Consumed by src/chat/db.py
// search_sessions (SELECT-only); this ladder step is the single schema owner.
describe('chat_db — v16 → v17 migration (ai_chat_messages_fts)', () => {
  const ftsHits = (q: string): number =>
    (
      getChatDb()
        .prepare(
          'SELECT COUNT(*) AS n FROM ai_chat_messages_fts WHERE ai_chat_messages_fts MATCH ?'
        )
        .get(`"${q}"`) as { n: number }
    ).n

  test('fresh DB carries the FTS table + the three sync triggers', () => {
    const db = getChatDb()
    const names = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'ai_chat_messages_fts%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    expect(names).toContain('ai_chat_messages_fts')
    const triggers = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((r) => r.name)
    for (const t of [
      'ai_chat_messages_fts_ai',
      'ai_chat_messages_fts_ad',
      'ai_chat_messages_fts_au'
    ]) {
      expect(triggers).toContain(t)
    }
  })

  test('v16 DB with existing messages forward-migrates: backfill makes old rows searchable (CJK substring)', () => {
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    // Full v16 shape: the v13 sessions table (+ v14 title / v15 archived) and the full
    // messages column set — v17 only ADDS the FTS side, so the shapes must be real.
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email_id INTEGER,
        anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email', 'general')),
        anchor_id INTEGER,
        backend_kind TEXT NOT NULL
          CHECK (backend_kind IN ('notion-agent', 'custom-api', 'ai-sdk')),
        backend_model TEXT,
        backend_agent_page_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        title TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        CHECK (
          (anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
          OR (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL)
        )
      );
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
        status TEXT NOT NULL, error_message TEXT, metadata TEXT,
        thinking TEXT, ui_message_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      -- A real v16 DB carries chat_tool_call (created at v3 + additive columns through v12);
      -- include it so the v18 whitelist_rule_id ALTER has a table to extend.
      CREATE TABLE chat_tool_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
        duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
        content_offset INTEGER, approval_status TEXT, approval_hash TEXT, ui_payload_json TEXT,
        content_hash TEXT, idempotency_key TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (message_id, tool_use_id)
      );
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '16');
      INSERT INTO ai_chat_sessions
        (id, email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at)
        VALUES (3, 777, 'email', 777, 'ai-sdk', 0, 0);
      INSERT INTO ai_chat_messages (session_id, role, content, status, created_at, updated_at)
        VALUES (3, 'user', '上季度 redis 超时复盘的结论是什么', 'complete', 0, 0);
    `)
    seed.close()

    const db = getChatDb()
    expect(
      (
        db.prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'").get() as {
          value: string
        }
      ).value
    ).toBe('30')
    // The 'rebuild' backfill indexed the pre-existing row: trigram CJK substring hits.
    expect(ftsHits('超时复盘')).toBe(1)
    expect(ftsHits('redis')).toBe(1)
  })

  test('triggers keep the FTS index live on INSERT / UPDATE / DELETE (real write paths)', () => {
    const s = createNewSession({ emailId: 801, backendKind: 'ai-sdk' })
    const m = appendMessage({
      sessionId: s.id,
      role: 'user',
      content: '交换机固件升级排期确认',
      status: 'complete'
    })
    expect(ftsHits('固件升级')).toBe(1)

    updateMessage(m.id, { content: '改聊 access point 的事' })
    expect(ftsHits('固件升级')).toBe(0)
    expect(ftsHits('access point')).toBe(1)

    deleteMessagesFromId(s.id, m.id)
    expect(ftsHits('access point')).toBe(0)
  })

  test('deleteSession cascade also clears the FTS index (FK cascade fires the delete trigger)', () => {
    const s = createNewSession({ emailId: 802, backendKind: 'ai-sdk' })
    appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: '灵动岛审批链路已经打通',
      status: 'complete'
    })
    expect(ftsHits('灵动岛审批')).toBe(1)
    deleteSession(s.id)
    expect(ftsHits('灵动岛审批')).toBe(0)
  })

  test('re-entry with physical v17 but meta rolled back to 16 converges without error', () => {
    // Build the fully-migrated DB, then roll ONLY the meta back — the IF NOT EXISTS
    // guards + the idempotent 'rebuild' must converge instead of throwing.
    const db = getChatDb()
    const s = createNewSession({ emailId: 803, backendKind: 'ai-sdk' })
    appendMessage({ sessionId: s.id, role: 'user', content: '重入收敛用例', status: 'complete' })
    db.prepare("UPDATE chat_db_meta SET value = '16' WHERE key = 'schema_version'").run()
    closeChatDb()

    expect(() => getChatDb()).not.toThrow()
    const ver = getChatDb()
      .prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'")
      .get() as { value: string }
    expect(ver.value).toBe('30')
    // Rebuild is idempotent — the row is indexed exactly once.
    expect(ftsHits('重入收敛')).toBe(1)
  })
})

// S2 W1 (task 07-02-s2-exec-skill-install) — v17 → v18: chat_tool_call.whitelist_rule_id (the exec
// whitelist audit; approval_status='auto_whitelist' records a card-skipped exec run + the matched
// rule id). Plain additive ALTER, same idempotency discipline as v10–v12.
describe('chat_db — v17 → v18 migration (chat_tool_call.whitelist_rule_id)', () => {
  const hasCol = (): boolean =>
    (
      getChatDb().prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    ).some((c) => c.name === 'whitelist_rule_id')

  test('fresh DB carries the whitelist_rule_id column', () => {
    getChatDb()
    expect(hasCol()).toBe(true)
  })

  test('append defaults whitelist_rule_id NULL; update records auto_whitelist + the rule id', () => {
    const s = createNewSession({ emailId: 900, backendKind: 'ai-sdk' })
    const m = appendMessage({
      sessionId: s.id,
      role: 'assistant',
      content: 'ran it',
      status: 'complete'
    })
    const tc = appendToolCall({
      messageId: m.id,
      toolUseId: 'tu-exec-1',
      toolName: 'run_command',
      inputJson: JSON.stringify({ argv: ['/bin/echo', 'hi'] }),
      confirmationTier: 'edit',
      status: 'running'
    })
    expect(tc.whitelist_rule_id).toBeNull()
    updateToolCall(tc.id, {
      status: 'ok',
      approvalStatus: 'auto_whitelist',
      whitelistRuleId: 42
    })
    const row = getToolCallByUseId(m.id, 'tu-exec-1')
    expect(row?.approval_status).toBe('auto_whitelist')
    expect(row?.whitelist_rule_id).toBe(42)
  })

  test('a v17 DB (no whitelist_rule_id column) forward-migrates: column added, converges to current', () => {
    closeChatDb()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
    const seed = new BetterSqlite3(dbPath)
    // A v17-shaped chat_tool_call WITHOUT whitelist_rule_id (the v3 base + v5/v10/v11/v12 adds).
    seed.exec(`
      CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ai_chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email_id INTEGER,
        anchor_type TEXT NOT NULL DEFAULT 'email' CHECK (anchor_type IN ('email', 'general')),
        anchor_id INTEGER,
        backend_kind TEXT NOT NULL CHECK (backend_kind IN ('notion-agent', 'custom-api', 'ai-sdk')),
        backend_model TEXT, backend_agent_page_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, title TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        CHECK ((anchor_type = 'email' AND email_id IS NOT NULL AND anchor_id = email_id)
          OR (anchor_type = 'general' AND anchor_id IS NULL AND email_id IS NULL))
      );
      CREATE TABLE ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, content TEXT NOT NULL,
        tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
        status TEXT NOT NULL, error_message TEXT, metadata TEXT, thinking TEXT, ui_message_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE chat_tool_call (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
        tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
        user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
        duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
        content_offset INTEGER, approval_status TEXT, approval_hash TEXT, ui_payload_json TEXT,
        content_hash TEXT, idempotency_key TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (message_id, tool_use_id)
      );
      INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '17');
    `)
    seed.close()

    const db = getChatDb()
    expect(
      (
        db.prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'").get() as {
          value: string
        }
      ).value
    ).toBe('30')
    expect(hasCol()).toBe(true)
  })

  test('re-entry with the physical column but meta rolled back to 17 converges without error', () => {
    getChatDb() // fully migrated (has the column)
    getChatDb().prepare("UPDATE chat_db_meta SET value = '17' WHERE key = 'schema_version'").run()
    closeChatDb()
    // The hasColumn guard must NOT re-ADD (would throw "duplicate column"); it just advances meta.
    expect(() => getChatDb()).not.toThrow()
    const ver = getChatDb()
      .prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'")
      .get() as { value: string }
    expect(ver.value).toBe('30')
    expect(hasCol()).toBe(true)
  })
})
