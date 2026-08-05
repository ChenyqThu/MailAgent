// @vitest-environment happy-dom
//
// P1-4 A-1 split (2026-07-10) — behavior-pinning tests for the pure row-model
// helpers extracted from EmailList.tsx into emailListRows.ts. These functions
// previously had ZERO direct unit coverage (only e2e screenshots exercised
// them indirectly); this suite is the equivalence safety net for the split and
// for the A-2 data-pipeline hook extraction that follows.
//
// Convention: every assertion pins the CURRENT behavior verbatim (source line
// references point at emailListRows.ts). Where behavior looks surprising it is
// asserted as-is and annotated — do not "fix" semantics from inside this file.
//
// happy-dom env: emailListRows.ts imports @shared/state/email-filter for
// ALL_PRIORITIES / ALL_CATEGORIES, whose zustand store reads localStorage at
// module init — node env has no stable localStorage global.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  applyAxisFilters,
  applyMultiFilter,
  applyTab,
  categoryOf,
  computeRowHeight,
  flattenGroups,
  groupBySentAnchor,
  groupByThread,
  partitionByDate,
  partitionFlat,
  recipientIsMe,
  rowTopOfId,
  sortThreadGroups,
  startOfDay,
  type ListRow,
  type ThreadGroup
} from '@shared/components/email/emailListRows'
import {
  ALL_CATEGORIES,
  ALL_PRIORITIES,
  NO_FILTER_AXES,
  type FilterAxes
} from '@shared/state/email-filter'
import type { GroupKey } from '@shared/state/group-collapse'
import type { EnrichedEmailMeta } from '@shared/api/types'

// ─── Fixtures ─────────────────────────────────────────────────────────

/** Minimal EnrichedEmailMeta builder — every field the helpers read is
 *  overridable; the rest are inert defaults. */
function em(over: Partial<EnrichedEmailMeta> & { internal_id: number }): EnrichedEmailMeta {
  return {
    subject: `subject-${over.internal_id}`,
    sender: 'someone@example.test',
    mailbox: '收件箱',
    is_read: true,
    is_flagged: false,
    thread_id: null,
    date_received: null,
    snippet: null,
    lang: 'unknown',
    ai_priority: null,
    ai_action: null,
    ai_category: null,
    attach_count: 0,
    is_important: false,
    processing_status: null,
    ...over
  }
}

function emailRow(
  email: EnrichedEmailMeta,
  over: Partial<Extract<ListRow, { type: 'email' }>> = {}
): ListRow {
  return { type: 'email', email, groupKey: 'today', bundleSelected: false, ...over }
}

const NO_SUPPLEMENT: ReadonlyMap<string, ReadonlyArray<EnrichedEmailMeta>> = new Map()
const NO_NEW: ReadonlySet<number> = new Set()

const LABELS: Record<GroupKey, string> = {
  pinned: 'PINNED',
  // 'flat' 桶不出标题（flattenGroups 跳过 header）—— 值只为补齐 Record。
  flat: '',
  today: 'TODAY',
  yesterday: 'YESTERDAY',
  thisWeek: 'THIS_WEEK',
  lastWeek: 'LAST_WEEK',
  older: 'OLDER'
}

function emptyBuckets(): Record<GroupKey, ThreadGroup[]> {
  return { pinned: [], flat: [], today: [], yesterday: [], thisWeek: [], lastWeek: [], older: [] }
}

function soloGroup(email: EnrichedEmailMeta): ThreadGroup {
  return { threadId: null, head: email, children: [], anchorDate: email.date_received ?? null }
}

// ─── applyAxisFilters（2026-08 起取代单选 chip applyChipFilter） ────────

