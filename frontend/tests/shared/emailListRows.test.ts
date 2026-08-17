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
  collectRemovedChildKeys,
  computeCollapseShifts,
  computeRowHeight,
  flattenGroups,
  groupBySentAnchor,
  groupByThread,
  isBotSender,
  isLowSignal,
  partitionByDate,
  partitionFlat,
  recipientIsMe,
  rowIdentityKey,
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
 *  overridable; the rest are inert defaults.
 *
 *  `sender_email`（v58 派生列）默认跟随 `sender` —— 多数 fixture 的 sender 本来就是
 *  裸地址，这样写测试不用每次两处都填。要模拟活库里「sender 是整个 From 头」的真实
 *  形态（68% 的行）或「取不到地址」，显式传 `sender_email`（含显式 `null`）。 */
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
    ...over,
    // 显式传了就用（含 null）；没传则跟随 sender。放在展开之后才盖得住。
    sender_email:
      'sender_email' in over ? over.sender_email : (over.sender ?? 'someone@example.test')
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

describe('applyTab（2026-08-14 判据重设计 · WP-4）', () => {
  test('🔴 同事真人邮件被判 low → 仍留「重点」（ai_priority 完全退出 tab 判据）', () => {
    // 活库实测：旧判据把 345 封划进「其他」，其中 183 封是这个形状 —— 同事发的
    // 业务邮件只是被 LLM 判了低优先级（owner 报的 Gary W 那封即在其中）。
    const human = em({
      internal_id: 1,
      sender: 'gary.w@omadanetworks.test',
      ai_priority: 'low',
      ai_category: '🛠️ 技术讨论'
    })
    expect(applyTab('focused', [human]).map((r) => r.internal_id)).toEqual([1])
    expect(applyTab('other', [human])).toHaveLength(0)
  })

  test('🔴 系统通知被判 normal → 仍进「其他」（分类是主判据，不是优先级）', () => {
    const noise = em({
      internal_id: 2,
      sender: 'someone@example.test',
      ai_priority: 'normal',
      ai_category: '🔔 系统通知'
    })
    expect(applyTab('other', [noise]).map((r) => r.internal_id)).toEqual([2])
    expect(applyTab('focused', [noise])).toHaveLength(0)
  })

  test('机器人发件人进「其他」，哪怕分类是业务类（不依赖 LLM 的兜底）', () => {
    const rows = [
      em({ internal_id: 1, sender: 'jira@tp-link-global.atlassian.test' }),
      em({ internal_id: 2, sender: 'confluence@tp-link-global.atlassian.test' }),
      em({ internal_id: 3, sender: 'notify.jira@email.tp-link.test' })
    ].map((r) => ({ ...r, ai_category: '🛠️ 技术讨论', ai_priority: 'important' as const }))
    expect(applyTab('other', rows).map((r) => r.internal_id)).toEqual([1, 2, 3])
    expect(applyTab('focused', rows)).toHaveLength(0)
  })

  test('未跑 LLM（ai_category 为空）且发件人不像机器人 → 留「重点」', () => {
    expect(
      applyTab('focused', [
        em({ internal_id: 9, sender: 'alice@omadanetworks.test', ai_category: null })
      ])
    ).toHaveLength(1)
  })

  test('两个 tab 互补：并集 = 全集，交集为空', () => {
    const rows = [
      em({ internal_id: 1, sender: 'alice@x.test' }),
      em({ internal_id: 2, sender: 'noreply@x.test' }),
      em({ internal_id: 3, sender: 'bob@x.test', ai_category: '🔔 系统通知' }),
      em({ internal_id: 4, sender: 'carol@x.test', ai_priority: 'low' })
    ]
    const focused = applyTab('focused', rows).map((r) => r.internal_id)
    const other = applyTab('other', rows).map((r) => r.internal_id)
    expect(focused).toEqual([1, 4])
    expect(other).toEqual([2, 3])
    expect([...focused, ...other].sort()).toEqual([1, 2, 3, 4])
  })
})

