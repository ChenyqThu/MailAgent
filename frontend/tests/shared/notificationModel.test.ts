// 通知面板纯呈现逻辑的行为测试（task 08-20-notification-center 步骤 7 + M2 批 B5）。
//
// 为什么值得测：分日判据是「当地零点之差」而不是 `(now - ts) / 86400000`。后者在跨夏令时
// 那天差一小时，会把昨晚的条目错分进「今天」—— 这类错误在界面上只表现为组头站错队，肉眼
// 极难发现，回归也不会有别的测试拦住。snooze 档位换算同理（且错的时刻要等一小时后才看
// 得出来）。
//
// 时区由 vitest.config.ts 钉死 America/Los_Angeles —— 下面的夏令时用例（2026-03-08 前拨 /
// 2026-11-01 回拨）因此在任何机器上都真的跨 DST，不是形式主义。

import { describe, expect, it } from 'vitest'

import type { NotificationUnreadCount } from '@shared/api/types/notifications'
import { NOTIFICATION_CATEGORY_VALUES } from '@shared/api/types/notifications'
import {
  NOTIFICATION_TAB_IDS,
  bellBadgeState,
  dayBucketOf,
  filterByTab,
  groupByDay,
  snoozeUntilMs,
  tabCategory,
  tabUnread
} from '@shared/components/notifications/notificationModel'

/** 本地时区的某天某点（测试跟随运行机器的时区，与被测函数同口径）。 */
function at(y: number, m: number, d: number, hh: number, mm = 0): number {
  return new Date(y, m - 1, d, hh, mm).getTime()
}

describe('dayBucketOf — 本地时区分日', () => {
  const now = at(2026, 8, 21, 14, 30)

  it('同一自然日 → today（含当天凌晨与未来时刻）', () => {
    expect(dayBucketOf(at(2026, 8, 21, 14, 29), now)).toBe('today')
    expect(dayBucketOf(at(2026, 8, 21, 0, 1), now)).toBe('today')
    // 时钟回拨 / 服务端稍快导致的「未来」时间戳不该掉进 earlier
    expect(dayBucketOf(at(2026, 8, 21, 23, 59), now)).toBe('today')
  })

  it('前一自然日 → yesterday，哪怕只差几分钟', () => {
    expect(dayBucketOf(at(2026, 8, 20, 23, 59), now)).toBe('yesterday')
    expect(dayBucketOf(at(2026, 8, 20, 0, 0), now)).toBe('yesterday')
  })

  it('更早 → earlier', () => {
    expect(dayBucketOf(at(2026, 8, 19, 23, 59), now)).toBe('earlier')
    expect(dayBucketOf(at(2026, 1, 1, 12, 0), now)).toBe('earlier')
  })

  it('🔴 跨夏令时切换日仍然分对（美西 2026-11-01 回拨一小时那天）', () => {
    // 回拨日的「昨天 23:30」距今 15 小时 —— 按 (now-ts)/86400000 取整会算成 0 天 = today。
    const nowAfterDst = at(2026, 11, 1, 13, 0)
    expect(dayBucketOf(at(2026, 10, 31, 23, 30), nowAfterDst)).toBe('yesterday')
    // 春季前拨（2026-03-08）方向相反：前天 00:30 距今不足 48 小时，不能被算成 yesterday。
    const nowAfterSpring = at(2026, 3, 8, 13, 0)
    expect(dayBucketOf(at(2026, 3, 6, 0, 30), nowAfterSpring)).toBe('earlier')
  })
})

describe('groupByDay', () => {
  const now = at(2026, 8, 21, 14, 30)
  const item = (id: number, ms: number): { id: number; lastEventAt: number } => ({
    id,
    lastEventAt: ms
  })

  it('相邻同日合成一段，并保持入参顺序', () => {
    const groups = groupByDay(
      [
        item(1, at(2026, 8, 21, 14, 0)),
        item(2, at(2026, 8, 21, 9, 41)),
        item(3, at(2026, 8, 20, 20, 15)),
        item(4, at(2026, 8, 12, 8, 0))
      ],
      now
    )
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'yesterday', 'earlier'])
    expect(groups[0].items.map((i) => i.id)).toEqual([1, 2])
    expect(groups[1].items.map((i) => i.id)).toEqual([3])
    expect(groups[2].items.map((i) => i.id)).toEqual([4])
  })

  it('空列表 → 空分组（面板据此走空态）', () => {
    expect(groupByDay([], now)).toEqual([])
  })

  it('顺序乱掉时切出两段而不是静默重排（服务端排序是唯一权威）', () => {
    const groups = groupByDay(
      [
        item(1, at(2026, 8, 21, 14, 0)),
        item(2, at(2026, 8, 20, 20, 0)),
        item(3, at(2026, 8, 21, 10, 0))
      ],
      now
    )
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'yesterday', 'today'])
  })
})

