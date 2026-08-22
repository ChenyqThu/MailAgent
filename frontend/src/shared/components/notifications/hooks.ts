// 统一通知中心 hooks（task 08-20-notification-center 步骤 7）。形状照
// `components/contacts/hooks.ts`：工厂 useMemo 一次 + useQuery/useMutation 薄封装，
// 失效统一走 `notificationMutation.ts` 的 `refreshNotifications`（唯一出口）。
//
// 🔴 轮询节拍是 **60s** 不是 5s：主通道是 SSE `notification.changed`（useEventBridge
// 立刻失效），轮询只是断线/远程 web 构建（`HttpApi.onEvent` 恒 no-op，无 SSE）的保险丝
// —— design §4.3 明示「别抄三徽标的 5s 模板」，那是 perf epic 正在消灭的轮询风暴。

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseMutationResult, UseQueryResult } from '@tanstack/react-query'

import { createNotificationsApi } from '@shared/api/notifications'
import type { NotificationsApi } from '@shared/api/notifications'
import type {
  NotificationCategory,
  NotificationItem,
  NotificationListResult,
  NotificationUnreadCount
} from '@shared/api/types/notifications'
import { resolveApiBaseUrl } from '@shared/components/settings/custom-ai/shared'
import { qk } from '@shared/lib/queryKeys'

import { refreshNotifications } from './notificationMutation'

/** SSE 在场时的兜底轮询节拍（design §4.3）。 */
const UNREAD_POLL_MS = 60_000

export function useNotificationsApi(): NotificationsApi {
  return useMemo(() => createNotificationsApi(resolveApiBaseUrl()), [])
}

/** 铃铛徽标数据源。恒查询（通知中心无 flag，design §8.e）；请求失败时 `data` 为
 *  undefined —— 调用方据此**不渲染计数点**（铃铛本身照常在，不白屏也不报错）。 */
export function useNotificationUnreadCount(): UseQueryResult<NotificationUnreadCount> {
  const api = useNotificationsApi()
  return useQuery({
    queryKey: qk.notifications.unreadCount(),
    queryFn: () => api.unreadCount(),
    staleTime: 4_000,
    refetchInterval: UNREAD_POLL_MS
  })
}

/** 面板列表。M1 只有 All（category=null）+ 活跃态（state='open'，含到期 snoozed）；
 *  `enabled` 由面板开合驱动 —— 关着的时候一次都不拉（AgentPendingBadge 的「不白拉」精神）。 */
export function useNotificationList(open: boolean): UseQueryResult<NotificationListResult> {
  const api = useNotificationsApi()
  return useQuery({
    queryKey: qk.notifications.list(null, 'open'),
    queryFn: () => api.list({ state: 'open', limit: 50 }),
    enabled: open,
    staleTime: 4_000
  })
}

/** 单条已读（天然幂等）。零乐观更新：成功后才失效，失败时条目保持未读态。 */
export function useMarkNotificationRead(): UseMutationResult<NotificationItem, Error, number> {
  const api = useNotificationsApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (notificationId: number) => api.markRead(notificationId),
    onSuccess: () => refreshNotifications(client)
  })
}

/** 全部已读。`category` 省略 = 全部类别（M1 面板只有 All，恒省略）。 */
export function useMarkAllNotificationsRead(): UseMutationResult<
  { updated: number },
  Error,
  NotificationCategory | undefined
> {
  const api = useNotificationsApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (category?: NotificationCategory) => api.readAll(category),
    onSuccess: () => refreshNotifications(client)
  })
}
