import { useCallback, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'

import { createMattersApi, createMatterChatApi } from '@shared/api/matters'
import type { MatterChatApi } from '@shared/api/matters'
import type { ReportAgentConfig } from '@shared/api/types'
import type {
  MatterAttentionListResponse,
  MatterAttentionSignal,
  MattersApi,
  MatterListResponse,
  MatterMutationOptions,
  MatterNotifyLevel,
  MatterNotifyLevelResponse,
  MatterPendingUpdatesResponse,
  MatterRunListResponse,
  MatterRunStartResult,
  MatterUpdate
} from '@shared/api/types/matter'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { useAppConfig } from '@shared/hooks/useAppConfig'
import type { AppConfigFlags } from '@shared/hooks/useAppConfig'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { useEventsStatusStore } from '@shared/state/eventsStatus'

import { useMatterMutation } from './matterMutation'

export function useMattersApi(): MattersApi {
  return useMemo(() => createMattersApi(resolveApiBaseUrl()), [])
}

/** 工作台「活跃行」主列表的 options 单源 —— MattersWorkspace 的 liveList 与
 *  启动预热 (lib/startupPrefetch T2) 共用: key / queryFn / 缓存配方一体, 预热写进
 *  缓存的必然被页面首挂命中 (防「key 漂移预热了个寂寞」)。
 *  缓存配方同 useEmailListRows (速赢包 §2): staleTime 5min + gcTime 15min, 写侧由
 *  refreshMatter / `matter.changed` SSE 精准失效, 所以可以放长。 */
export function matterLiveListOptions(api: MattersApi): {
  queryKey: ReturnType<typeof qk.matters.list>
  queryFn: () => Promise<MatterListResponse>
  staleTime: number
  gcTime: number
} {
  return {
    queryKey: qk.matters.list(),
    queryFn: () => api.list({ limit: 100 }),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  }
}

/** P3 — the Matter Chat surface's own serve-api face (context snapshot / scope audit / undo).
 *  Separate from `useMattersApi` for the same reason the factories are separate (api/matters.ts). */
export function useMatterChatApi(): MatterChatApi {
  return useMemo(() => createMatterChatApi(resolveApiBaseUrl()), [])
}

/** 模块级 = 引用稳定（select 每次换新函数会让 react-query 每次重算投影）。 */
const selectMatterFlags = (
  flags: AppConfigFlags
): { mattersEnabled: boolean; matterAgentEnabled: boolean } => ({
  mattersEnabled: flags.mattersEnabled,
  matterAgentEnabled: flags.matterAgentEnabled
})

/** 事项总闸 + 事项 Agent 闸。数据源是与通讯录**共享**的那一次 `/chat/config`
 *  （`useAppConfig`：单 key 单请求；失败即 error 而不是缓存成「已禁用」）。
 *
 *  🔴 `flagsPending` 区分的是「还不知道开没开」与「确定关着」—— 两者的 `mattersEnabled`
 *  都是 false，但前者该出骨架、后者该渲染 null（task 08-20 P0-3：整页 `return null` 的白屏）。
 *  取 `isPending` 而不是 `!isSuccess`：请求进 error 态时按「关着」处理，否则永远停在骨架。 */
export function useMatterFlags(): {
  mattersEnabled: boolean
  matterAgentEnabled: boolean
  flagsPending: boolean
} {
  const query = useAppConfig(selectMatterFlags)
  return {
    ...(query.data ?? { mattersEnabled: false, matterAgentEnabled: false }),
    flagsPending: query.isPending
  }
}

export function useMattersEnabled(): boolean {
  return useMatterFlags().mattersEnabled
}

/** 事项 runs 列表缓存键。导出给 useEventBridge：`matter.run.changed` SSE（payload 带
 *  public_id）到达时定向失效, 让 30s 兜底轮询之外的实时刷新走事件。 */
export const matterRunsKey = (matterId: string) => [...qk.matters.detail(matterId), 'runs'] as const
export const globalAttentionKey = () => [...qk.matters.all(), 'attention', 'open'] as const
export const matterAttentionKey = (matterId: string) =>
  [...qk.matters.detail(matterId), 'attention', 'open'] as const
export const notifyLevelKey = () => [...qk.matters.config(), 'notify-level'] as const

/** 匹配任意 matter 的 detail attention 缓存（matterId 未知时按形状判）。`matter.attention`
 *  SSE 到达时要失效**所有**已打开事项的信号缓存 —— 事件其实带 `matter_ids`，但那是内部数字
 *  主键、而这些键用 `publicId` 字符串，对不上（详见 useEventBridge 该分支的注释）。判定放在
 *  key 工厂旁边，别让消费方手抄 `['matters','detail',id,'attention',…]` 的下标。 */
export function isMatterAttentionDetailKey(key: readonly unknown[]): boolean {
  const probe = matterAttentionKey('*')
  return (
    key.length >= probe.length && key[0] === probe[0] && key[1] === probe[1] && key[3] === probe[3]
  )
}

/** `matter.changed` SSE 的 payload 判定（S1）——「这条事件该刷哪个事项」。
 *
 *  与 `isMatterAttentionDetailKey` 同款：判定放在 key 工厂旁边、纯函数可直测，
 *  别让 `useEventBridge` 手写一段内联的 typeof 判断。
 *
 *  🔴 拿不到合法 public_id 一律返 null（调用方直接 return，不做任何失效）——
 *  这条总线是 lossy 的，宁可漏刷一次，也不能因为一条畸形事件去全量刷缓存
 *  （`matter.attention` 正是因为 payload 用了对不上的内部数字 id，才被迫退化成按形状全量失效）。
 */
export function matterChangedPublicId(data: unknown): string | null {
  if (data == null || typeof data !== 'object') return null
  const value = (data as { public_id?: unknown }).public_id
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `matter.attention` payload 的 public_ids（perf-sse-realtime：worker 起增发
 *  `public_ids`, 让消费端从「按形状全量失效」升级成定向失效）。
 *
 *  返 null = 拿不到可用的 public_ids（老格式 / 后端映射失败发了空数组 / 畸形）——
 *  调用方**必须**回落全量失效：这条事件的语义是「有信号变了」, 漏刷 = 角标停在旧值,
 *  与 `matterChangedPublicId` 的「宁可漏刷」相反（那条有 refreshMatter 精确清单兜底）。 */
export function matterAttentionPublicIds(data: unknown): string[] | null {
  if (data == null || typeof data !== 'object') return null
  const raw = (data as { public_ids?: unknown }).public_ids
  if (!Array.isArray(raw)) return null
  const ids = raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return ids.length > 0 ? ids : null
}

export function useMatterRuns(
  matterId: string,
  enabled = true
): UseQueryResult<MatterRunListResponse> {
  const api = useMattersApi()
  // perf-sse-realtime R1-5: SSE 在场时实时性靠 `matter.run.changed`（useEventBridge
  // 定向失效 matterRunsKey），活跃 run 的轮询降为 30s 兜底（lossy 总线丢一条也会
  // 在一个兜底周期内自愈）；SSE 不在（web 无桥 / 断线）保持原 2s。
  const sseConnected = useEventsStatusStore((s) => s.status.state === 'connected')
  return useQuery({
    queryKey: matterRunsKey(matterId),
    queryFn: () => api.listRuns(matterId),
    enabled,
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (run) => run.lifecycle_state === 'queued' || run.lifecycle_state === 'running'
      )
        ? sseConnected
          ? 30_000
          : 2000
        : false
  })
}

/** 待审提案的**唯一**取数口：一个请求覆盖全部活跃事项（`GET /api/matters/updates`）。
 *
 *  🔴 工作台与详情页共用同一个 key ⇒ react-query 只发一次请求。这正是本批要消掉的东西：
 *  原来工作台按事项扇出 `listUpdates` + 按提案扇出 `getUpdate`（N + P 个请求），详情页
 *  另发一次自己的 `listUpdates` —— 一次进入就能把 6 个 loopback 连接槽占满。
 *  🔴 参数（key / staleTime / gcTime）只在这里写一份：两处各写一份 = 两个观察者的新鲜度
 *  判据不一致，「谁先挂载谁说了算」的抖动。 */
function pendingUpdatesOptions(api: MattersApi): {
  queryKey: readonly unknown[]
  queryFn: () => Promise<MatterPendingUpdatesResponse>
  staleTime: number
  gcTime: number
} {
  return {
    queryKey: qk.matters.pendingUpdates(),
    queryFn: () => api.listPendingUpdates(),
    // 提案的实时性靠写侧 refreshMatter / `matter.changed` SSE 精准失效（见 matterMutation.ts），
    // 不靠短 staleTime —— 后者只会让「切走再切回」每次重拉。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  }
}

export function usePendingMatterUpdates(
  enabled = true
): UseQueryResult<MatterPendingUpdatesResponse> {
  const api = useMattersApi()
  return useQuery({ ...pendingUpdatesOptions(api), enabled })
}

const NO_UPDATES: MatterUpdate[] = []

/** 上面那份聚合缓存的**单事项切片**（详情页用）。不是第二个请求：同 key ⇒ 同一份数据，
 *  select 只在客户端切一刀。 */
export function useMatterPendingUpdates(
  matterId: string,
  enabled = true
): UseQueryResult<MatterUpdate[]> {
  const api = useMattersApi()
  const select = useCallback(
    (data: MatterPendingUpdatesResponse): MatterUpdate[] =>
      data.items.find((entry) => entry.matter_public_id === matterId)?.updates ?? NO_UPDATES,
    [matterId]
  )
  return useQuery({ ...pendingUpdatesOptions(api), enabled, select })
}

export function useGlobalAttention(enabled = true): UseQueryResult<MatterAttentionListResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: globalAttentionKey(),
    queryFn: () => api.listAttention('open'),
    enabled,
    // 缓存配方同 useEmailListRows（速赢包 §2）。(Sidebar 已提升为 RootLayout 单例
    // —— task 08-20-perf-shell-prefetch-sidebar §② —— 路由切换不再 remount, 长
    // staleTime 的收益从「防切页重拉」变成纯兜底。) 信号的实时性靠
    // `matter.attention` SSE 精准失效（useEventBridge），不靠短 staleTime。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
}

export function useMatterAttention(
  matterId: string,
  enabled = true
): UseQueryResult<MatterAttentionListResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: matterAttentionKey(matterId),
    queryFn: () => api.listMatterAttention(matterId, 'open'),
    enabled,
    // 同上（SSE 失效 + 事项写入连带 detail 前缀失效，缓存可以放长）。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
}