describe('isBotSender', () => {
  test('折叠 local part 后子串命中 —— 一个 token 盖住全部分隔符写法', () => {
    for (const s of [
      'noreply@x.test',
      'no-reply@x.test',
      'no.reply@x.test',
      'no_reply@x.test',
      'sc-noreply@google.test',
      'noreply+a659685@id.atlassian.test',
      'noreply.rsemail@mc2.adp.test',
      'donotreply@x.test',
      'do-not-reply@x.test',
      'notification.usa@tp-link.test',
      'cloud.ops.notify@tp-link.test',
      'newsletter@omadanetworks.test',
      'mailer-daemon@x.test'
    ]) {
      expect(isBotSender(s), s).toBe(true)
    }
  })

  test('🔴 短词按「整段相等」匹配 —— 真人 local part 含它的子串不误伤', () => {
    expect(isBotSender('jira@tp-link-global.atlassian.test')).toBe(true)
    expect(isBotSender('jira-notifications@x.test')).toBe(true)
    // `talbot` / `abbot` 含 bot、`jirasmith` 含 jira —— 段相等判据下都不命中。
    expect(isBotSender('talbot@x.test')).toBe(false)
    expect(isBotSender('abbot.lee@x.test')).toBe(false)
    expect(isBotSender('jirasmith@x.test')).toBe(false)
    expect(isBotSender('build-bot@x.test')).toBe(true)
  })

  test('🔴 只看 local part，不看域名（同事可能挂在通知类子域下）', () => {
    expect(isBotSender('alice@notifications.company.test')).toBe(false)
    expect(isBotSender('bob@jira.company.test')).toBe(false)
  })

  test('🔴 support / service / info / admin 共享信箱有意不收（真人技术支持要留在重点）', () => {
    for (const s of [
      'psi.support@tp-link.test',
      'service@x.test',
      'info@e.atlassian.test',
      'admin.usa@tp-link.test'
    ]) {
      expect(isBotSender(s), s).toBe(false)
    }
  })

  test('🔴 判据读 sender_email（裸地址）不读 sender —— 显示名不再污染判据', () => {
    // email_metadata.sender 不保证是裸地址: AppleScript 路径写整个 From 头
    // (活库 13014 行里 8850 行 = 68%, 全部 backend_origin='applescript')。拿 sender
    // 判就是在读**发件人自己填的显示名** —— 活库实测 `"徐静雅 (Jira)" <itjsm.gm@…>`
    // 是真人邮件, 却靠显示名里的 "(Jira)" 命中 bot 判据。
    // WP-5 起解析收口到 Python 持久化边界 (derive_sender_email → sender_email 列),
    // 前端只读那一列, 这里钉的就是「读对了列」。
    const human = em({
      internal_id: 1,
      sender: '"徐静雅 (Jira)" <itjsm.gm@tp-link.test>',
      sender_email: 'itjsm.gm@tp-link.test'
    })
    expect(isLowSignal(human)).toBe(false)
    expect(applyTab('focused', [human])).toHaveLength(1)

    const alertCenter = em({
      internal_id: 2,
      sender: 'Alert Center <alice@tp-link.test>',
      sender_email: 'alice@tp-link.test'
    })
    expect(isLowSignal(alertCenter)).toBe(false)

    // 地址本身是机器人 → 显示名写什么都照样命中。
    const bot = em({
      internal_id: 3,
      sender: 'Atlassian <noreply+65ff4a9@id.atlassian.test>',
      sender_email: 'noreply+65ff4a9@id.atlassian.test'
    })
    expect(isLowSignal(bot)).toBe(true)
    expect(applyTab('other', [bot])).toHaveLength(1)
  })

  test('🔴 sender_email 取不到地址（null）→ 不判机器人，留「重点」', () => {
    // 活库 2 行 sender='' ⇒ derive_sender_email 返 None ⇒ 列为 NULL。
    const noAddr = em({ internal_id: 1, sender: 'noreply-ish garbage', sender_email: null })
    expect(isLowSignal(noAddr)).toBe(false)
    expect(applyTab('focused', [noAddr])).toHaveLength(1)
  })

  test('普通同事地址 / 空值 → false', () => {
    expect(isBotSender('lucien.chen@omadanetworks.test')).toBe(false)
    expect(isBotSender(null)).toBe(false)
    expect(isBotSender(undefined)).toBe(false)
    expect(isBotSender('')).toBe(false)
    expect(isBotSender('@x.test')).toBe(false)
  })

  test('大小写无关', () => {
    expect(isBotSender('NoReply@X.TEST')).toBe(true)
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

  test('🔴 supplement 只供折叠内的子邮件 —— 更新的 supplement 邮件不再抢 head（08-14 WP-1 方案 A）', () => {
    // 改之前: head = 9 (supplement 里 07-10 的已发回复), 而 anchorDate = 07-08
    // (可见集合最新) —— 显示的那封与排序/分桶的依据来自两个不同集合, 正是
    // 「今天的邮件出现在昨天组 + 组内乱序」的病根。
    // 现在: head 恒取可见集合最新 (1 @07-08), 9 退到 children (DESC 里仍在最前)。
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
    expect(groups[0]!.head.internal_id).toBe(1) // 可见集合最新, 不是全体最新
    expect(groups[0]!.children.map((c) => c.internal_id)).toEqual([9, 2])
    expect(groups[0]!.anchorDate).toBe('2026-07-08T10:00:00')
    // 🔴 同源不变量: 显示时间 === 排序/分桶依据。
    expect(groups[0]!.anchorDate).toBe(groups[0]!.head.date_received)
  })

  test('🔴 anchorDate 恒等于 head.date_received（不再是第二个独立来源）', () => {
    const supplement = new Map([
      ['tA', [em({ internal_id: 11, thread_id: 'tA', date_received: '2026-07-10T09:00:00' })]],
      ['tB', [em({ internal_id: 12, thread_id: 'tB', date_received: '2026-07-11T09:00:00' })]]
    ])
    const groups = groupByThread(
      [
        em({ internal_id: 1, thread_id: 'tA', date_received: '2026-07-08T10:00:00' }),
        em({ internal_id: 2, thread_id: 'tA', date_received: '2026-07-07T10:00:00' }),
        em({ internal_id: 3, thread_id: 'tB', date_received: '2026-07-09T10:00:00' }),
        em({ internal_id: 4, date_received: '2026-07-06T10:00:00' }) // solitary
      ],
      supplement
    )
    for (const g of groups) {
      expect(g.anchorDate, `group head=${g.head.internal_id}`).toBe(g.head.date_received)
    }
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

// ─── WP-1 端到端回归：head 与分桶/排序同源（task 08-14） ──────────────
//
// owner 2026-08-14 dogfood：「我在当前 emaillist 的昨天看到了很多邮件，但他们都是
// 今天的（按照 PST 时间算）」「排序感觉也有问题，时间顺序都是乱的」。两个症状同源 ——
// head 取自「可见集合 + supplement」的全体最新，anchorDate（分桶 + 组排序的唯一依据）
// 只取自可见集合。下面两条是实证过的落进该分支的路径，各跑一遍完整链路
// （filter → groupByThread → partitionByDate）而不是手搓一个「假设已被过滤」的入参。

describe('groupByThread × partitionByDate — head 与分桶/排序同源（WP-1）', () => {
  // 与 partitionByDate 那组同款冻结时钟：Friday 2026-07-10 12:00 本地
  // （vitest TZ 钉 America/Los_Angeles）→ today: 07-10T00:00, yesterday: 07-09。
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T12:00:00'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const NO_PINS: ReadonlySet<number> = new Set()
  const fullPri = new Set(ALL_PRIORITIES)
  const fullCat = new Set(ALL_CATEGORIES)

  test('🔴 路径①：线程最新那封被 tab 判据排除 → head 退回可见集合最新，分桶跟着走', () => {
    // 活库原型 internal_id=1000012705：线程里最新那封今天 09:28 到，但它是噪音，
    // Focused 视图看不到它；线程里可见的最新是昨天 20:45。改之前 head=今天那封 /
    // anchorDate=昨天那封 → 行上写着「2 小时前」却排在「昨天」组里。
    const noisyNewest = em({
      internal_id: 705,
      thread_id: 't-gary',
      date_received: '2026-07-10T09:28:00',
      sender: 'notify.jira@email.tp-link.test',
      ai_category: '🔔 系统通知'
    })
    const visibleOlder = em({
      internal_id: 659,
      thread_id: 't-gary',
      date_received: '2026-07-09T20:45:00',
      sender: 'gary.w@omadanetworks.test'
    })
    const inbox = [noisyNewest, visibleOlder]
    const focused = applyTab('focused', inbox)
    // 前提坐实：最新那封确实不在可见集合里。
    expect(focused.map((r) => r.internal_id)).toEqual([659])
    // supplement = 跨邮箱全线程（listByThreads 不带 mailbox / tab 过滤）。
    const groups = groupByThread(focused, new Map([['t-gary', inbox]]))
    expect(groups).toHaveLength(1)
    const g = groups[0]!
    expect(g.head.internal_id).toBe(659)
    expect(g.children.map((c) => c.internal_id)).toEqual([705])
    expect(g.anchorDate).toBe(g.head.date_received)
    const buckets = partitionByDate(groups, NO_PINS)
    expect(buckets.today).toHaveLength(0)
    expect(buckets.yesterday.map((x) => x.head.internal_id)).toEqual([659])
  })

  test('🔴 路径①b：优先级筛选排除掉线程最新那封（与 tab 判据无关的同一形态）', () => {
    const filteredOutNewest = em({
      internal_id: 705,
      thread_id: 't-p',
      date_received: '2026-07-10T09:28:00',
      ai_priority: 'low'
    })
    const visibleOlder = em({
      internal_id: 659,
      thread_id: 't-p',
      date_received: '2026-07-09T20:45:00',
      ai_priority: 'important'
    })
    const inbox = [filteredOutNewest, visibleOlder]
    const visible = applyMultiFilter(inbox, new Set(['important']), fullCat)
    expect(visible.map((r) => r.internal_id)).toEqual([659])
    const groups = groupByThread(visible, new Map([['t-p', inbox]]))
    expect(groups[0]!.head.internal_id).toBe(659)
    expect(groups[0]!.anchorDate).toBe(groups[0]!.head.date_received)
    expect(partitionByDate(groups, NO_PINS).yesterday).toHaveLength(1)
  })

  test('🔴 路径②：线程最新那封在发件箱（收件箱视图下天然不可见）', () => {
    // 活库原型 internal_id=1000012714：owner 自己今天 10:54 回的那封在发件箱，
    // 收件箱的可见集合里没有它；线程可见最新是昨天 20:00。
    const myReply = em({
      internal_id: 714,
      thread_id: 't-x',
      date_received: '2026-07-10T10:54:00',
      mailbox: '发件箱'
    })
    const visible = em({
      internal_id: 649,
      thread_id: 't-x',
      date_received: '2026-07-09T20:00:00'
    })
    // 收件箱可见集合只有 649；supplement 跨邮箱补全整条线程。
    const groups = groupByThread([visible], new Map([['t-x', [myReply, visible]]]))
    expect(groups).toHaveLength(1)
    const g = groups[0]!
    expect(g.head.internal_id).toBe(649)
    expect(g.children.map((c) => c.internal_id)).toEqual([714])
    expect(g.anchorDate).toBe(g.head.date_received)
    const buckets = partitionByDate(groups, NO_PINS)
    expect(buckets.today).toHaveLength(0)
    expect(buckets.yesterday.map((x) => x.head.internal_id)).toEqual([649])
  })

  test('🔴 组内按 head 的显示时间严格递减（owner 报的「时间顺序都是乱的」）', () => {
    // 三条线程的绝对最新分别在发件箱 / 被 tab 排除 / 就在可见集合里 —— 混合形态。
    const inbox = [
      em({ internal_id: 659, thread_id: 't1', date_received: '2026-07-09T20:45:00' }),
      em({ internal_id: 649, thread_id: 't2', date_received: '2026-07-09T20:00:00' }),
      em({ internal_id: 600, thread_id: 't3', date_received: '2026-07-09T17:30:00' }),
      em({ internal_id: 590, date_received: '2026-07-09T09:00:00' }) // solitary
    ]
    const supplement = new Map([
      [
        't1',
        [
          ...inbox.filter((e) => e.thread_id === 't1'),
          em({
            internal_id: 705,
            thread_id: 't1',
            date_received: '2026-07-10T09:28:00',
            mailbox: '发件箱'
          })
        ]
      ],
      [
        't2',
        [
          ...inbox.filter((e) => e.thread_id === 't2'),
          em({
            internal_id: 714,
            thread_id: 't2',
            date_received: '2026-07-10T10:54:00',
            mailbox: '发件箱'
          })
        ]
      ],
      ['t3', inbox.filter((e) => e.thread_id === 't3')]
    ])
    const groups = groupByThread(applyMultiFilter(inbox, fullPri, fullCat), supplement)
    const buckets = partitionByDate(groups, NO_PINS)
    // 全部落「昨天」组（没有一条被 supplement 的今日时间戳推进「今天」）。
    expect(buckets.today).toHaveLength(0)
    const bucket = buckets.yesterday
    expect(bucket.map((g) => g.head.internal_id)).toEqual([659, 649, 600, 590])
    // 🔴 行上真正显示的时间（head.date_received）严格递减 —— 改之前这里会是
    // 09:28 / 10:54 / 17:30 / 09:00 那种乱序。
    const shown = bucket.map((g) => g.head.date_received ?? '')
    expect(shown).toEqual([...shown].sort().reverse())
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

// ─── rowIdentityKey / computeCollapseShifts（收起位移过渡 · 方案 A 2026-08） ──

describe('rowIdentityKey', () => {
  test('header / loader 各有独立键（分组头也参与位移）', () => {
    expect(
      rowIdentityKey({ type: 'header', key: 'today', label: 'T', count: 1, collapsed: false })
    ).toBe('h:today')
    expect(rowIdentityKey({ type: 'loader' })).toBe('loader')
  })

  test('🔴 虚拟头与它的首个子行是同一个 internal_id —— 键必须带角色位区分', () => {
    // flattenGroups 展开虚拟头时 members = [head, ...children]，所以最新那封会同时
    // 以「虚拟头」和「首个子行」出现两行。键若只用 internal_id，收起差分会把这两行
    // 混成一条，算出来的位移张冠李戴。
    const head = emailRow(em({ internal_id: 1 }), {
      thread: {
        isHead: true,
        threadId: 't1',
        childCount: 1,
        expanded: true,
        agg: { memberIds: [1, 2], aggFlagged: false }
      }
    })
    const child = emailRow(em({ internal_id: 1 }), {
      thread: { isHead: false, threadId: 't1', childIndex: 0 }
    })
    expect(rowIdentityKey(head)).not.toBe(rowIdentityKey(child))
  })

  test('单封（无 thread）与线程头不同键；同一行两次调用稳定', () => {
    const solo = emailRow(em({ internal_id: 7 }))
    expect(rowIdentityKey(solo)).toBe(rowIdentityKey(emailRow(em({ internal_id: 7 }))))
    expect(rowIdentityKey(solo)).not.toBe(
      rowIdentityKey(
        emailRow(em({ internal_id: 7 }), {
          thread: { isHead: true, threadId: 't', childCount: 1, expanded: false }
        })
      )
    )
  })

  test('同一封邮件落在不同分组桶 → 不同键（置顶区与日期区各自独立成行）', () => {
    expect(rowIdentityKey(emailRow(em({ internal_id: 3 }), { groupKey: 'pinned' }))).not.toBe(
      rowIdentityKey(emailRow(em({ internal_id: 3 }), { groupKey: 'today' }))
    )
  })
})

describe('computeCollapseShifts', () => {
  // 展开态：header(28) / 虚拟头(60) / 子行 ×2(60) / 尾随单封(60)。
  const HEAD = emailRow(em({ internal_id: 1 }), {
    thread: {
      isHead: true,
      threadId: 't1',
      childCount: 2,
      expanded: true,
      agg: { memberIds: [1, 2, 3], aggFlagged: false }
    }
  })
  const HEAD_COLLAPSED = emailRow(em({ internal_id: 1 }), {
    thread: {
      isHead: true,
      threadId: 't1',
      childCount: 2,
      expanded: false,
      agg: { memberIds: [1, 2, 3], aggFlagged: false }
    }
  })
  const CHILD_A = emailRow(em({ internal_id: 1 }), {
    thread: { isHead: false, threadId: 't1', childIndex: 0 }
  })
  const CHILD_B = emailRow(em({ internal_id: 2 }), {
    thread: { isHead: false, threadId: 't1', childIndex: 1 }
  })
  const TAIL = emailRow(em({ internal_id: 9 }))
  const HEADER: ListRow = {
    type: 'header',
    key: 'today',
    label: 'TODAY',
    count: 1,
    collapsed: false
  }
  const BEFORE_ROWS: ListRow[] = [HEADER, HEAD, CHILD_A, CHILD_B, TAIL]
  const BEFORE_H = [28, 60, 60, 60, 60]
  const AFTER_ROWS: ListRow[] = [HEADER, HEAD_COLLAPSED, TAIL]
  const AFTER_H = [28, 60, 60]

  test('收起点下方的行按被摘掉的总高度上移；上方与收起行本身不动', () => {
    const shifts = computeCollapseShifts(
      { rows: BEFORE_ROWS, heights: BEFORE_H, scrollTop: 0 },
      { rows: AFTER_ROWS, heights: AFTER_H, scrollTop: 0 }
    )
    // 只有尾随行进 map —— header 与线程头前后 top 相同（dy=0 被 minDelta 滤掉）。
    expect([...shifts.keys()]).toEqual([rowIdentityKey(TAIL)])
    expect(shifts.get(rowIdentityKey(TAIL))).toBe(120) // 两个子行各 60
  })

  test('🔴 展开态的 chevron 状态变化不影响匹配（expanded 不进键）', () => {
    // HEAD(expanded:true) → HEAD_COLLAPSED(expanded:false) 必须仍认作同一行，
    // 否则线程头会被当成「新出现的行」而漏掉（或算出错误位移）。
    const shifts = computeCollapseShifts(
      { rows: BEFORE_ROWS, heights: BEFORE_H, scrollTop: 0 },
      { rows: [HEADER, HEAD_COLLAPSED], heights: [28, 60], scrollTop: 0 }
    )
    expect(shifts.has(rowIdentityKey(HEAD_COLLAPSED))).toBe(false) // dy=0，不是「没匹配上」
  })

  test('被摘掉的子行不出现在结果里（不做退场，不留幽灵行）', () => {
    const shifts = computeCollapseShifts(
      { rows: BEFORE_ROWS, heights: BEFORE_H, scrollTop: 0 },
      { rows: AFTER_ROWS, heights: AFTER_H, scrollTop: 0 }
    )
    expect(shifts.has(rowIdentityKey(CHILD_B))).toBe(false)
  })

  test('🔴 靠底部收起：scrollTop 被 clamp 时，位移按「视觉差」算', () => {
    // 总高从 268 掉到 148，浏览器把 scrollTop 从 100 clamp 到 60（clamp 量 40）。
    // 尾随行的内容差 120，但视觉上只跳了 120-40=80；上方的 header 反而**下移** 40。
    const shifts = computeCollapseShifts(
      { rows: BEFORE_ROWS, heights: BEFORE_H, scrollTop: 100 },
      { rows: AFTER_ROWS, heights: AFTER_H, scrollTop: 60 }
    )
    expect(shifts.get(rowIdentityKey(TAIL))).toBe(80)
    expect(shifts.get(rowIdentityKey(HEADER))).toBe(-40)
  })

  test('几何没变 → 空 map（调用方据此完全不起 tween）', () => {
    expect(
      computeCollapseShifts(
        { rows: AFTER_ROWS, heights: AFTER_H, scrollTop: 0 },
        { rows: AFTER_ROWS, heights: AFTER_H, scrollTop: 0 }
      ).size
    ).toBe(0)
  })

  test('after 里全新出现的行不参与（before 无对应项）', () => {
    const fresh = emailRow(em({ internal_id: 77 }))
    const shifts = computeCollapseShifts(
      { rows: [HEADER, TAIL], heights: [28, 60], scrollTop: 0 },
      { rows: [HEADER, fresh, TAIL], heights: [28, 60, 60], scrollTop: 0 }
    )
    expect(shifts.has(rowIdentityKey(fresh))).toBe(false)
    expect(shifts.get(rowIdentityKey(TAIL))).toBe(-60) // 插了一行 → 下移
  })

  test('minDelta 亚像素抖动被滤掉（不为 0.3px 起一次 tween）', () => {
    const shifts = computeCollapseShifts(
      { rows: [TAIL], heights: [60], scrollTop: 0 },
      { rows: [TAIL], heights: [60], scrollTop: 0.3 }
    )
    expect(shifts.size).toBe(0)
  })

  describe('collectRemovedChildKeys（幽灵退场的候选集）', () => {
    test('收起摘掉的子行进集合 —— 含与虚拟头同 internal_id 的首个子行（role 位区分）', () => {
      const removed = collectRemovedChildKeys(BEFORE_ROWS, AFTER_ROWS)
      expect(removed).toEqual(new Set([rowIdentityKey(CHILD_A), rowIdentityKey(CHILD_B)]))
    })

    test('存活的子行不进集合（capture 后这次重排根本没动线程）', () => {
      expect(collectRemovedChildKeys(BEFORE_ROWS, BEFORE_ROWS).size).toBe(0)
    })

    test('🔴 只认子行：单封 / 线程头 / header 被移除（数据刷新）不播退场', () => {
      // TAIL（单封）、HEAD（线程头）、HEADER 全部消失 —— 这是列表数据变了，
      // 不是收起；给它们播退场会把「移出列表」演成「收进线程」。
      const removed = collectRemovedChildKeys(BEFORE_ROWS, [CHILD_A, CHILD_B])
      expect(removed.size).toBe(0)
    })
  })
})
