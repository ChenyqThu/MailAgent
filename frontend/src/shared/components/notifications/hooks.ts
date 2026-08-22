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

/** 面板列表。活跃态（state='open'，含到期 snoozed）+ 当前 tab 的 category（null = All）；
 *  `enabled` 由面板开合驱动 —— 关着的时候一次都不拉（AgentPendingBadge 的「不白拉」精神）。
 *  category 进 queryKey：切 tab = 另一份结果集，各自缓存、来回切不重取。 */
export function useNotificationList(
  open: boolean,
  category: NotificationCategory | null
): UseQueryResult<NotificationListResult> {
  const api = useNotificationsApi()
  return useQuery({
    queryKey: qk.notifications.list(category, 'open'),
    queryFn: () => api.list({ state: 'open', limit: 50, category: category ?? undefined }),
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

/** 全部已读。`category` 省略 = 全部类别；面板传当前 tab 的 category —— 标的是用户正
 *  看着的那一份（All tab 才是全部）。 */
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

/** 稍后提醒（M2）。`until` 由调用方按本地时区算好（`notificationModel.ts::snoozeUntilMs`）。
 *  成功后条目从 open 列表消失（服务端列表默认 state='open'，未到期 snoozed 不在内）。
 *  零乐观更新：失败时条目留在原位（与 markRead 同一条纪律）。 */
export function useSnoozeNotification(): UseMutationResult<
  NotificationItem,
  Error,
  { id: number; untilMs: number }
> {
  const api = useNotificationsApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, untilMs }: { id: number; untilMs: number }) => api.snooze(id, untilMs),
    onSuccess: () => refreshNotifications(client)
  })
}

/** 标记已处理（M2）。与「已读」是两个独立轴 —— resolve 不动 readAt，条目从徽标里消失
 *  是 state 的效果。 */
export function useResolveNotification(): UseMutationResult<NotificationItem, Error, number> {
  const api = useNotificationsApi()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (notificationId: number) => api.resolve(notificationId),
    onSuccess: () => refreshNotifications(client)
  })
}
