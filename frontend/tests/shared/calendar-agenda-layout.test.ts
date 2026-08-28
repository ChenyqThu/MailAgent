// task 08-27 P5 — 日/周时间轴三源布局纯函数单测 (lib/agendaLayout +
// calendar-filter 的 agenda 版筛选, node 环境, 零 hooks import 链, 对齐
// calendar-month-grid.test.ts 惯例)。
// 覆盖: 条目三分 / 置顶色带列区间裁剪与 lane 堆叠 / 时刻标记定位与同刻级联 /
// mail 条目 occurrence 解析 (缓存命中/uid 回退/合成兜底) / 成员级排除过滤
// (dogfood 轮 2: 二级栏日历源树按 calendar 名 · matterId · agentId 各自勾选)。

import { describe, expect, test } from 'vitest'

import {
  agendaSrc,
  groupEntriesByLocalDay,
  layoutDayMoments,
  layoutTimelineBands,
  MOMENT_HEIGHT_PX,
  resolveMailOccurrence,
  splitTimelineEntries
} from '../../src/shared/components/calendar/lib/agendaLayout'
import { filterAgendaByMembers } from '../../src/shared/components/calendar/lib/calendar-filter'
import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'
import type { CalendarMemberExclusions } from '../../src/shared/state/calendar-view'

/** 只写要排除的那一组, 其余默认空集 (= 全选)。 */
function exclusions(
  over: Partial<Record<keyof CalendarMemberExclusions, string[]>> = {}
): CalendarMemberExclusions {
  return {
    mail: new Set(over.mail ?? []),
    matter: new Set(over.matter ?? []),
    agent: new Set(over.agent ?? [])
  }
}

/** 网格原点: 2026-06-01 本地 00:00。 */
const GRID_START = new Date(2026, 5, 1)
const HOUR_PX = 48

/** 第 n 天 h 点 m 分的本地时间 ISO。 */
function iso(day: number, hour = 0, minute = 0): string {
  return new Date(2026, 5, 1 + day, hour, minute).toISOString()
}

let seq = 0
function mk(over: Partial<AgendaEntry>): AgendaEntry {
  seq += 1
  return {
    id: `e-${seq}`,
    source: 'mail',
    hot: false,
    title: `条目 ${seq}`,
    startIso: iso(0, 9),
    endIso: iso(0, 10),
    allDay: false,
    multiDay: false,
    ...over
  }
}

function mkOcc(over: Partial<CalendarEventOccurrence>): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-1',
    recurrence_id: null,
    sequence: 0,
    summary: '缓存事件',
    occurrence_start_iso: iso(0, 9),
    occurrence_end_iso: iso(0, 10),
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: 'Work',
    organizer: 'me@example.test',
    attendees: [],
    location: '',
    url: '',
    status: 'CONFIRMED',
    response_status: 'ACCEPTED',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: null,
    ...over
  }
}

describe('filterAgendaByMembers — 三组各按自己的成员 id 排除', () => {
  const mailA = mk({ source: 'mail', calendarName: 'Work' })
  const mailB = mk({ source: 'mail', calendarName: 'Team' })
  const matter = mk({ source: 'matter', endIso: null, matterId: 'MAT-1' })
  const matter2 = mk({ source: 'matter', endIso: null, matterId: 'MAT-2' })
  const item = mk({ source: 'matter', endIso: null, matterId: 'MAT-1', itemId: '77' })
  const agent = mk({ source: 'agent', endIso: null, agentId: 'a-1' })
  const agent2 = mk({ source: 'agent', endIso: null, agentId: 'a-2' })
  const all = [mailA, mailB, matter, matter2, item, agent, agent2]

  test('空排除集 (=全选) 原样返回', () => {
    expect(filterAgendaByMembers(all, exclusions())).toEqual(all)
    expect(filterAgendaByMembers(all, undefined)).toEqual(all)
  })

  test('邮箱组: 排除 Team → 只滤该 calendar, 别的组不受影响', () => {
    const out = filterAgendaByMembers(all, exclusions({ mail: ['Team'] }))
    expect(out.map((e) => e.id)).toEqual([
      mailA.id,
      matter.id,
      matter2.id,
      item.id,
      agent.id,
      agent2.id
    ])
  })

  test('事项组: 排除 MAT-1 → 事项本身与它的行动项一起消失', () => {
    const out = filterAgendaByMembers(all, exclusions({ matter: ['MAT-1'] }))
    expect(out.map((e) => e.id)).toEqual([mailA.id, mailB.id, matter2.id, agent.id, agent2.id])
  })

  test('Agent 组: 排除 a-2 → 只留 a-1', () => {
    const out = filterAgendaByMembers(all, exclusions({ agent: ['a-2'] }))
    expect(out.map((e) => e.id)).toEqual([
      mailA.id,
      mailB.id,
      matter.id,
      matter2.id,
      item.id,
      agent.id
    ])
  })

  test('三组同时排除各管各的', () => {
    const out = filterAgendaByMembers(
      all,
      exclusions({ mail: ['Work'], matter: ['MAT-2'], agent: ['a-1'] })
    )
    expect(out.map((e) => e.id)).toEqual([mailB.id, matter.id, item.id, agent2.id])
  })

  test('没有成员身份的条目恒显示 (只受组级开关管)', () => {
    const orphanMail = mk({ source: 'mail' })
    const orphanMatter = mk({ source: 'matter', endIso: null })
    const out = filterAgendaByMembers(
      [orphanMail, orphanMatter, mailA],
      exclusions({ mail: ['Work'], matter: ['MAT-1'] })
    )
    expect(out.map((e) => e.id)).toEqual([orphanMail.id, orphanMatter.id])
  })
})