// ─── tab 值域（M2）─────────────────────────────────────────────────────────

describe('通知面板 tab', () => {
  it('tab 集 = 「全部」+ 四个 category，顺序跟随值域单源', () => {
    expect(NOTIFICATION_TAB_IDS).toEqual(['all', ...NOTIFICATION_CATEGORY_VALUES])
    // 每个 category 恰好一个 tab —— 漏一个 = 那类通知在面板里没有入口。
    expect(NOTIFICATION_TAB_IDS.length).toBe(NOTIFICATION_CATEGORY_VALUES.length + 1)
  })

  it('tabCategory：all → null（不过滤），其余 → 自身', () => {
    expect(tabCategory('all')).toBeNull()
    for (const category of NOTIFICATION_CATEGORY_VALUES) {
      expect(tabCategory(category)).toBe(category)
    }
  })

  // 🔴 桩里 total(8) **有意**不等于 byCategory 之和(7)：真实服务端两者一致，那样的桩会
  // 让「all 取 total」与「all 把四类加起来」两种实现都绿 —— 恒绿装饰。
  const counts: NotificationUnreadCount = {
    total: 8,
    byCategory: { action_required: 3, reviews: 0, results: 4, system: 0 },
    bySeverity: { info: 5, warn: 3, critical: 0 },
    openByCategory: { action_required: 4, reviews: 1, results: 4, system: 0 }
  }

  it('tabUnread：all 取服务端 total（不在前端把 byCategory 加起来）', () => {
    expect(tabUnread('all', counts)).toBe(8)
  })

  it('tabUnread：类目 tab 取该类目', () => {
    expect(tabUnread('action_required', counts)).toBe(3)
    expect(tabUnread('reviews', counts)).toBe(0)
  })

  it('tabUnread：计数还没到 → 0（不渲染计数）', () => {
    expect(tabUnread('all', undefined)).toBe(0)
    expect(tabUnread('system', undefined)).toBe(0)
  })

  // 切 tab 的过滤在前端做（列表恒拉全类目一份）：漏过滤 = 每个 tab 都显示全部条目。
  describe('filterByTab', () => {
    const rows = [
      { id: 1, category: 'results' as const },
      { id: 2, category: 'action_required' as const },
      { id: 3, category: 'system' as const },
      { id: 4, category: 'action_required' as const }
    ]

    it('all → 原样返回（含顺序）', () => {
      expect(filterByTab(rows, 'all').map((r) => r.id)).toEqual([1, 2, 3, 4])
    })

    it('类目 tab → 只留该类目，保持服务端排序', () => {
      expect(filterByTab(rows, 'action_required').map((r) => r.id)).toEqual([2, 4])
      expect(filterByTab(rows, 'system').map((r) => r.id)).toEqual([3])
    })

    it('该类目一条都没有 → 空（面板据此走空态，而不是显示别的类目）', () => {
      expect(filterByTab(rows, 'reviews')).toEqual([])
    })
  })
})

// ─── 铃铛徽标判据（M2）─────────────────────────────────────────────────────

