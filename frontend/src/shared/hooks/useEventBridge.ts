// Sprint 16 — mount-once SSE event router.
//
// 挂在 App 根 (QueryClientProvider 内部)。订阅 main 进程的 SSE 事件流, 路由到
// React Query invalidate 调用。同 query key 的 invalidate 200ms debounce, 避免
// 高频 burst (大批量 outbox 派发) 打爆 refetch。
//
// 分层失效 (fe-review P1-2): 邮件级写事件不再宽 invalidate 整个 ['emails'] 前缀
// (会一次 refetch 主列表 + cross + pinned-supplement + thread-batch +
// thread-enriched 五个活跃族)。改由 planInvalidation 规划 directive:
//   • 主列表族恒 refetch (predicate isMainListKey) —— 承接新邮件到达 + 可见行状态
//   • 四个 supplement 族仅当其缓存持有「主列表未覆盖」的变更 id 才 refetch
//     (EmailList 的合并视图里主列表行优先级高于所有 supplement, 故主列表已含的 id
//      不必再动 supplement); 判定 = isEmailSupplementKey + queryDataHoldsAnyId,
//     id 跨 debounce 窗口累积, flush 时用主列表缓存 (collectMainListIds) 扣除。
// EmailRow.optimisticPatch 的 ['emails'] 前缀写 cache 语义不受影响 (与 refetch
// 扇出解耦)。路由决策全在纯模块 emailInvalidation.ts, 单测在
// tests/shared/emailInvalidation.test.ts。
//
// 同时通过 mailApi.events.onStatus 把 SSE 连接状态写入 zustand `useEventsStatus`
// store, 让 SettingsPage / usePollingFallback 等读到。

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useMailApi } from './useMailApi'
import { useEventsStatusStore } from '@shared/state/eventsStatus'
import {
  planInvalidation,
  isMainListKey,
  isEmailSupplementKey,
  queryDataHoldsAnyId,
  collectMainListIds
} from '@shared/lib/emailInvalidation'
import type { SseEvent } from '@shared/api/types'

const DEBOUNCE_MS = 200

// Debounce keys for the two predicate-based invalidations. Exact-key
// directives debounce under their own JSON.stringify(key).
const MAIN_LIST_DEBOUNCE_KEY = 'emails:main-list'
const SUPPLEMENTS_DEBOUNCE_KEY = 'emails:supplements'

/**
 * 单挂载 hook。组件 mount 时启动 SSE event 订阅 + status 同步,
 * unmount 时清理 (App 根永远 mount, 实际上只清理 HMR).
 */
export function useEventBridge(): void {
  const queryClient = useQueryClient()
  const mailApi = useMailApi()
  const setStatus = useEventsStatusStore((s) => s.setStatus)

  useEffect(() => {
    // ---- 拉初始 status (handler 注册前) ----
    void mailApi.events
      .status()
      .then(setStatus)
      .catch(() => {
        // events api 不可用 (Web build / 早期启动) — 不阻塞 UI
        setStatus({
          state: 'disabled',
          lastError: null,
          lastEventTs: null,
          url: ''
        })
      })

    // ---- per-key debounce store ----
    const pending: Record<string, ReturnType<typeof setTimeout>> = {}
    function debounceInvalidate(keyJson: string, fn: () => void): void {
      if (pending[keyJson]) clearTimeout(pending[keyJson])
      pending[keyJson] = setTimeout(() => {
        delete pending[keyJson]
        void fn()
      }, DEBOUNCE_MS)
    }

    // supplement 族的 refetch 用 containment 门控 —— 把 debounce 窗口内所有变更
    // 的 internal_id 累积起来, 一次 flush 只对「缓存持有主列表未覆盖 id」的
    // supplement 查询 refetch。id 集合在 flush 时快照 + 清空。
    const supplementIds = new Set<number>()

    function flushSupplements(): void {
      const ids = new Set(supplementIds)
      supplementIds.clear()
      if (ids.size === 0) return
      // 主列表 refetch 已覆盖它当前持有的 id (合并视图主列表行优先), 这些 id 不必
      // 再动 supplement。只对主列表未覆盖的 id (老 pinned / 窗口外线程成员) 检查
      // supplement 缓存持有关系。
      // ⚠️ coverage 只能用 **active** 主列表: type:'active' 过滤掉切过 view / 用过
      // 更大 fetchLimit 后残留 (未 GC) 的 inactive 历史 cache —— 它不代表当前显示,
      // 若含某 id 会误判 "已覆盖" 而漏刷 active supplement (违反 optimisticPatch 收敛)。
      const mainListEntries = queryClient
        .getQueriesData<unknown>({ predicate: (q) => isMainListKey(q.queryKey), type: 'active' })
        .map(([queryKey, data]) => ({ queryKey, data }))
      const mainListIds = collectMainListIds(mainListEntries)
      const uncovered = new Set([...ids].filter((id) => !mainListIds.has(id)))
      if (uncovered.size === 0) return
      void queryClient.invalidateQueries({
        predicate: (q) =>
          isEmailSupplementKey(q.queryKey) && queryDataHoldsAnyId(q.state.data, uncovered)
      })
    }

    // ---- directive executor ----
    function runDirective(
      directive: ReturnType<typeof planInvalidation>[number],
      internalId: number | null
    ): void {
      switch (directive.kind) {
        case 'main-list':
          debounceInvalidate(MAIN_LIST_DEBOUNCE_KEY, () =>
            queryClient.invalidateQueries({ predicate: (q) => isMainListKey(q.queryKey) })
          )
          break
        case 'supplements':
          if (internalId != null) supplementIds.add(internalId)
          debounceInvalidate(SUPPLEMENTS_DEBOUNCE_KEY, flushSupplements)
          break
        case 'key': {
          const key = directive.key
          debounceInvalidate(JSON.stringify(key), () =>
            queryClient.invalidateQueries({ queryKey: key })
          )
          break
        }
      }
    }

    // ---- event → invalidate router ----
    function handleEvent(ev: SseEvent): void {
      const directives = planInvalidation(ev.event_type, ev.internal_id)
      for (const directive of directives) runDirective(directive, ev.internal_id)
    }

    const unsubEvent = mailApi.events.onEvent(handleEvent)
    const unsubStatus = mailApi.events.onStatus(setStatus)

    return () => {
      unsubEvent()
      unsubStatus()
      for (const t of Object.values(pending)) clearTimeout(t)
    }
  }, [mailApi, queryClient, setStatus])
}
