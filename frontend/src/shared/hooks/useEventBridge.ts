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
  eventInternalIds,
  isMainListKey,
  isEmailSupplementKey,
  isThreadMembersKey,
  queryDataHoldsAnyId,
  collectMainListIds
} from '@shared/lib/emailInvalidation'
import type { SseEvent } from '@shared/api/types'
import {
  globalAttentionKey,
  isMatterAttentionDetailKey,
  matterChangedPublicId
} from '@shared/components/matters/hooks'
import { refreshMatter } from '@shared/components/matters/matterMutation'

const DEBOUNCE_MS = 200

// Debounce keys for the two predicate-based invalidations. Exact-key
// directives debounce under their own JSON.stringify(key).
const MAIN_LIST_DEBOUNCE_KEY = 'emails:main-list'
const SUPPLEMENTS_DEBOUNCE_KEY = 'emails:supplements'
const THREAD_MEMBERS_DEBOUNCE_KEY = 'email:thread-members'

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

    // thread-members 门控: 与 supplement 同款 id-containment, 但 **不做主列表覆盖
    // 抑制** —— thread sidebar / bundle 的 ['email','thread',id] 缓存是独立视图,
    // 不与主列表合并, 主列表 refetch 不会更新它, 故任何持有该 id 的线程缓存都要刷。
    const threadMemberIds = new Set<number>()

    function flushThreadMembers(): void {
      const ids = new Set(threadMemberIds)
      threadMemberIds.clear()
      if (ids.size === 0) return
      void queryClient.invalidateQueries({
        predicate: (q) => isThreadMembersKey(q.queryKey) && queryDataHoldsAnyId(q.state.data, ids)
      })
    }

    // ---- directive executor ----
    // ids = 本事件涉及的全部 internal_id (单封事件 1 个; issue #58 的入向已读回收批量
    // 事件 internal_id=null、id 在 data.internal_ids, 一轮一条不刷屏)。containment 门控
    // 按整批累积, 否则批量事件只刷列表/徽标, 打开中的详情 toolbar 仍显示未读。
    function runDirective(
      directive: ReturnType<typeof planInvalidation>[number],
      ids: readonly number[]
    ): void {
      switch (directive.kind) {
        case 'main-list':
          debounceInvalidate(MAIN_LIST_DEBOUNCE_KEY, () =>
            queryClient.invalidateQueries({ predicate: (q) => isMainListKey(q.queryKey) })
          )
          break
        case 'supplements':
          for (const id of ids) supplementIds.add(id)
          debounceInvalidate(SUPPLEMENTS_DEBOUNCE_KEY, flushSupplements)
          break
        case 'thread-members':
          for (const id of ids) threadMemberIds.add(id)
          debounceInvalidate(THREAD_MEMBERS_DEBOUNCE_KEY, flushThreadMembers)
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
      // Matters P5 — matter.attention 走这里而**不是** planInvalidation：那个 switch 的
      // directive 词表（main-list / supplements / thread-members）全是邮件域概念，matter
      // 缓存一个都用不上。加分支的人注意：SSE 事件在本文件有两个分发点，matter 域在此、
      // 邮件域在 emailInvalidation.ts（后者 default 分支会静默丢弃未注册类型）。
      if (ev.event_type === 'matter.attention') {
        debounceInvalidate('matters:global-attention', () =>
          queryClient.invalidateQueries({ queryKey: globalAttentionKey() })
        )
        // 🔴 事件**带** matter_ids（`worker.py` 的 `safe_publish("matter.attention", …)`），这里
        // 仍做按形状的全量失效，是因为**两侧 id space 不同**：payload 里是内部数字主键
        // `matter.id`，而这些缓存键用的是 `publicId` 字符串（`MAT-0001`）。要定向失效，得让
        // 后端改发 public_id 或前端维护 id→publicId 映射 —— 那是契约改动，不是这里能就地决定的。
        // 在那之前，全量失效是唯一不会漏刷的选择（漏刷 = 信号角标停在旧值）。
        debounceInvalidate('matters:detail-attention', () =>
          queryClient.invalidateQueries({
            predicate: (query) => isMatterAttentionDetailKey(query.queryKey)
          })
        )
        return
      }
      // S1 — 事项本体的变更（owner 在 UI 里改的 / agent 工具改的 / 跟进 run 落的提案）。
      // 后端在**事务提交后**发, 且 payload 只带 public_id —— 与 `matter.attention` 不同,
      // 这里能定向失效, 不必按形状全量刷 (那条的 payload 是内部数字 id, 对不上缓存键)。
      // 失效清单复用 `refreshMatter`: SSE 路径与用户点击路径共用同一份, 不会漂开。
      if (ev.event_type === 'matter.changed') {
        const publicId = matterChangedPublicId(ev.data)
        if (!publicId) return
        // 按事项分桶 debounce: 一轮 agent run 会连发十几条 (每条 matter_event 一次),
        // 同一事项只刷一次; 不同事项互不压制。
        debounceInvalidate(`matters:changed:${publicId}`, () => {
          void refreshMatter(queryClient, publicId)
        })
        return
      }
      const directives = planInvalidation(ev.event_type, ev.internal_id, ev.data)
      const ids = eventInternalIds(ev.internal_id, ev.data)
      for (const directive of directives) runDirective(directive, ids)
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
