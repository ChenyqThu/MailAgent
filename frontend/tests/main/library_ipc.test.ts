// 资料库主进程侧（task 09-03 P1-L5）：路径 jail + 两个 IPC + `libpreview://` 协议。
//
// 三层各钉几条：
//   · `library_paths`（纯 node）：真临时目录 —— `..` / 绝对路径 / 越界 symlink / 未知根 / 挂载根 /
//     投影同目录相对引用 / 扩展名黑名单；
//   · `handlers/library`：serve-api（daemon_api）与 shell 都 mock，看「missing 不开」「黑名单不开」
//     「reveal 走 showItemInFolder」；
//   · `library_preview_protocol`：真文件 → 200 + content-type；目录 / 越界 / 坏 host → 404。

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRead, mockOpenPath, mockShowItemInFolder, attachmentRows, dataRootRef } = vi.hoisted(
  () => ({
    mockDaemonRead: vi.fn(),
    // 形参不能省：`vi.fn(async () => '')` 的 calls 是零元组，下面按 `calls[0][0]` 断言路径会红。
    mockOpenPath: vi.fn(async (_absPath: string) => ''),
    mockShowItemInFolder: vi.fn(),
    attachmentRows: new Map<number, { local_path: string; filename: string }>(),
    dataRootRef: { current: '' }
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: mockOpenPath, showItemInFolder: mockShowItemInFolder },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../src/electron/main/daemon_api', () => ({
  daemonRead: mockDaemonRead
}))

vi.mock('../../src/electron/main/db', () => ({
  resolveDataRoot: () => dataRootRef.current,
  resolveDbPath: () => join(dataRootRef.current, 'data', 'sync_store.db'),
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (id: number) => {
        const row = attachmentRows.get(id)
        if (!row) return undefined
        if (sql.includes('filename')) return { filename: row.filename }
        return { local_path: row.local_path }
      }
    })
  })
}))

import {
  isBlockedForOpen,
  jailUnder,
  LibraryPathError,
  mimeForPath,
  resolveVirtualPath,
  splitVirtualPath,
  type LibraryPathContext
} from '../../src/electron/main/library_paths'
import {
  _resetLibraryMountsCacheForTests,
  openLibraryTarget
} from '../../src/electron/main/handlers/library'
import { handleLibraryPreviewRequest } from '../../src/electron/main/library_preview_protocol'
import { buildLibraryPreviewUrl } from '../../src/shared/libraryIpcContract'

let root: string
let libraryRoot: string
let attachmentsRoot: string
let mountDir: string
let outside: string

