// L4 群聊 g1 (CHAT_DB v31) — 迁移幂等 + 三载体的值域 CHECK + 两写者列级纪律。
//
// Verified scenarios:
//   ① fresh DB 到 v31：两个新列 + 两张新表 + 两个索引都在，schema_version = 31。
//   ② OLD-LIBRARY REPLAY：手工种一个 v30 形状的库（无 v31 列/表、meta=30）升级安全；再把 meta
//     回滚到 30 重开（crash-before-meta 形状）——**跑第二遍不许抛**（hasColumn / IF NOT EXISTS
//     幂等守卫），且旧行原样存活。
//   ③ CHECK 拒非法值：outcome / trigger_kind / response_mode 三条值域，越域 INSERT 必抛。
//     🔴 这是词表漂移的最后一道拦网 —— 词表加了值而 CHECK 没跟上，那一类 turn 的台账整条写
//     不进去（指标与地板计数同时静默失真）。
//   ④ 两写者列级纪律的 gateway 半边：advanceSeenCursor 只动 seen_through_id，不碰
//     response_mode（serve-api 侧的对称断言在 tests/api/test_chat_group_config.py）。
//   ⑤ appendMessage 透传 chain_id；groupUsage / familyOf / insertGroupTurn 的读写口径。
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
  listMessages
} from '../../src/electron/main/chat_db'
import {
  advanceSeenCursor,
  familyOf,
  getGroupMemberConfigs,
  getSeenCursor,
  groupUsage,
  insertGroupTurn,
  listGroupTurns
} from '../../src/electron/main/chat_db/groups'

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
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-db-v31-'))
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

