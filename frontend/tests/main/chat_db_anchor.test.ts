// P2c — chat session anchor (v6 → v7 migration + email/general anchor behaviour).
//
// task 06-18-custom-ai-harness-agent Phase 2. chat_db.ts is the ai_chat.db schema
// owner; this suite verifies:
//   - a seeded v6 DB migrates to v7, backfilling anchor_type='email', anchor_id=
//     email_id for every existing row, preserving email_id + message rows, and
//     writing a .pre-v7.bak snapshot.
//   - email getOrCreateSession is byte-identical to pre-v7 (reuse by email_id).
//   - general sessions: email_id/anchor_id NULL, no emailId sentinel; listed by
//     listGeneralSessions; never leak into listSessionsForEmail.
//   - the v7 coupling CHECK rejects a sentinel (email_id=0 general / null email).
//
// Mirrors chat_db.test.ts harness (electron mock + per-test tmp file).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeChatDb,
  createNewSession,
  getChatDb,
  getOrCreateSession,
  getSession,
  listGeneralSessions,
  listSessionsForEmail
} from '../../src/electron/main/chat_db'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-anchor-'))
  dbPath = join(tmpDir, 'ai_chat.db')
  process.env['AI_CHAT_DB_PATH'] = dbPath
})

afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  rmSync(tmpDir, { recursive: true, force: true })
})

/** Hand-build a v6 ai_chat.db (pre-anchor: email_id NOT NULL, no anchor columns)
 *  with one email session + one message, so the v6→v7 migration has real data to
 *  backfill + a message row whose survival proves the FK-off rebuild didn't
 *  cascade-delete it. */
