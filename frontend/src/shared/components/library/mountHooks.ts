// 挂载根的数据层（design §8.2）：`GET/POST/PATCH/DELETE /library/mounts` 四条端点 + 一把
// 系统目录选择器。
//
// 🔴 **本文件是 `abs_path` 进 renderer 的唯一入口** —— `/library/mounts` 是唯一带绝对路径的
// 响应，而它只有设置页的挂载列表在调。树走 `GET /library/tree` 里内嵌的 `LibraryMountSummary`，
// 那个类型**根本没有 `abs_path` 字段**（不是「没渲染」，是结构上拿不到），所以「绝对路径只在
// 设置页出现」不靠自觉，靠类型。
//
// query key 挂在 `['library']` 前缀下，`useInvalidateLibrary().all()` 一刀能带上它。

import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'

import type { LibraryMount } from '@shared/api/types/library'
import type { LibraryMountMode } from '@shared/libraryConstants'
import { useMailApi } from '@shared/hooks/useMailApi'

import { useLibraryApi } from './hooks'

export const libMountsQk = ['library', 'mounts'] as const

/** 服务端的拒绝原因，原样呈现（design §8.2：拒挂规则由服务端强制，前端不再造一套判断）。
 *  envelope 的 `hint` 是给人看的那半句（如「选一个更小的文件夹」），跟在 message 后面。 */
export function mountErrorText(err: unknown): string {
  const e = err as { message?: unknown; hint?: unknown } | null
  const message = typeof e?.message === 'string' ? e.message : String(err)
  return typeof e?.hint === 'string' && e.hint !== '' ? `${message} · ${e.hint}` : message
}

/** 末段目录名 = 挂载的默认显示名。两种分隔符都切，Windows 侧同样成立。 */
export function mountLabelFromPath(absPath: string): string {
  const segments = absPath.split(/[/\\]/).filter((s) => s !== '')
  return segments.length > 0 ? segments[segments.length - 1] : absPath
}

export function useLibraryMountsQuery(enabled = true): UseQueryResult<LibraryMount[]> {
  const api = useLibraryApi()
  return useQuery<LibraryMount[]>({
    queryKey: libMountsQk,
    queryFn: () => api.mounts(),
    enabled,
    staleTime: 15_000
  })
}

export interface MountMutations {
  add(absPath: string, label: string, mode: LibraryMountMode): Promise<LibraryMount>
  patch(mountId: number, patch: { label?: string; mode?: LibraryMountMode }): Promise<LibraryMount>
  /** 卸载：挂载行标 `unmounted`、其下文件行标 `missing`，**不删行、不动磁盘**（§8.2 F5）。 */
  remove(mountId: number): Promise<LibraryMount>
  busy: boolean
}

export function useMountMutations(): MountMutations {
  const api = useLibraryApi()
  const qc = useQueryClient()
  // 挂载增删改会同时改树（多一根 / 少一根 / 只读锁）、文件夹列表（文件行状态）与挂载列表，
  // 逐个失效不如整域一刀 —— 这不是热路径。
  const invalidateAll = useCallback(
    () => qc.invalidateQueries({ queryKey: ['library'] }).then(() => undefined),
    [qc]
  )

  const add = useMutation({
    mutationFn: (v: { absPath: string; label: string; mode: LibraryMountMode }) =>
      api.addMount(v.absPath, v.label, v.mode),
    onSuccess: invalidateAll
  })
  const patch = useMutation({
    mutationFn: (v: { mountId: number; patch: { label?: string; mode?: LibraryMountMode } }) =>
      api.patchMount(v.mountId, v.patch),
    onSuccess: invalidateAll
  })
  const remove = useMutation({
    mutationFn: (mountId: number) => api.removeMount(mountId),
    onSuccess: invalidateAll
  })

  return useMemo(
    () => ({
      add: (absPath, label, mode) => add.mutateAsync({ absPath, label, mode }),
      patch: (mountId, body) => patch.mutateAsync({ mountId, patch: body }),
      remove: (mountId) => remove.mutateAsync(mountId),
      busy: add.isPending || patch.isPending || remove.isPending
    }),
    [add, patch, remove]
  )
}

/**
 * 系统目录选择器 —— 复用既有的 `settings:pickFolder`（`dialog.showOpenDialog` +
 * `properties: ['openDirectory']`），不为资料库另开一个 IPC 键：同一个系统对话框开两条通道，
 * 以后改一处就漏一处。取消返回 `null`。
 */
export function usePickMountFolder(): (title: string) => Promise<string | null> {
  const api = useMailApi()
  return useCallback((title: string) => api.settings.pickFolder(title), [api])
}
