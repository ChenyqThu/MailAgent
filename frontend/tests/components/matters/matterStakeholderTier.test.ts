import { describe, expect, it } from 'vitest'

import type { MatterStakeholder } from '@shared/api/types/matter'
import {
  buildReorderPayload,
  splitStakeholdersByTier
} from '@shared/components/matters/matterStakeholderTier'

/**
 * S2 —— 干系人分组与重排 payload 的纯逻辑。
 *
 * 两条最容易写错、且错了不会报错只会「顺序悄悄不对」的地方：
 * 1. 分桶时**不许重排**（服务端已按 `(tier='core') DESC, sort_order, id` 排好）
 * 2. 重排 payload 跨组**统一编号**（per-tier 重置会让每次换组都要重排两个组）
 */

function stakeholder(id: number, tier?: 'core' | 'normal'): MatterStakeholder {
  return {
    id,
    matter_id: 1,
    person_key: `k${id}`,
    display_name: `p${id}`,
    email_normalized: `p${id}@example.test`,
    organization: null,
    role: null,
    relationship: null,
    is_waiting_on: false,
    ...(tier ? { tier } : {}),
    last_contact_at: null,
    source_resource_id: null,
    contact_id: null,
    deleted_at: null,
    created_at: 0,
    updated_at: 0
  }
}

describe('splitStakeholdersByTier', () => {
  it('按 tier 分桶', () => {
    const { core, normal } = splitStakeholdersByTier([
      stakeholder(1, 'core'),
      stakeholder(2, 'normal'),
      stakeholder(3, 'core')
    ])
    expect(core.map((s) => s.id)).toEqual([1, 3])
    expect(normal.map((s) => s.id)).toEqual([2])
  })

  it('🔴 桶内保持服务端给的相对顺序，不重排', () => {
    // 服务端按 sort_order 排好后传下来的顺序是 3,1,2 —— 读侧再 sorted() 就会把
    // 用户拖出来的顺序覆盖掉（同 SYNC_FOLDERS 数组序那条纪律）。
    const { core } = splitStakeholdersByTier([
      stakeholder(3, 'core'),
      stakeholder(1, 'core'),
      stakeholder(2, 'core')
    ])
    expect(core.map((s) => s.id)).toEqual([3, 1, 2])
  })

  it('旧后端不发 tier ⇒ 归 normal（不是凭空多一个「未知」组）', () => {
    const { core, normal } = splitStakeholdersByTier([stakeholder(1), stakeholder(2)])
    expect(core).toEqual([])
    expect(normal.map((s) => s.id)).toEqual([1, 2])
  })
})

describe('buildReorderPayload', () => {
  it('跨组统一编号，core 在前', () => {
    const payload = buildReorderPayload(
      [stakeholder(10, 'core'), stakeholder(11, 'core')],
      [stakeholder(20, 'normal')]
    )
    expect(payload).toEqual([
      { id: 10, sort_order: 0, tier: 'core' },
      { id: 11, sort_order: 1, tier: 'core' },
      { id: 20, sort_order: 2, tier: 'normal' }
    ])
  })

  it('🔴 tier 按**它落在哪个数组**给，不读行上的旧 tier', () => {
    // 换组的整个机制就是这个：把行从一个数组挪到另一个，payload 里的 tier 跟着变。
    // 若这里读 stakeholder.tier，换组就永远不生效（值还是旧的）。
    const moved = stakeholder(7, 'normal')
    const payload = buildReorderPayload([moved], [])
    expect(payload).toEqual([{ id: 7, sort_order: 0, tier: 'core' }])
  })

  it('空组不产生条目', () => {
    expect(buildReorderPayload([], [])).toEqual([])
  })

  it('sort_order 连续无空洞（服务端只按值排序，空洞无害但会让下次计算难读）', () => {
    const payload = buildReorderPayload(
      [stakeholder(1, 'core')],
      [stakeholder(2, 'normal'), stakeholder(3, 'normal')]
    )
    expect(payload.map((entry) => entry.sort_order)).toEqual([0, 1, 2])
  })
})

describe('「其他」组的默认折叠态', () => {
  it('🔴 还没人被标核心时默认展开 —— 否则存量事项打开后一个干系人都看不见', () => {
    // 语义在组件里（useState 初值 = core.length === 0）。这里钉的是那条判据本身：
    // tier 是 v60 才有的列，存量行全是 normal，一律折叠 = 把整个干系人区藏起来。
    const { core } = splitStakeholdersByTier([stakeholder(1), stakeholder(2)])
    expect(core.length === 0).toBe(true)
  })

  it('有核心成员时才折叠「其他」', () => {
    const { core } = splitStakeholdersByTier([stakeholder(1, 'core'), stakeholder(2)])
    expect(core.length === 0).toBe(false)
  })
})
