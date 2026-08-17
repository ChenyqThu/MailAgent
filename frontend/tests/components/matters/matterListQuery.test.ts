// V3-01/03/04/06 —— 事项清单查询模型（scope / 快捷条件 / 多选筛选 / 排序）的语义闸。
// scope 部分是老 `filterView` 测试的等价迁移（trash 压过 archive、archived 排除 deleted、
// open/done 按 status 分割），其余钉新模型：类别间 AND、标签间 OR、nonext 按 kind 判。

import { describe, expect, test } from 'vitest'

import type {
  Matter,
  MatterAttentionSignal,
  MatterUpdateSummary
} from '../../../src/shared/api/types/matter'
import {
  activeMatterFilterCount,
  applyMatterListQuery,
  DEFAULT_MATTER_LIST_QUERY,
  MATTER_SCOPES,
  matterInScope,
  matterScopeOf,
  matterScopeParams
} from '../../../src/shared/components/matters/matterListQuery'
import type { MatterListQuery } from '../../../src/shared/components/matters/matterListQuery'
import { deriveFocusStats, isMatterDueSoon } from '../../../src/shared/lib/matterDerive'

const NOW = new Date(2026, 7, 13, 10, 0).getTime()
const DAY = 86_400_000

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 1,
    public_id: 'MAT-0001',
    title: 'Ship the release',
    description: '',
    matter_type: null,
    tags: [],
    status: 'active',
    health: 'unknown',
    priority: 'p1',
    owner_id: null,
    source: 'manual',
    due_at: null,
    waiting_context: null,
    next_attention_at: null,
    attention_reason: null,
    last_activity_at: null,
    latest_accepted_update_id: null,
    current_summary: null,
    summary_at: null,
    summary_by_kind: null,
    summary_by_id: null,
    version: 1,
    archived_at: null,
    archived_by_kind: null,
    archived_by_id: null,
    deleted_at: null,
    deleted_by_kind: null,
    deleted_by_id: null,
    purge_after: null,
    created_at: 1,
    updated_at: 1,
    ...overrides
  }
}

function query(overrides: Partial<MatterListQuery> = {}): MatterListQuery {
  return { ...DEFAULT_MATTER_LIST_QUERY, ...overrides }
}

const ctx = { now: NOW }

describe('matterScopeOf / matterInScope（老 filterView 语义的等价迁移）', () => {
  const live = matter({ public_id: 'MAT-0001', status: 'active' })
  const done = matter({ public_id: 'MAT-0002', status: 'done' })
  const canceled = matter({ public_id: 'MAT-0003', status: 'canceled' })
  const archived = matter({ public_id: 'MAT-0004', archived_at: 10 })
  const trashed = matter({ public_id: 'MAT-0005', archived_at: 10, deleted_at: 20 })
  const values = [live, done, canceled, archived, trashed]

  test('trash wins over archive; archived excludes deleted; done covers canceled', () => {
    expect(matterScopeOf(trashed)).toBe('trash')
    expect(matterScopeOf(archived)).toBe('archived')
    expect(matterScopeOf(done)).toBe('done')
    expect(matterScopeOf(canceled)).toBe('done')
    expect(matterScopeOf(live)).toBe('open')
  })

  test('投影行（无 archived/deleted 键，如 MatterDuplicateCandidate.matter）按活跃行判', () => {
    expect(matterScopeOf({ status: 'active' })).toBe('open')
    expect(matterScopeOf({ status: 'done' })).toBe('done')
  })

  test('applyMatterListQuery 的 scope 分割与老 filterView 一致', () => {
    const ids = (scope: MatterListQuery['scope']): string[] =>
      applyMatterListQuery(values, query({ scope }), '', ctx).map((value) => value.public_id)
    expect(ids('open')).toEqual(['MAT-0001'])
    expect(ids('done').sort()).toEqual(['MAT-0002', 'MAT-0003'])
    expect(ids('archived')).toEqual(['MAT-0004'])
    expect(ids('trash')).toEqual(['MAT-0005'])
    expect(matterInScope(trashed, 'archived')).toBe(false)
  })
})

describe('matterScopeParams（scope → 服务端请求参数）', () => {
  test('archived/trash 走服务端 view 参数（修「恒为空」bug 的落点），all/open/done 无参数', () => {
    expect(matterScopeParams('archived')).toEqual({ view: 'archived' })
    expect(matterScopeParams('trash')).toEqual({ view: 'trash' })
    expect(matterScopeParams('all')).toEqual({})
    expect(matterScopeParams('open')).toEqual({})
    expect(matterScopeParams('done')).toEqual({})
  })
})