describe('applyAxisFilters', () => {
  const rows = [
    em({ internal_id: 1, is_read: false }),
    em({ internal_id: 2, is_flagged: true }),
    em({ internal_id: 3, sync_status: 'failed' }),
    em({ internal_id: 4, sync_status: 'dead_letter' }),
    em({ internal_id: 5, attach_count: 2 }),
    em({ internal_id: 6, processing_status: '已完成' }),
    em({ internal_id: 7, to_addr: '"Doe, John" <ME@Example.test>, x@y.test' })
  ]
  const axes = (over: Partial<FilterAxes> = {}): FilterAxes => ({ ...NO_FILTER_AXES, ...over })
  const ids = (out: ReadonlyArray<{ internal_id: number }>): number[] =>
    out.map((r) => r.internal_id)

  test('全 false → 原样拷贝（防御性 copy，不是同一引用）', () => {
    const out = applyAxisFilters(axes(), rows, 'me@example.test')
    expect(ids(out)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(out).not.toBe(rows)
  })

  test('unread 只留 is_read=false', () => {
    expect(ids(applyAxisFilters(axes({ unread: true }), rows, null))).toEqual([1])
  })

  test("flagMark='flagged' 排除「已完成」（三态里 done 不算 flagged）", () => {
    const withDoneFlag = [
      ...rows,
      em({ internal_id: 8, is_flagged: true, processing_status: '已完成' })
    ]
    expect(ids(applyAxisFilters(axes({ flagMark: 'flagged' }), withDoneFlag, null))).toEqual([2])
  })

  test("flagMark='done' 只看 processing_status", () => {
    expect(ids(applyAxisFilters(axes({ flagMark: 'done' }), rows, null))).toEqual([6])
  })

  test('hasAttach 需要 attach_count > 0', () => {
    expect(ids(applyAxisFilters(axes({ hasAttach: true }), rows, null))).toEqual([5])
  })

  test('failed 同时收 failed 与 dead_letter（沿用旧 chip 口径）', () => {
    expect(ids(applyAxisFilters(axes({ failed: true }), rows, null))).toEqual([3, 4])
  })

  test('toMe 忽略大小写、认带显示名的收件人头', () => {
    expect(ids(applyAxisFilters(axes({ toMe: true }), rows, 'me@example.test'))).toEqual([7])
  })

  test('🔴 toMe 在 userEmail 未知时惰性 —— 不过滤，而不是清空列表', () => {
    expect(ids(applyAxisFilters(axes({ toMe: true }), rows, null))).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  test('多条轴按 AND 组合', () => {
    const both = [
      em({ internal_id: 10, is_read: false, attach_count: 1 }),
      em({ internal_id: 11, is_read: false }),
      em({ internal_id: 12, attach_count: 3 })
    ]
    expect(ids(applyAxisFilters(axes({ unread: true, hasAttach: true }), both, null))).toEqual([10])
  })
})

describe('recipientIsMe', () => {
  test('剥 mailto: + 大小写无关', () => {
    expect(recipientIsMe('mailto:ME@Example.test', 'me@example.test')).toBe(true)
    expect(recipientIsMe('Me@Example.test', 'MAILTO:me@example.test')).toBe(true)
  })
  test('多收件人里命中任意一个', () => {
    expect(recipientIsMe('a@x.test, me@example.test, b@y.test', 'me@example.test')).toBe(true)
  })
  test('空 to_addr / 空 userEmail → false（判据缺失不算命中）', () => {
    expect(recipientIsMe(null, 'me@example.test')).toBe(false)
    expect(recipientIsMe('me@example.test', null)).toBe(false)
    expect(recipientIsMe('me@example.test', '   ')).toBe(false)
  })
  test('不匹配的收件人 → false', () => {
    expect(recipientIsMe('someone@else.test', 'me@example.test')).toBe(false)
  })
})

// ─── applyTab ─────────────────────────────────────────────────────────

describe('applyTab', () => {
  const rows = [
    em({ internal_id: 1, ai_priority: 'low' }),
    em({ internal_id: 2, ai_priority: 'urgent' }),
    em({ internal_id: 3, ai_priority: null })
  ]

  test("'other' keeps only ai_priority === 'low'", () => {
    expect(applyTab('other', rows).map((r) => r.internal_id)).toEqual([1])
  })

  test("'focused' keeps everything that is not low", () => {
    expect(applyTab('focused', rows).map((r) => r.internal_id)).toEqual([2, 3])
  })

  test("'focused' keeps unclassified rows (ai_priority null) so new mail never lands in Other", () => {
    expect(applyTab('focused', [em({ internal_id: 9, ai_priority: null })])).toHaveLength(1)
  })
})

// ─── categoryOf ───────────────────────────────────────────────────────

describe('categoryOf', () => {
  test('null when the LLM has not classified the row', () => {
    expect(categoryOf(em({ internal_id: 1, ai_category: null }))).toBeNull()
  })

  test('returns the verbatim emoji-prefixed label', () => {
    expect(categoryOf(em({ internal_id: 1, ai_category: '💼 产品管理' }))).toBe('💼 产品管理')
  })
})

// ─── applyMultiFilter ─────────────────────────────────────────────────

describe('applyMultiFilter', () => {
  const fullPri = new Set(ALL_PRIORITIES)
  const fullCat = new Set(ALL_CATEGORIES)

  test('full priority + full category selections short-circuit to a copy', () => {
    const rows = [em({ internal_id: 1 }), em({ internal_id: 2 })]
    const out = applyMultiFilter(rows, fullPri, fullCat)
    expect(out.map((r) => r.internal_id)).toEqual([1, 2])
    expect(out).not.toBe(rows)
  })

  test('a priority subset keeps matches and DROPS unclassified (null priority) rows', () => {
    // Pinned behavior (emailListRows.ts applyMultiFilter): the priority leg
    // excludes ai_priority === null when the selection is not full — the
    // "keep unclassified" leniency applies to categories only.
    const rows = [
      em({ internal_id: 1, ai_priority: 'urgent' }),
      em({ internal_id: 2, ai_priority: 'low' }),
      em({ internal_id: 3, ai_priority: null })
    ]
    const out = applyMultiFilter(rows, new Set(['urgent']), fullCat)
    expect(out.map((r) => r.internal_id)).toEqual([1])
  })

  test('a category subset keeps unclassified (null category) rows', () => {
    const rows = [
      em({ internal_id: 1, ai_category: '💼 产品管理' }),
      em({ internal_id: 2, ai_category: '🔔 系统通知' }),
      em({ internal_id: 3, ai_category: null })
    ]
    const out = applyMultiFilter(rows, fullPri, new Set(['💼 产品管理']))
    expect(out.map((r) => r.internal_id)).toEqual([1, 3])
  })

  test('priority and category legs compose with AND', () => {
    const rows = [
      em({ internal_id: 1, ai_priority: 'urgent', ai_category: '💼 产品管理' }),
      em({ internal_id: 2, ai_priority: 'urgent', ai_category: '🔔 系统通知' }),
      em({ internal_id: 3, ai_priority: 'normal', ai_category: '💼 产品管理' })
    ]
    const out = applyMultiFilter(rows, new Set(['urgent']), new Set(['💼 产品管理']))
    expect(out.map((r) => r.internal_id)).toEqual([1])
  })
})

// ─── groupByThread ────────────────────────────────────────────────────

describe('groupByThread', () => {
  test('emails without thread_id are solitary (threadId null, no children)', () => {
    const groups = groupByThread(
      [em({ internal_id: 1, date_received: '2026-07-08T10:00:00' })],
      NO_SUPPLEMENT
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      threadId: null,
      children: [],
      anchorDate: '2026-07-08T10:00:00'
    })
  })

  test('a single-message thread is functionally solitary (threadId null — no chevron)', () => {
    const groups = groupByThread(
      [em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' })],
      NO_SUPPLEMENT
    )
    expect(groups[0]!.threadId).toBeNull()
    expect(groups[0]!.children).toHaveLength(0)
  })

  test('multi-message thread: head = newest by date_received, children in DESC order', () => {
    const groups = groupByThread(
      [
        em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-06T10:00:00' }),
        em({ internal_id: 2, thread_id: 't1', date_received: '2026-07-08T10:00:00' }),
        em({ internal_id: 3, thread_id: 't1', date_received: '2026-07-07T10:00:00' })
      ],
      NO_SUPPLEMENT
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.threadId).toBe('t1')
    expect(groups[0]!.head.internal_id).toBe(2)
    expect(groups[0]!.children.map((c) => c.internal_id)).toEqual([3, 1])
  })

  test('de-dupes by internal_id — the same email never surfaces twice', () => {
    const dup = em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' })
    const groups = groupByThread(
      [dup, dup, em({ internal_id: 2, thread_id: 't1', date_received: '2026-07-07T10:00:00' })],
      NO_SUPPLEMENT
    )
    const ids = [groups[0]!.head.internal_id, ...groups[0]!.children.map((c) => c.internal_id)]
    expect(ids).toEqual([1, 2])
  })

  test('supplement merges cross-mailbox siblings; a newer supplement message becomes head but anchorDate stays newest VISIBLE', () => {
    // #10 dogfood semantics: my sent reply (today, from supplement) may lead
    // the bundle, but sort/bucket anchor comes from the visible inbox set.
    const supplement = new Map([
      [
        't1',
        [
          em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' }), // dup of visible — skipped
          em({
            internal_id: 9,
            thread_id: 't1',
            date_received: '2026-07-10T09:00:00',
            mailbox: '发件箱'
          })
        ]
      ]
    ])
    const groups = groupByThread(
      [
        em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' }),
        em({ internal_id: 2, thread_id: 't1', date_received: '2026-07-07T10:00:00' })
      ],
      supplement
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.head.internal_id).toBe(9) // supplement sent reply leads
    expect(groups[0]!.children.map((c) => c.internal_id)).toEqual([1, 2])
    expect(groups[0]!.anchorDate).toBe('2026-07-08T10:00:00') // newest visible, not 07-10
  })

  test('supplement-only rows retain metadata snippets for preview height', () => {
    const supplement = new Map([
      [
        't1',
        [
          em({
            internal_id: 9,
            thread_id: 't1',
            date_received: '2026-07-07T09:00:00',
            snippet: 'supplement body preview'
          })
        ]
      ]
    ])
    const groups = groupByThread(
      [em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' })],
      supplement
    )
    const child = groups[0]!.children.find((row) => row.internal_id === 9)
    expect(child?.snippet).toBe('supplement body preview')
    expect(
      computeRowHeight(
        child ? emailRow(child, { thread: { threadId: 't1', isHead: false } }) : undefined,
        NO_NEW
      )
    ).toBe(84)
  })

  test('groups sort by anchorDate DESC — supplement messages do not bump thread order', () => {
    const supplement = new Map([
      ['tA', [em({ internal_id: 11, thread_id: 'tA', date_received: '2026-07-10T09:00:00' })]]
    ])
    const groups = groupByThread(
      [
        em({ internal_id: 1, thread_id: 'tA', date_received: '2026-07-08T10:00:00' }),
        em({ internal_id: 2, thread_id: 'tA', date_received: '2026-07-07T10:00:00' }),
        em({ internal_id: 3, thread_id: 'tB', date_received: '2026-07-09T10:00:00' }),
        em({ internal_id: 4, thread_id: 'tB', date_received: '2026-07-06T10:00:00' })
      ],
      supplement
    )
    // tB (visible anchor 07-09) outranks tA (visible anchor 07-08) even though
    // tA's absolute newest message (supplement, 07-10) is fresher.
    expect(groups.map((g) => g.threadId)).toEqual(['tB', 'tA'])
  })
})

// ─── groupBySentAnchor ────────────────────────────────────────────────

describe('groupBySentAnchor', () => {
  test('sent email without supplement (or single-entry thread) is solitary', () => {
    const sent = em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' })
    const groups = groupBySentAnchor([sent], new Map([['t1', [sent]]]))
    expect(groups[0]).toMatchObject({
      threadId: null,
      children: [],
      anchorDate: '2026-07-08T10:00:00'
    })
  })

  test('children = strictly EARLIER thread context, excluding other sent anchors, DESC order', () => {
    const s1 = em({
      internal_id: 1,
      thread_id: 't1',
      date_received: '2026-07-08T10:00:00',
      mailbox: '发件箱'
    })
    const s2 = em({
      internal_id: 2,
      thread_id: 't1',
      date_received: '2026-07-05T10:00:00',
      mailbox: '发件箱'
    })
    const c1 = em({ internal_id: 3, thread_id: 't1', date_received: '2026-07-07T10:00:00' })
    const c2 = em({ internal_id: 4, thread_id: 't1', date_received: '2026-07-06T10:00:00' })
    const later = em({ internal_id: 5, thread_id: 't1', date_received: '2026-07-09T10:00:00' })
    const supplement = new Map([['t1', [s1, s2, c1, c2, later]]])

    const groups = groupBySentAnchor([s1, s2], supplement)
    expect(groups).toHaveLength(2)
    // s1 (07-08) sorts before s2 (07-05); its context = c1 + c2 (earlier only,
    // `later` @07-09 excluded, fellow anchor s2 excluded via anchorIds).
    expect(groups[0]!.head.internal_id).toBe(1)
    expect(groups[0]!.threadId).toBe('t1')
    expect(groups[0]!.children.map((c) => c.internal_id)).toEqual([3, 4])
    // s2 has no messages earlier than 07-05 → solitary (threadId null).
    expect(groups[1]!.head.internal_id).toBe(2)
    expect(groups[1]!.threadId).toBeNull()
    expect(groups[1]!.children).toHaveLength(0)
  })

  test('a thread message with the SAME timestamp as the sent anchor is excluded (strict <)', () => {
    const sent = em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' })
    const same = em({ internal_id: 2, thread_id: 't1', date_received: '2026-07-08T10:00:00' })
    const groups = groupBySentAnchor([sent], new Map([['t1', [sent, same]]]))
    expect(groups[0]!.children).toHaveLength(0)
    expect(groups[0]!.threadId).toBeNull()
  })

  test('groups sort by sent date DESC', () => {
    const a = em({ internal_id: 1, date_received: '2026-07-05T10:00:00' })
    const b = em({ internal_id: 2, date_received: '2026-07-09T10:00:00' })
    const groups = groupBySentAnchor([a, b], NO_SUPPLEMENT)
    expect(groups.map((g) => g.head.internal_id)).toEqual([2, 1])
  })
})

// ─── partitionByDate ──────────────────────────────────────────────────

describe('partitionByDate', () => {
  // Frozen clock: Friday 2026-07-10 12:00 local (vitest TZ pins
  // America/Los_Angeles). Derived boundaries — today: 07-10T00:00,
  // yesterday: 07-09, weekStart (Monday): 07-06, lastWeekStart: 06-29.
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const NO_PINS: ReadonlySet<number> = new Set()

  test('startOfDay zeroes the time-of-day in local time', () => {
    const d = startOfDay(new Date('2026-07-10T12:34:56'))
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0
    ])
    expect(d.getDate()).toBe(10)
  })

  test('routes groups into today / yesterday / thisWeek / lastWeek / older', () => {
    const buckets = partitionByDate(
      [
        soloGroup(em({ internal_id: 1, date_received: '2026-07-10T08:00:00' })),
        soloGroup(em({ internal_id: 2, date_received: '2026-07-09T23:00:00' })),
        soloGroup(em({ internal_id: 3, date_received: '2026-07-07T10:00:00' })),
        soloGroup(em({ internal_id: 4, date_received: '2026-07-01T10:00:00' })),
        soloGroup(em({ internal_id: 5, date_received: '2026-06-20T10:00:00' }))
      ],
      NO_PINS
    )
    expect(buckets.today.map((g) => g.head.internal_id)).toEqual([1])
    expect(buckets.yesterday.map((g) => g.head.internal_id)).toEqual([2])
    expect(buckets.thisWeek.map((g) => g.head.internal_id)).toEqual([3])
    expect(buckets.lastWeek.map((g) => g.head.internal_id)).toEqual([4])
    expect(buckets.older.map((g) => g.head.internal_id)).toEqual([5])
  })

  test('a pinned HEAD lifts the whole group into the pinned bucket', () => {
    const g = soloGroup(em({ internal_id: 1, date_received: '2026-07-10T08:00:00' }))
    const buckets = partitionByDate([g], new Set([1]))
    expect(buckets.pinned).toHaveLength(1)
    expect(buckets.today).toHaveLength(0)
  })

  test('a pinned CHILD also lifts the whole thread ("固定也是整个线程固定")', () => {
    const g: ThreadGroup = {
      threadId: 't1',
      head: em({ internal_id: 1, date_received: '2026-07-10T08:00:00' }),
      children: [em({ internal_id: 2, date_received: '2026-07-09T08:00:00' })],
      anchorDate: '2026-07-10T08:00:00'
    }
    const buckets = partitionByDate([g], new Set([2]))
    expect(buckets.pinned).toHaveLength(1)
    expect(buckets.today).toHaveLength(0)
  })

  test('anchorDate outranks head.date_received for bucketing (#10 dogfood)', () => {
    // Head is a supplement sent reply stamped today; anchorDate (newest
    // visible inbox mail) is last week — the thread must NOT bucket as today.
    const g: ThreadGroup = {
      threadId: 't1',
      head: em({ internal_id: 1, date_received: '2026-07-10T09:00:00' }),
      children: [em({ internal_id: 2, date_received: '2026-07-01T08:00:00' })],
      anchorDate: '2026-07-01T08:00:00'
    }
    const buckets = partitionByDate([g], NO_PINS)
    expect(buckets.lastWeek).toHaveLength(1)
    expect(buckets.today).toHaveLength(0)
  })

  test('groups without any date fall into older', () => {
    const buckets = partitionByDate(
      [soloGroup(em({ internal_id: 1, date_received: null }))],
      NO_PINS
    )
    expect(buckets.older).toHaveLength(1)
  })
})

// ─── sortThreadGroups / partitionFlat（非日期排序） ────────────────────

describe('sortThreadGroups', () => {
  const g = (id: number, over: Partial<EnrichedEmailMeta> = {}): ThreadGroup =>
    soloGroup(em({ internal_id: id, ...over }))

  test('sender desc = Z→A，显示名优先、空显示名回落地址（与 SQL 的 COALESCE(NULLIF(...)) 同义）', () => {
    const groups = [
      g(1, { sender_name: 'Bob', sender: 'zzz@x.test' }),
      g(2, { sender_name: null, sender: 'alice@x.test' }),
      g(3, { sender_name: '', sender: 'carol@x.test' })
    ]
    expect(sortThreadGroups(groups, 'sender', 'asc').map((x) => x.head.internal_id)).toEqual([
      2, 1, 3
    ])
    expect(sortThreadGroups(groups, 'sender', 'desc').map((x) => x.head.internal_id)).toEqual([
      3, 1, 2
    ])
  })

  test('subject 大小写无关', () => {
    const groups = [g(1, { subject: 'beta' }), g(2, { subject: 'Alpha' })]
    expect(sortThreadGroups(groups, 'subject', 'asc').map((x) => x.head.internal_id)).toEqual([
      2, 1
    ])
  })

  test('importance desc = critical 在最前', () => {
    const groups = [
      g(1, { ai_priority: 'low' }),
      g(2, { ai_priority: 'critical' }),
      g(3, { ai_priority: 'normal' })
    ]
    expect(sortThreadGroups(groups, 'importance', 'desc').map((x) => x.head.internal_id)).toEqual([
      2, 3, 1
    ])
  })

  test('🔴 未分类优先级恒沉底 —— 升序也不许被顶到最前', () => {
    const groups = [
      g(1, { ai_priority: null }),
      g(2, { ai_priority: 'critical' }),
      g(3, { ai_priority: 'low' })
    ]
    expect(sortThreadGroups(groups, 'importance', 'desc').map((x) => x.head.internal_id)).toEqual([
      2, 3, 1
    ])
    expect(sortThreadGroups(groups, 'importance', 'asc').map((x) => x.head.internal_id)).toEqual([
      3, 2, 1
    ])
  })

  test('同值时 internal_id 作稳定第二键；不改原数组', () => {
    const groups = [g(3, { subject: 'same' }), g(1, { subject: 'same' }), g(2, { subject: 'same' })]
    expect(sortThreadGroups(groups, 'subject', 'asc').map((x) => x.head.internal_id)).toEqual([
      1, 2, 3
    ])
    expect(groups.map((x) => x.head.internal_id)).toEqual([3, 1, 2])
  })
})

describe('partitionFlat', () => {
  test('只产出 pinned + flat；flat 保持传入顺序（不再按日期切段）', () => {
    const groups = [
      soloGroup(em({ internal_id: 1, date_received: '2020-01-01T00:00:00' })),
      soloGroup(em({ internal_id: 2, date_received: '2099-01-01T00:00:00' })),
      soloGroup(em({ internal_id: 3 }))
    ]
    const buckets = partitionFlat(groups, new Set([3]))
    expect(buckets.pinned.map((g) => g.head.internal_id)).toEqual([3])
    expect(buckets.flat.map((g) => g.head.internal_id)).toEqual([1, 2])
    for (const k of ['today', 'yesterday', 'thisWeek', 'lastWeek', 'older'] as const) {
      expect(buckets[k]).toEqual([])
    }
  })

  test('线程里任一成员被固定 → 整条线程进 pinned（与 partitionByDate 同语义）', () => {
    const g: ThreadGroup = {
      threadId: 't1',
      head: em({ internal_id: 1 }),
      children: [em({ internal_id: 2 })],
      anchorDate: null
    }
    expect(partitionFlat([g], new Set([2])).pinned).toHaveLength(1)
    expect(partitionFlat([g], new Set([2])).flat).toHaveLength(0)
  })
})

// ─── flattenGroups ────────────────────────────────────────────────────

describe('flattenGroups', () => {
  const notCollapsed = (): boolean => false
  const notExpanded = (): boolean => false

  test('emits bucket headers in fixed order, skips empty buckets; count = bundles NOT total messages', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 }), em({ internal_id: 3 })],
        anchorDate: null
      }
    ]
    buckets.older = [soloGroup(em({ internal_id: 4 }))]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, null, false)
    expect(rows.map((r) => r.type)).toEqual(['header', 'email', 'header', 'email'])
    const h0 = rows[0] as Extract<ListRow, { type: 'header' }>
    expect(h0).toMatchObject({ key: 'today', label: 'TODAY', count: 1, collapsed: false })
  })

  test('a collapsed bucket renders its header only', () => {
    const buckets = emptyBuckets()
    buckets.today = [soloGroup(em({ internal_id: 1 }))]
    const rows = flattenGroups(buckets, LABELS, () => true, notExpanded, null, false)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ type: 'header', collapsed: true })
  })

  test('a folded thread head carries thread info (isHead, childCount, expanded:false, 成员聚合) and hides children', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 }), em({ internal_id: 3 })],
        anchorDate: null
      }
    ]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, null, false)
    expect(rows).toHaveLength(2) // header + 虚拟头 only
    const head = rows[1] as Extract<ListRow, { type: 'email' }>
    expect(head.thread).toEqual({
      isHead: true,
      threadId: 't1',
      childCount: 2,
      expanded: false,
      // 成员集含最新一封自己 (虚拟头代表整条线程, 不是「除自己以外的兄弟」)。
      agg: { memberIds: [1, 2, 3], aggFlagged: false }
    })
  })

  test('虚拟头 aggFlagged = 任一成员 is_flagged（哪怕最新一封自己没标）', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1, is_flagged: false }),
        children: [em({ internal_id: 2, is_flagged: true }), em({ internal_id: 3 })],
        anchorDate: null
      },
      // 对照组: 全员无旗 → false。
      {
        threadId: 't2',
        head: em({ internal_id: 11 }),
        children: [em({ internal_id: 12 })],
        anchorDate: null
      }
    ]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, null, false)
    const heads = rows
      .filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
      .map((r) => (r.thread?.isHead ? r.thread.agg?.aggFlagged : null))
    expect(heads).toEqual([true, false])
  })

  test('线程虚拟头 — 展开的子行含最新一封自己 (DESC, 最新在最上)', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 })],
        anchorDate: null
      }
    ]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, (tid) => tid === 't1', null, false)
    // header + 虚拟头 + 2 子行 (最新一封 1 也在子行里)。
    expect(rows).toHaveLength(4)
    const emails = rows.filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
    expect(emails.map((r) => r.email.internal_id)).toEqual([1, 1, 2])
    expect(emails[0]!.thread?.isHead).toBe(true)
    expect(emails[1]!.thread).toEqual({ isHead: false, threadId: 't1', childIndex: 0 })
    expect(emails[2]!.thread).toEqual({ isHead: false, threadId: 't1', childIndex: 1 })
  })

  test('child rows carry a 0-based childIndex (线程展开入场动画的 stagger 依据)', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 }), em({ internal_id: 3 }), em({ internal_id: 4 })],
        anchorDate: null
      }
    ]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, (tid) => tid === 't1', null, false)
    // header + 虚拟头 + 4 子行 (含最新一封)
    expect(rows).toHaveLength(6)
    const indices = rows
      .slice(2)
      .map((r) => (r as Extract<ListRow, { type: 'email' }>).thread)
      .map((t) => (t && !t.isHead ? t.childIndex : null))
    // 连续且从 0 起 —— CSS animation-delay 直接乘这个值, 跳号会让入场节奏破相。
    expect(indices).toEqual([0, 1, 2, 3])
  })

  test('主题 v3 — expanded thread: only the row activeId hits is selected, not the whole bundle', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 })],
        anchorDate: null
      },
      soloGroup(em({ internal_id: 5 }))
    ]
    // activeId = child id 2, thread expanded → ONLY the child row selected;
    // head and the unrelated solitary row stay unselected (2026-07-12 owner
    // 实机 review: 整 bundle 连坐高亮取消).
    const rows = flattenGroups(buckets, LABELS, notCollapsed, (tid) => tid === 't1', 2, false)
    const emails = rows.filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
    expect(emails.map((r) => [r.email.internal_id, r.bundleSelected])).toEqual([
      [1, false], // 虚拟头
      [1, false], // 最新一封的子行
      [2, true],
      [5, false]
    ])
  })

  test('🔴 展开时 activeId 命中最新一封 → 只亮子行, 虚拟头不亮 (同一封不许亮两行)', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 })],
        anchorDate: null
      }
    ]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, (tid) => tid === 't1', 1, false)
    const emails = rows.filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
    expect(emails.map((r) => [r.email.internal_id, r.bundleSelected])).toEqual([
      [1, false], // 虚拟头 —— 展开态下不套 active 样式
      [1, true], // 它自己的子行才是选中那行
      [2, false]
    ])
  })

  test('主题 v3 — collapsed thread head stands in for a hidden selected child', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 })],
        anchorDate: null
      }
    ]
    // activeId = child id 2 but the thread is COLLAPSED → the head row (the
    // only visible representative of the bundle) carries the selection.
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, 2, false)
    const emails = rows.filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
    expect(emails.map((r) => [r.email.internal_id, r.bundleSelected])).toEqual([[1, true]])
  })

  test('solitary 行不带 thread 块 → 保持单封语义 (零聚合零级联)', () => {
    const buckets = emptyBuckets()
    // groupBySentAnchor 的无上下文发件 + groupByThread 的单封线程都退化成这个形状。
    buckets.today = [soloGroup(em({ internal_id: 5, is_flagged: true }))]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, null, false)
    const row = rows[1] as Extract<ListRow, { type: 'email' }>
    expect(row.thread).toBeUndefined()
  })

  test('🔴 发件箱 sent-anchor 分组不吃虚拟头语义 (无 agg + 展开不重复 head)', () => {
    // 发件箱的 head 是「我发的那封」锚点、**不在** children 里 (children 是它之前的
    // 上下文)。给它套虚拟头会让展开时发件重复出现, 且点旗标会级联改掉一堆我根本没在
    // 看的上下文邮件 —— 所以 groupBySentAnchor 打 sentAnchor 标, flatten 据此退回单封。
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1, is_flagged: true }),
        children: [em({ internal_id: 2, is_flagged: true })],
        anchorDate: null,
        sentAnchor: true
      }
    ]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, (tid) => tid === 't1', null, false)
    const emails = rows.filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
    // header + 锚点 + 1 条上下文 (锚点不重复出现)
    expect(emails.map((r) => r.email.internal_id)).toEqual([1, 2])
    const head = emails[0]!
    expect(head.thread?.isHead).toBe(true)
    // 无 agg → EmailRow 走纯单封语义 (无聚合显示、无级联写)
    expect(head.thread?.isHead === true && head.thread.agg).toBeUndefined()
  })

  test('sent-anchor 折叠时仍由锚点行代表隐藏的选中上下文 (选中态可见性不回退)', () => {
    const buckets = emptyBuckets()
    buckets.today = [
      {
        threadId: 't1',
        head: em({ internal_id: 1 }),
        children: [em({ internal_id: 2 })],
        anchorDate: null,
        sentAnchor: true
      }
    ]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, 2, false)
    const emails = rows.filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
    expect(emails.map((r) => [r.email.internal_id, r.bundleSelected])).toEqual([[1, true]])
  })

  test('groupBySentAnchor 给带上下文的分组打 sentAnchor 标 (孤立发件不打)', () => {
    const s1 = em({ internal_id: 1, thread_id: 't1', date_received: '2026-07-08T10:00:00' })
    const ctx = em({ internal_id: 3, thread_id: 't1', date_received: '2026-07-07T10:00:00' })
    const lone = em({ internal_id: 9, thread_id: 't2', date_received: '2026-07-06T10:00:00' })
    const groups = groupBySentAnchor(
      [s1, lone],
      new Map([
        ['t1', [s1, ctx]],
        ['t2', [lone]]
      ])
    )
    expect(groups.find((g) => g.head.internal_id === 1)?.sentAnchor).toBe(true)
    // 无上下文 → 退化成 solitary, 本来就没 thread 块, 不需要标。
    expect(groups.find((g) => g.head.internal_id === 9)?.sentAnchor).toBeUndefined()
  })

  test('a solitary row is bundleSelected when activeId matches its head', () => {
    const buckets = emptyBuckets()
    buckets.today = [soloGroup(em({ internal_id: 5 }))]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, 5, false)
    expect((rows[1] as Extract<ListRow, { type: 'email' }>).bundleSelected).toBe(true)
  })

  test("🔴 'flat' 桶不出分组标题（非日期排序 = 平铺），但 pinned 桶的标题照出且恒在最上", () => {
    const buckets = emptyBuckets()
    buckets.pinned = [soloGroup(em({ internal_id: 9 }))]
    buckets.flat = [soloGroup(em({ internal_id: 1 })), soloGroup(em({ internal_id: 2 }))]
    const rows = flattenGroups(buckets, LABELS, notCollapsed, notExpanded, null, false)
    expect(rows.map((r) => r.type)).toEqual(['header', 'email', 'email', 'email'])
    expect(rows[0]).toMatchObject({ type: 'header', key: 'pinned' })
    expect(
      rows
        .filter((r): r is Extract<ListRow, { type: 'email' }> => r.type === 'email')
        .map((r) => r.email.internal_id)
    ).toEqual([9, 1, 2])
  })

  test("'flat' 桶不吃折叠状态（collapsedOf 说 true 也照渲染 —— 它没有可点的标题）", () => {
    const buckets = emptyBuckets()
    buckets.flat = [soloGroup(em({ internal_id: 1 }))]
    const rows = flattenGroups(buckets, LABELS, () => true, notExpanded, null, false)
    expect(rows.map((r) => r.type)).toEqual(['email'])
  })

  test('appendLoader adds the trailing loader sentinel row', () => {
    const rows = flattenGroups(emptyBuckets(), LABELS, notCollapsed, notExpanded, null, true)
    expect(rows).toEqual([{ type: 'loader' }])
  })
})

