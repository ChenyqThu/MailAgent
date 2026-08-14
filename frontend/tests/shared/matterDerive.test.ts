import { describe, expect, test } from 'vitest'

import type { Matter, MatterItem } from '../../src/shared/api/types/matter'
import { hasNextAction, nextAction, rankOf, trashDaysRemaining } from '../../src/shared/lib/matterDerive'

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

// `filterView` / `MATTER_VIEWS`（左轨 12 档视图模型）已随 v3 信息架构退役 —— scope 语义
// （trash 压过 archive、archived 排除 deleted、open/done 按 status 分割）的等价断言迁到
// `tests/components/matters/matterListQuery.test.ts`（新模型 `matterScopeOf`/`applyMatterListQuery`）。

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