export type AttentionAction = 'resolved' | 'snoozed' | 'dismissed'
export interface AttentionActionInput {
  matterId: string
  signalId: number
  action: AttentionAction
}

function removeSignal(
  data: MatterAttentionListResponse | undefined,
  signalId: number
): MatterAttentionListResponse | undefined {
  return data ? { ...data, items: data.items.filter((signal) => signal.id !== signalId) } : data
}

export function useAttentionAction(): UseMutationResult<
  MatterAttentionSignal,
  Error,
  AttentionActionInput,
  { global?: MatterAttentionListResponse; detail?: MatterAttentionListResponse }
> {
  const api = useMattersApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ matterId, signalId, action }) =>
      action === 'resolved'
        ? api.resolveAttention(matterId, signalId)
        : action === 'snoozed'
          ? api.snoozeAttention(matterId, signalId, { preset: '3d' })
          : api.dismissAttention(matterId, signalId),
    onMutate: async ({ matterId, signalId }) => {
      await Promise.all([
        client.cancelQueries({ queryKey: globalAttentionKey() }),
        client.cancelQueries({ queryKey: matterAttentionKey(matterId) })
      ])
      const global = client.getQueryData<MatterAttentionListResponse>(globalAttentionKey())
      const detail = client.getQueryData<MatterAttentionListResponse>(matterAttentionKey(matterId))
      client.setQueryData(globalAttentionKey(), removeSignal(global, signalId))
      client.setQueryData(matterAttentionKey(matterId), removeSignal(detail, signalId))
      return { global, detail }
    },
    onError: (_error, variables, context) => {
      if (context?.global) client.setQueryData(globalAttentionKey(), context.global)
      if (context?.detail)
        client.setQueryData(matterAttentionKey(variables.matterId), context.detail)
    },
    onSettled: (_data, _error, variables) =>
      Promise.all([
        client.invalidateQueries({ queryKey: globalAttentionKey() }),
        client.invalidateQueries({ queryKey: matterAttentionKey(variables.matterId) })
      ]).then(() => undefined)
  })
}

