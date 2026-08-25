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

// 允许的 route 目标（值 = TanStack Router 的路由 path 字面量）自 task 08-24-l4-nav-shell
// Step R 起**从 nav registry 派生**（标了 `notificationRoute` 的那几条），不再在这里手抄
// 一份 path 清单 —— 它与侧栏 / ⌘K 是同一批入口，抄第二份就会在改路由时漏掉一边。
// 🔴 白名单**只转录现状三条**，不借机扩面：加档 = 给那条 entry 标 `notificationRoute`
// + 确认真有信源会发它。
import {
  NOTIFICATION_ROUTE_TARGETS,
  type NotificationRouteTarget
} from '@shared/navigation/registry'
// 只引类型：本模块运行时不依赖 router。
import type { useNavigate } from '@tanstack/react-router'

import { clampSettingsTab } from '@shared/lib/settingsTabs'

export { NOTIFICATION_ROUTE_TARGETS, type NotificationRouteTarget }

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

type NavigateFn = ReturnType<typeof useNavigate>

/**
 * route 型链接的落地 switch —— **单源**（task 08-24-l4-nav-shell Step B，Step R check ①）。
 * 此前 NotificationPanel 与 router-instance（系统通知点击）各手抄一份，且两份都漏了
 * `/settings` case：kos ingest_log 的死信通知（`/settings?tab=integrations`）过得了白名单
 * 却落不了地，点了只标已读哪也不去。收敛成一份 + `default: never` 穷尽闸 ——
 * registry 白名单再加档而这里漏 case 时 typecheck 当场红，不再静默吞。
 *
 * search 逐 case clamp（TanStack validateSearch 的口径在类型层进不来，值层各路由
 * 自己还会再验一遍）。
 */
export function navigateNotificationRoute(
  navigate: NavigateFn,
  link: Extract<NotificationLink, { type: 'route' }>
): void {
  switch (link.to) {
    case '/agents': {
      // `/agents` 的 validateSearch 要求 tab 三档之一；非法值按路由自身口径归 agents。
      const tab = link.search?.tab
      const safeTab = tab === 'reports' || tab === 'chats' ? tab : 'agents'
      void navigate({ to: '/agents', search: { tab: safeTab } })
      return
    }
    case '/admin/kanban':
      void navigate({ to: '/admin/kanban' })
      return
    case '/settings':
      void navigate({ to: '/settings', search: { tab: clampSettingsTab(link.search?.tab) } })
      return
    default: {
      const exhaustive: never = link.to
      return exhaustive
    }
  }
}
