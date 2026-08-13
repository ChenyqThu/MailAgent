import { describe, expect, test } from 'vitest'

import {
  MATTER_DATE_GRID_CELLS,
  MATTER_DATE_PRESETS,
  addLocalDays,
  isSameLocalDay,
  monthGridDays,
  resolveMatterDatePreset,
  shiftDayByMonths,
  shiftMonth,
  startOfLocalDay
} from '../../src/shared/components/matters/matterDatePresets'

/** 断言辅助：把毫秒读成本地日历上的 `YYYY-MM-DD`（不经 UTC，避免时区把断言搅乱）。 */
function ymd(timestamp: number): string {
  const date = new Date(timestamp)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

/** 本地零点 —— 与 UI 写侧（`new Date(y, m, d).getTime()`）同一条构造路径。 */
function at(year: number, month: number, day: number, hour = 10): number {
  return new Date(year, month - 1, day, hour, 30, 15, 250).getTime()
}

describe('startOfLocalDay / isSameLocalDay', () => {
  test('collapses any instant to local midnight of that calendar day', () => {
    const noon = at(2026, 8, 13, 12)
    const lateNight = at(2026, 8, 13, 23)
    expect(startOfLocalDay(noon)).toBe(new Date(2026, 7, 13).getTime())
    expect(startOfLocalDay(noon)).toBe(startOfLocalDay(lateNight))
    expect(isSameLocalDay(noon, lateNight)).toBe(true)
    expect(isSameLocalDay(noon, at(2026, 8, 14))).toBe(false)
  })

  test('produces the exact epoch-ms shape the write path expects (local midnight)', () => {
    const value = startOfLocalDay(at(2026, 8, 13))
    const asDate = new Date(value)
    expect(asDate.getHours()).toBe(0)
    expect(asDate.getMinutes()).toBe(0)
    expect(asDate.getSeconds()).toBe(0)
    expect(asDate.getMilliseconds()).toBe(0)
    // 服务端 `_require_epoch_ms` 拒秒级：毫秒量级必须是 13 位。
    expect(String(value).length).toBe(13)
  })
})

describe('resolveMatterDatePreset', () => {
  test('today = the current local day', () => {
    expect(ymd(resolveMatterDatePreset('today', at(2026, 8, 13)))).toBe('2026-08-13')
  })

  test('thisWeek = the Sunday closing the current (Monday-start) week', () => {
    // 2026-08-13 是周四 → 本周日 = 2026-08-16。
    expect(new Date(at(2026, 8, 13)).getDay()).toBe(4)
    expect(ymd(resolveMatterDatePreset('thisWeek', at(2026, 8, 13)))).toBe('2026-08-16')
  })

  test('thisWeek on a Monday still lands on that same week Sunday', () => {
    // 2026-08-10 是周一 → +6 天。
    expect(new Date(at(2026, 8, 10)).getDay()).toBe(1)
    expect(ymd(resolveMatterDatePreset('thisWeek', at(2026, 8, 10)))).toBe('2026-08-16')
  })

  test('thisWeek on a Sunday resolves to today, not a week later', () => {
    expect(new Date(at(2026, 8, 16)).getDay()).toBe(0)
    expect(ymd(resolveMatterDatePreset('thisWeek', at(2026, 8, 16)))).toBe('2026-08-16')
  })

  test('nextWeek is always exactly seven days after thisWeek', () => {
    for (const day of [10, 13, 16]) {
      const now = at(2026, 8, day)
      const week = resolveMatterDatePreset('thisWeek', now)
      const next = resolveMatterDatePreset('nextWeek', now)
      expect(ymd(next)).toBe(ymd(addLocalDays(week, 7)))
    }
  })

  test('thisMonth = last calendar day of the current month', () => {
    expect(ymd(resolveMatterDatePreset('thisMonth', at(2026, 8, 13)))).toBe('2026-08-31')
    // 30 天月 + 平年 2 月 + 闰年 2 月。
    expect(ymd(resolveMatterDatePreset('thisMonth', at(2026, 9, 1)))).toBe('2026-09-30')
    expect(ymd(resolveMatterDatePreset('thisMonth', at(2026, 2, 5)))).toBe('2026-02-28')
    expect(ymd(resolveMatterDatePreset('thisMonth', at(2028, 2, 5)))).toBe('2028-02-29')
  })

  // 🔴 跨年是这组映射最容易写错的地方（12 月 + 周/月进位）。
  test('crosses the year boundary for both week presets in late December', () => {
    // 2026-12-28 是周一 → 本周日 = 2027-01-03、下周日 = 2027-01-10。
    const now = at(2026, 12, 28)
    expect(new Date(now).getDay()).toBe(1)
    expect(ymd(resolveMatterDatePreset('thisWeek', now))).toBe('2027-01-03')
    expect(ymd(resolveMatterDatePreset('nextWeek', now))).toBe('2027-01-10')
    // 但「本月」仍钉在 12 月最后一天，不跟着跨年。
    expect(ymd(resolveMatterDatePreset('thisMonth', now))).toBe('2026-12-31')
  })

  test('December 31 keeps thisMonth on the same day and rolls the weeks into next year', () => {
    const now = at(2026, 12, 31) // 周四
    expect(ymd(resolveMatterDatePreset('thisMonth', now))).toBe('2026-12-31')
    expect(ymd(resolveMatterDatePreset('thisWeek', now))).toBe('2027-01-03')
    expect(ymd(resolveMatterDatePreset('nextWeek', now))).toBe('2027-01-10')
  })

  test('every preset returns local midnight, never an intraday instant', () => {
    for (const preset of MATTER_DATE_PRESETS) {
      const value = resolveMatterDatePreset(preset, at(2026, 12, 31, 23))
      expect(value).toBe(startOfLocalDay(value))
    }
  })
})

describe('monthGridDays', () => {
  test('always yields a full 6x7 grid starting on the Monday on/before the 1st', () => {
    // 2026-08-01 是周六 → 网格从 2026-07-27（周一）起。
    const grid = monthGridDays(2026, 7)
    expect(grid).toHaveLength(MATTER_DATE_GRID_CELLS)
    expect(new Date(grid[0]!).getDay()).toBe(1)
    expect(ymd(grid[0]!)).toBe('2026-07-27')
    expect(ymd(grid[MATTER_DATE_GRID_CELLS - 1]!)).toBe('2026-09-06')
  })

  test('a month starting on Monday keeps the 1st in the first cell', () => {
    // 2026-06-01 是周一。
    const grid = monthGridDays(2026, 5)
    expect(ymd(grid[0]!)).toBe('2026-06-01')
  })

  test('a month starting on Sunday backfills six days, not zero', () => {
    // 2026-11-01 是周日 → 回退 6 天到 2026-10-26。
    const grid = monthGridDays(2026, 10)
    expect(ymd(grid[0]!)).toBe('2026-10-26')
    expect(new Date(grid[0]!).getDay()).toBe(1)
  })

  test('cells are contiguous local days with no gaps across a DST boundary', () => {
    // 美西 2026-11-01 回拨 —— 纯毫秒加法会在这里错位，构造器不会。
    const grid = monthGridDays(2026, 10)
    for (let i = 1; i < grid.length; i += 1) {
      expect(ymd(grid[i]!)).toBe(ymd(addLocalDays(grid[i - 1]!, 1)))
      expect(grid[i]).toBe(startOfLocalDay(grid[i]!))
    }
  })

  test('grid spans December into the next year', () => {
    const grid = monthGridDays(2026, 11)
    expect(ymd(grid[0]!)).toBe('2026-11-30')
    expect(new Date(grid[MATTER_DATE_GRID_CELLS - 1]!).getFullYear()).toBe(2027)
  })
})

describe('shiftMonth', () => {
  test('wraps both directions across the year boundary', () => {
    expect(ymd(shiftMonth(2026, 11, 1))).toBe('2027-01-01')
    expect(ymd(shiftMonth(2026, 0, -1))).toBe('2025-12-01')
    expect(ymd(shiftMonth(2026, 7, 0))).toBe('2026-08-01')
  })
})

describe('shiftDayByMonths', () => {
  test('keeps the day-of-month when the target month is long enough', () => {
    expect(ymd(shiftDayByMonths(at(2026, 8, 13), 1))).toBe('2026-09-13')
    expect(ymd(shiftDayByMonths(at(2026, 8, 13), -1))).toBe('2026-07-13')
  })

  // 🔴 不夹取的话 `new Date(y, m + 1, 31)` 会溢出到再下个月 —— 光标「跳过整个二月」。
  test('clamps to the last day of a shorter target month', () => {
    expect(ymd(shiftDayByMonths(at(2026, 1, 31), 1))).toBe('2026-02-28')
    expect(ymd(shiftDayByMonths(at(2028, 1, 31), 1))).toBe('2028-02-29')
    expect(ymd(shiftDayByMonths(at(2026, 5, 31), 1))).toBe('2026-06-30')
  })

  test('wraps across the year boundary in both directions', () => {
    expect(ymd(shiftDayByMonths(at(2026, 12, 15), 1))).toBe('2027-01-15')
    expect(ymd(shiftDayByMonths(at(2026, 1, 15), -1))).toBe('2025-12-15')
  })

  test('always lands on local midnight', () => {
    const value = shiftDayByMonths(at(2026, 8, 13, 23), 1)
    expect(value).toBe(startOfLocalDay(value))
  })
})
