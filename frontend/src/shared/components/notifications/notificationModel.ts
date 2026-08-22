// 通知面板的纯呈现逻辑（task 08-20-notification-center 步骤 7 + M2 批 B5）。
//
// 与组件分家的理由和 `contactListModel.ts` / `matterTimelineModel.ts` 一样：这几个函数是
// 可单测的纯函数，留在 .tsx 里既不能 export（react-refresh/only-export-components）也不好
// 测。这里是分日口径 / tab 值域 / snooze 档位换算 / 铃铛徽标判据 —— 图标与色调映射带
// lucide 组件，留在组件文件。
//
// 后端 list 契约不含分组：分日是纯前端呈现（design §6.3），不加分组查询参数。

import {
  NOTIFICATION_CATEGORY_VALUES,
  type NotificationCategory,
  type NotificationUnreadCount
} from '@shared/api/types/notifications'

/** 相对时间与钟点的分界：更近的读「N 分钟/小时前」，更远的读 HH:MM —— 分日组头已经交代
 *  了日期，钟点不歧义。mockup 的五条时间戳（2 分钟前 / 18 分钟前 / 1 小时前 / 09:41 /
 *  20:15）就是这一个阈值的产物。 */
export const RELATIVE_WINDOW_MS = 6 * 60 * 60 * 1000

export type DayBucket = 'today' | 'yesterday' | 'earlier'

function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 本地时区分日。判据是**当地零点之差**而不是 `(now-ts)/86400000`：跨夏令时那天两者差
 *  一小时，直接除会把昨天 23:30 的条目算进「今天」。`Math.round` 在这里正是吸收那一小时
 *  的容差，不是懒惰取整。 */
export function dayBucketOf(eventMs: number, nowMs: number): DayBucket {
  const days = Math.round((startOfLocalDay(nowMs) - startOfLocalDay(eventMs)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return 'earlier'
}

/** 按分日切段。**保持入参顺序**（服务端已按 `last_event_at DESC` 排好，这里不重排）；
 *  同一 bucket 只有相邻时才合段 —— 顺序乱掉时宁可切出两段可见的异常，也不静默重排掩盖。 */
export function groupByDay<T extends { lastEventAt: number }>(
  items: readonly T[],
  nowMs: number
): Array<{ bucket: DayBucket; items: T[] }> {
  const out: Array<{ bucket: DayBucket; items: T[] }> = []
  for (const item of items) {
    const bucket = dayBucketOf(item.lastEventAt, nowMs)
    const tail = out[out.length - 1]
    if (tail && tail.bucket === bucket) tail.items.push(item)
    else out.push({ bucket, items: [item] })
  }
  return out
}

// ─── tab 值域（M2）─────────────────────────────────────────────────────────

/** 面板 tab = 「全部」+ 四个 category。🔴 后四档**从 category 值域派生**，不手抄第二份
 *  —— 值域单源是 `types/notifications.ts`（它自己再跨语言锁 `center_models.py`）。加一个
 *  category 时 tab 行自动跟上，只需补 i18n 文案。 */
export const NOTIFICATION_TAB_IDS = ['all', ...NOTIFICATION_CATEGORY_VALUES] as const
export type NotificationTabId = (typeof NOTIFICATION_TAB_IDS)[number]

/** tab → list 查询的 `category` 参数（`all` = 不过滤）。 */
export function tabCategory(tab: NotificationTabId): NotificationCategory | null {
  return tab === 'all' ? null : tab
}

/** tab 上的未读数。`all` 取 total，其余取该类目 —— 两者同出服务端一条 GROUP BY，
 *  不在前端把 byCategory 加起来（那会与服务端的 total 口径漂）。 */
export function tabUnread(
  tab: NotificationTabId,
  counts: NotificationUnreadCount | undefined
): number {
  if (!counts) return 0
  if (tab === 'all') return counts.total
  return counts.byCategory?.[tab] ?? 0
}

// ─── 铃铛徽标（M2）─────────────────────────────────────────────────────────

/** 铃铛的呈现判据。`unread === null` = 计数还没到（或请求失败）→ 调用方**不渲染
 *  计数点**（不闪一个假的 0）。`critical` = 未读里有 critical → 红点档（fail 配方），
 *  否则 accent 计数点。
 *
 *  `pendingActionCount` 是 M3 批 C5 收编 `AgentPendingBadge` 带进来的第三档：待办
 *  （`action_required` 的**活跃**行）是 **level 型**指示，与 edge 型的未读数不是一
 *  回事 —— 用户读了通知但没去批时未读掉到 0，而审批仍挂着，铃铛得留一个持久的点。
 *  返回计数而不是布尔：判据是 `> 0`，但 tooltip 要报数，两处各读一次同一个字段会
 *  分裂口径。 */
export function bellBadgeState(counts: NotificationUnreadCount | undefined): {
  unread: number | null
  critical: boolean
  pendingActionCount: number
} {
  if (!counts) return { unread: null, critical: false, pendingActionCount: 0 }
  // `?? 0`：`bySeverity` / `openByCategory` 分别是 M2 / M3 才加的字段，比前端旧的
  // 服务端不发它们 —— 缺字段时退化成「无红点 / 无待办点」，而不是 undefined > 0 的
  // 静默 false（同结果，但这里写明是有意的降级）。
  return {
    unread: counts.total,
    critical: (counts.bySeverity?.critical ?? 0) > 0,
    pendingActionCount: counts.openByCategory?.action_required ?? 0
  }
}

// ─── snooze 档位（M2）──────────────────────────────────────────────────────

/** 「稍后提醒」的三档。🔴 换算在**前端**做：服务端的 preset 集只有 `3d`，而「明天早上」
 *  是本地时区概念（服务端的 UTC 时钟算不出用户的早上）。wire 上只传算好的 epoch 毫秒。 */
export const SNOOZE_PRESETS = ['hour', 'tomorrow', 'threeDays'] as const
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number]

/** 「明天早上」是几点。 */
const MORNING_HOUR = 8

/**
 * 档位 → 显式 epoch 毫秒。
 *
 * 🔴 `tomorrow` / `threeDays` 走**日期分量**运算（`new Date(y, m, d + n, …)`）而不是加
 * 固定毫秒：跨夏令时那天两者差一小时 —— 加固定毫秒会把「明天 08:00」算成 07:00 或
 * 09:00，把「3 天后的这个点」算成前后错一小时。分量运算由 Date 自己吸收那一小时。
 */
export function snoozeUntilMs(preset: SnoozePreset, nowMs: number): number {
  const now = new Date(nowMs)
  switch (preset) {
    case 'hour':
      return nowMs + 60 * 60 * 1000
    case 'tomorrow':
      // 字面意思：**下一个**自然日的早上（凌晨 03:00 点的 snooze 也是明天 08:00 才回来，
      // 不是 5 小时后的今天早上 —— 用户说的是「明天」）。
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, MORNING_HOUR).getTime()
    case 'threeDays':
      return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 3,
        now.getHours(),
        now.getMinutes(),
        now.getSeconds(),
        now.getMilliseconds()
      ).getTime()
  }
}
