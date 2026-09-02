// L4 群聊 (CHAT_DB v30) — migration + listing exclusion + speaker persistence contract.
//
// Verified scenarios:
//   ① fresh DB migrates to v30: ai_chat_sessions.members_json + ai_chat_messages.speaker_agent_id
//     both exist; schema_version = 30.
//   ② OLD-LIBRARY REPLAY: a hand-seeded v29-shaped DB (no v30 columns, meta=29) upgrades safely —
//     columns added, rows intact; and a meta-rollback re-entry (physical v30 + meta 29, the
//     crash-before-meta shape) re-runs without "duplicate column" (hasColumn guard).
//   ③ origin='group' rows are EXCLUDED from the interactive listAllSessions default clause and
//     from listGeneralSessions, and returned by the 'group' filter (the 群聊 tab's query).
//   ④ createNewSession({groupMembers}) stamps origin='group' + members_json; appendMessage
//     persists speaker_agent_id and listMessages returns it (NULL for user rows).
//
// Runner: ELECTRON_RUN_AS_NODE=1 electron … (better-sqlite3 ABI — see
// reference_vitest_better_sqlite3_abi_runner).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendMessage,
  closeChatDb,
  createNewSession,
  getChatDb,
  listAllSessions,
  listGeneralSessions,
  listMessages
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
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-db-group-'))
  dbPath = join(tmpDir, 'ai_chat.db')
  process.env['AI_CHAT_DB_PATH'] = dbPath
  closeChatDb()
})

afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function columnNames(table: string): string[] {
  const rows = getChatDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function schemaVersion(): number {
  const row = getChatDb()
    .prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'")
    .get() as { value: string }
  return parseInt(row.value, 10)
}

/** Seed a minimal v29-shaped DB (the two group columns absent, meta=29). migrate() entering at
 *  current=29 only runs the v30 block, which touches exactly these two tables. */
function seedV29ChatDb(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3')
  const seed = new BetterSqlite3(dbPath)
  seed.exec(`
    CREATE TABLE chat_db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE ai_chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id INTEGER,
      anchor_type TEXT NOT NULL DEFAULT 'email',
      anchor_id INTEGER,
      backend_kind TEXT NOT NULL,
      backend_model TEXT,
      backend_agent_page_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      origin TEXT,
      agent_id TEXT
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
    INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '29');
    INSERT INTO ai_chat_sessions
      (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at, origin)
      VALUES (NULL, 'general', NULL, 'ai-sdk', 1, 1, 'team');
  `)
  seed.close()
}

describe('CHAT_DB v30 migration', () => {
  test('① fresh DB carries both v30 columns at schema_version 30', () => {
    expect(columnNames('ai_chat_sessions')).toContain('members_json')
    expect(columnNames('ai_chat_messages')).toContain('speaker_agent_id')
    expect(schemaVersion()).toBe(31)
  })

  test('② v29-shaped old DB upgrades safely; meta-rollback re-entry is idempotent', () => {
    seedV29ChatDb()
    // Upgrade the old library.
    expect(columnNames('ai_chat_sessions')).toContain('members_json')
    expect(columnNames('ai_chat_messages')).toContain('speaker_agent_id')
    expect(schemaVersion()).toBe(31)
    // Pre-existing row survives untouched.
    const row = getChatDb().prepare('SELECT origin, members_json FROM ai_chat_sessions').get() as {
      origin: string
      members_json: string | null
    }
    expect(row.origin).toBe('team')
    expect(row.members_json).toBeNull()
    // Crash-before-meta replay: physical v30 + meta rolled back to 29 → re-open must not throw
    // ("duplicate column name") and must converge back to 30.
    getChatDb()
      .prepare("INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '29')")
      .run()
    closeChatDb()
    expect(schemaVersion()).toBe(31)
  })
})

describe('v30 group listing exclusion (③) + write faces (④)', () => {
  test('③ interactive lists exclude group rows; the group filter returns them', () => {
    const plain = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    const team = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk', agentId: 'a1' })
    const group = createNewSession({
      anchorType: 'general',
      backendKind: 'ai-sdk',
      groupMembers: ['a1', 'a2'],
      title: '新群聊'
    })
    for (const s of [plain, team, group]) {
      appendMessage({ sessionId: s.id, role: 'user', content: 'hi', status: 'complete' })
    }
    const interactive = listAllSessions({ origin: 'interactive' }).map((s) => s.id)
    expect(interactive).toContain(plain.id)
    expect(interactive).not.toContain(team.id)
    expect(interactive).not.toContain(group.id)
    const groups = listAllSessions({ origin: 'group' }).map((s) => s.id)
    expect(groups).toEqual([group.id])
    // listGeneralSessions（⌘O 通用列表）同样排除 group 行。
    const general = listGeneralSessions().map((s) => s.id)
    expect(general).toContain(plain.id)
    expect(general).not.toContain(group.id)
  })

  test('④ group create stamps members_json; appendMessage persists speaker_agent_id', () => {
    const group = createNewSession({
      anchorType: 'general',
      backendKind: 'ai-sdk',
      groupMembers: ['agent_a', 'agent_b'],
      title: 'T'
    })
    expect(group.origin).toBe('group')
    expect(JSON.parse(group.members_json ?? '[]')).toEqual(['agent_a', 'agent_b'])
    appendMessage({ sessionId: group.id, role: 'user', content: 'hello', status: 'complete' })
    appendMessage({
      sessionId: group.id,
      role: 'assistant',
      content: 'reply',
      status: 'complete',
      speakerAgentId: 'agent_a'
    })
    const rows = listMessages(group.id)
    expect(rows).toHaveLength(2)
    expect(rows[0]?.speaker_agent_id ?? null).toBeNull()
    expect(rows[1]?.speaker_agent_id).toBe('agent_a')
    // 群聊行是 general anchor + 非法输入拒绝（互斥 / 空数组）。
    expect(() =>
      createNewSession({
        anchorType: 'general',
        backendKind: 'ai-sdk',
        agentId: 'x',
        groupMembers: ['y']
      })
    ).toThrow(/mutually exclusive/)
    expect(() =>
      createNewSession({ anchorType: 'general', backendKind: 'ai-sdk', groupMembers: [] })
    ).toThrow(/non-empty/)
  })
})
