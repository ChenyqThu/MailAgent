// @vitest-environment happy-dom

// 阶段2·2.7 (F18/UX-P0④) — key-nav 纯函数层:
//   keyNavWindow — 各视图窗口口径必须与视图自身的 useCalendarEventsInWindow
//   参数一致 (同 queryKey 缓存命中), 这里用同一套本地日期公式钉住映射;
//   buildKeyNavSequence — day/week/month 时间序, agenda 与展开序一致 + 跨天去重;
//   stepAnchor — j/k 步进 / 端点 clamp / 无锚点从「现在」附近起步.

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { CalendarEventOccurrence } from '@shared/api/types'

import {
  buildKeyNavSequence,
  keyNavWindow,
  matchFocusTarget,
  occurrenceKey,
  stepAnchor
} from '../../src/shared/components/calendar/lib/key-nav'
import { useCalendarFocus } from '../../src/shared/state/calendar-focus'

function occ(
  id: number,
  startIso: string,
  endIso: string,
  over: Partial<CalendarEventOccurrence> = {}
): CalendarEventOccurrence {
  return {
    id,
    ical_uid: `uid-${id}`,
    recurrence_id: null,
    sequence: 0,
    summary: `evt-${id}`,
    occurrence_start_iso: startIso,
    occurrence_end_iso: endIso,
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    organizer: '',
    attendees: [],
    location: '',
    url: '',
    status: 'CONFIRMED',
    response_status: '',
    source: 'caldav' as CalendarEventOccurrence['source'],
    notion_page_id: null,
    related_email_internal_id: null,
    ...over
  }
}

/** 本地日期 → ISO (TZ 由 vitest.config 钉 America/Los_Angeles, 结果确定). */
function localIso(y: number, m: number, d: number): string {
  return new Date(y, m, d).toISOString()
}

afterEach(() => {
  vi.useRealTimers()
})

describe('occurrenceKey', () => {
  test('matches the Layout/view `${id}-${start}` convention', () => {
    const o = occ(7, '2026-07-15T17:00:00Z', '2026-07-15T18:00:00Z')
    expect(occurrenceKey(o)).toBe('7-2026-07-15T17:00:00Z')
  })
})

describe('keyNavWindow — 视图窗口口径', () => {
  // 2026-07-15 是周三; 周一=07-13, 月首=07-01 其周一=06-29.
  const wed = new Date(2026, 6, 15, 10, 30)

  test('today → 本地 00:00 ~ +1d (DayView 口径)', () => {
    expect(keyNavWindow('today', wed)).toEqual({
      fromIso: localIso(2026, 6, 15),
      toIso: localIso(2026, 6, 16)
    })
  })

  test('week → startOfWeek ~ +7d (WeekView 口径)', () => {
    expect(keyNavWindow('week', wed)).toEqual({
      fromIso: localIso(2026, 6, 13),
      toIso: localIso(2026, 6, 20)
    })
  })

  test('month → startOfWeek(startOfMonth) ~ +42d (MonthView 口径)', () => {
    expect(keyNavWindow('month', wed)).toEqual({
      fromIso: localIso(2026, 5, 29),
      toIso: localIso(2026, 5, 29 + 42)
    })
  })

  test('agenda → todayStartLocal ~ +14d (AgendaView rangeDays 默认)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 9, 0))
    expect(keyNavWindow('agenda', wed)).toEqual({
      fromIso: localIso(2026, 6, 15),
      toIso: localIso(2026, 6, 29)
    })
  })

  test('recurring → null (无时间轴, 不参与巡航)', () => {
    expect(keyNavWindow('recurring', wed)).toBeNull()
  })
})

describe('buildKeyNavSequence', () => {
  test('week/day/month — 时间序 (start, 同 start 按 end)', () => {
    const a = occ(1, '2026-07-15T17:00:00Z', '2026-07-15T18:00:00Z')
    const b = occ(2, '2026-07-15T16:00:00Z', '2026-07-15T17:00:00Z')
    const cShort = occ(3, '2026-07-15T16:00:00Z', '2026-07-15T16:30:00Z')
    const seq = buildKeyNavSequence('week', [a, b, cShort])
    expect(seq.map((o) => o.id)).toEqual([3, 2, 1])
  })

  test('agenda — 与展开序一致: 日升序 + 日内 all-day 前, 跨天事件按首个出现日去重', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 8, 0))
    // 均为 LA 本地时刻 (UTC-7): 15 日 09:00 = 16:00Z.
    const day15 = occ(1, '2026-07-15T16:00:00Z', '2026-07-15T17:00:00Z')
    const allDay15 = occ(2, '2026-07-15T07:00:00Z', '2026-07-16T07:00:00Z', {
      is_all_day: true
    })
    // 跨 15-17 日的多天事件: 展开出 3 天, 序列只保留首日一条.
    const span = occ(3, '2026-07-15T18:00:00Z', '2026-07-17T18:00:00Z')
    const day16 = occ(4, '2026-07-16T16:00:00Z', '2026-07-16T17:00:00Z')
    const seq = buildKeyNavSequence('agenda', [day16, span, day15, allDay15])
    expect(seq.map((o) => o.id)).toEqual([2, 1, 3, 4])
  })

  test('agenda — 起于窗口前的进行中事件不因窗口外日 key 丢失', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 8, 0))
    // 13 日开始 16 日结束, 首个展开日 (13/14 日) 在窗口 [15, 29) 外.
    const ongoing = occ(5, '2026-07-13T16:00:00Z', '2026-07-16T17:00:00Z')
    const seq = buildKeyNavSequence('agenda', [ongoing])
    expect(seq.map((o) => o.id)).toEqual([5])
  })
})