function tableNames(): string[] {
  const rows = getChatDb()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>
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

/** Seed a minimal v30-shaped DB (v31 columns/tables absent, meta=30). */
function seedV30ChatDb(): void {
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
      members_json TEXT
    );
    CREATE TABLE ai_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      speaker_agent_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO chat_db_meta (key, value) VALUES ('schema_version', '30');
    INSERT INTO ai_chat_sessions
      (email_id, anchor_type, anchor_id, backend_kind, created_at, updated_at, origin, members_json)
      VALUES (NULL, 'general', NULL, 'ai-sdk', 1, 1, 'group', '["a1","a2"]');
  `)
  seed.close()
}

describe('CHAT_DB v31 migration', () => {
  test('① fresh DB carries every v31 carrier at schema_version 31', () => {
    expect(columnNames('ai_chat_sessions')).toContain('group_config_json')
    expect(columnNames('ai_chat_messages')).toContain('chain_id')
    expect(tableNames()).toEqual(
      expect.arrayContaining(['ai_chat_group_member', 'ai_chat_group_turn'])
    )
    expect(indexNames()).toEqual(
      expect.arrayContaining(['idx_group_turn_session_time', 'idx_group_turn_chain'])
    )
    expect(schemaVersion()).toBe(31)
  })

  test('② v30-shaped old DB upgrades; a second run (meta rollback) is idempotent', () => {
    seedV30ChatDb()
    expect(columnNames('ai_chat_sessions')).toContain('group_config_json')
    expect(columnNames('ai_chat_messages')).toContain('chain_id')
    expect(schemaVersion()).toBe(31)
    // Pre-existing group row survives untouched (additive migration).
    const row = getChatDb()
      .prepare('SELECT origin, members_json, group_config_json FROM ai_chat_sessions')
      .get() as { origin: string; members_json: string; group_config_json: string | null }
    expect(row.origin).toBe('group')
    expect(JSON.parse(row.members_json)).toEqual(['a1', 'a2'])
    expect(row.group_config_json).toBeNull()

    // Crash-before-meta replay: physical v31 + meta rolled back to 30 → the whole v31 block
    // re-runs. Must not throw ("duplicate column name" / "table already exists").
    getChatDb()
      .prepare("INSERT OR REPLACE INTO chat_db_meta (key, value) VALUES ('schema_version', '30')")
      .run()
    closeChatDb()
    expect(() => schemaVersion()).not.toThrow()
    expect(schemaVersion()).toBe(31)
  })
})

describe('v31 value-domain CHECKs (③)', () => {
  function insertTurn(overrides: { outcome?: string; triggerKind?: string }): void {
    getChatDb()
      .prepare(
        `INSERT INTO ai_chat_group_turn
          (session_id, run_id, chain_id, seq, agent_id, trigger_kind, outcome, started_at)
         VALUES (1, 'r', 1, 0, 'a1', ?, ?, 1)`
      )
      .run(overrides.triggerKind ?? 'human', overrides.outcome ?? 'spoke')
  }

  test('outcome / trigger_kind / response_mode reject out-of-domain values', () => {
    // 合法值先证明这条路是通的（否则「都抛」也可能是别的原因）。
    expect(() => insertTurn({ outcome: 'held_dup', triggerKind: 'judge_post' })).not.toThrow()
    expect(() => insertTurn({ outcome: 'spoken' })).toThrow(/CHECK/)
    expect(() => insertTurn({ triggerKind: 'judge' })).toThrow(/CHECK/)
    const db = getChatDb()
    expect(() =>
      db
        .prepare(
          `INSERT INTO ai_chat_group_member (session_id, agent_id, response_mode, updated_at)
           VALUES (1, 'a1', 'always', 1)`
        )
        .run()
    ).toThrow(/CHECK/)
  })

  test('response_mode defaults to mention when the row is created without it', () => {
    getChatDb()
      .prepare(
        `INSERT INTO ai_chat_group_member (session_id, agent_id, seen_through_id, updated_at)
         VALUES (1, 'a1', NULL, 1)`
      )
      .run()
    expect(getGroupMemberConfigs(1)[0]?.responseMode).toBe('mention')
  })
})

describe('v31 read/write faces (④⑤)', () => {
  function newGroup(members: string[], parentId?: number): number {
    const s = createNewSession({
      anchorType: 'general',
      backendKind: 'ai-sdk',
      groupMembers: members,
      title: 'G'
    })
    if (parentId != null) {
      getChatDb()
        .prepare('UPDATE ai_chat_sessions SET parent_session_id = ? WHERE id = ?')
        .run(parentId, s.id)
    }
    return s.id
  }

  test('④ advanceSeenCursor never clobbers response_mode (column-level write)', () => {
    const sessionId = newGroup(['a1'])
    getChatDb()
      .prepare(
        `INSERT INTO ai_chat_group_member (session_id, agent_id, response_mode, updated_at)
         VALUES (?, 'a1', 'realtime', 1)`
      )
      .run(sessionId)

    advanceSeenCursor(sessionId, 'a1', 17)

    const row = getGroupMemberConfigs(sessionId)[0]
    // 🔴 owner 设的 realtime 必须活下来 —— 整行 UPSERT 会把它冲回默认的 mention。
    expect(row?.responseMode).toBe('realtime')
    expect(row?.seenThroughId).toBe(17)
  })

  test('④ cursor only moves forward; a missing row is created on demand', () => {
    const sessionId = newGroup(['a1'])
    expect(getSeenCursor(sessionId, 'a1')).toBeNull()
    advanceSeenCursor(sessionId, 'a1', 10)
    expect(getSeenCursor(sessionId, 'a1')).toBe(10)
    // 乱序 turn 不该把游标拉回去（会让成员把已看过的历史当新消息重看一遍）。
    advanceSeenCursor(sessionId, 'a1', 4)
    expect(getSeenCursor(sessionId, 'a1')).toBe(10)
    advanceSeenCursor(sessionId, 'a1', 11)
    expect(getSeenCursor(sessionId, 'a1')).toBe(11)
    // 补出来的行走表的 DEFAULT（gateway 不写 response_mode 列）。
    expect(getGroupMemberConfigs(sessionId)[0]?.responseMode).toBe('mention')
  })

  test('⑤ appendMessage persists chain_id; listMessages returns it', () => {
    const sessionId = newGroup(['a1'])
    const root = appendMessage({ sessionId, role: 'user', content: 'hi', status: 'complete' })
    const reply = appendMessage({
      sessionId,
      role: 'assistant',
      content: 'yo',
      status: 'complete',
      speakerAgentId: 'a1',
      chainId: root.id,
      tokensInput: 100,
      tokensOutput: 20,
      costUsd: 0.001
    })
    expect(reply.chain_id).toBe(root.id)
    const rows = listMessages(sessionId)
    expect(rows[0]?.chain_id ?? null).toBeNull()
    expect(rows[1]?.chain_id).toBe(root.id)
    expect(rows[1]?.tokens_input).toBe(100)
    expect(rows[1]?.cost_usd).toBeCloseTo(0.001)
  })

  test('⑤ groupUsage sums the family window; unknown cost stays null', () => {
    const parent = newGroup(['a1'])
    const child = newGroup(['a1'], parent)
    const base = Date.now()
    const turn = (sessionId: number, startedAt: number, cost: number | null): void => {
      insertGroupTurn({
        sessionId,
        runId: 'r',
        chainId: 1,
        seq: 0,
        agentId: 'a1',
        triggerKind: 'human',
        outcome: 'spoke',
        tokensInput: 100,
        tokensOutput: 50,
        costUsd: cost,
        startedAt
      })
    }
    turn(parent, base, 0.02)
    turn(child, base, null)
    turn(parent, base - 7_200_000, 9.99) // 2h 前 —— 不进 1h 窗口

    const family = [parent, child, ...familyOf(parent).childSessionIds].filter(
      (id, i, all) => all.indexOf(id) === i
    )
    const usage = groupUsage(family, base - 3_600_000)
    expect(usage.turns).toBe(2)
    expect(usage.tokens).toBe(300)
    // 一行有价一行无价 → 已知部分求和（SUM 忽略 NULL）；整窗全 NULL 才是 null。
    expect(usage.costUsd).toBeCloseTo(0.02)
    expect(groupUsage([child], base - 3_600_000).costUsd).toBeNull()
    expect(groupUsage([], base).turns).toBe(0)
  })

  test('⑤ familyOf links parent ↔ group children only', () => {
    const parent = newGroup(['a1'])
    const child = newGroup(['a1'], parent)
    // 非群子会话（custom_agent_call 的子 session 也用 parent_session_id）不进 family。
    const sub = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    getChatDb()
      .prepare('UPDATE ai_chat_sessions SET parent_session_id = ? WHERE id = ?')
      .run(parent, sub.id)

    expect(familyOf(parent)).toEqual({ parentSessionId: null, childSessionIds: [child] })
    expect(familyOf(child).parentSessionId).toBe(parent)
  })

  test('⑤ insertGroupTurn writes every outcome; listGroupTurns reads newest first', () => {
    const sessionId = newGroup(['a1'])
    const base = Date.now()
    const outcomes = ['spoke', 'silent', 'held_dup', 'skipped', 'failed', 'stopped'] as const
    outcomes.forEach((outcome, i) => {
      insertGroupTurn({
        sessionId,
        runId: 'r',
        chainId: 1,
        seq: i,
        agentId: 'a1',
        triggerKind: 'agent',
        outcome,
        startedAt: base + i,
        error: outcome === 'stopped' ? 'chain_cap' : null
      })
    })
    const turns = listGroupTurns(sessionId)
    expect(turns).toHaveLength(outcomes.length)
    expect(turns[0]?.outcome).toBe('stopped')
    expect(turns[0]?.error).toBe('chain_cap')
  })
})
