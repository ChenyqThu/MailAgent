// task 09-03 —— 一个会话的排队行（`chat_queued_input`）的读侧单源。
//
// 为什么要把它从 QueuedInputBar 里抽出来：面板判断「这个会话上有没有一轮在跑」原本只有 `/run/active`
// 探针一条路，而那条探针在 `active===false` 之后**停止轮询**（refetchInterval 返回 false），只有
// `chat:turn-persisted` 广播 / 窗口聚焦 / 重挂载能把它叫醒。派发一轮排队追问的时序恰好是：上一轮
// persist 广播 → 面板重探（此刻新 run 还没 register）→ 探到 active:false 并就此闩死 → 2~8 秒后
// dispatcher 的 run 才真的 register。于是整轮派发期间面板既不显示「AI 在后台干活」，`queueModeActive`
// 也是假的 —— 用户这时按下的 Enter 会走**直发**，撞上会话租约的 409 E_RUN_ACTIVE 被丢掉。
//
// 修法不靠加轮询：dispatcher claim 一行的那一刻就是「这一轮开始了」，而 claim 会立刻广播
// `chat:queued-input-changed`。所以 `status==='claimed'` 本身就是事件驱动、毫秒级到达的在跑事实，
// 面板直接读它即可。claimed 是有界的：派发失败会 revert 回 queued，进程被杀则下次启动
// restoreAllStale() 收尾。

import { useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { QueuedInput } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'

/** 进程内「这个会话的队列被带外改动了」信号。
 *
 *  存在的理由只有一个：改动方拿不到 QueryClient。transport 的 fetch 包装（撞 409 转投队列那条，
 *  见 useMailAgentAiSdkRuntime）住在 runtime provider 外面，而且它所在的组件树在不少场景下压根
 *  没有 QueryClientProvider —— 在那里调 `useQueryClient()` 会**直接抛**（实测打挂 20 条既有用例）。
 *  所以由改动方发信号、由本 hook（读侧唯一入口，天然在 QueryClientProvider 里）来失效。
 *
 *  Electron 另有 `chat:queued-input-changed` 广播走同一条失效路径；这个信号是 web（无 IPC）那侧
 *  的等价物，两边因此表现一致。 */
type QueuedInputListener = () => void
const queuedInputListeners = new Map<number, Set<QueuedInputListener>>()

export function notifyQueuedInputChanged(sessionId: number): void {
  for (const listener of queuedInputListeners.get(sessionId) ?? []) listener()
}

function subscribeQueuedInputChanged(sessionId: number, listener: QueuedInputListener): () => void {
  const set = queuedInputListeners.get(sessionId) ?? new Set<QueuedInputListener>()
  set.add(listener)
  queuedInputListeners.set(sessionId, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) queuedInputListeners.delete(sessionId)
  }
}

export interface QueuedInputRowsState {
  rows: QueuedInput[]
  /** 有行已被 dispatcher claim → 这个会话上有一轮派发 run 正在起（或已经在跑）。 */
  dispatchInFlight: boolean
  /** 最早那条 claimed 行的 claim 时刻（claim 会写 updated_at）= 这一轮的起点；没有则 null。 */
  dispatchStartedAt: number | null
}

export function useQueuedInputRows(opts: {
  enabled: boolean
  gatewayBaseUrl: string | null
  sessionId: number | null
}): QueuedInputRowsState {
  const { enabled, gatewayBaseUrl, sessionId } = opts
  const mailApi = useMailApi()
  const queryClient = useQueryClient()
  const queryKey = useMemo(() => qk.chat.queuedInput(sessionId), [sessionId])
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const response = await fetch(
        `${gatewayBaseUrl}/api/ai/queued-input?sessionId=${encodeURIComponent(String(sessionId))}`,
        { credentials: 'include' }
      )
      if (!response.ok) throw new Error('queued input fetch failed')
      const body = (await response.json()) as { items?: QueuedInput[] }
      return body.items ?? []
    },
    enabled: enabled && gatewayBaseUrl != null && sessionId != null,
    retry: false
  })

  useEffect(() => {
    if (!enabled || sessionId == null) return undefined
    const invalidate = (payload: { sessionId: number }): void => {
      if (payload.sessionId === sessionId) void queryClient.invalidateQueries({ queryKey })
    }
    const disposeQueued = mailApi.chat.onQueuedInputChanged?.(invalidate)
    const disposeTurn = mailApi.chat.onTurnPersisted?.((payload) => invalidate(payload))
    const disposeLocal = subscribeQueuedInputChanged(sessionId, () => invalidate({ sessionId }))
    return () => {
      disposeQueued?.()
      disposeTurn?.()
      disposeLocal()
    }
  }, [enabled, mailApi, queryClient, queryKey, sessionId])

  const rows = query.data ?? []
  const claimedAt = rows.reduce<number | null>(
    (earliest, row) =>
      row.status !== 'claimed'
        ? earliest
        : earliest === null || row.updatedAt < earliest
          ? row.updatedAt
          : earliest,
    null
  )
  return { rows, dispatchInFlight: claimedAt !== null, dispatchStartedAt: claimedAt }
}
