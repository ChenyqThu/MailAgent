import { describe, expect, it } from 'vitest'

import { hasNextAction, nextAction } from '@shared/lib/matterDerive'
import type { Matter, MatterItem } from '@shared/api/types/matter'

/**
 * 「健康」判定以前是拿 nextAction() 的返回串 .includes('缺少下一步') 判的 —— 改一下那句
 * 措辞就会静默失效。这组用例把**判定**与**文案**分别钉死，任何一边动了另一边都不会被牵连。
 */

function matter(overrides: Partial<Matter> = {}): Matter {
  return {
    id: 1,
    public_id: 'MAT-0001',
    title: 't',
    description: '',
    matter_type: null,
    tags: [],
    status: 'active',
    health: 'unknown',
    priority: 'p1',
    owner_id: null,
    source: 'test',
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
    created_at: 0,
    updated_at: 0,
    ...overrides
  } as Matter
}

function item(overrides: Partial<MatterItem>): MatterItem {
  return {
    id: 1,
    matter_id: 1,
    kind: 'action',
    title: 'do it',
    description: null,
    position: 0,
    status: 'open',
    deleted_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides
  } as MatterItem
}

describe('hasNextAction', () => {
  it('is false when nothing actionable exists', () => {
    expect(hasNextAction(matter(), [])).toBe(false)
  })

  it.each([
    ['open action', item({ status: 'open' })],
    ['in-progress action', item({ status: 'in_progress' })],
    ['waiting action', item({ status: 'waiting' })],
    ['open blocker', item({ kind: 'blocker', status: 'open' })]
  ])('is true with an %s', (_label, entry) => {
    expect(hasNextAction(matter(), [entry])).toBe(true)
  })

  it('treats monitoring and done as having a defined stance', () => {
    expect(hasNextAction(matter({ status: 'monitoring' }), [])).toBe(true)
    expect(hasNextAction(matter({ status: 'done' }), [])).toBe(true)
  })

  it('ignores deleted and completed items', () => {
    expect(hasNextAction(matter(), [item({ deleted_at: 1 })])).toBe(false)
    expect(hasNextAction(matter(), [item({ status: 'done' })])).toBe(false)
  })

  it('agrees with the copy nextAction produces', () => {
    // 两者必须同向 —— 这是把它们分开之后唯一还需要保持的关系。
    const withAction = matter()
    const withoutAction = matter()
    expect(hasNextAction(withAction, [item({ status: 'open' })])).toBe(true)
    expect(nextAction(withAction, [item({ status: 'open' })])).toBe('do it')
    expect(hasNextAction(withoutAction, [])).toBe(false)
    expect(nextAction(withoutAction, [])).toContain('缺少下一步')
  })
})