// ─── computeRowHeight ─────────────────────────────────────────────────

describe('computeRowHeight', () => {
  test('undefined row → 28, header → 28, loader → 44', () => {
    expect(computeRowHeight(undefined, NO_NEW)).toBe(28)
    expect(
      computeRowHeight(
        { type: 'header', key: 'today', label: 'TODAY', count: 1, collapsed: false },
        NO_NEW
      )
    ).toBe(28)
    expect(computeRowHeight({ type: 'loader' }, NO_NEW)).toBe(44)
  })

  test('no snippet text + no ai strip → 60', () => {
    expect(computeRowHeight(emailRow(em({ internal_id: 1 })), NO_NEW)).toBe(60)
  })

  test('ai strip alone → 78 (via ai_priority / ai_action / failed sync / NEW chip)', () => {
    expect(computeRowHeight(emailRow(em({ internal_id: 1, ai_priority: 'urgent' })), NO_NEW)).toBe(
      78
    )
    expect(computeRowHeight(emailRow(em({ internal_id: 1, ai_action: '需要回复' })), NO_NEW)).toBe(
      78
    )
    expect(
      computeRowHeight(emailRow(em({ internal_id: 1, sync_status: 'dead_letter' })), NO_NEW)
    ).toBe(78)
    // `isNew` mirrors EmailRow's aiStripVisible — newIds membership alone flips the strip.
    expect(computeRowHeight(emailRow(em({ internal_id: 7 })), new Set([7]))).toBe(78)
  })

  test('snippet text alone → 84 (own e.snippet takes precedence)', () => {
    expect(computeRowHeight(emailRow(em({ internal_id: 1, snippet: 'hello body' })), NO_NEW)).toBe(
      84
    )
  })

  test('snippet + ai strip → 100', () => {
    const row = emailRow(em({ internal_id: 1, snippet: 'hello', ai_priority: 'important' }))
    expect(computeRowHeight(row, NO_NEW)).toBe(100)
  })
})

