// 通知条目 deep-link 的**单源解析器**（task 08-20-notification-center 步骤 7；design §6.4）。
//
// 载荷来自后端 `payload_json.link`，是判别 union。这里只做「解析 + 白名单」，跳转动作留在
// 组件里（`useNavigate` 是 hook，且 TanStack Router 的 `to` 是字面量联合类型 —— 解析器返回
// 收窄后的字面量，组件用 switch 逐个字面量 navigate，全程零 `as any`）。
//
// 🔴 未知 type / 字段缺失 / 路由不在白名单 → 返回 null，条目点击**只标已读不跳转**（前向
// 兼容：新版后端加了新 link 型，老前端不炸也不乱跳）。白名单只列信源真会发的目标
// （`run_worker.py` 的 `/agents?tab=agents`、`job_worker.py` / `service.py` /
// `davmail_watchdog.py` 的 `/admin/kanban`）—— 加信源时同步加档，不预留空位。
//
// M2 批 B5 补齐 design §6.4 表里的另外四型（report / contact_queue / matter /
// updater_restart）。它们的落地动作各不相同（两个走 store-intent、一个走现成的 matters
// 通道、一个直调 updater IPC），但**解析**这一步仍然只有这一处。

/** 允许的 route 目标。值 = TanStack Router 的路由 path 字面量。 */
export const NOTIFICATION_ROUTE_TARGETS = ['/agents', '/admin/kanban', '/settings'] as const
export type NotificationRouteTarget = (typeof NOTIFICATION_ROUTE_TARGETS)[number]

export type NotificationLink =
  | { type: 'session'; sessionId: number }
  | { type: 'route'; to: NotificationRouteTarget; search: Record<string, unknown> | null }
  /** 报告完成（`reports/worker.py`）→ `/agents?tab=reports` 并选中那一份。 */
  | { type: 'report'; reportId: string }
  /** 通讯录治理建议（`governance.py`）→ 打开工作台抽屉的「待审建议」tab。 */
  | { type: 'contact_queue' }
  /** 事项提案 / 关注信号（`run_service.py` / `matters/worker.py`）→ 打开那件事。 */
  | { type: 'matter'; publicId: string }
  /** 应用更新就绪（Electron main 的 updater）→ 重启装更新。 */
  | { type: 'updater_restart' }

/** 非空字符串字段的统一取法（reportId / publicId 都是不透明 id，只校验形状）。 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

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

  if (link.type === 'report') {
    const reportId = nonEmptyString(link.reportId)
    return reportId === null ? null : { type: 'report', reportId }
  }

  // 无参数型：判 type 就够，不校验别的字段（后端往载荷里多塞字段不该让链接失效）。
  if (link.type === 'contact_queue') return { type: 'contact_queue' }
  if (link.type === 'updater_restart') return { type: 'updater_restart' }

  if (link.type === 'matter') {
    const publicId = nonEmptyString(link.publicId)
    return publicId === null ? null : { type: 'matter', publicId }
  }

  return null
}