describe('bellBadgeState', () => {
  const withSeverity = (critical: number, total = critical): NotificationUnreadCount => ({
    total,
    byCategory: { action_required: 0, reviews: 0, results: 0, system: total },
    bySeverity: { info: 0, warn: 0, critical },
    openByCategory: { action_required: 0, reviews: 0, results: 0, system: total }
  })

  it('计数未到 → unread=null（调用方据此不渲染计数点，而不是闪一个假的 0）', () => {
    expect(bellBadgeState(undefined)).toEqual({
      unread: null,
      critical: false,
      pendingActionCount: 0
    })
  })

  it('未读为 0 → unread=0 且不是红点档', () => {
    expect(bellBadgeState(withSeverity(0, 0))).toEqual({
      unread: 0,
      critical: false,
      pendingActionCount: 0
    })
  })

  it('未读里有 critical → 红点档', () => {
    expect(bellBadgeState(withSeverity(2, 5))).toEqual({
      unread: 5,
      critical: true,
      pendingActionCount: 0
    })
  })

  it('只有 warn/info → 计数点档（红点是「有严重的事」，不是「有事」）', () => {
    expect(
      bellBadgeState({
        total: 6,
        byCategory: { action_required: 1, reviews: 2, results: 3, system: 0 },
        bySeverity: { info: 4, warn: 2, critical: 0 },
        openByCategory: { action_required: 1, reviews: 2, results: 3, system: 0 }
      })
    ).toEqual({ unread: 6, critical: false, pendingActionCount: 1 })
  })

  it('服务端还没上 bySeverity / openByCategory（比前端旧）→ 退化，不炸', () => {
    const legacy = {
      total: 3,
      byCategory: { action_required: 0, reviews: 0, results: 3, system: 0 }
    } as NotificationUnreadCount
    expect(bellBadgeState(legacy)).toEqual({
      unread: 3,
      critical: false,
      pendingActionCount: 0
    })
  })

  // 🔴 C5 收编 AgentPendingBadge 的核心判据：待办是 **level 型**（挂着就在），未读是
  // **edge 型**（读过就掉）。桩里 total=0 而 openByCategory.action_required=2 —— 这正是
  // 「读了通知但没去批」的真实形状，只看未读轴的实现在这里会得到 0。
  it('未读清零但仍有活跃待办 → pendingActionCount 保留（level 型不随已读掉）', () => {
    expect(
      bellBadgeState({
        total: 0,
        byCategory: { action_required: 0, reviews: 0, results: 0, system: 0 },
        bySeverity: { info: 0, warn: 0, critical: 0 },
        openByCategory: { action_required: 2, reviews: 1, results: 0, system: 0 }
      })
    ).toEqual({ unread: 0, critical: false, pendingActionCount: 2 })
  })

  it('活跃的只有别的类目 → 没有待办（reviews/results 不进待办点）', () => {
    expect(
      bellBadgeState({
        total: 0,
        byCategory: { action_required: 0, reviews: 0, results: 0, system: 0 },
        bySeverity: { info: 0, warn: 0, critical: 0 },
        openByCategory: { action_required: 0, reviews: 3, results: 4, system: 1 }
      }).pendingActionCount
    ).toBe(0)
  })
})

// ─── snooze 档位换算（M2）──────────────────────────────────────────────────

describe('snoozeUntilMs', () => {
  const HOUR = 60 * 60 * 1000

  it('1 小时后 = 真实流逝一小时（春季前拨那天钟点因此从 01:30 跳到 03:30）', () => {
    const plain = at(2026, 8, 21, 14, 30)
    expect(snoozeUntilMs('hour', plain) - plain).toBe(HOUR)
    // 2026-03-08 02:00 PST → 03:00 PDT：01:30 加一小时的墙上时间是 03:30 而不是 02:30。
    const beforeSpringForward = at(2026, 3, 8, 1, 30)
    expect(new Date(snoozeUntilMs('hour', beforeSpringForward)).getHours()).toBe(3)
  })

  it('明天早上 = 次日 08:00 本地时区', () => {
    const result = snoozeUntilMs('tomorrow', at(2026, 8, 21, 14, 30))
    const d = new Date(result)
    expect([d.getMonth() + 1, d.getDate()]).toEqual([8, 22])
    expect([d.getHours(), d.getMinutes()]).toEqual([8, 0])
  })

  it('明天早上：凌晨点的也是**明天**，不是几小时后的今天早上', () => {
    const d = new Date(snoozeUntilMs('tomorrow', at(2026, 8, 21, 3, 0)))
    expect([d.getDate(), d.getHours()]).toEqual([22, 8])
  })

  it('🔴 明天早上跨夏令时回拨日仍是 08:00（加固定 24h 会算成 07:00）', () => {
    // 2026-11-01 回拨：Oct 31 20:00 PDT 的「明天早上」= Nov 1 08:00 PST，实际流逝 13 小时。
    const now = at(2026, 10, 31, 20, 0)
    const result = snoozeUntilMs('tomorrow', now)
    const d = new Date(result)
    expect([d.getDate(), d.getHours()]).toEqual([1, 8])
    expect(result - now).toBe(13 * HOUR)
  })

  it('🔴 3 天后 = 同一墙上钟点（回拨周里真实流逝 73 小时，不是 72）', () => {
    const now = at(2026, 10, 31, 12, 0)
    const result = snoozeUntilMs('threeDays', now)
    const d = new Date(result)
    expect([d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([11, 3, 12])
    expect(result - now).toBe(73 * HOUR)
  })

  it('三档都落在未来（服务端 snooze 拒收过去时刻 → 400）', () => {
    const now = at(2026, 8, 21, 23, 59)
    for (const preset of ['hour', 'tomorrow', 'threeDays'] as const) {
      expect(snoozeUntilMs(preset, now)).toBeGreaterThan(now)
    }
  })
})
