// 通知条目 deep-link 的**单源解析器**（task 08-20-notification-center 步骤 7；design §6.4）。
//
// 载荷来自后端 `payload_json.link`，是判别 union。这里只做「解析 + 白名单」，跳转动作留在
// 组件里（`useNavigate` 是 hook，且 TanStack Router 的 `to` 是字面量联合类型 —— 解析器返回
// 收窄后的字面量，组件用 switch 逐个字面量 navigate，全程零 `as any`）。
//
// 🔴 未知 type / 字段缺失 / 路由不在白名单 → 返回 null，条目点击**只标已读不跳转**（前向
// 兼容：新版后端加了新 link 型，老前端不炸也不乱跳）。白名单只列 M1 三个信源真会发的两个
// 目标（`run_worker.py` 的 `/agents?tab=agents`、`job_worker.py` / `service.py` /
// `davmail_watchdog.py` 的 `/admin/kanban`）—— M2 加信源时同步加档，不预留空位。

/** M1 允许的 route 目标。值 = TanStack Router 的路由 path 字面量。 */
export const NOTIFICATION_ROUTE_TARGETS = ['/agents', '/admin/kanban'] as const
export type NotificationRouteTarget = (typeof NOTIFICATION_ROUTE_TARGETS)[number]

export type NotificationLink =
  | { type: 'session'; sessionId: number }
  | { type: 'route'; to: NotificationRouteTarget; search: Record<string, unknown> | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function resolveNotificationLink(
  payload: Record<string, unknown> | null | undefined
): NotificationLink | null {
  if (!payload) return null
  const link = payload.link
  if (!isRecord(link)) return null

  if (link.type === 'session') {
    const sessionId = link.sessionId
    // 后端 `_session_id_of` 拿不到会话时发的是 route 退化型；这里再守一道 0/负数/非整数。
    if (typeof sessionId !== 'number' || !Number.isInteger(sessionId) || sessionId <= 0) return null
    return { type: 'session', sessionId }
  }

  if (link.type === 'route') {
    const to = link.to
    if (typeof to !== 'string') return null
    if (!(NOTIFICATION_ROUTE_TARGETS as readonly string[]).includes(to)) return null
    return {
      type: 'route',
      to: to as NotificationRouteTarget,
      search: isRecord(link.search) ? link.search : null
    }
  }

  return null
}
