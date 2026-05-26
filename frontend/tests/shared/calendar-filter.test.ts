// Phase 4·#1 — filterOccurrencesByCalendars 纯函数单测 (node 环境, 零 hooks
// import 链). 覆盖: 全选语义 (undefined / 空数组) / 单选 / 多选 / 无匹配 / 不可变.

import { describe, expect, test } from 'vitest'

import { filterOccurrencesByCalendars } from '../../src/shared/components/calendar/lib/calendar-filter'
import type { CalendarEventOccurrence } from '../../src/shared/api/types'

function occ(id: number, calendarName: string): CalendarEventOccurrence {
  return {
    id,
    ical_uid: `uid-${id}`,
    recurrence_id: null,
    sequence: 0,
    summary: `e${id}`,
    occurrence_start_iso: '2026-05-26T10:00:00Z',
    occurrence_end_iso: '2026-05-26T11:00:00Z',
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: calendarName,
    organizer: '',
    attendees: [],
    location: '',
    url: '',
    status: 'CONFIRMED',
    response_status: '',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: null
  }
}

describe('filterOccurrencesByCalendars (Phase 4·#1)', () => {
  const events = [occ(1, '日历'), occ(2, 'Work'), occ(3, '日历'), occ(4, 'Shared')]

  test('undefined selectedCalendars → 返回全部 (全选语义)', () => {
    expect(filterOccurrencesByCalendars(events, undefined)).toHaveLength(4)
  })

  test('空数组 → 返回全部 (= 全选语义, 跟 undefined 一致)', () => {
    expect(filterOccurrencesByCalendars(events, [])).toHaveLength(4)
  })

  test('单选 → 只保留匹配 calendar_name 的 occurrence', () => {
    const r = filterOccurrencesByCalendars(events, ['日历'])
    expect(r.map((e) => e.id)).toEqual([1, 3])
  })

  test('多选 → 保留匹配任一选中 calendar', () => {
    const r = filterOccurrencesByCalendars(events, ['Work', 'Shared'])
    expect(r.map((e) => e.id)).toEqual([2, 4])
  })

  test('无匹配 → 空数组', () => {
    expect(filterOccurrencesByCalendars(events, ['Nonexistent'])).toEqual([])
  })

  test('不修改入参数组 (返回新数组)', () => {
    const copy = [...events]
    filterOccurrencesByCalendars(events, ['日历'])
    expect(events).toEqual(copy)
  })
})
