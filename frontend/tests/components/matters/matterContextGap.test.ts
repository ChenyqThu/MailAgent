// 「缺上下文」判据的自噬循环回归网（0812 dogfood 批 · 修法 5）。
//
// 旧判据 `payload.resources.length === 0` 看的是**投影**（pinned 或未确认的 agent 建议），
// 「已确认但没 pin」的资料根本不进这个数组。于是：agent 挂 3 条建议（可见 3、不弹卡）→
// 用户把 3 条都确认（可见 0）→ 🔴 弹「缺上下文」→ 点外扩 → 灌一批垃圾（可见 10、卡片消失）。
// **用户越配合越被灌垃圾。**活库 MAT-0002 的 9 条已确认资料 pinned 全是 0，正是这个形状。

import { describe, expect, test } from 'vitest'

import type { MatterContextSnapshotPayload } from '@shared/api/matters'
import { hasContextGap } from '@shared/components/matters/useMatterContextSnapshot'

function payload(
  overrides: Partial<MatterContextSnapshotPayload> = {},
  matterOverrides: Partial<MatterContextSnapshotPayload['matter']> = {}
): MatterContextSnapshotPayload {
  return {
    matter: {
      id: 2,
      public_id: 'MAT-0002',
      title: '汇总 2025 目标完成度',
      type: null,
      tags: [],
      status: 'active',
      health: 'on_track',
      priority: 'p1',
      due_at: null,
      waiting_context: null,
      background: '',
      goal: '',
      current_summary: null,
      version: 3,
      summary_accepted_at: 1,
      ...matterOverrides
    },
    items: [],
    stakeholders: [],
    resources: [],
    events: [],
    ...overrides
  }
}

describe('hasContextGap', () => {
  test('已确认但没 pin 的资料不再被当成「没有资料」', () => {
    // 投影为空（确认过的资料不进 resources），真实关联数 9 —— 这个事项不缺上下文。
    const snapshot = payload({
      resources: [],
      resource_counts: {
        linked_resources: 9,
        confirmed_resources: 9,
        unconfirmed_suggestions: 0
      }
    })
    expect(hasContextGap(snapshot)).toBe(false)
  })

  test('真的一条资料都没关联时仍然报缺口', () => {
    const snapshot = payload({
      resources: [],
      resource_counts: {
        linked_resources: 0,
        confirmed_resources: 0,
        unconfirmed_suggestions: 0
      }
    })
    expect(hasContextGap(snapshot)).toBe(true)
  })

  test('waiting_context 是显式声明，与资料多少正交', () => {
    const snapshot = payload(
      {
        resources: [],
        resource_counts: {
          linked_resources: 9,
          confirmed_resources: 9,
          unconfirmed_suggestions: 0
        }
      },
      { waiting_context: { who: 'gary' } }
    )
    expect(hasContextGap(snapshot)).toBe(true)
  })

  test('旧后端不发 resource_counts 时 fail-soft 回退到投影判据', () => {
    expect(hasContextGap(payload({ resources: [] }))).toBe(true)
    expect(
      hasContextGap(
        payload({
          resources: [
            {
              id: 5,
              kind: 'email',
              provider: 'mailagent',
              external_key: 'email:1',
              title: null,
              canonical_url: null,
              revision: null,
              access_policy: 'allowed',
              metadata: {},
              excerpt: null
            }
          ]
        })
      )
    ).toBe(false)
  })
})