// task 08-14 —— 范围增加 `all` 并设为默认（修「标完成就从列表消失、切到已完成筛选也救不回来」：
// 默认 scope='open' 与状态筛选是 AND，标完成的事项落进 done 范围就被默认范围挡死，交集恒空）。
describe('scope: all（task 08-14 默认范围）', () => {
  test('默认查询的 scope 是 all，且 all 置于 MATTER_SCOPES 首位', () => {
    expect(DEFAULT_MATTER_LIST_QUERY.scope).toBe('all')
    expect(MATTER_SCOPES[0]).toBe('all')
  })

  test('matterInScope(_, "all") 恒真 —— 不按归属过滤，`matterScopeOf` 本身不变', () => {
    const live = matter({ public_id: 'MAT-0001', status: 'active' })
    const done = matter({ public_id: 'MAT-0002', status: 'done' })
    const canceled = matter({ public_id: 'MAT-0003', status: 'canceled' })
    expect(matterScopeOf(done)).toBe('done') // 归属判定不受 all 影响
    for (const value of [live, done, canceled]) {
      expect(matterInScope(value, 'all')).toBe(true)
    }
  })

  test('applyMatterListQuery scope=all：进行中 + 已完成 + 已取消同时可见（验收 §5 第一条）', () => {
    const live = matter({ public_id: 'MAT-0001', status: 'active' })
    const done = matter({ public_id: 'MAT-0002', status: 'done' })
    const canceled = matter({ public_id: 'MAT-0003', status: 'canceled' })
    const ids = applyMatterListQuery([live, done, canceled], query({ scope: 'all' }), '', ctx).map(
      (value) => value.public_id
    )
    expect(ids.sort()).toEqual(['MAT-0001', 'MAT-0002', 'MAT-0003'])
  })

  test('切到「进行中」（open）：已完结的事项消失（旧行为不回退，验收 §5 第二条）', () => {
    const live = matter({ public_id: 'MAT-0001', status: 'active' })
    const done = matter({ public_id: 'MAT-0002', status: 'done' })
    expect(
      applyMatterListQuery([live, done], query({ scope: 'open' }), '', ctx).map(
        (value) => value.public_id
      )
    ).toEqual(['MAT-0001'])
  })

  test('matterScopeParams("all") 返回 {}，与 open/done 同路走默认 live 数据集', () => {
    expect(matterScopeParams('all')).toEqual({})
  })
})

describe('快捷条件', () => {
  test('attn 吃 attention index；proposal 吃 pending updates index', () => {
    const flagged = matter({ public_id: 'MAT-0001' })
    const calm = matter({ public_id: 'MAT-0002' })
    const attention = new Map([
      [
        'MAT-0001',
        [{ id: 7, kind: 'run_failed' as const, state: 'open' as const, severity: 'warn' as const }]
      ]
    ])
    expect(
      applyMatterListQuery([flagged, calm], query({ quick: ['attn'] }), '', { ...ctx, attention })
    ).toEqual([flagged])

    const updates = new Map([['MAT-0002', [{ id: 8, review_status: 'pending' as const } as never]]])
    expect(
      applyMatterListQuery([flagged, calm], query({ quick: ['proposal'] }), '', { ...ctx, updates })
    ).toEqual([calm])
  })

  test('due 是 7 天窗口且含逾期（设计 H3§3）', () => {
    const overdue = matter({ public_id: 'MAT-0001', due_at: NOW - 3 * DAY })
    const soon = matter({ public_id: 'MAT-0002', due_at: NOW + 6 * DAY })
    const far = matter({ public_id: 'MAT-0003', due_at: NOW + 20 * DAY })
    const none = matter({ public_id: 'MAT-0004' })
    expect(
      applyMatterListQuery([overdue, soon, far, none], query({ quick: ['due'] }), '', ctx).map(
        (value) => value.public_id
      )
    ).toEqual(['MAT-0001', 'MAT-0002'])
  })

  test('V3-15 —— tile 计数 / tile 下的列表 / due 快捷筛选三者命中集完全一致', () => {
    // 恰好逾期 1 天、6 天后、8 天后：8 天后那条是唯一该被排除的边界用例。
    const overdue = matter({ public_id: 'MAT-0001', due_at: NOW - 1 * DAY })
    const soon = matter({ public_id: 'MAT-0002', due_at: NOW + 6 * DAY })
    const far = matter({ public_id: 'MAT-0003', due_at: NOW + 8 * DAY })
    const rows = [overdue, soon, far]

    // ① 看板 tile 计数（deriveFocusStats.dueSoonCount）。
    const stats = deriveFocusStats(
      rows,
      [] as MatterAttentionSignal[],
      new Map<string, MatterUpdateSummary[]>(),
      NOW
    )
    expect(stats.dueSoonCount).toBe(2)

    // ② 看板「临近到期」列表命中集（MatterFocus.tsx 现在直接吃 isMatterDueSoon）。
    const dueSoonList = rows.filter(
      (row) => row.status !== 'done' && row.status !== 'canceled' && isMatterDueSoon(row, NOW)
    )
    expect(dueSoonList.map((row) => row.public_id)).toEqual(['MAT-0001', 'MAT-0002'])

    // ③ 清单 `due` 快捷筛选命中集。
    const quickFiltered = applyMatterListQuery(rows, query({ quick: ['due'] }), '', ctx).map(
      (row) => row.public_id
    )
    expect(quickFiltered).toEqual(['MAT-0001', 'MAT-0002'])

    // 三者命中集完全一致（数量与成员两道断言合起来即恒等）。
    expect(dueSoonList.length).toBe(stats.dueSoonCount)
    expect(quickFiltered).toEqual(dueSoonList.map((row) => row.public_id))
  })

  test('nonext 按 kind 判（有 next_action 投影 = 有下一步；monitoring/done 也不算缺）', () => {
    const missing = matter({ public_id: 'MAT-0001', status: 'planned' })
    const projected = matter({
      public_id: 'MAT-0002',
      next_action: { kind: 'action', title: 'Send draft', due_at: null }
    })
    const monitoring = matter({ public_id: 'MAT-0003', status: 'monitoring' })
    expect(
      applyMatterListQuery([missing, projected, monitoring], query({ quick: ['nonext'] }), '', ctx)
    ).toEqual([missing])
  })

  test('waiting 认 status 或 next_action 投影里的 waiting', () => {
    const byStatus = matter({ public_id: 'MAT-0001', status: 'waiting' })
    const byItem = matter({
      public_id: 'MAT-0002',
      next_action: { kind: 'waiting', title: 'Legal', due_at: null }
    })
    const neither = matter({ public_id: 'MAT-0003' })
    expect(
      applyMatterListQuery([byStatus, byItem, neither], query({ quick: ['waiting'] }), '', ctx).map(
        (value) => value.public_id
      )
    ).toEqual(['MAT-0001', 'MAT-0002'])
  })
})

