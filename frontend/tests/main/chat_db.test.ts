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

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  abortStreamingMessages,
  appendMessage,
  closeChatDb,
  deleteSession,
  getChatDb,
  getMessage,
  getOrCreateSession,
  getSession,
  listMessages,
  listSessionsForEmail,
  resolveChatDbPath,
  updateMessage
} from '../../src/electron/main/chat_db'

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

  test('opening a fresh DB creates the file + tables', () => {
    const db = getChatDb()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>
    const names = tables.map((t) => t.name)
    expect(names).toContain('ai_chat_sessions')
    expect(names).toContain('ai_chat_messages')
    expect(names).toContain('chat_db_meta')
    const ver = db
      .prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(ver.value).toBe('1')
  })

  test('re-opening an existing DB does not re-run migrations (idempotent)', () => {
    getChatDb()
    closeChatDb()
    // Second open must succeed without throwing.
    const db = getChatDb()
    const ver = db
      .prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'")
      .get() as { value: string }
    expect(ver.value).toBe('1')
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

    expect(
      listMessages(a.id).find((r) => r.status === 'streaming')
    ).toBeUndefined()
    expect(
      listMessages(b.id).find((r) => r.status === 'streaming')
    ).toBeTruthy()
  })
})