describe('stepAnchor', () => {
  const a = occ(1, '2026-07-15T16:00:00Z', '2026-07-15T17:00:00Z')
  const b = occ(2, '2026-07-15T17:00:00Z', '2026-07-15T18:00:00Z')
  const c = occ(3, '2026-07-15T18:00:00Z', '2026-07-15T19:00:00Z')
  const seq = [a, b, c]
  const at = (iso: string): number => Date.parse(iso)

  test('j/k 沿序列步进', () => {
    expect(stepAnchor(seq, occurrenceKey(a), 1, at('2026-07-15T16:30:00Z'))?.id).toBe(2)
    expect(stepAnchor(seq, occurrenceKey(b), -1, at('2026-07-15T16:30:00Z'))?.id).toBe(1)
  })

  test('端点 clamp 不回绕', () => {
    expect(stepAnchor(seq, occurrenceKey(c), 1, 0)?.id).toBe(3)
    expect(stepAnchor(seq, occurrenceKey(a), -1, 0)?.id).toBe(1)
  })

  test('无锚点: j 从现在之后最近事件起步, k 从现在之前最近事件起步', () => {
    const now = at('2026-07-15T16:30:00Z') // a 已开始, b/c 未来
    expect(stepAnchor(seq, null, 1, now)?.id).toBe(2)
    expect(stepAnchor(seq, null, -1, now)?.id).toBe(1)
  })

  test('无锚点且无未来事件: j 退回第一个', () => {
    const now = at('2026-07-15T23:00:00Z')
    expect(stepAnchor(seq, null, 1, now)?.id).toBe(1)
    expect(stepAnchor(seq, null, -1, now)?.id).toBe(3)
  })

  test('陈旧锚点 (不在当前序列, 如日期步进后) 按无锚点处理', () => {
    const stale = occurrenceKey(occ(99, '2026-07-10T16:00:00Z', '2026-07-10T17:00:00Z'))
    expect(stepAnchor(seq, stale, 1, at('2026-07-15T16:30:00Z'))?.id).toBe(2)
  })

  test('空序列 → null', () => {
    expect(stepAnchor([], null, 1, Date.now())).toBeNull()
  })
})

describe('「在日历中查看」跨面定位 (calendar-focus 读侧)', () => {
  const now = Date.parse('2026-07-15T16:30:00Z')
  const past = occ(1, '2026-07-15T15:00:00Z', '2026-07-15T15:30:00Z', {
    ical_uid: 'uid-series',
    recurrence_id: '2026-07-15T15:00:00Z'
  })
  const future = occ(2, '2026-07-15T18:00:00Z', '2026-07-15T19:00:00Z', {
    ical_uid: 'uid-series',
    recurrence_id: '2026-07-15T18:00:00Z'
  })
  const other = occ(3, '2026-07-15T17:00:00Z', '2026-07-15T17:30:00Z', {
    ical_uid: 'uid-other'
  })
  const seq = [past, other, future]

  test('store: request → consume 单次消费, 二次 consume 为 null', () => {
    useCalendarFocus.getState().request({
      dateIso: '2026-07-15T18:00:00Z',
      icalUid: 'uid-series',
      recurrenceId: null
    })
    expect(useCalendarFocus.getState().pending?.icalUid).toBe('uid-series')
    const target = useCalendarFocus.getState().consume()
    expect(target?.icalUid).toBe('uid-series')
    expect(useCalendarFocus.getState().pending).toBeNull()
    expect(useCalendarFocus.getState().consume()).toBeNull()
  })

  test('consume 出的 target 在序列中命中 → Layout setAnchor 的选中对象', () => {
    useCalendarFocus.getState().request({
      dateIso: '2026-07-15T15:00:00Z',
      icalUid: 'uid-series',
      recurrenceId: '2026-07-15T15:00:00Z'
    })
    const target = useCalendarFocus.getState().consume()
    expect(target).not.toBeNull()
    expect(matchFocusTarget(seq, target!, now)?.id).toBe(1)
  })

  test('recurrenceId 精确命中优先', () => {
    const m = matchFocusTarget(
      seq,
      { icalUid: 'uid-series', recurrenceId: '2026-07-15T15:00:00Z' },
      now
    )
    expect(m?.id).toBe(1)
  })

  test('recurrenceId null → 同 uid 第一个未来 occurrence', () => {
    const m = matchFocusTarget(seq, { icalUid: 'uid-series', recurrenceId: null }, now)
    expect(m?.id).toBe(2)
  })

  test('recurrenceId 失配 (detached 改期) → 退化未来优先', () => {
    const m = matchFocusTarget(seq, { icalUid: 'uid-series', recurrenceId: 'gone' }, now)
    expect(m?.id).toBe(2)
  })

  test('无未来 occurrence → 退化第一个; uid 不在窗口 → null (静默放弃)', () => {
    const lateNow = Date.parse('2026-07-15T23:00:00Z')
    expect(matchFocusTarget(seq, { icalUid: 'uid-series', recurrenceId: null }, lateNow)?.id).toBe(
      1
    )
    expect(matchFocusTarget(seq, { icalUid: 'uid-missing', recurrenceId: null }, now)).toBeNull()
  })
})
