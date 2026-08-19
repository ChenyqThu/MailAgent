// per-folder 配置 (v62, `folder_pref`) 的读侧 —— 设置页与侧边栏文件夹树共用同一份缓存。
//
// 端点纯本地 SQLite 读写，**不** davmail-gated；失败静默（图标退回兜底、两个开关按缺省
// 显示），因为它只影响观感与两个 gate 的旁路配置，不影响列表本身能不能用。
//
// 🔴 这里**没有顺序**。显示顺序的权威是 `SYNC_FOLDERS` 数组序（`getWhitelist()` 的
// 数组序），消费方式恒为：按 whitelist 的顺序遍历，用 imap_name 到本 map 里取配置。

import * as React from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import type { FolderPref, FolderPrefsResult } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

export function useFolderPrefsQuery(enabled = true): UseQueryResult<FolderPrefsResult> {
  const mailApi = useMailApi()
  return useQuery({
    queryKey: qk.folder.prefs(),
    queryFn: () => mailApi.folder.getPrefs(),
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    retry: false
  })
}

/* ── 一行配置的 UI 视角（= `folder_pref` 的一行，`ai` 已翻成 UI 极性）─────────── */

export interface FolderPrefValue {
  /** lucide kebab 名；null = 没设过 → 兜底 folder 图标。 */
  icon: string | null
  /** 新邮件推不推飞书（= 落库 `notify_enabled`，**同向**，白名单语义）。 */
  notify: boolean
  /** 跑不跑 LLM 分类（= 落库 `llm_disabled` 的**反面**，黑名单语义）。 */
  ai: boolean
}

/** 白名单里取不到 `folder_pref` 行的文件夹用这套 —— 与后端两个 gate 的缺省逐字对齐：
 *  `FOLDER_NOTIFY_ENABLED` 是白名单（缺省不推）、`FOLDER_LLM_DISABLED` 是黑名单（缺省跑）。 */
export const FOLDER_PREF_DEFAULTS: FolderPrefValue = { icon: null, notify: false, ai: true }

/** 落库行 → UI 视角。🔴 **极性翻转只在这一处发生**，别在组件里再翻一次。 */
export function folderPrefValue(row: FolderPref | undefined): FolderPrefValue {
  if (!row) return FOLDER_PREF_DEFAULTS
  return { icon: row.icon, notify: row.notify_enabled, ai: !row.llm_disabled }
}

/** imap_name → 该文件夹的 `folder_pref` 行。
 *  🔴 **只有设过配置的文件夹才有行** —— 取不到 = 全默认（兜底图标 / 不推飞书 / 跑 LLM），
 *  不是错误，调用方不要按「缺行」当异常处理。 */
export function useFolderPrefMap(enabled = true): ReadonlyMap<string, FolderPref> {
  const { data } = useFolderPrefsQuery(enabled)
  return React.useMemo(() => new Map((data?.prefs ?? []).map((p) => [p.imap_name, p])), [data])
}
