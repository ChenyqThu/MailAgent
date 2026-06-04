// B1 — outbox payload_json 的 JS/Python 逐字节契约 golden.
//
// writeFlagDirect (TS) 与 OutboxRepository.enqueue (Python) 现共用同一条原子
// UPSERT SQL (ON CONFLICT(...) WHERE status='pending' DO UPDATE json_patch). 本
// 测试锁 TS 侧 payload_json 字节序列 == 共享 GOLDEN; 对侧 tests/sync/
// test_outbox_parity.py 锁 Python 侧 == 同一 GOLDEN. 两者同 golden → 双跑期 (B1
// 后 D1 前 TS 直写与 Python in-process 写并存) 逐字节一致, 根除「两份手抄漂移」.
//
// ⚠️ 改 GOLDEN 必须同步改 tests/sync/test_outbox_parity.py 的 GOLDEN_NOTION.

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// 共享 golden —— 逐字节等同 test_outbox_parity.py::GOLDEN_NOTION.
// 序列: (writeFlagDirect opts, 该步后 notion target pending 行的 payload_json).
const GOLDEN_NOTION: Array<[Record<string, unknown>, string]> = [
  [{ isRead: true }, '{"is_read":true}'],
  [{ isFlagged: false }, '{"is_read":true,"is_flagged":false}'],
  [
    { isRead: false, processingStatus: '已完成' },
    '{"is_read":false,"is_flagged":false,"processing_status":"已完成"}'
  ]
]

// hoisted 容器 —— vi.mock 工厂在 import 前提升, 运行时读 h.db (beforeEach 赋值).
const h = vi.hoisted(() => ({ db: null as Database.Database | null }))

vi.mock('../../src/electron/main/db', () => ({
  getWriteDb: () => h.db
}))

import { writeFlagDirect } from '../../src/electron/main/handlers/write_ops'

const INTERNAL_ID = 1001

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE email_metadata (
    internal_id INTEGER PRIMARY KEY, is_read INTEGER DEFAULT 0, is_flagged INTEGER DEFAULT 0,
    processing_status TEXT, updated_at REAL)`)
  db.exec(`CREATE TABLE email_outbox (
    outbox_id INTEGER PRIMARY KEY AUTOINCREMENT, internal_id INTEGER NOT NULL, op_type TEXT NOT NULL,
    target TEXT NOT NULL, payload_json TEXT NOT NULL, source TEXT, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_retry_at REAL,
    created_at REAL NOT NULL, updated_at REAL NOT NULL)`)
  // v20 partial unique index —— writeFlagDirect 的 UPSERT ON CONFLICT 依赖它.
  db.exec(`CREATE UNIQUE INDEX ux_outbox_pending_intent
    ON email_outbox(internal_id, op_type, target) WHERE status='pending'`)
  db.prepare(`INSERT INTO email_metadata (internal_id) VALUES (?)`).run(INTERNAL_ID)
  return db
}

function pendingPayload(target: 'mailapp' | 'notion'): string | undefined {
  const row = h
    .db!.prepare(
      `SELECT payload_json FROM email_outbox
       WHERE internal_id=? AND op_type='flag_sync' AND target=? AND status='pending'`
    )
    .get(INTERNAL_ID, target) as { payload_json: string } | undefined
  return row?.payload_json
}

beforeEach(() => {
  h.db = makeDb()
})

afterEach(() => {
  h.db?.close()
  h.db = null
  vi.restoreAllMocks()
})

describe('write_ops — outbox payload_json JS/Python 契约 golden', () => {
  test('notion payload_json 字节序列逐步 == 共享 GOLDEN (INSERT + json_patch merge)', () => {
    for (const [opts, expected] of GOLDEN_NOTION) {
      const r = writeFlagDirect(INTERNAL_ID, opts)
      expect(r.ok).toBe(true)
      expect(pendingPayload('notion')).toBe(expected)
    }
  })

  test('mailapp payload 排除 processing_status, 仍逐字节紧凑', () => {
    // 单次写含三字段 → mailapp 只收 is_read/is_flagged, 紧凑 sorted.
    const r = writeFlagDirect(INTERNAL_ID, {
      isRead: true,
      isFlagged: false,
      processingStatus: '已完成'
    })
    expect(r.ok).toBe(true)
    expect(pendingPayload('mailapp')).toBe('{"is_flagged":false,"is_read":true}')
    expect(pendingPayload('notion')).toBe(
      '{"is_flagged":false,"is_read":true,"processing_status":"已完成"}'
    )
  })

  test('merge 覆盖同 key + 保留 base 顺序 (mailapp)', () => {
    writeFlagDirect(INTERNAL_ID, { isRead: true })
    writeFlagDirect(INTERNAL_ID, { isRead: false, isFlagged: true })
    expect(pendingPayload('mailapp')).toBe('{"is_read":false,"is_flagged":true}')
  })

  test('单次写两 target 各一行 pending (无跨 target 合并)', () => {
    const r = writeFlagDirect(INTERNAL_ID, { isRead: true }) as {
      ok: true
      data: { outbox_ids: number[]; merged_ids: number[] }
    }
    expect(r.ok).toBe(true)
    expect(r.data.outbox_ids).toHaveLength(2) // mailapp + notion 各一新行
    expect(pendingPayload('mailapp')).toBe('{"is_read":true}')
    expect(pendingPayload('notion')).toBe('{"is_read":true}')
  })
})
