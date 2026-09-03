// L4 群聊话题 T3 (CHAT_DB v32) — TS 侧 listAllSessions 的两件事：话题不进群清单 + 群行的
// has_unread_threads 派生列。
//
// 这两段 SQL 在 Python 侧（src/chat/db.py::list_all_sessions，远程 web 走那条）另有一份逐字
// 手抄，文本对齐由 tests/config/test_chat_type_mirror_parity.py
// ::test_group_list_thread_exclusion_mirror_parity 锁死；本文件锁的是**桌面这一侧真跑出来的
// 行为**（文本对了但语义写反了，闸照样绿）。
//
// Verified scenarios:
//   ① 群清单里有群、有子群，**没有**话题（判据恒是 invoked_by='thread'，不是 parent 非空 ——
//     子群和话题在别的列上一模一样）。
//   ② has_unread_threads：话题有未读 → true；话题从没打开过（last_read_at NULL）→ false；
//     群底下没有话题 → false。🔴 值必须是真 boolean（SQLite 的 EXISTS 给的是 0/1，读侧判据
//     是 `=== true`，不折就永远不亮）。
//   ③ 非群查询（interactive）不带这一列 —— 它没有消费点，白搭一个逐行子查询。
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
  listAllSessions
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
  tmpDir = mkdtempSync(join(tmpdir(), 'chat-db-threads-'))
  dbPath = join(tmpDir, 'ai_chat.db')
  process.env['AI_CHAT_DB_PATH'] = dbPath
  closeChatDb()
})

afterEach(() => {
  closeChatDb()
  delete process.env['AI_CHAT_DB_PATH']
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
})

function newGroup(): number {
  return createNewSession({ anchorType: 'general', backendKind: 'ai-sdk', groupMembers: ['a1'] }).id
}

/** 建话题 / 子群走的是 serve-api（POST /chat/sessions/{id}/threads），这里直接摆出那行的形状。 */
function newChild(parentId: number, invokedBy: 'thread' | 'judge', rootMessageId?: number): number {
  const id = newGroup()
  getChatDb()
    .prepare(
      `UPDATE ai_chat_sessions
         SET parent_session_id = ?, invoked_by = ?, thread_root_message_id = ?
       WHERE id = ?`
    )
    .run(parentId, invokedBy, rootMessageId ?? null, id)
  return id
}

function setWatermarks(sessionId: number, updatedAt: number, lastReadAt: number | null): void {
  getChatDb()
    .prepare('UPDATE ai_chat_sessions SET updated_at = ?, last_read_at = ? WHERE id = ?')
    .run(updatedAt, lastReadAt, sessionId)
}

function groupRow(groupId: number) {
  return listAllSessions({ origin: 'group' }).find((s) => s.id === groupId)
}

describe('v32 群清单分家（①）', () => {
  test('话题不进群清单；子群仍在', () => {
    const group = newGroup()
    const subgroup = newChild(group, 'judge')
    const thread = newChild(group, 'thread', 100)

    const ids = listAllSessions({ origin: 'group' }).map((s) => s.id)
    expect(ids).toContain(group)
    expect(ids).toContain(subgroup)
    expect(ids).not.toContain(thread)
  })

  test("origin='all' 看得见话题（AI 该搜得到话题里的内容）", () => {
    const group = newGroup()
    const thread = newChild(group, 'thread', 100)
    appendMessage({ sessionId: thread, role: 'user', content: '话题里说的话', status: 'complete' })
    expect(listAllSessions({ origin: 'all' }).map((s) => s.id)).toContain(thread)
  })
})

describe('v32 has_unread_threads 派生列（②③）', () => {
  test('话题有未读 → 群行为 true，且是真 boolean 不是 1', () => {
    const group = newGroup()
    const thread = newChild(group, 'thread', 100)
    setWatermarks(thread, 5_000, 4_000)

    const row = groupRow(group)
    expect(row?.has_unread_threads).toBe(true)
    // 🔴 `toBe(true)` 已经排除了 1；这条断言只是把「为什么不能用 toBeTruthy」写在代码里。
    expect(typeof row?.has_unread_threads).toBe('boolean')
  })

  test('从没打开过的话题不算未读；没有话题的群也是 false', () => {
    const group = newGroup()
    const empty = newGroup()
    const thread = newChild(group, 'thread', 100)
    setWatermarks(thread, 6_000, null)
    expect(groupRow(group)?.has_unread_threads).toBe(false)
    expect(groupRow(empty)?.has_unread_threads).toBe(false)
  })

  test('子群里的未读不算「未读话题」（判据是 invoked_by 不是 parent 非空）', () => {
    const group = newGroup()
    const subgroup = newChild(group, 'judge')
    setWatermarks(subgroup, 5_000, 4_000)
    expect(groupRow(group)?.has_unread_threads).toBe(false)
  })

  test('非群查询不带这一列（没有消费点，不白搭一个逐行子查询）', () => {
    const plain = createNewSession({ anchorType: 'general', backendKind: 'ai-sdk' })
    appendMessage({ sessionId: plain.id, role: 'user', content: 'hi', status: 'complete' })
    const row = listAllSessions({ origin: 'interactive' }).find((s) => s.id === plain.id)
    expect(row).toBeDefined()
    expect('has_unread_threads' in (row as object)).toBe(false)
  })
})
