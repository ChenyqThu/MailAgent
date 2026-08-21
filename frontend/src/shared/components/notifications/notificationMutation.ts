/**
 * 通知中心缓存失效的唯一出口（08-20-notification-center 设计 §4.2）。
 *
 * SSE `notification.changed` 到达时（`useEventBridge.ts`）与写操作（mark read /
 * mark all read / snooze / resolve，M2 起）成功后都调用这个函数，不在各调用点
 * 各写一份 `invalidateQueries` —— 通知相关新顶层 key 一律加进这里失效。
 */

import type { QueryClient } from '@tanstack/react-query'

import { qk } from '@shared/lib/queryKeys'

export async function refreshNotifications(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: qk.notifications.all() })
}
