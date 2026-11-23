// renderer 侧的两个资料库 IPC（design §2.5）：用系统应用打开 / 在访达中显示。
// 只递「哪个文件」，绝对路径全程留在主进程；非 Electron（web 构建 / 测试）诚实返回不支持。

import type { LibraryFile } from '@shared/api/types/library'
import { canInvokeElectronIpc, invokeIpc } from '@shared/ipc/client'
import { readableIpcError } from '@shared/lib/ipcErrors'
import {
  LIBRARY_IPC,
  type LibraryOpenResult,
  type LibraryOpenTarget
} from '@shared/libraryIpcContract'

type LibraryTargetChannel =
  | typeof LIBRARY_IPC.openPath
  | typeof LIBRARY_IPC.showInFolder
  | typeof LIBRARY_IPC.trashItem

async function call(
  channel: LibraryTargetChannel,
  target: LibraryOpenTarget
): Promise<LibraryOpenResult> {
  if (!canInvokeElectronIpc()) {
    return { ok: false, code: 'E_UNSUPPORTED', message: 'desktop only' }
  }
  try {
    return await invokeIpc(channel, target)
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

/** 挂载区删除（design §8.2 F12）：走系统废纸篓，不进库内 `.trash`。
 *  🔴 服务端对挂载区文件的 `DELETE /library/file/{id}` 恒拒，`mount_id > 0` 的删除只能走这条。 */
export function trashLibraryTarget(target: LibraryOpenTarget): Promise<LibraryOpenResult> {
  return call(LIBRARY_IPC.trashItem, target)
}

/** 设置页「库占用」。非 Electron（web 构建 / 测试）恒 0 —— 那里没有本机库可量。 */
export async function libraryUsageBytes(): Promise<number> {
  if (!canInvokeElectronIpc()) return 0
  try {
    return (await invokeIpc(LIBRARY_IPC.usage)).bytes
  } catch {
    return 0
  }
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
