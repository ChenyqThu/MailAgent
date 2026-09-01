// task 08-27 P5 — 日程时间冲突判定纯函数单测 (lib/conflict, node 环境, 零 hooks
// import 链, 对齐 calendar-agenda-layout.test.ts 惯例)。
//
// 覆盖已拍板的四条判据: 只算 mail↔mail 段相交 / 严格半开区间 (贴边不算) /
// 排除已取消与已拒 (暂定仍算) / 全天与跨天不参与; 外加自身排除与计数。

import { describe, expect, test } from 'vitest'

import {
  candidateFromEntry,
  candidateFromOccurrence,
  conflictsFor,
  detectConflicts,
  overlaps,
  type ConflictCandidate
} from '../../src/shared/components/calendar/lib/conflict'
import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'

/** 2026-06-01 起第 day 天 hour:minute 的本地时间 ISO。 */
function iso(day: number, hour = 0, minute = 0): string {
  return new Date(2026, 5, 1 + day, hour, minute).toISOString()
}
function ms(day: number, hour = 0, minute = 0): number {
  return new Date(2026, 5, 1 + day, hour, minute).getTime()
}

let seq = 0
function mkEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
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

function mkOcc(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-1',
    recurrence_id: null,
    sequence: 0,
    summary: '会议',
    occurrence_start_iso: iso(0, 9),
    occurrence_end_iso: iso(0, 10),
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: 'Work',
    organizer: 'boss@example.test',
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

function cand(id: string, fromHour: number, toHour: number): ConflictCandidate {
  return { id, title: id, startMs: ms(0, fromHour), endMs: ms(0, toHour) }
}

describe('相交口径 — 严格半开区间', () => {
  test('两段有真实交集 = 冲突', () => {
    expect(overlaps(cand('a', 9, 10), cand('b', 9, 11))).toBe(true)
    // b 完全包住 a
    expect(overlaps(cand('a', 10, 11), cand('b', 9, 12))).toBe(true)
  })

  test('完全分开 = 不冲突', () => {
    expect(overlaps(cand('a', 9, 10), cand('b', 11, 12))).toBe(false)
  })

  test('贴边 (前一场结束 = 后一场开始) 不算冲突', () => {
    expect(overlaps(cand('a', 9, 10), cand('b', 10, 11))).toBe(false)
    expect(overlaps(cand('b', 10, 11), cand('a', 9, 10))).toBe(false)
  })
})

describe('detectConflicts — 视图打标', () => {
  test('相交的两条各记 1 个对手, 不相交的不进表', () => {
    const hit = detectConflicts([cand('a', 9, 10), cand('b', 9, 11), cand('c', 14, 15)])
    expect(hit.get('a')).toBe(1)
    expect(hit.get('b')).toBe(1)
    expect(hit.has('c')).toBe(false)
  })

  test('对手数是真的计数, 且贴边的那对不互算', () => {
    const hit = detectConflicts([cand('a', 9, 12), cand('b', 10, 11), cand('c', 11, 13)])
    expect(hit.get('a')).toBe(2)
    expect(hit.get('b')).toBe(1) // b 与 c 贴边 (11:00), 只与 a 冲突
    expect(hit.get('c')).toBe(1)
  })

  test('孤零零一条不会跟自己冲突', () => {
    expect(detectConflicts([cand('a', 9, 10)]).size).toBe(0)
  })
})

describe('conflictsFor — 抽屉列冲突对象', () => {
  const self = cand('self', 10, 11)
  const others = [cand('later', 10, 12), cand('early', 9, 11), cand('far', 15, 16), self]

  test('排除自身 id', () => {
    expect(conflictsFor(self, others).map((c) => c.id)).not.toContain('self')
  })

  test('只留相交的, 按开始时间升序', () => {
    expect(conflictsFor(self, others).map((c) => c.id)).toEqual(['early', 'later'])
  })
})

describe('candidateFromEntry — 谁参与冲突判定', () => {
  test('普通 mail 定时条目参与', () => {
    expect(candidateFromEntry(mkEntry({ title: '周会' }), mkOcc())).toMatchObject({
      title: '周会',
      startMs: ms(0, 9),
      endMs: ms(0, 10)
    })
  })

  test('事项截止 / Agent 排程不参与 (跨源不算)', () => {
    expect(candidateFromEntry(mkEntry({ source: 'matter', endIso: null }), null)).toBeNull()
    expect(candidateFromEntry(mkEntry({ source: 'agent', endIso: null }), null)).toBeNull()
    // 即使后端给了 endIso, 非 mail 源一律不参与
    expect(candidateFromEntry(mkEntry({ source: 'matter' }), null)).toBeNull()
  })

  test('无 endIso 的 mail 时刻条目不参与', () => {
    expect(candidateFromEntry(mkEntry({ endIso: null }), mkOcc())).toBeNull()
  })

  test('全天 / 跨天 (置顶色带) 不参与', () => {
    expect(candidateFromEntry(mkEntry({ allDay: true }), mkOcc())).toBeNull()
    expect(candidateFromEntry(mkEntry({ multiDay: true }), mkOcc())).toBeNull()
  })

  test('已取消 / 自己已拒的会不占时间', () => {
    expect(candidateFromEntry(mkEntry(), mkOcc({ status: 'CANCELLED' }))).toBeNull()
    expect(candidateFromEntry(mkEntry(), mkOcc({ response_status: 'DECLINED' }))).toBeNull()
    // 大小写不敏感 (CalDAV 回读大小写不稳)
    expect(candidateFromEntry(mkEntry(), mkOcc({ response_status: 'declined' }))).toBeNull()
  })

  test('暂定 / 待回复仍然占时间 = 算冲突', () => {
    expect(candidateFromEntry(mkEntry(), mkOcc({ response_status: 'TENTATIVE' }))).not.toBeNull()
    expect(candidateFromEntry(mkEntry(), mkOcc({ response_status: 'NEEDS-ACTION' }))).not.toBeNull()
  })

  test('缓存没解析出 occurrence 时按占时间处理 —— 拿不到状态不等于那场会不存在', () => {
    expect(candidateFromEntry(mkEntry(), null)).not.toBeNull()
  })
})

describe('candidateFromOccurrence — 抽屉侧同一套判据', () => {
  test('id 用 occurrenceKey (与选中锚点 / 改期 override 同一把尺子)', () => {
    const occ = mkOcc({ id: 42 })
    expect(candidateFromOccurrence(occ)?.id).toBe(`42-${occ.occurrence_start_iso}`)
  })

  test('全天不参与', () => {
    expect(candidateFromOccurrence(mkOcc({ is_all_day: true }))).toBeNull()
  })

  test('跨本地日不参与 (与视图的置顶色带同判据)', () => {
    expect(
      candidateFromOccurrence(
        mkOcc({ occurrence_start_iso: iso(0, 22), occurrence_end_iso: iso(1, 2) })
      )
    ).toBeNull()
    // 结束恰在次日 00:00 的仍算单日 (endMs-1 归前一日)
    expect(
      candidateFromOccurrence(
        mkOcc({ occurrence_start_iso: iso(0, 22), occurrence_end_iso: iso(1, 0) })
      )
    ).not.toBeNull()
  })

  test('已取消 / 已拒不参与, 暂定参与', () => {
    expect(candidateFromOccurrence(mkOcc({ status: 'CANCELLED' }))).toBeNull()
    expect(candidateFromOccurrence(mkOcc({ response_status: 'DECLINED' }))).toBeNull()
    expect(candidateFromOccurrence(mkOcc({ response_status: 'TENTATIVE' }))).not.toBeNull()
  })
})
