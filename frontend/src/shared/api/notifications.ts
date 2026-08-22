// 统一通知中心 REST client（task 08-20-notification-center 步骤 7）。照 api/contacts.ts 的
// 工厂形状：`createNotificationsApi(baseUrl)`，请求走 shared/api/http_client 的 envelope 解包
// （baseUrl 已含 `/api`，所以这里的 path 是 `/notifications…`）。
//
// M2 追加 snooze / resolve 两个动作端点（design §5）；`publish` 是 Electron main 侧的
// internal face（loopback + 本地 token），renderer 永远不调，故这里仍不摆。

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
  /** 稍后提醒。`untilMs` 是**显式 epoch 毫秒**：服务端也收 `preset`，但那套预设只有
   *  `3d` 一档，而「明天早上」这类档位本就该按**用户本地时区**算 —— 换算留在前端
   *  （`notificationModel.ts::snoozeUntilMs`），wire 上只传算好的时刻。 */
  snooze(notificationId: number, untilMs: number): Promise<NotificationItem>
  /** 标记已处理。与「已读」是两个独立轴：resolve 不动 `readAt`。 */
  resolve(notificationId: number): Promise<NotificationItem>
}

let fallbackKeyCounter = 0

/** mutation 信封（`src/api/schemas/matters.py::MutationEnvelope`，通知端点复用同一个
 *  DTO）+ 与之一致的 `Idempotency-Key` header —— 服务端逐字比对两者，不一致直接
 *  `E_IDEMPOTENCY_CONFLICT`。形状照 `api/matters.ts::mutationRequest`；`expected_version`
 *  / `reason` 是可选字段，通知动作两者都没有，故不发（StrictModel 只禁多字段，不要求
 *  显式 null）。 */
function mutationRequest(): { body: Record<string, unknown>; headers: Record<string, string> } {
  const idempotencyKey =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `notification-${Date.now()}-${(fallbackKeyCounter += 1)}`
  return {
    body: { mutation: { source: 'desktop_ui', idempotency_key: idempotencyKey } },
    headers: { 'Idempotency-Key': idempotencyKey }
  }
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
    },

    snooze(notificationId: number, untilMs: number): Promise<NotificationItem> {
      const { body, headers } = mutationRequest()
      return request(baseUrl, 'POST', `/notifications/${notificationId}/snooze`, {
        body: { ...body, until: untilMs },
        headers
      })
    },

    resolve(notificationId: number): Promise<NotificationItem> {
      const { body, headers } = mutationRequest()
      return request(baseUrl, 'POST', `/notifications/${notificationId}/resolve`, { body, headers })
    }
  }
}
