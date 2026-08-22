// 统一通知中心 REST client（task 08-20-notification-center 步骤 7）。照 api/contacts.ts 的
// 工厂形状：`createNotificationsApi(baseUrl)`，请求走 shared/api/http_client 的 envelope 解包
// （baseUrl 已含 `/api`，所以这里的 path 是 `/notifications…`）。
//
// M1 只有四个端点（design §5）；snooze / resolve / publish 是 M2，不预先摆空方法。

import { request, requestWithMeta } from './http_client'
import type {
  NotificationCategory,
  NotificationItem,
  NotificationListResult,
  NotificationListState,
  NotificationUnreadCount
} from './types/notifications'

export interface NotificationListOptions {
  category?: NotificationCategory
  /** 默认 `open`（含到期 snoozed），服务端同默认值。 */
  state?: NotificationListState
  unreadOnly?: boolean
  /** 1-100，服务端默认 50。 */
  limit?: number
  offset?: number
}

export interface NotificationsApi {
  list(options?: NotificationListOptions): Promise<NotificationListResult>
  unreadCount(): Promise<NotificationUnreadCount>
  /** 不传 category = 全部类别。返回被标记的行数。 */
  readAll(category?: NotificationCategory): Promise<{ updated: number }>
  markRead(notificationId: number): Promise<NotificationItem>
}

/** meta 里的计数字段。老服务端/测试桩缺字段时回落 `fallback`，不硬造数字也不 NaN。 */
function metaNumber(meta: Record<string, unknown>, key: string, fallback: number): number {
  const value = meta[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function createNotificationsApi(baseUrl: string): NotificationsApi {
  return {
    async list(options: NotificationListOptions = {}): Promise<NotificationListResult> {
      // data 是裸数组，分页/未读计数在 meta（design §5：`{count,total,limit,offset,unread}`）
      // —— 用 requestWithMeta 把它抬进返回值，读侧不用再发第二个请求要 total。
      const { data, meta } = await requestWithMeta<NotificationItem[]>(
        baseUrl,
        'GET',
        '/notifications',
        {
          query: {
            category: options.category,
            state: options.state,
            unreadOnly: options.unreadOnly,
            limit: options.limit,
            offset: options.offset
          }
        }
      )
      const items = Array.isArray(data) ? data : []
      return {
        items,
        total: metaNumber(meta, 'total', items.length),
        unread: metaNumber(meta, 'unread', 0),
        limit: metaNumber(meta, 'limit', items.length),
        offset: metaNumber(meta, 'offset', 0)
      }
    },

    unreadCount(): Promise<NotificationUnreadCount> {
      return request(baseUrl, 'GET', '/notifications/unread-count')
    },

    readAll(category?: NotificationCategory): Promise<{ updated: number }> {
      return request(baseUrl, 'POST', '/notifications/read-all', {
        body: category ? { category } : {}
      })
    },

    markRead(notificationId: number): Promise<NotificationItem> {
      return request(baseUrl, 'POST', `/notifications/${notificationId}/read`)
    }
  }
}
