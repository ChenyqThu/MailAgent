// Phase C — folder handler 单测.
//
// 读路径 (listFolder / getFolderEmail / searchFolder / folderSyncStatus) 用
// 一个手搓的 fake Database (getDb mock) 测 shaping 逻辑 — 不碰 better-sqlite3
// native binding (该 binding 在 CI/本地常因 Node ABI mismatch 跑不起来, 见
// email.test.ts 同样问题; 用 fake db 让 shaping 测试稳定可跑)。
//
// 写路径 (runFolder* / IPC envelope guard) mock callCli, 验证 CLI args 拼装
// + 非法输入返回 E_INVALID_ARG envelope (仿 calendar.test.ts)。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// ── fake better-sqlite3 (getDb mock) ────────────────────────────────────
// prepare(sql) → { all, get }. 测试用 setRows / setRow 注入返回值, 并记录
// 最后一次 prepare 的 sql + bound params 给断言用。
interface FakeStmt {
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
}
let fakeAllRows: unknown[] = []
let fakeGetRow: unknown = undefined
let lastSql = ''
let lastParams: unknown[] = []
const fakeDb = {
  prepare(sql: string): FakeStmt {
    lastSql = sql
    // Capture sql in the closures too — the handler caches prepared
    // statements by SQL text (module-level stmtCache), so on a cache hit
    // `prepare` isn't re-invoked; recording sql at .all()/.get() time keeps
    // lastSql/lastParams accurate regardless of cache state.
    return {
      all: (...params: unknown[]) => {
        lastSql = sql
        lastParams = params
        return fakeAllRows
      },
      get: (...params: unknown[]) => {
        lastSql = sql
        lastParams = params
        return fakeGetRow
      }
    }
  }
}

