import { describe, expect, test } from 'vitest'

import type { Matter, MatterItem } from '../../src/shared/api/types/matter'
import {
  filterView,
  MATTER_VIEWS,
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
})
