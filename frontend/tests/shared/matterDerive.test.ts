import { describe, expect, test } from 'vitest'

import type { Matter, MatterItem } from '../../src/shared/api/types/matter'
import {
  filterView,
  hasNextAction,
  MATTER_VIEWS,
  matterTagView,
  matterTagViewName,
  nextAction,
  rankOf,
  trashDaysRemaining
} from '../../src/shared/lib/matterDerive'

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

function item(overrides: Partial<MatterItem> = {}): MatterItem {
  return {
    id: 1,
    matter_id: 1,
    kind: 'action',
    title: 'Send proposal',
    description: null,
    position: 0,
    status: 'open',
    priority: null,
    owner_kind: null,
    owner_id: null,
    waiting_on_stakeholder_id: null,
    due_at: null,
    completed_at: null,
    checklist: [],
    source_resource_id: null,
    source_locator: null,
    created_at: 1,
    updated_at: 1,
    deleted_at: null,
    ...overrides
  }
}

describe('filterView', () => {
  const live = matter({ public_id: 'MAT-0001', status: 'active' })
  const done = matter({ public_id: 'MAT-0002', status: 'done' })
  const canceled = matter({ public_id: 'MAT-0003', status: 'canceled' })
  const archived = matter({ public_id: 'MAT-0004', archived_at: 10 })
  const trashed = matter({ public_id: 'MAT-0005', archived_at: 10, deleted_at: 20 })
  const values = [live, done, canceled, archived, trashed]

  test('all/status/completed operate only on live matters', () => {
    expect(filterView(values, 'all').map((value) => value.public_id)).toEqual(['MAT-0001'])
    expect(filterView(values, 'active')).toEqual([live])
    expect(filterView(values, 'completed')).toEqual([done, canceled])
  })

  test('archived excludes trash and trash wins over archive', () => {
    expect(filterView(values, 'archived')).toEqual([archived])
    expect(filterView(values, 'trash')).toEqual([trashed])
  })

  test('focus only considers live due/attention matters', () => {
    const focused = matter({ public_id: 'MAT-0006', due_at: 100 })
    const archivedFocused = matter({ public_id: 'MAT-0007', due_at: 100, archived_at: 10 })
    expect(filterView([focused, archivedFocused], 'focus')).toEqual([focused])
  })

  test('attention and review consume optional indexes without changing legacy callers', () => {
    const attention = new Map([
      [
        live.public_id,
        [
          {
            id: 7,
            kind: 'run_failed' as const,
            state: 'open' as const,
            severity: 'critical' as const
          }
        ]
      ]
    ])
    const updates = new Map([
      [live.public_id, [{ id: 8, review_status: 'pending' as const } as never]]
    ])
    expect(filterView(values, 'attention', attention)).toEqual([live])
    expect(filterView(values, 'review', undefined, updates)).toEqual([live])
    expect(filterView(values, 'attention')).toEqual([])
  })
})

test('MATTER_VIEWS pins P5 ordering while preserving completed', () => {
  expect(MATTER_VIEWS).toEqual([
    'focus',
    'attention',
    'review',
    'active',
    'waiting',
    'blocked',
    'planned',
    'monitoring',
    'all',
    'completed',
    'archived',
    'trash'
  ])
})

describe('rankOf', () => {
  test('critical signal outranks signal-free priority and due date', () => {
    expect(
      rankOf(
        matter({
          priority: 'p3',
          due_at: 999,
          attention_signals: [{ kind: 'run_failed', state: 'open', severity: 'critical' }]
        })
      )
    ).toEqual([0, 3, 999])
    expect(rankOf(matter({ priority: 'p0', due_at: 1 }))).toEqual([2, 0, 1])
  })

  test('non-critical open signal ranks one and closed signals do not count', () => {
    expect(
      rankOf(matter({ attention_signals: [{ kind: 'deadline_near', state: 'open' }] }))[0]
    ).toBe(1)
    expect(
      rankOf(
        matter({
          attention_signals: [{ kind: 'deadline_near', state: 'resolved', severity: 'critical' }]
        })
      )[0]
    ).toBe(2)
  })

  test('missing due date sorts last', () => {
    expect(rankOf(matter())[2]).toBe(Number.MAX_SAFE_INTEGER)
  })

  test('optional attention index overrides embedded fallback', () => {
    const value = matter({ attention_signals: [] })
    const attention = new Map([
      [
        value.public_id,
        [{ kind: 'deadline_near' as const, state: 'open' as const, severity: 'warn' as const }]
      ]
    ])
    expect(rankOf(value, attention)[0]).toBe(1)
  })
})