export function useNotifyLevel(enabled = true): UseQueryResult<MatterNotifyLevelResponse> {
  const api = useMattersApi()
  return useQuery({
    queryKey: notifyLevelKey(),
    queryFn: () => api.getNotifyLevel(),
    enabled,
    // 写侧 useSetNotifyLevel 直接 setQueryData 回写 → 读侧缓存可以放长。
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000
  })
}

export function useSetNotifyLevel(): UseMutationResult<
  MatterNotifyLevelResponse,
  Error,
  MatterNotifyLevel
> {
  const api = useMattersApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (level) => api.setNotifyLevel(level),
    onSuccess: (data) => client.setQueryData(notifyLevelKey(), data)
  })
}

/** 🔴 带 `expectedVersion` 的写 ⇒ 必须走 `useMatterMutation`（它把「冲突后重新拉取」焊死在
 *  包装里）。这里的 version 藏在调用方传进来的 options 里，肉眼扫文件看不见 —— 所以
 *  `matterMutationGate.test.ts` 对本函数单列了一条断言。 */
export function useStartMatterRun(
  matterId: string
): UseMutationResult<MatterRunStartResult, Error, MatterMutationOptions> {
  const api = useMattersApi()
  const client = useQueryClient()
  return useMatterMutation({
    matterId,
    mutationFn: (options: MatterMutationOptions) => api.startRun(matterId, options),
    onSuccess: () => client.invalidateQueries({ queryKey: matterRunsKey(matterId) })
  })
}

export function useMatterAgentProfiles(enabled = true): UseQueryResult<ReportAgentConfig[]> {
  const mailApi = useMailApi()
  return useQuery({
    queryKey: [...qk.matters.config(), 'agent-profiles'],
    queryFn: async () =>
      (await mailApi.report.getConfig()).filter((profile) => profile.type === 'custom'),
    enabled
  })
}
