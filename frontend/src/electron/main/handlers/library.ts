// 资料库的两个主进程 IPC（design §2.5）：`library:openPath` / `library:showInFolder`。
//
// renderer 永不拿到绝对路径：它只递「哪个文件」（library id / 附件 id / 文件夹虚拟路径），
// 主进程按 id 问本机 serve-api 要虚拟路径，再经 `library_paths` 的 jail 落到磁盘 ——
// 库根 + `data/attachments/` + 挂载根，三座 jail 之外一律不开。扩展名黑名单
// （`.app .command .scpt .sh .pkg .dmg .jar .exe`）在 openPath 与 showInFolder 都生效：
// 「在访达中显示」一个 .app 本身无害，但两条通道一条口径，少一处例外就少一处漏。
//
// 返回值是 `LibraryOpenResult` 而不是 throw：这两个动作的失败对用户是一句 toast，
// 不需要 renderer 再从 `Error invoking remote method …` 里剥壳。

import { join } from 'node:path'

import { ipcMain, shell } from 'electron'

import type { LibraryMount } from '@shared/api/types/library'
import {
  LIBRARY_IPC,
  type LibraryOpenResult,
  type LibraryOpenTarget
} from '@shared/libraryIpcContract'
import { daemonRead } from '../daemon_api'
import { resolveDataRoot } from '../db'
import {
  isBlockedForOpen,
  LibraryPathError,
  resolveVirtualPath,
  type AttachmentLocation,
  type LibraryPathContext
} from '../library_paths'
import { getAttachmentLocalPath, getAttachmentFilename } from './attachment'

interface LibraryFileRow {
  path: string
  status: string
}

/** 挂载表几秒内不会变，一次预览会为页面里的每个静态资源各打一次协议 —— 缓一小会儿。 */
const MOUNTS_TTL_MS = 30_000
let mountsCache: { at: number; roots: ReadonlyMap<string, string> } | null = null

async function loadMountRoots(): Promise<ReadonlyMap<string, string>> {
  const now = Date.now()
  if (mountsCache && now - mountsCache.at < MOUNTS_TTL_MS) return mountsCache.roots
  const roots = new Map<string, string>()
  try {
    const mounts = await daemonRead<LibraryMount[]>('/library/mounts')
    for (const mount of mounts) {
      if (mount.status === 'ok' && mount.abs_path) roots.set(mount.label, mount.abs_path)
    }
  } catch {
    // serve-api 不可达 → 当作没有挂载根；内置根与投影不受影响。
  }
  mountsCache = { at: now, roots }
  return roots
}

/** 单测 / 挂载增删后的失效口。 */
export function _resetLibraryMountsCacheForTests(): void {
  mountsCache = null
}

async function attachmentLocation(attachmentId: number): Promise<AttachmentLocation | null> {
  const absPath = getAttachmentLocalPath(attachmentId)
  if (absPath === null) return null
  return { absPath, filename: getAttachmentFilename(attachmentId) ?? '' }
}

export async function buildLibraryPathContext(): Promise<LibraryPathContext> {
  const dataRoot = resolveDataRoot()
  return {
    libraryRoot: join(dataRoot, 'data', 'library'),
    attachmentsRoot: join(dataRoot, 'data', 'attachments'),
    mountRoots: await loadMountRoots(),
    attachmentLocation
  }
}

function isTarget(value: unknown): value is LibraryOpenTarget {
  if (!value || typeof value !== 'object') return false
  const rec = value as Record<string, unknown>
  switch (rec.kind) {
    case 'file':
      return Number.isInteger(rec.fileId) && (rec.fileId as number) >= 0
    case 'attachment':
      return Number.isInteger(rec.attachmentId) && (rec.attachmentId as number) >= 0
    case 'folder':
      return typeof rec.path === 'string' && rec.path.length > 0
    default:
      return false
  }
}

/** 目标 → 虚拟路径 → 绝对路径。`file` 先问 serve-api（missing / trashed 不开）。 */
export async function resolveOpenTarget(target: LibraryOpenTarget): Promise<string> {
  const ctx = await buildLibraryPathContext()
  if (target.kind === 'attachment') {
    const location = await attachmentLocation(target.attachmentId)
    if (location === null) throw new LibraryPathError('E_NOT_FOUND', 'attachment has no file on disk')
    const { absPath } = await resolveVirtualPath(
      `mail-attachments/${target.attachmentId}/${location.filename}`,
      ctx
    )
    return absPath
  }
  let virtual: string
  if (target.kind === 'file') {
    const row = await daemonRead<LibraryFileRow>(`/library/file/${target.fileId}`)
    if (row.status !== 'present') {
      throw new LibraryPathError('E_NOT_FOUND', `file is ${row.status}`)
    }
    virtual = row.path
  } else {
    virtual = target.path
  }
  const { absPath } = await resolveVirtualPath(virtual, ctx)
  return absPath
}

function failure(err: unknown): LibraryOpenResult {
  if (err instanceof LibraryPathError) return { ok: false, code: err.code, message: err.message }
  const code = (err as { code?: string } | null)?.code
  return {
    ok: false,
    code: typeof code === 'string' ? code : 'E_INTERNAL',
    message: err instanceof Error ? err.message : String(err)
  }
}

export async function openLibraryTarget(
  target: unknown,
  action: 'open' | 'reveal',
  shellLike: Pick<typeof shell, 'openPath' | 'showItemInFolder'> = shell
): Promise<LibraryOpenResult> {
  if (!isTarget(target)) return { ok: false, code: 'E_INVALID_ARG', message: 'bad open target' }
  try {
    const absPath = await resolveOpenTarget(target)
    if (isBlockedForOpen(absPath)) {
      return { ok: false, code: 'E_AUTH_FAILED', message: 'this file type is never opened from the app' }
    }
    if (action === 'open') {
      const errorMessage = await shellLike.openPath(absPath)
      if (errorMessage) return { ok: false, code: 'E_INTERNAL', message: errorMessage }
    } else {
      shellLike.showItemInFolder(absPath)
    }
    return { ok: true }
  } catch (err) {
    return failure(err)
  }
}

export function registerLibraryHandlers(): void {
  ipcMain.handle(LIBRARY_IPC.openPath, (_evt, target: unknown) => openLibraryTarget(target, 'open'))
  ipcMain.handle(LIBRARY_IPC.showInFolder, (_evt, target: unknown) =>
    openLibraryTarget(target, 'reveal')
  )
}