// G-34 起 nextAction 返回**描述符**（kind + 用户内容 title + tone），文案交给 i18n ——
// 这里断言的是判定与色调，不再断言中文串（那正是本条要修的硬编码）。
describe('nextAction', () => {
  test('prefers open/in-progress action, then waiting action, then blocker', () => {
    expect(
      nextAction(matter(), [
        item({ status: 'waiting', title: 'Legal' }),
        item({ id: 2, status: 'open', title: 'Send draft' })
      ])
    ).toEqual({ kind: 'action', title: 'Send draft', tone: 'neutral' })
    expect(nextAction(matter(), [item({ status: 'waiting', title: 'Legal' })])).toEqual({
      kind: 'waiting',
      title: 'Legal',
      tone: 'warn'
    })
    expect(
      nextAction(matter(), [item({ kind: 'blocker', status: null, title: 'Budget approval' })])
    ).toEqual({ kind: 'blocker', title: 'Budget approval', tone: 'critical' })
  })

  test('uses monitoring/done kinds and the missing-next-step fallback', () => {
    expect(nextAction(matter({ status: 'monitoring' }), [])).toEqual({
      kind: 'monitoring',
      title: null,
      tone: 'neutral'
    })
    expect(nextAction(matter({ status: 'done' }), [])).toEqual({
      kind: 'done',
      title: null,
      tone: 'neutral'
    })
    expect(nextAction(matter({ status: 'planned' }), [])).toEqual({
      kind: 'missing',
      title: null,
      tone: 'warn'
    })
  })

  test('ignores deleted action items and computes trash countdown', () => {
    expect(nextAction(matter(), [item({ deleted_at: 10 })]).kind).toBe('missing')
    expect(trashDaysRemaining(matter({ deleted_at: 0, purge_after: 3 * 86_400_000 }), 0)).toBe(3)
  })

  // 补充项（批次 3）—— 清单端点不返回 items，所以清单行吃服务端的 `next_action` 投影。
  // 少了这一路，一屏事项全会显示「缺少下一步」，而详情页打开就有（Focus 的健康活跃率
  // 同源，会一起失真）。canonical = `src/matters/repository.py::list_next_action_summaries`，
  // 那边的 pytest 钉的是同一张优先级表。
  test('list rows without items consume the server next_action projection', () => {
    const row = matter({
      next_action: { kind: 'waiting', title: 'Ping Bob', due_at: null }
    })
    expect(nextAction(row)).toEqual({ kind: 'waiting', title: 'Ping Bob', tone: 'warn' })
    expect(hasNextAction(row)).toBe(true)
  })

  test('explicit items win over the projection; an empty array still means "no items"', () => {
    const row = matter({
      next_action: { kind: 'blocker', title: 'Stale projection', due_at: null }
    })
    // 详情页手里有真条目 ⇒ 就地算，不看投影（投影可能比这一屏旧）。
    expect(nextAction(row, [item({ status: 'open', title: 'Send draft' })]).title).toBe('Send draft')
    // `[]` 是「确实一条都没有」，不是「这一层没有数据」—— 不许回退去读投影。
    expect(nextAction(row, []).kind).toBe('missing')
  })

  test('old backends without the projection fail soft to the status fallback', () => {
    expect(nextAction(matter()).kind).toBe('missing')
    expect(nextAction(matter({ next_action: null })).kind).toBe('missing')
    expect(hasNextAction(matter({ next_action: null }))).toBe(false)
  })
})

// G-01 —— 左轨标签分组。视图 key 是 `tag:<标签名>`（标签的身份就是名字）。
describe('tag views', () => {
  test('round-trips names that themselves contain a colon', () => {
    expect(matterTagView('合规')).toBe('tag:合规')
    expect(matterTagViewName(matterTagView('a:b'))).toBe('a:b')
    expect(matterTagViewName('all')).toBeNull()
    expect(matterTagViewName('attention')).toBeNull()
  })

  test('filters live matters by tag and never leaks archived/trashed rows', () => {
    const tagged = matter({ public_id: 'MAT-0001', tags: ['合规', '预算'] })
    const other = matter({ public_id: 'MAT-0002', tags: ['预算'] })
    const archivedTagged = matter({ public_id: 'MAT-0003', tags: ['合规'], archived_at: 10 })
    const trashedTagged = matter({ public_id: 'MAT-0004', tags: ['合规'], deleted_at: 20 })
    const values = [tagged, other, archivedTagged, trashedTagged]
    expect(filterView(values, matterTagView('合规'))).toEqual([tagged])
    expect(filterView(values, matterTagView('预算')).map((value) => value.public_id)).toEqual([
      'MAT-0001',
      'MAT-0002'
    ])
    expect(filterView(values, matterTagView('不存在'))).toEqual([])
  })

  test('tag view keeps done/canceled matters (unlike `all`)', () => {
    // 「全部」按业务状态收窄，标签筛选**不**——按标签找东西时把已完成的藏起来会让人以为丢了。
    const done = matter({ public_id: 'MAT-0005', status: 'done', tags: ['合规'] })
    expect(filterView([done], matterTagView('合规'))).toEqual([done])
    expect(filterView([done], 'all')).toEqual([])
  })
})
