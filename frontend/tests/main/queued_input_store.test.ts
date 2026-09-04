import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cancelQueuedInput,
  claimQueuedInput,
  closeChatDb,
  confirmQueuedInput,
  createNewSession,
  enqueueQueuedInput,
  getChatDb,
  getQueuedInput,
  listQueuedInput,
  markSent,
  restoreAllStale,
  restoreClaimedForSession,
  restoreForSession,
  updateQueuedInput
} from '../../src/electron/main/chat_db'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp' } }))

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'queued-input-'))
  process.env.AI_CHAT_DB_PATH = join(tmpDir, 'ai_chat.db')
  closeChatDb()
})

afterEach(() => {
  closeChatDb()
  delete process.env.AI_CHAT_DB_PATH
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function sessionId(): number {
  return createNewSession({ emailId: 1, backendKind: 'ai-sdk' }).id
}

describe('queued input store', () => {
  test('CRUD and restored confirmation use state CAS', () => {
    const sid = sessionId()
    const item = enqueueQueuedInput(sid, '  hello  ')
    expect(item.content).toBe('hello')
    expect(listQueuedInput(sid)).toHaveLength(1)
    expect(updateQueuedInput(item.id, 'updated')).toBe(true)
    expect(restoreForSession(sid)).toBe(1)
    expect(getQueuedInput(item.id)?.status).toBe('restored')
    expect(confirmQueuedInput(item.id)).toBe(true)
    expect(cancelQueuedInput(item.id)).toBe(true)
    expect(updateQueuedInput(item.id, 'nope')).toBe(false)
  })

  test('claim CAS only wins once', () => {
    const item = enqueueQueuedInput(sessionId(), 'one')
    expect(claimQueuedInput([item.id], 10)).toEqual([item.id])
    expect(claimQueuedInput([item.id], 11)).toEqual([])
  })

  test('caps pending rows at 20 and content at 16K', () => {
    const sid = sessionId()
    for (let index = 0; index < 20; index += 1) enqueueQueuedInput(sid, `row-${index}`)
    expect(() => enqueueQueuedInput(sid, 'overflow')).toThrow('E_QUEUE_FULL')
    expect(() => enqueueQueuedInput(sid, 'x'.repeat(16_385))).toThrow('E_INVALID_ARG')
  })

  test('restoreAllStale restores queued and claimed rows', () => {
    const sid = sessionId()
    const first = enqueueQueuedInput(sid, 'one')
    const second = enqueueQueuedInput(sid, 'two')
    claimQueuedInput([second.id], Date.now())
    expect(restoreAllStale()).toBe(2)
    expect(listQueuedInput(sid).map((item) => item.status)).toEqual(['restored', 'restored'])
    expect(first.id).toBeLessThan(second.id)
  })

  // 0903 —— 一轮 run 结束时的收尾：只把「那一轮没能送出去」的 claimed 行还给用户，还排着队的
  // queued 行不动（用户随时可改可撤，降级它没道理）。落 'restored' 而不是 'queued' 是循环闸。
  test('restoreClaimedForSession 只降级 claimed，且落 restored（不是 queued）', () => {
    const sid = sessionId()
    const claimed = enqueueQueuedInput(sid, '被那一轮带走但没送到')
    const stillQueued = enqueueQueuedInput(sid, '还排着队')
    expect(claimQueuedInput([claimed.id], Date.now())).toEqual([claimed.id])

    expect(restoreClaimedForSession(sid)).toBe(1)

    expect(getQueuedInput(claimed.id)?.status).toBe('restored')
    expect(getQueuedInput(stillQueued.id)?.status).toBe('queued')
  })

  test('restoreClaimedForSession 是会话内的，不碰别的会话', () => {
    const mine = sessionId()
    const other = sessionId()
    const a = enqueueQueuedInput(mine, 'a')
    const b = enqueueQueuedInput(other, 'b')
    claimQueuedInput([a.id, b.id], Date.now())

    expect(restoreClaimedForSession(mine)).toBe(1)

    expect(getQueuedInput(a.id)?.status).toBe('restored')
    expect(getQueuedInput(b.id)?.status).toBe('claimed')
  })

  test('markSent is session-scoped, idempotent, and binds delivered id only to the first row', () => {
    const sid = sessionId()
    const otherSid = sessionId()
    const first = enqueueQueuedInput(sid, 'one')
    const second = enqueueQueuedInput(sid, 'two')
    const other = enqueueQueuedInput(otherSid, 'other')
    claimQueuedInput([first.id, second.id, other.id], Date.now())
    expect(markSent(sid, [other.id], 98)).toBe(0)
    expect(markSent(sid, [first.id, second.id], 99)).toBe(2)
    expect(getQueuedInput(first.id)?.deliveredMessageId).toBe(99)
    expect(getQueuedInput(second.id)?.deliveredMessageId).toBeNull()
    expect(getQueuedInput(first.id)?.status).toBe('sent')
    expect(getQueuedInput(other.id)?.status).toBe('claimed')
    expect(markSent(sid, [first.id, second.id], 99)).toBe(0)
    expect(cancelQueuedInput(first.id)).toBe(false)

    const third = enqueueQueuedInput(sid, 'three')
    claimQueuedInput([third.id], Date.now())
    expect(() => markSent(sid, [third.id], 99)).toThrow()
  })

  test('v26 table and indexes exist', () => {
    sessionId()
    const db = getChatDb()
    const version = db
      .prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'")
      .get() as {
      value: string
    }
    expect(version.value).toBe('32')
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='chat_queued_input'")
      .get() as {
      sql: string
    }
    expect(sql.sql).toContain("CHECK (mode IN ('follow_up', 'steering'))")
    expect(sql.sql).toContain(
      "CHECK (status IN ('queued', 'claimed', 'sent', 'canceled', 'restored'))"
    )
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
      name: string
    }>
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining(['idx_chat_queued_input_dispatch', 'idx_chat_queued_input_delivery'])
    )
  })
})
