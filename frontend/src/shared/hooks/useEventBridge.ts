// Sprint 16 — mount-once SSE event router.
//
// 挂在 App 根 (QueryClientProvider 内部)。订阅 main 进程的 SSE 事件流, 路由到
// React Query invalidate 调用。同 query key 的 invalidate 200ms debounce, 避免
// 高频 burst (大批量 outbox 派发) 打爆 refetch。
//
// 同时通过 mailApi.events.onStatus 把 SSE 连接状态写入 zustand `useEventsStatus`
// store, 让 SettingsPage / usePollingFallback 等读到。

import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { useMailApi } from './useMailApi'
import { useEventsStatusStore } from '@shared/state/eventsStatus'
import type { SseEvent } from '@shared/api/types'

const DEBOUNCE_MS = 200

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

    // ---- event → invalidate router ----
    function handleEvent(ev: SseEvent): void {
      const id = ev.internal_id
      const t = ev.event_type
      // 任意邮件级写事件 → 列表 / 单封 / mailbox 计数 都可能变
      if (
        t === 'email.synced' ||
        t === 'email.flag_changed' ||
        t === 'email.failed' ||
        t === 'email.dead_letter'
      ) {
        debounceInvalidate('["emails"]', () =>
          queryClient.invalidateQueries({ queryKey: ['emails'] })
        )
        debounceInvalidate('["mailboxes"]', () =>
          queryClient.invalidateQueries({ queryKey: ['mailboxes'] })
        )
        if (id != null) {
          debounceInvalidate(`["email",${id}]`, () =>
            queryClient.invalidateQueries({ queryKey: ['email', id] })
          )
          debounceInvalidate(`["email",${id},"ai"]`, () =>
            queryClient.invalidateQueries({ queryKey: ['email', id, 'ai'] })
          )
        }
        return
      }
      // outbox 派发完成 → Notion / Mail.app 状态可能变 (但 SQLite intent 已写过,
      // 这里 invalidate 主要是为了反映 fanout 完成后的衍生状态; pinned 不在 outbox 流里)
      if (t === 'outbox.done') {
        debounceInvalidate('["emails"]', () =>
          queryClient.invalidateQueries({ queryKey: ['emails'] })
        )
        return
      }
      // folder 同步完成 (worker safe_publish('folder.synced', ...))
      // → 宽 invalidate ['folder'] 命中多文件夹 whitelist (['folder','whitelist'])
      // + discover (['folder','discover']) 查询, 让 SidebarFolderTree 等及时反映新状态。
      if (t === 'folder.synced') {
        debounceInvalidate('["folder"]', () =>
          queryClient.invalidateQueries({ queryKey: ['folder'] })
        )
        return
      }
      // LLM 完成 → 单封 ai 字段 + 列表 (ai_priority / ai_action 显示)
      if (t === 'llm.success') {
        if (id != null) {
          debounceInvalidate(`["email",${id},"ai"]`, () =>
            queryClient.invalidateQueries({ queryKey: ['email', id, 'ai'] })
          )
        }
        debounceInvalidate('["emails"]', () =>
          queryClient.invalidateQueries({ queryKey: ['emails'] })
        )
        return
      }
      // 其他事件 (outbox.enqueued / outbox.failed / llm.failed) 当前不触发 invalidate;
      // 留作扩展空间 (e.g. admin queue depth dashboard 可订阅 outbox.enqueued).
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
