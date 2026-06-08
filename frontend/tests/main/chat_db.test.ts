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
  createNewSession,
  deleteMessagesFromId,
  deleteSession,
  getChatDb,
  getMessage,
  getOrCreateSession,
  getSession,
  getToolCallByUseId,
  listAllSessions,
  listLastNMessages,
  listMessages,
  listSessionsForEmail,
  listToolCallsForMessage,
  resolveChatDbPath,
  updateMessage,
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
    expect(names).toContain('agent_memory_kv')
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    // Sprint 19 (PR-1a): bumped to 3 — chat_tool_call + wiki_pages + wiki_fts + agent_memory_kv.
    // Sprint 19 (bug-fix): bumped to 4 — drop UNIQUE on ai_chat_sessions so
    // newSession() can INSERT a fresh row instead of resurrecting old.
    // task 06-08-chat Bug 2: bumped to 5 — chat_tool_call.content_offset.
    expect(ver.value).toBe('5')
  })

  test('fresh DB schema includes the v2 metadata column', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('metadata')
  })

  test('fresh DB schema includes the v5 chat_tool_call.content_offset column', () => {
    const db = getChatDb()
    const cols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('content_offset')
  })

  test('re-opening an existing DB does not re-run migrations (idempotent)', () => {
    getChatDb()
    closeChatDb()
    // Second open must succeed without throwing.
    const db = getChatDb()
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(ver.value).toBe('5')
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
    // bumped to v5 → a v1 DB now climbs the whole ladder to v5.
    expect(ver.value).toBe('5')
    const cols = db.prepare('PRAGMA table_info(ai_chat_messages)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('metadata')
    // v5 column present after climbing from v1.
    const toolCols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{
      name: string
    }>
    expect(toolCols.map((c) => c.name)).toContain('content_offset')
    // Old data preserved verbatim — the v1-stored thread_id encoding stays
    // in `model`, where notion_agent.extractTurn's backcompat reader picks
    // it up.
    const row = db
      .prepare("SELECT model, metadata FROM ai_chat_messages WHERE role = 'assistant'")
      .get() as { model: string; metadata: string | null }
    expect(row.model).toBe('notion-agent:thr-old')
    expect(row.metadata).toBeNull()
    // Sprint 19 — v3 tables exist post-migration.
    const tableNames = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string
      }>
    ).map((t) => t.name)
    expect(tableNames).toContain('chat_tool_call')
    expect(tableNames).toContain('wiki_pages')
    expect(tableNames).toContain('agent_memory_kv')
  })

  test('opening a future-version DB refuses to load', () => {
    const db = getChatDb()
    db.prepare("UPDATE chat_db_meta SET value = '99' WHERE key = 'schema_version'").run()
    closeChatDb()
    expect(() => getChatDb()).toThrow(/schema is at v99/)
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

// Sprint 19 PR-1a — v3 schema additions integrity (wiki_pages + wiki_fts triggers,
// agent_memory_kv composite PK). M2 tools will use these; smoke-check here that
// the migration left them in a workable shape.
describe('chat_db — v3 schema (wiki + memory_kv)', () => {
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

  test('agent_memory_kv composite PRIMARY KEY (scope, key)', () => {
    const db = getChatDb()
    const now = Date.now()
    const stmt = db.prepare(
      `INSERT INTO agent_memory_kv (scope, key, value_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    stmt.run('sender.bob@acme.com', 'tone', '"casual"', now, now)
    // Different scope, same key → OK
    expect(() => stmt.run('sender.alice@acme.com', 'tone', '"formal"', now, now)).not.toThrow()
    // Same scope + key → duplicate PK
    expect(() => stmt.run('sender.bob@acme.com', 'tone', '"changed"', now, now)).toThrow()
  })
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
    // Schema climbs v3 → v4 → v5.
    const ver = db.prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'").get() as {
      value: string
    }
    expect(ver.value).toBe('5')
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
    db.prepare(
      `INSERT INTO ai_chat_sessions
         (email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
       VALUES (500, 'custom-api', 'sonnet', NULL, 2000, 2000)`
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
    expect(ver.value).toBe('5')
    // Column present, pre-existing row reads NULL (degrade path in renderer).
    const cols = db.prepare('PRAGMA table_info(chat_tool_call)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).toContain('content_offset')
    const legacy = db
      .prepare("SELECT content_offset FROM chat_tool_call WHERE tool_use_id = 'toolu_legacy'")
      .get() as { content_offset: number | null }
    expect(legacy.content_offset).toBeNull()
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
    const rows = listAllSessions(2)
    expect(rows).toHaveLength(2)
    // newest two emails (603, 602)
    expect(rows.map((r) => r.email_id)).toEqual([603, 602])
  })
})