// ─── rowTopOfId ───────────────────────────────────────────────────────

describe('rowTopOfId', () => {
  const rows: ListRow[] = [
    { type: 'header', key: 'today', label: 'TODAY', count: 2, collapsed: false },
    emailRow(em({ internal_id: 1 })),
    emailRow(em({ internal_id: 2 })),
    { type: 'loader' }
  ]
  const heights = [28, 60, 84, 44]

  test('returns the prefix-sum pixel offset of the matching email row', () => {
    expect(rowTopOfId(rows, heights, 1)).toBe(28)
    expect(rowTopOfId(rows, heights, 2)).toBe(88)
  })

  test('first row at offset 0 (header rows never match an internal_id)', () => {
    const justEmail: ListRow[] = [emailRow(em({ internal_id: 9 }))]
    expect(rowTopOfId(justEmail, [60], 9)).toBe(0)
  })

  test('unknown id → null', () => {
    expect(rowTopOfId(rows, heights, 999)).toBeNull()
  })

  test('🔴 线程展开后同一 id 有两行 (虚拟头 + 子行) → 命中**第一**行 = 虚拟头', () => {
    // 手风琴滚动锚定 (captureScrollAnchor(headInternalId)) 靠这个偏移把母行钉在
    // 原位。若哪天改成命中子行, 展开瞬间列表会整体跳一行高度。
    const dupRows: ListRow[] = [
      { type: 'header', key: 'today', label: 'TODAY', count: 1, collapsed: false },
      emailRow(em({ internal_id: 1 }), {
        thread: {
          isHead: true,
          threadId: 't1',
          childCount: 1,
          expanded: true,
          agg: { memberIds: [1, 2], aggFlagged: false }
        }
      }),
      emailRow(em({ internal_id: 1 }), {
        thread: { isHead: false, threadId: 't1', childIndex: 0 }
      }),
      emailRow(em({ internal_id: 2 }), {
        thread: { isHead: false, threadId: 't1', childIndex: 1 }
      })
    ]
    expect(rowTopOfId(dupRows, [28, 60, 60, 60], 1)).toBe(28)
  })
})