describe('splitTimelineEntries — 条目三分', () => {
  test('全天/跨天 → bands; mail 定时 → timed; 时间点 → moments', () => {
    const allday = mk({ allDay: true, startIso: iso(0), endIso: iso(1) })
    const span = mk({ multiDay: true, startIso: iso(0, 22), endIso: iso(1, 8) })
    const timedMail = mk({ startIso: iso(0, 9), endIso: iso(0, 10) })
    const matterDue = mk({ source: 'matter', startIso: iso(0, 15), endIso: null })
    const agentTick = mk({ source: 'agent', startIso: iso(0, 8), endIso: null })
    const mailNoEnd = mk({ source: 'mail', startIso: iso(0, 11), endIso: null })
    const out = splitTimelineEntries([allday, span, timedMail, matterDue, agentTick, mailNoEnd])
    expect(out.bands.map((e) => e.id)).toEqual([allday.id, span.id])
    expect(out.timed.map((e) => e.id)).toEqual([timedMail.id])
    expect(out.moments.map((e) => e.id)).toEqual([matterDue.id, agentTick.id, mailNoEnd.id])
  })
})

describe('layoutTimelineBands — 置顶条区', () => {
  test('周区 (dayCount=7): 列区间与 lane 与数据一致, 越界端点被裁剪', () => {
    const inWeek = mk({ multiDay: true, startIso: iso(2, 9), endIso: iso(4, 17) })
    const overhang = mk({ multiDay: true, startIso: iso(5, 9), endIso: iso(9, 17) })
    const { bands, laneCount } = layoutTimelineBands([inWeek, overhang], GRID_START, 7)
    const byId = new Map(bands.map((b) => [b.entry.id, b]))
    expect(byId.get(inWeek.id)).toMatchObject({ startCol: 2, span: 3, lane: 0 })
    expect(byId.get(overhang.id)).toMatchObject({ startCol: 5, span: 2, lane: 0 })
    expect(laneCount).toBe(1)
  })

  test('单日全天条目 = span 1 色带 (DTEND 次日 00:00 不占用结束日)', () => {
    const allday = mk({ allDay: true, startIso: iso(3), endIso: iso(4) })
    const { bands } = layoutTimelineBands([allday], GRID_START, 7)
    expect(bands[0]).toMatchObject({ startCol: 3, span: 1 })
  })

  test('重叠色带分 lane, 区外条目不出带', () => {
    const a = mk({ multiDay: true, startIso: iso(0, 9), endIso: iso(3, 17) })
    const b = mk({ multiDay: true, startIso: iso(2, 9), endIso: iso(5, 17) })
    const out = mk({ multiDay: true, startIso: iso(10, 9), endIso: iso(12, 17) })
    const { bands, laneCount } = layoutTimelineBands([a, b, out], GRID_START, 7)
    expect(bands).toHaveLength(2)
    expect(bands.map((x) => x.lane).sort()).toEqual([0, 1])
    expect(laneCount).toBe(2)
  })

  test('日区 (dayCount=1): 相交的跨天条目裁成整行 span 1', () => {
    const span = mk({ multiDay: true, startIso: iso(-2, 9), endIso: iso(2, 17) })
    const { bands } = layoutTimelineBands([span], GRID_START, 1)
    expect(bands[0]).toMatchObject({ startCol: 0, span: 1 })
  })
})