describe('多选筛选：类别间 AND、同类内 OR', () => {
  const a = matter({ public_id: 'MAT-0001', status: 'active', priority: 'p0', tags: ['合规'] })
  const b = matter({ public_id: 'MAT-0002', status: 'waiting', priority: 'p0', tags: ['交付'] })
  const c = matter({ public_id: 'MAT-0003', status: 'inbox', priority: 'p3', tags: [] })

  test('状态组多选（needyou = inbox+active）内部 OR', () => {
    expect(
      applyMatterListQuery([a, b, c], query({ statusGroups: ['needyou'] }), '', ctx).map(
        (value) => value.public_id
      )
    ).toEqual(['MAT-0001', 'MAT-0003'])
  })

  test('标签间 OR、与优先级 AND', () => {
    expect(
      applyMatterListQuery(
        [a, b, c],
        query({ tags: ['合规', '交付'], priorities: ['p0'] }),
        '',
        ctx
      ).map((value) => value.public_id)
    ).toEqual(['MAT-0001', 'MAT-0002'])
    expect(
      applyMatterListQuery([a, b, c], query({ tags: ['合规'], priorities: ['p3'] }), '', ctx)
    ).toEqual([])
  })

  test('搜索按标签名也能命中（原 getOrderedVisibleMatters 行为）', () => {
    expect(applyMatterListQuery([a, b, c], query(), 'launch', ctx)).toEqual([])
    expect(
      applyMatterListQuery([a, b, c], query(), '合规', ctx).map((value) => value.public_id)
    ).toEqual(['MAT-0001'])
  })
})

describe('排序四档与方向', () => {
  const early = matter({ public_id: 'MAT-0001', due_at: NOW + DAY, priority: 'p2', updated_at: 5 })
  const late = matter({
    public_id: 'MAT-0002',
    due_at: NOW + 9 * DAY,
    priority: 'p0',
    updated_at: 9
  })
  const noDue = matter({ public_id: 'MAT-0003', priority: 'p1', updated_at: 7 })

  const ids = (q: Partial<MatterListQuery>): string[] =>
    applyMatterListQuery([early, late, noDue], query(q), '', ctx).map((value) => value.public_id)

  test('updated 新在前；due 近在前且无期限最后；priority p0 在前', () => {
    expect(ids({ sort: 'updated' })).toEqual(['MAT-0002', 'MAT-0003', 'MAT-0001'])
    expect(ids({ sort: 'due' })).toEqual(['MAT-0001', 'MAT-0002', 'MAT-0003'])
    expect(ids({ sort: 'priority' })).toEqual(['MAT-0002', 'MAT-0003', 'MAT-0001'])
  })

  test('rank（默认）走 compareMatterRank：critical 信号压过优先级', () => {
    const attention = new Map([
      [
        'MAT-0001',
        [
          {
            id: 1,
            kind: 'run_failed' as const,
            state: 'open' as const,
            severity: 'critical' as const
          }
        ]
      ]
    ])
    expect(
      applyMatterListQuery([early, late], query(), '', { ...ctx, attention }).map(
        (value) => value.public_id
      )
    ).toEqual(['MAT-0001', 'MAT-0002'])
  })

  test('reverse 翻转整个序', () => {
    expect(ids({ sort: 'updated', dir: 'reverse' })).toEqual(['MAT-0001', 'MAT-0003', 'MAT-0002'])
  })
})

test('activeMatterFilterCount 只数四类筛选，不含 scope/分组/排序', () => {
  expect(activeMatterFilterCount(query())).toBe(0)
  expect(
    activeMatterFilterCount(
      query({
        scope: 'done',
        group: 'due',
        sort: 'priority',
        dir: 'reverse',
        quick: ['attn'],
        statusGroups: ['blocked'],
        priorities: ['p0', 'p1'],
        tags: ['合规']
      })
    )
  ).toBe(5)
})
