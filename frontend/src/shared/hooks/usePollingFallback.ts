// Sprint 16 — fallback polling interval helper.
//
// 旧版 EmailList / Sidebar / usePinnedSync 各自硬编码 refetchInterval (5s/60s/10s);
// 新版改成 SSE 主推送, polling 只在 SSE 断线时兜底. 这个 hook 返回当前应使用的
// refetchInterval (ms) 或 false (停).
//
// 决策矩阵 (sseState × pollIntervalSec):
//   connected     → false (SSE 在工作, 不轮询)
//   idle          → useFallback (启动早期; 给个兜底)
//   connecting    → useFallback
//   reconnecting  → useFallback
//   disconnected  → useFallback
//   disabled      → useFallback (用户/env 把 SSE 关了, 必须轮询才有更新)
//
// useFallback 逻辑:
//   pollIntervalSec === 0  → false (用户禁用 fallback, 完全静默)
//   pollIntervalSec === 5  → 5000
//   pollIntervalSec === 10 → 10000
//   pollIntervalSec === 30 → 30000
//   pollIntervalSec === 60 → 60000 (默认; 实际类型上是 5|10|30|0 但 settings 接口
//                                   保留 60 的扩展空间; 缺省值取 60)

import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'

import { useMailApi } from './useMailApi'
import { useEventsStatusStore } from '@shared/state/eventsStatus'
import type { PersistentSettings } from '@shared/api/types'

/** 默认 fallback 周期 (ms). settings 未加载完时用. */
const DEFAULT_FALLBACK_MS = 60_000

export interface PollingFallbackOptions {
  /** perf-sse-realtime R3 — SSE connected 时不归零而改用这个**长间隔**保险轮询 (ms)。
   *
   *  背景: 总线显式 lossy (inprocess_bus 队列满即丢 / 重连无 catch-up), connected
   *  即关一切轮询 ⇒ 丢一条 email.synced 该数据面就永久卡死。缺省 undefined = 保持
   *  原语义 (connected → false), **仅邮件主列表启用** —— 其他调用点行为不变。 */
  connectedIntervalMs?: number
}

export function usePollingFallback(options?: PollingFallbackOptions): number | false {
  const mailApi = useMailApi()
  const sseState = useEventsStatusStore((s) => s.status.state)

  const { data: settings } = useQuery<PersistentSettings>({
    queryKey: qk.settings.all(),
    queryFn: () => mailApi.settings.get(),
    staleTime: 5 * 60_000 // settings 不常变, 5 分钟够
  })

  const interval = settings?.pollIntervalSec
  // 用户显式 disabled — 完全静默, 保险轮询也尊重这个开关。
  if (interval === 0) return false

  if (sseState === 'connected') return options?.connectedIntervalMs ?? false

  // 未加载完 或 fallback 给个默认值
  const sec = typeof interval === 'number' && interval > 0 ? interval : DEFAULT_FALLBACK_MS / 1000
  return sec * 1000
}
