// 挂载相关的两个主进程 IPC（task 09-03 P2-L6；design §8.2 F12 + §1.5）：
//   · `library:trashItem` —— 挂载区删除走**系统**废纸篓（服务端对挂载区文件的 DELETE 恒拒）；
//   · `library:usage`     —— 设置页「库占用」，只回字节数，**不回路径**。
//
// 与 `library_ipc.test.ts` 分文件：那份是 P1-L5 的资产（jail / open / reveal / 预览协议），
// 这份只钉本 lane 新加的两条，互不牵扯。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { mockDaemonRead, mockTrashItem, mockOpenPath, dataRootRef } = vi.hoisted(() => ({
  mockDaemonRead: vi.fn(),
  mockTrashItem: vi.fn(async (_absPath: string) => undefined),
  mockOpenPath: vi.fn(async (_absPath: string) => ''),
  dataRootRef: { current: '' }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openPath: mockOpenPath, showItemInFolder: vi.fn(), trashItem: mockTrashItem },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../src/electron/main/daemon_api', () => ({ daemonRead: mockDaemonRead }))

vi.mock('../../src/electron/main/db', () => ({
  resolveDataRoot: () => dataRootRef.current,
  resolveDbPath: () => join(dataRootRef.current, 'data', 'sync_store.db'),
  getDb: () => ({ prepare: () => ({ get: () => undefined }) })
}))

import {
  _resetLibraryMountsCacheForTests,
  libraryUsageBytes,
  trashLibraryTarget
} from '../../src/electron/main/handlers/library'
import { LIBRARY_IPC } from '../../src/shared/libraryIpcContract'

let root: string
let libraryRoot: string
let mountDir: string

beforeEach(() => {
  vi.clearAllMocks()
  _resetLibraryMountsCacheForTests()
  root = mkdtempSync(join(tmpdir(), 'mailagent-library-mount-'))
  dataRootRef.current = root
  libraryRoot = join(root, 'data', 'library')
  mountDir = join(root, 'mount')
  mkdirSync(join(libraryRoot, 'my-docs'), { recursive: true })
  mkdirSync(join(root, 'data', 'attachments'), { recursive: true })
  mkdirSync(join(mountDir, 'q3'), { recursive: true })
  writeFileSync(join(libraryRoot, 'my-docs', 'note.md'), 'x'.repeat(1000))
  writeFileSync(join(mountDir, 'q3', 'plan.docx'), 'y')
  writeFileSync(join(mountDir, 'q3', 'run.sh'), 'echo')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('IPC 键名单源', () => {
  test('两个新键都在 `LIBRARY_IPC` 里（跨进程键名只写一次）', () => {
    expect(LIBRARY_IPC.trashItem).toBe('library:trashItem')
    expect(LIBRARY_IPC.usage).toBe('library:usage')
  })
})

describe('library:trashItem —— 挂载区删除走系统废纸篓', () => {
  test('present 的挂载区文件：解析成绝对路径后交给 shell.trashItem', async () => {
    mockDaemonRead.mockImplementation(async (path: string) =>
      path === '/library/mounts'
        ? [{ id: 7, label: '工作区', abs_path: mountDir, mode: 'rw', status: 'ok' }]
        : { path: '@工作区/q3/plan.docx', status: 'present' }
    )
    const result = await trashLibraryTarget({ kind: 'file', fileId: 3 })

    expect(result).toEqual({ ok: true })
    expect(mockTrashItem).toHaveBeenCalledTimes(1)
    expect(String(mockTrashItem.mock.calls[0]?.[0]).endsWith(join('q3', 'plan.docx'))).toBe(true)
  })

  test('jail 之外的虚拟路径拒绝，且一个字节都不动', async () => {
    mockDaemonRead.mockImplementation(async (path: string) =>
      path === '/library/mounts' ? [] : { path: '@没挂过的根/x.txt', status: 'present' }
    )
    const result = await trashLibraryTarget({ kind: 'file', fileId: 3 })

    expect(result.ok).toBe(false)
    expect(mockTrashItem).not.toHaveBeenCalled()
  })

  test('目标形状不合法直接 E_INVALID_ARG', async () => {
    expect(await trashLibraryTarget({ kind: 'nope' })).toMatchObject({
      ok: false,
      code: 'E_INVALID_ARG'
    })
    expect(mockTrashItem).not.toHaveBeenCalled()
  })

  test('扩展名黑名单**不适用**于扔废纸篓（那道闸挡的是「执行」，不是「删除」）', async () => {
    mockDaemonRead.mockImplementation(async (path: string) =>
      path === '/library/mounts'
        ? [{ id: 7, label: '工作区', abs_path: mountDir, mode: 'rw', status: 'ok' }]
        : { path: '@工作区/q3/run.sh', status: 'present' }
    )
    const result = await trashLibraryTarget({ kind: 'file', fileId: 9 })

    expect(result).toEqual({ ok: true })
    expect(String(mockTrashItem.mock.calls[0]?.[0]).endsWith(join('q3', 'run.sh'))).toBe(true)
  })
})

describe('library:usage —— 库占用', () => {
  test('只数库根 + library.db 三件套；挂载根的文件不算进去', () => {
    writeFileSync(join(root, 'data', 'library.db'), 'z'.repeat(500))
    writeFileSync(join(root, 'data', 'library.db-wal'), 'z'.repeat(200))
    // 挂载目录里的文件在用户自己的盘上，不属于「库占用」。
    writeFileSync(join(mountDir, 'q3', 'huge.bin'), 'b'.repeat(9_000))

    expect(libraryUsageBytes()).toEqual({ bytes: 1000 + 500 + 200 })
  })

  test('库根还没建时回 0，不抛', () => {
    rmSync(join(root, 'data'), { recursive: true, force: true })
    expect(libraryUsageBytes()).toEqual({ bytes: 0 })
  })
})