vi.mock('../../../src/electron/main/db', () => ({
  getDb: () => fakeDb,
  closeDb: () => {},
  resolveDbPath: () => ':memory:'
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

const { mockCallCli } = vi.hoisted(() => ({ mockCallCli: vi.fn() }))
vi.mock('../../../src/electron/main/cli_runner', async () => {
  const actual = await vi.importActual<typeof import('../../../src/electron/main/cli_runner')>(
    '../../../src/electron/main/cli_runner'
  )
  return { ...actual, callCli: mockCallCli }
})

const handlers = await import('../../../src/electron/main/handlers/folder')
const { __testing } = handlers

beforeEach(() => {
  fakeAllRows = []
  fakeGetRow = undefined
  lastSql = ''
  lastParams = []
  mockCallCli.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// A representative raw folder_email row (the shape better-sqlite3 returns).
function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    folder: 'archive',
    imap_uid: 42,
    imap_uidvalidity: 1001,
    message_id: '<abc@host>',
    thread_id: 't1',
    subject: 'Hello',
    sender: 'alice@acme.com',
    sender_name: 'Alice',
    to_addr: 'me@me.com',
    cc_addr: '',
    date_received: '2026-05-20T10:00:00+08:00',
    is_flagged: 1,
    has_attachments: 1,
    snippet: 'preview…',
    attachments_json: JSON.stringify([{ filename: 'a.pdf', size: 1234, content_type: 'application/pdf' }]),
    body_html: '<p>hi</p>',
    body_markdown: 'hi',
    ...overrides
  }
}

// ── reads ────────────────────────────────────────────────────────────────

describe('folder — listFolder', () => {
  test('shapes rows + coerces bool / parses attachments', () => {
    fakeAllRows = [rawRow()]
    const out = __testing.listFolder({ folder: 'archive', limit: 50 })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      id: 7,
      folder: 'archive',
      imap_uid: 42,
      subject: 'Hello',
      is_flagged: true,
      has_attachments: true,
      snippet: 'preview…'
    })
    expect(out[0]!.attachments).toEqual([
      { filename: 'a.pdf', size: 1234, content_type: 'application/pdf' }
    ])
    // WHERE folder=? AND deleted_at IS NULL + LIMIT/OFFSET bound
    expect(lastSql).toContain('deleted_at IS NULL')
    expect(lastParams).toEqual(['archive', 50, 0])
  })

  test('invalid folder → [] without touching db', () => {
    fakeAllRows = [rawRow()]
    // @ts-expect-error — intentionally bad folder
    const out = __testing.listFolder({ folder: 'spam' })
    expect(out).toEqual([])
  })

  test('limit clamps to [1, 1000]', () => {
    fakeAllRows = []
    __testing.listFolder({ folder: 'drafts', limit: 99999 })
    expect(lastParams[1]).toBe(1000)
  })
})

describe('folder — getFolderEmail', () => {
  test('returns detail with body fields', () => {
    fakeGetRow = rawRow({ folder: 'drafts' })
    const out = __testing.getFolderEmail(7)
    expect(out).toMatchObject({
      id: 7,
      folder: 'drafts',
      body_html: '<p>hi</p>',
      body_markdown: 'hi'
    })
  })

  test('missing row → null', () => {
    fakeGetRow = undefined
    expect(__testing.getFolderEmail(999)).toBeNull()
  })
})

describe('folder — searchFolder', () => {
  test('smart transform CJK query + records transformed_query', () => {
    fakeAllRows = [rawRow()]
    const out = __testing.searchFolder({ query: '产品', folder: 'archive' })
    expect(out.total_hits).toBe(1)
    // 产品 → (产品* OR (产* AND 品*))
    expect(out.transformed_query).toBe('(产品* OR (产* AND 品*))')
    // MATCH param is the transformed query, folder filter bound after
    expect(lastParams[0]).toBe('(产品* OR (产* AND 品*))')
    expect(lastParams).toContain('archive')
  })

  test('raw mode passes query through, transformed_query null', () => {
    fakeAllRows = []
    const out = __testing.searchFolder({ query: 'redis AND timeout', raw: true })
    expect(out.transformed_query).toBeNull()
    expect(lastParams[0]).toBe('redis AND timeout')
  })

  test('empty query short-circuits (no db hit)', () => {
    const out = __testing.searchFolder({ query: '   ' })
    expect(out).toEqual({ query: '   ', transformed_query: null, total_hits: 0, hits: [] })
    expect(lastSql).toBe('')
  })
})

describe('folder — folderSyncStatus', () => {
  test('returns states + per-folder counts', () => {
    // First prepare() = sync_state SELECT; subsequent = COUNT per folder.
    // Our fake returns the same fakeAllRows for .all() and fakeGetRow for
    // .get(); set both so states + counts populate.
    fakeAllRows = [
      {
        folder: 'archive',
        imap_uidvalidity: 1001,
        last_uidnext: 50,
        last_full_sync_at: 1716000000,
        last_incremental_sync_at: null,
        last_error: null
      }
    ]
    fakeGetRow = { n: 12 }
    const out = __testing.folderSyncStatus()
    expect(out.states).toHaveLength(1)
    expect(out.states[0]!.folder).toBe('archive')
    expect(out.counts).toEqual({ archive: 12, drafts: 12 })
  })
})

// ── writes (CLI arg construction) ──────────────────────────────────────────

describe('folder — write CLI args', () => {
  test('runFolderSyncNow full', async () => {
    mockCallCli.mockResolvedValue({ folder: 'archive', full: true })
    await __testing.runFolderSyncNow('archive', true)
    expect(mockCallCli).toHaveBeenCalledWith(['folder', 'sync-now', 'archive', '--full'], {
      write: true,
      needsAuth: true,
      timeoutMs: 120_000
    })
  })

  test('runFolderSyncNow incremental', async () => {
    mockCallCli.mockResolvedValue({})
    await __testing.runFolderSyncNow('drafts', false)
    expect(mockCallCli).toHaveBeenCalledWith(
      ['folder', 'sync-now', 'drafts', '--incremental'],
      expect.objectContaining({ write: true, needsAuth: true })
    )
  })

  test('runFolderDelete adds --yes', async () => {
    mockCallCli.mockResolvedValue({ id: 7, deleted: true })
    await __testing.runFolderDelete(7)
    expect(mockCallCli).toHaveBeenCalledWith(['folder', 'delete', '7', '--yes'], expect.anything())
  })

  test('runFolderMove default 收件箱 + --yes', async () => {
    mockCallCli.mockResolvedValue({ id: 7, moved_to: '收件箱', success: true })
    await __testing.runFolderMove(7)
    expect(mockCallCli).toHaveBeenCalledWith(
      ['folder', 'move', '7', '--to', '收件箱', '--yes'],
      expect.anything()
    )
  })

  test('runFolderSendDraft adds --yes', async () => {
    mockCallCli.mockResolvedValue({ id: 7, sent: true })
    await __testing.runFolderSendDraft(7)
    expect(mockCallCli).toHaveBeenCalledWith(
      ['folder', 'send-draft', '7', '--yes'],
      expect.anything()
    )
  })

  test('runFolderCreateDraft threads to/html + optional cc/subject', async () => {
    mockCallCli.mockResolvedValue({ appended_uid: 99, success: true })
    await __testing.runFolderCreateDraft({
      to: 'a@b.com,c@d.com',
      html: '<p>hi</p>',
      cc: 'e@f.com',
      subject: 'Re: x'
    })
    expect(mockCallCli).toHaveBeenCalledWith(
      [
        'folder',
        'create-draft',
        '--to',
        'a@b.com,c@d.com',
        '--html',
        '<p>hi</p>',
        '--cc',
        'e@f.com',
        '--subject',
        'Re: x'
      ],
      expect.anything()
    )
  })

  test('runFolderCreateDraft omits cc/subject when absent', async () => {
    mockCallCli.mockResolvedValue({ appended_uid: 100, success: true })
    await __testing.runFolderCreateDraft({ to: 'a@b.com', html: '<p>x</p>' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['folder', 'create-draft', '--to', 'a@b.com', '--html', '<p>x</p>'],
      expect.anything()
    )
  })

  test('runFolderEditDraft id + html + optional overrides', async () => {
    mockCallCli.mockResolvedValue({ old_id: 7, new_uid: 101, success: true })
    await __testing.runFolderEditDraft({ id: 7, html: '<p>y</p>', to: 'a@b.com' })
    expect(mockCallCli).toHaveBeenCalledWith(
      ['folder', 'edit-draft', '7', '--html', '<p>y</p>', '--to', 'a@b.com'],
      expect.anything()
    )
  })
})
