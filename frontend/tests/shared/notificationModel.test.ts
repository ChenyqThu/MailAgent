// 通知面板分日口径的行为测试（task 08-20-notification-center 步骤 7）。
//
// 为什么值得测：分日判据是「当地零点之差」而不是 `(now - ts) / 86400000`。后者在跨夏令时
// 那天差一小时，会把昨晚的条目错分进「今天」—— 这类错误在界面上只表现为组头站错队，肉眼
// 极难发现，回归也不会有别的测试拦住。

import { describe, expect, it } from 'vitest'

import { dayBucketOf, groupByDay } from '@shared/components/notifications/notificationModel'

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