describe('layoutDayMoments — 时刻标记定位', () => {
  const dayMs = GRID_START.getTime()

  test('top 按时刻换算 (HOUR_PX=48: 15:00 → 720, 15:30 → 744)', () => {
    const a = mk({ source: 'matter', startIso: iso(0, 15), endIso: null })
    const b = mk({ source: 'agent', startIso: iso(0, 15, 30), endIso: null })
    const out = layoutDayMoments([a, b], dayMs, HOUR_PX)
    expect(out.map((m) => m.topPx)).toEqual([15 * HOUR_PX, 15.5 * HOUR_PX])
  })

  test('同刻标记依序向下级联避让 (20px 步进)', () => {
    const a = mk({ id: 'm-a', source: 'matter', startIso: iso(0, 8), endIso: null })
    const b = mk({ id: 'm-b', source: 'agent', startIso: iso(0, 8), endIso: null })
    const out = layoutDayMoments([a, b], dayMs, HOUR_PX)
    expect(out[0].topPx).toBe(8 * HOUR_PX)
    expect(out[1].topPx).toBe(8 * HOUR_PX + MOMENT_HEIGHT_PX + 2)
  })

  test('底部越界钳到最后一格', () => {
    const late = mk({ source: 'matter', startIso: iso(0, 23, 59), endIso: null })
    const out = layoutDayMoments([late], dayMs, HOUR_PX)
    expect(out[0].topPx).toBe(24 * HOUR_PX - MOMENT_HEIGHT_PX)
  })
})

describe('groupEntriesByLocalDay', () => {
  test('按本地开始日分组, 键 = YYYY-MM-DD', () => {
    const d0 = mk({ startIso: iso(0, 9) })
    const d1 = mk({ startIso: iso(1, 9) })
    const m = groupEntriesByLocalDay([d0, d1])
    expect(m.get('2026-06-01')?.map((e) => e.id)).toEqual([d0.id])
    expect(m.get('2026-06-02')?.map((e) => e.id)).toEqual([d1.id])
  })
})

describe('resolveMailOccurrence — 缓存解析三级', () => {
  test('eventId + 起点命中缓存 (状态字段跟着缓存走)', () => {
    const occ = mkOcc({ id: 7, occurrence_start_iso: iso(0, 9), status: 'CANCELLED' })
    const entry = mk({ eventId: 7, startIso: iso(0, 9) })
    expect(resolveMailOccurrence(entry, [occ])).toBe(occ)
  })

  test('eventId 未命中时按 icalUid + 起点回退', () => {
    const occ = mkOcc({ id: 99, ical_uid: 'uid-x', occurrence_start_iso: iso(0, 9) })
    const entry = mk({ eventId: 7, icalUid: 'uid-x', startIso: iso(0, 9) })
    expect(resolveMailOccurrence(entry, [occ])).toBe(occ)
  })

  test('全未命中 → 合成最小形状 (标题/时间来自 entry, endIso 空退化为 start)', () => {
    const entry = mk({
      eventId: 7,
      icalUid: 'uid-miss',
      title: '兜底事件',
      startIso: iso(0, 9),
      endIso: null,
      calendarName: 'Work'
    })
    const occ = resolveMailOccurrence(entry, [])
    expect(occ.id).toBe(7)
    expect(occ.summary).toBe('兜底事件')
    expect(occ.occurrence_end_iso).toBe(iso(0, 9))
    expect(occ.calendar_name).toBe('Work')
  })
})

describe('agendaSrc', () => {
  test('hot 只对 mail 生效', () => {
    expect(agendaSrc(mk({ source: 'mail', hot: true }))).toBe('hot')
    expect(agendaSrc(mk({ source: 'mail', hot: false }))).toBe('mail')
    expect(agendaSrc(mk({ source: 'matter', hot: true, endIso: null }))).toBe('matter')
  })
})