function ctx(): LibraryPathContext {
  return {
    libraryRoot,
    attachmentsRoot,
    mountRoots: new Map([['工作区', mountDir]]),
    attachmentLocation: async (id) => {
      const row = attachmentRows.get(id)
      return row ? { absPath: join(root, row.local_path), filename: row.filename } : null
    }
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'OK'
  } catch (err) {
    return err instanceof LibraryPathError ? err.code : 'OTHER'
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mailagent-library-'))
  dataRootRef.current = root
  libraryRoot = join(root, 'data', 'library')
  attachmentsRoot = join(root, 'data', 'attachments')
  mountDir = join(root, 'mount')
  outside = join(root, 'outside')
  for (const dir of [
    join(libraryRoot, 'my-docs', 'sub'),
    join(libraryRoot, 'agent-docs'),
    join(attachmentsRoot, '42'),
    join(mountDir, 'q3'),
    outside
  ]) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(join(libraryRoot, 'my-docs', 'note.md'), '# hi')
  writeFileSync(join(libraryRoot, 'my-docs', 'page.html'), '<script>document.title="ran"</script>')
  writeFileSync(join(libraryRoot, 'my-docs', 'run.sh'), 'echo')
  writeFileSync(join(libraryRoot, 'my-docs', 'sub', 'style.css'), 'body{}')
  writeFileSync(join(mountDir, 'q3', 'plan.docx'), 'x')
  writeFileSync(join(attachmentsRoot, '42', 'report_1.html'), '<b>att</b>')
  writeFileSync(join(attachmentsRoot, '42', 'logo.png'), 'png')
  writeFileSync(join(outside, 'secret.txt'), 'nope')
  symlinkSync(join(outside, 'secret.txt'), join(libraryRoot, 'my-docs', 'escape.txt'))
  symlinkSync(outside, join(libraryRoot, 'my-docs', 'escape-dir'))
  attachmentRows.clear()
  attachmentRows.set(42, { local_path: 'data/attachments/42/report_1.html', filename: 'report.html' })
  mockDaemonRead.mockReset()
  mockOpenPath.mockClear()
  mockShowItemInFolder.mockClear()
  _resetLibraryMountsCacheForTests()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('library_paths — 虚拟路径校验', () => {
  test('拒 .. / 绝对路径 / 空段 / NUL', () => {
    for (const bad of ['../x', 'my-docs/../x', '/etc/passwd', 'my-docs//a', 'my-docs/a\0b', '']) {
      expect(() => splitVirtualPath(bad), bad).toThrow(LibraryPathError)
    }
    expect(splitVirtualPath('my-docs/产品/定价.md')).toEqual(['my-docs', '产品', '定价.md'])
  })

  test('内置根落在 DATA_ROOT/data/library 下；未知顶层 404', async () => {
    const { absPath } = await resolveVirtualPath('my-docs/note.md', ctx())
    expect(absPath.endsWith(join('data', 'library', 'my-docs', 'note.md'))).toBe(true)
    expect(await codeOf(resolveVirtualPath('somewhere/x.md', ctx()))).toBe('E_NOT_FOUND')
    expect(await codeOf(resolveVirtualPath('my-docs/nope.md', ctx()))).toBe('E_NOT_FOUND')
  })

  test('symlink 成分一律拒（文件与目录两种，指向根外）', async () => {
    expect(await codeOf(resolveVirtualPath('my-docs/escape.txt', ctx()))).toBe('E_AUTH_FAILED')
    expect(await codeOf(resolveVirtualPath('my-docs/escape-dir/secret.txt', ctx()))).toBe(
      'E_AUTH_FAILED'
    )
    // jailUnder 本身也钉一条：拼出来的路径 realpath 后不逐字相等就拒。
    expect(await codeOf(jailUnder(libraryRoot, ['my-docs', 'escape.txt']))).toBe('E_AUTH_FAILED')
  })

  test('挂载根按 @label 找；未知 / 不可用挂载 404', async () => {
    const { absPath } = await resolveVirtualPath('@工作区/q3/plan.docx', ctx())
    expect(absPath.endsWith(join('mount', 'q3', 'plan.docx'))).toBe(true)
    expect(await codeOf(resolveVirtualPath('@没有/x', ctx()))).toBe('E_NOT_FOUND')
  })

  test('投影：末段按显示名或磁盘名认附件本体；其他末段当同目录相对引用；不能出附件目录', async () => {
    const byShown = await resolveVirtualPath('mail-attachments/42/report.html', ctx())
    const byDisk = await resolveVirtualPath('mail-attachments/42/report_1.html', ctx())
    expect(byShown.absPath).toBe(byDisk.absPath)
    const sibling = await resolveVirtualPath('mail-attachments/42/logo.png', ctx())
    expect(sibling.absPath.endsWith(join('42', 'logo.png'))).toBe(true)
    expect(await codeOf(resolveVirtualPath('mail-attachments/42/../43/x', ctx()))).toBe(
      'E_INVALID_ARG'
    )
    expect(await codeOf(resolveVirtualPath('mail-attachments/7/x.html', ctx()))).toBe('E_NOT_FOUND')
    expect(await codeOf(resolveVirtualPath('mail-attachments/42', ctx()))).toBe('E_INVALID_ARG')
  })

  test('扩展名黑名单 + MIME 表', () => {
    expect(isBlockedForOpen('/x/Foo.APP')).toBe(true)
    expect(isBlockedForOpen('/x/run.sh')).toBe(true)
    expect(isBlockedForOpen('/x/note.md')).toBe(false)
    expect(mimeForPath('/x/page.html')).toBe('text/html; charset=utf-8')
    expect(mimeForPath('/x/blob.bin')).toBe('application/octet-stream')
  })
})

describe('handlers/library — openPath / showInFolder', () => {
  test('file 目标：问 serve-api 要虚拟路径，present 才开', async () => {
    mockDaemonRead.mockImplementation(async (path: string) =>
      path === '/library/file/7'
        ? { path: 'my-docs/note.md', status: 'present' }
        : path === '/library/mounts'
          ? []
          : undefined
    )
    const result = await openLibraryTarget({ kind: 'file', fileId: 7 }, 'open')
    expect(result).toEqual({ ok: true })
    expect(mockOpenPath).toHaveBeenCalledTimes(1)
    expect(String(mockOpenPath.mock.calls[0]?.[0]).endsWith(join('my-docs', 'note.md'))).toBe(true)
  })

  test('missing / trashed 的文件不开', async () => {
    mockDaemonRead.mockImplementation(async (path: string) =>
      path === '/library/mounts' ? [] : { path: 'my-docs/note.md', status: 'trashed' }
    )
    const result = await openLibraryTarget({ kind: 'file', fileId: 7 }, 'open')
    expect(result.ok).toBe(false)
    expect(mockOpenPath).not.toHaveBeenCalled()
  })

  test('黑名单扩展名两条通道都拒', async () => {
    mockDaemonRead.mockImplementation(async (path: string) =>
      path === '/library/mounts' ? [] : { path: 'my-docs/run.sh', status: 'present' }
    )
    const opened = await openLibraryTarget({ kind: 'file', fileId: 1 }, 'open')
    const revealed = await openLibraryTarget({ kind: 'file', fileId: 1 }, 'reveal')
    expect(opened).toMatchObject({ ok: false, code: 'E_AUTH_FAILED' })
    expect(revealed).toMatchObject({ ok: false, code: 'E_AUTH_FAILED' })
    expect(mockOpenPath).not.toHaveBeenCalled()
    expect(mockShowItemInFolder).not.toHaveBeenCalled()
  })

  test('attachment 目标走 email_attachment.local_path；folder 目标走虚拟路径 reveal', async () => {
    mockDaemonRead.mockResolvedValue([])
    const att = await openLibraryTarget({ kind: 'attachment', attachmentId: 42 }, 'open')
    expect(att).toEqual({ ok: true })
    expect(String(mockOpenPath.mock.calls[0]?.[0]).endsWith(join('42', 'report_1.html'))).toBe(true)

    const folder = await openLibraryTarget({ kind: 'folder', path: 'my-docs/sub' }, 'reveal')
    expect(folder).toEqual({ ok: true })
    expect(String(mockShowItemInFolder.mock.calls[0]?.[0]).endsWith(join('my-docs', 'sub'))).toBe(
      true
    )
  })

  test('挂载根来自 GET /library/mounts（只认 status ok）', async () => {
    mockDaemonRead.mockImplementation(async (path: string) =>
      path === '/library/mounts'
        ? [
            { id: 1, label: '工作区', abs_path: mountDir, mode: 'rw', status: 'ok' },
            { id: 2, label: '拔了', abs_path: outside, mode: 'ro', status: 'unavailable' }
          ]
        : undefined
    )
    expect(await openLibraryTarget({ kind: 'folder', path: '@工作区/q3' }, 'reveal')).toEqual({
      ok: true
    })
    expect(await openLibraryTarget({ kind: 'folder', path: '@拔了/secret.txt' }, 'open')).toMatchObject(
      { ok: false, code: 'E_NOT_FOUND' }
    )
  })

  test('坏载荷不抛，回 E_INVALID_ARG', async () => {
    expect(await openLibraryTarget({ kind: 'file', fileId: -1 }, 'open')).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
    expect(await openLibraryTarget('my-docs/note.md', 'open')).toMatchObject({ ok: false })
  })
})

describe('libpreview:// 协议', () => {
  beforeEach(() => {
    mockDaemonRead.mockResolvedValue([])
  })

  test('真文件 → 200 + content-type，脚本原样送出（不过 DOMPurify）', async () => {
    const res = await handleLibraryPreviewRequest(
      new Request(buildLibraryPreviewUrl('my-docs/page.html'))
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('<script>document.title="ran"</script>')
  })

  test('相对引用在同一个根内解析（中文段 percent-encode 往返）', async () => {
    const res = await handleLibraryPreviewRequest(
      new Request(buildLibraryPreviewUrl('my-docs/sub/style.css'))
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
    const mount = await handleLibraryPreviewRequest(
      new Request(buildLibraryPreviewUrl('mail-attachments/42/logo.png'))
    )
    expect(mount.status).toBe(200)
    expect(mount.headers.get('content-type')).toBe('image/png')
  })

  test('目录 / 越界 symlink / 坏 host / 不存在 一律 404', async () => {
    for (const url of [
      buildLibraryPreviewUrl('my-docs/sub'),
      buildLibraryPreviewUrl('my-docs/escape.txt'),
      buildLibraryPreviewUrl('my-docs/missing.html'),
      'libpreview://elsewhere/my-docs/page.html'
    ]) {
      const res = await handleLibraryPreviewRequest(new Request(url))
      expect(res.status, url).toBe(404)
    }
  })
})