function seedV6Db(): void {
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
      backend_model TEXT,
      backend_agent_page_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX idx_sessions_email ON ai_chat_sessions(email_id, updated_at DESC);
    CREATE TABLE ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL,
      tokens_input INTEGER, tokens_output INTEGER, cost_usd REAL, model TEXT,
      status TEXT NOT NULL, error_message TEXT, metadata TEXT, thinking TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE chat_tool_call (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
      tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_json TEXT NOT NULL,
      user_edited_input_json TEXT, output_json TEXT, status TEXT NOT NULL,
      duration_ms INTEGER, confirmation_tier TEXT NOT NULL, confirmed_at INTEGER,
      content_offset INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (message_id, tool_use_id)
    );
    INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '6');
    INSERT INTO ai_chat_sessions
      (id, email_id, backend_kind, backend_model, backend_agent_page_id, created_at, updated_at)
      VALUES (1, 700, 'custom-api', 'sonnet', NULL, 1000, 1000);
    INSERT INTO ai_chat_messages
      (session_id, role, content, status, created_at, updated_at)
      VALUES (1, 'user', 'pre-anchor chat', 'complete', 1000, 1000);
  `)
  seed.close()
}

describe('chat_db — v6 → v7 anchor migration', () => {
  test('a v6 DB climbs to v7, backfills anchor, preserves data + writes .pre-v7.bak', () => {
    seedV6Db()
    const db = getChatDb()

    const ver = (
      db.prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'").get() as {
        value: string
      }
    ).value
    // Climbs through the v6→v7 anchor step (asserted below) and on to the
    // current head (v8 — agent_memory_kv provenance/priority; v9 —
    // ai_chat_messages.ui_message_json; v10 — chat_tool_call approval audit; v11 —
    // chat_tool_call.ui_payload_json; v12 — chat_tool_call.content_hash + idempotency_key;
    // all additive).
    expect(ver).toBe('12')

    // Anchor columns added + backfilled for the pre-existing email row.
    const row = db.prepare('SELECT * FROM ai_chat_sessions WHERE id = 1').get() as {
      email_id: number | null
      anchor_type: string
      anchor_id: number | null
      backend_model: string
    }
    expect(row.email_id).toBe(700)
    expect(row.anchor_type).toBe('email')
    expect(row.anchor_id).toBe(700)
    expect(row.backend_model).toBe('sonnet')

    // CRITICAL — message row survived the FK-off DROP/rebuild (the v3→v4 cascade
    // bug class); table shape now allows NULL email_id.
    const msgs = db
      .prepare('SELECT content FROM ai_chat_messages WHERE session_id = 1')
      .all() as Array<{ content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe('pre-anchor chat')

    // CHECK present on the new table.
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_chat_sessions'")
        .get() as { sql: string }
    ).sql
    expect(tableSql).toMatch(/anchor_type/)
    expect(tableSql).toMatch(/CHECK/)

    // Backup snapshot written.
    expect(existsSync(dbPath + '.pre-v7.bak')).toBe(true)
  })
})

describe('chat_db — email anchor (zero regression)', () => {
  test('getOrCreateSession reuses by email_id + backfills anchor columns', () => {
    const a = getOrCreateSession({ emailId: 42, backendKind: 'custom-api' })
    const b = getOrCreateSession({ emailId: 42, backendKind: 'custom-api' })
    expect(a.id).toBe(b.id)
    expect(a.email_id).toBe(42)
    expect(a.anchor_type).toBe('email')
    expect(a.anchor_id).toBe(42)
  })

  test('default (no anchorType) is email anchor', () => {
    const s = createNewSession({ emailId: 7, backendKind: 'custom-api' })
    expect(s.anchor_type).toBe('email')
    expect(s.anchor_id).toBe(7)
  })
})

describe('chat_db — general anchor', () => {
  test('general session has NULL email_id/anchor_id, no sentinel', () => {
    const s = createNewSession({ anchorType: 'general', backendKind: 'custom-api' })
    expect(s.email_id).toBeNull()
    expect(s.anchor_type).toBe('general')
    expect(s.anchor_id).toBeNull()
    const got = getSession(s.id)
    expect(got?.email_id).toBeNull()
    expect(got?.anchor_type).toBe('general')
  })

  test('general getOrCreateSession reuses the latest general session', () => {
    const first = createNewSession({ anchorType: 'general', backendKind: 'custom-api' })
    const reused = getOrCreateSession({ anchorType: 'general', backendKind: 'custom-api' })
    expect(reused.id).toBe(first.id)
  })

  test('general sessions never leak into a per-email sidebar', () => {
    const email = getOrCreateSession({ emailId: 88, backendKind: 'custom-api' })
    const general = createNewSession({ anchorType: 'general', backendKind: 'custom-api' })
    const sidebar = listSessionsForEmail(88).map((r) => r.id)
    expect(sidebar).toContain(email.id)
    expect(sidebar).not.toContain(general.id)
    const generals = listGeneralSessions().map((r) => r.id)
    expect(generals).toContain(general.id)
    expect(generals).not.toContain(email.id)
  })

  test('email anchor without an emailId throws (no silent sentinel insert)', () => {
    expect(() => getOrCreateSession({ backendKind: 'custom-api' })).toThrow(/non-negative integer/)
  })

  test('invalid anchorType throws (codex NIT — not silently treated as email)', () => {
    expect(() =>
      // wire-sourced bad string — TS cast simulates a malformed payload reaching resolveAnchor.
      getOrCreateSession({ anchorType: 'thread' as never, emailId: 1, backendKind: 'custom-api' })
    ).toThrow(/invalid anchorType/)
  })

  test('general anchor carrying an emailId throws (codex HIGH — no sentinel)', () => {
    // incl. 0 — the exact sentinel we banned.
    expect(() =>
      createNewSession({ anchorType: 'general', emailId: 0, backendKind: 'custom-api' })
    ).toThrow(/must not carry an emailId/)
    expect(() =>
      getOrCreateSession({ anchorType: 'general', emailId: 5, backendKind: 'custom-api' })
    ).toThrow(/must not carry an emailId/)
  })
})

describe('chat_db — v7 coupling CHECK', () => {
  test('rejects a general row carrying an email_id sentinel', () => {
    const db = getChatDb()
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_chat_sessions
             (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at)
           VALUES (0, 'general', 0, 'custom-api', 1, 1)`
        )
        .run()
    ).toThrow()
  })

  test('rejects an email row with a NULL email_id', () => {
    const db = getChatDb()
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_chat_sessions
             (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at)
           VALUES (NULL, 'email', NULL, 'custom-api', 1, 1)`
        )
        .run()
    ).toThrow()
  })

  test('rejects an email row whose anchor_id != email_id (codex HIGH equality)', () => {
    const db = getChatDb()
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_chat_sessions
             (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at)
           VALUES (5, 'email', 6, 'custom-api', 1, 1)`
        )
        .run()
    ).toThrow()
  })
})
