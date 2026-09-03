// renderer 侧的两个资料库 IPC（design §2.5）：用系统应用打开 / 在访达中显示。
// 只递「哪个文件」，绝对路径全程留在主进程；非 Electron（web 构建 / 测试）诚实返回不支持。

import type { LibraryFile } from '@shared/api/types/library'
import { readableIpcError } from '@shared/lib/ipcErrors'
import {
  LIBRARY_IPC,
  type LibraryOpenResult,
  type LibraryOpenTarget
} from '@shared/libraryIpcContract'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

function ipcInvoke(): Invoke | null {
  const w = window as unknown as { electron?: { ipcRenderer?: { invoke?: Invoke } } }
  const invoke = w.electron?.ipcRenderer?.invoke
  return typeof invoke === 'function' ? invoke.bind(w.electron?.ipcRenderer) : null
}

async function call(channel: string, target: LibraryOpenTarget): Promise<LibraryOpenResult> {
  const invoke = ipcInvoke()
  if (invoke === null) return { ok: false, code: 'E_UNSUPPORTED', message: 'desktop only' }
  try {
    return (await invoke(channel, target)) as LibraryOpenResult
  } catch (err) {
    return { ok: false, code: 'E_INTERNAL', message: readableIpcError(err) }
  }
}

export function openLibraryTarget(target: LibraryOpenTarget): Promise<LibraryOpenResult> {
  return call(LIBRARY_IPC.openPath, target)
}

export function revealLibraryTarget(target: LibraryOpenTarget): Promise<LibraryOpenResult> {
  return call(LIBRARY_IPC.showInFolder, target)
}

/** 文件对象 → IPC 目标（库内按 id、投影按 attachment_id；两者都没有 = 不可打开）。 */
export function openTargetOf(
  file: Pick<LibraryFile, 'id' | 'attachment_id'>
): LibraryOpenTarget | null {
  if (typeof file.id === 'number') return { kind: 'file', fileId: file.id }
  if (typeof file.attachment_id === 'number') {
    return { kind: 'attachment', attachmentId: file.attachment_id }
  }
  return null
}
