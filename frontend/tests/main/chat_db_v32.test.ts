// L4 群聊话题 (CHAT_DB v32) — 迁移幂等 + 「一条消息至多一个话题」的唯一部分索引。
//
// Verified scenarios:
//   ① fresh DB 到 v32：`ai_chat_sessions.thread_root_message_id` 列 + 唯一部分索引
//     `idx_chat_sessions_thread_root` 都在，schema_version = 32。
//   ② OLD-LIBRARY REPLAY：手工种一个 v31 形状的库（无 v32 列 / 索引、meta=31）升级安全；再把
//     meta 回滚到 31 重开（crash-before-meta 形状）——**跑第二遍不许抛**（hasColumn /
//     IF NOT EXISTS 幂等守卫），且旧行原样存活、新列读回 NULL。
//   ③ 唯一部分索引的两半语义（建话题端点的幂等根据）：
//     • 同一个父群下同一条根消息**开不出第二个话题**（UNIQUE 拒插）；
//     • 换个父群、或换条根消息 → 放行；
//     • 🔴 `thread_root_message_id IS NULL` 的普通行 / 子群行**不受这条索引管**（同一个父群下
//       可以有任意多个子群）—— 部分索引的 WHERE 子句就是为这条存在，去掉它索引会白白覆盖全表。
//
// Runner: ELECTRON_RUN_AS_NODE=1 electron … (better-sqlite3 ABI — see
// reference_vitest_better_sqlite3_abi_runner).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeChatDb, createNewSession, getChatDb } from '../../src/electron/main/chat_db'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-db-v32-'))
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

function indexNames(): string[] {
  const rows = getChatDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all() as Array<{ name: string }>
  return rows.map((r) => r.name)
}

function schemaVersion(): number {
  const row = getChatDb()
    .prepare("SELECT value FROM chat_db_meta WHERE key = 'schema_version'")
    .get() as { value: string }
  return parseInt(row.value, 10)
}

/** Seed a minimal v31-shaped DB (v32 column/index absent, meta=31). */
function seedV31ChatDb(): void {
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
      agent_id TEXT,
      members_json TEXT,
      group_config_json TEXT,
      parent_session_id INTEGER,
      invoked_by TEXT
    );
    CREATE TABLE ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      speaker_agent_id TEXT,
      chain_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '31');
    INSERT INTO ai_chat_sessions
      (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at, origin,
       members_json, invoked_by)
      VALUES (NULL, 'general', NULL, 'ai-sdk', 1, 1, 'group', '["a1","a2"]', 'judge');
  `)
  seed.close()
}

describe('CHAT_DB v32 migration', () => {
  test('① fresh DB carries the v32 column + partial unique index at schema_version 32', () => {
    expect(columnNames('ai_chat_sessions')).toContain('thread_root_message_id')
    expect(indexNames()).toEqual(expect.arrayContaining(['idx_chat_sessions_thread_root']))
    expect(schemaVersion()).toBe(32)
  })

  test('① the index is the PARTIAL unique one (WHERE thread_root_message_id IS NOT NULL)', () => {
    const row = getChatDb()
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('idx_chat_sessions_thread_root') as { sql: string | null } | undefined
    const sql = (row?.sql ?? '').replace(/\s+/g, ' ')
    // 🔴 少了 UNIQUE，同根重复 POST 会建出第二个话题；少了 WHERE，索引覆盖全表（每条普通
    // 会话都进索引）。两半都要在，所以逐词断言而不是「索引存在就算数」。
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i)
    expect(sql).toMatch(/ai_chat_sessions\(parent_session_id, thread_root_message_id\)/i)
    expect(sql).toMatch(/WHERE thread_root_message_id IS NOT NULL/i)
  })

  test('② v31-shaped old DB upgrades; a second run (meta rollback) is idempotent', () => {
    seedV31ChatDb()
    expect(columnNames('ai_chat_sessions')).toContain('thread_root_message_id')
    expect(indexNames()).toEqual(expect.arrayContaining(['idx_chat_sessions_thread_root']))
    expect(schemaVersion()).toBe(32)
    // 既有群行原样存活；新列读回 NULL（additive migration，老行不是话题）。
    const row = getChatDb()
      .prepare(
        'SELECT origin, invoked_by, members_json, thread_root_message_id FROM ai_chat_sessions'
      )
      .get() as {
      origin: string
      invoked_by: string | null
      members_json: string
      thread_root_message_id: number | null
    }
    expect(row.origin).toBe('group')
    expect(row.invoked_by).toBe('judge')
    expect(JSON.parse(row.members_json)).toEqual(['a1', 'a2'])
    expect(row.thread_root_message_id).toBeNull()

    // Crash-before-meta replay: 物理 v32 + meta 回滚到 31 → 整个 v32 块重跑。
    // 不许抛（"duplicate column name" / "index already exists"）。
    getChatDb()
      .prepare("INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '31')")
      .run()
    closeChatDb()
    expect(() => schemaVersion()).not.toThrow()
    expect(schemaVersion()).toBe(32)
  })
})

describe('v32 唯一部分索引 = 一条消息至多一个话题（③）', () => {
  function newSession(): number {
    return createNewSession({ anchorType: 'general', backendKind: 'ai-sdk', groupMembers: ['a1'] })
      .id
  }

  function markThread(sessionId: number, parentId: number, rootMessageId: number | null): void {
    getChatDb()
      .prepare(
        'UPDATE ai_chat_sessions SET parent_session_id = ?, invoked_by = ?, thread_root_message_id = ? WHERE id = ?'
      )
      .run(parentId, rootMessageId == null ? 'judge' : 'thread', rootMessageId, sessionId)
  }

  test('同群同根开不出第二个话题；换群 / 换根放行', () => {
    const parent = newSession()
    const other = newSession()
    markThread(newSession(), parent, 100)
    // 同一个父群 + 同一条根消息 → UNIQUE 拒插（端点据此走幂等分支返回已有话题）。
    expect(() => markThread(newSession(), parent, 100)).toThrow(/UNIQUE/i)
    // 同一条消息 id 在另一个群下是另一条消息（id 不跨群共享，但索引也不该跨群误判）。
    expect(() => markThread(newSession(), other, 100)).not.toThrow()
    expect(() => markThread(newSession(), parent, 101)).not.toThrow()
  })

  test('🔴 thread_root_message_id 为 NULL 的行不受索引管（同群多个子群合法）', () => {
    const parent = newSession()
    markThread(newSession(), parent, null)
    // 第二个子群（同父、根消息都是 NULL）。SQLite 的 UNIQUE 把 NULL 视作互不相等，
    // 但真正让这条索引不覆盖全表的是 WHERE 子句 —— 这条用例钉的是「子群不受影响」这个行为。
    expect(() => markThread(newSession(), parent, null)).not.toThrow()
    const count = getChatDb()
      .prepare(
        "SELECT COUNT(*) AS n FROM ai_chat_sessions WHERE parent_session_id = ? AND COALESCE(invoked_by,'') <> 'thread'"
      )
      .get(parent) as { n: number }
    expect(count.n).toBe(2)
  })
})
