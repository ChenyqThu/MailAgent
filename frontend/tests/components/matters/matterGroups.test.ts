// V3-05 —— 事项清单行内分组（设计 `list.jsx::groupsFor` / H3§2）的语义闸：五个维度各一条、
// 空组不产出、标签维度的「一行进多组」与导航序去重。
//
// 🔴 为什么导航序也钉在这里：清单渲染与详情页上/下条导航必须是同一个视觉序，两边都吃
// `groupMatters` + `orderedMatterIds`。这道测试是那个「同一份序」的判据。

import { describe, expect, test } from 'vitest'

import { MATTER_STATUSES } from '../../../src/shared/api/types/matter'
import type { Matter } from '../../../src/shared/api/types/matter'
import {
  groupMatters,
  matterDueBucket,
  orderedMatterIds
} from '../../../src/shared/components/matters/matterListQuery'

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

const shape = (matters: readonly Matter[], mode: Parameters<typeof groupMatters>[1]) =>
  groupMatters(matters, mode, NOW).map((group) => [
    group.key,
    group.matters.map((value) => value.public_id)
  ])

describe('groupMatters', () => {
  test('status —— 六个语义组按词表顺序，成员按 MATTER_STATUS_GROUP_MEMBERS 收编', () => {
    const rows = [
      matter({ public_id: 'MAT-0001', status: 'blocked' }),
      matter({ public_id: 'MAT-0002', status: 'inbox' }),
      matter({ public_id: 'MAT-0003', status: 'canceled' }),
      matter({ public_id: 'MAT-0004', status: 'active' }),
      matter({ public_id: 'MAT-0005', status: 'done' })
    ]
    expect(shape(rows, 'status')).toEqual([
      // inbox 与 active 同属「需要你推进」，组内保持传入顺序（= applyMatterListQuery 的序）
      ['status:needyou', ['MAT-0002', 'MAT-0004']],
      ['status:blocked', ['MAT-0001']],
      ['status:closed', ['MAT-0003', 'MAT-0005']]
    ])
  })

  test('due —— 逾期 / 今天·明天 / 本周内 / 更晚 / 无期限五档，边界按整日差', () => {
    const rows = [
      matter({ public_id: 'MAT-0001', due_at: NOW - DAY }),
      matter({ public_id: 'MAT-0002', due_at: NOW }),
      matter({ public_id: 'MAT-0003', due_at: NOW + DAY }),
      matter({ public_id: 'MAT-0004', due_at: NOW + 7 * DAY }),
      matter({ public_id: 'MAT-0005', due_at: NOW + 8 * DAY }),
      matter({ public_id: 'MAT-0006' })
    ]
    expect(shape(rows, 'due')).toEqual([
      ['due:overdue', ['MAT-0001']],
      ['due:soon', ['MAT-0002', 'MAT-0003']],
      ['due:week', ['MAT-0004']],
      ['due:later', ['MAT-0005']],
      ['due:none', ['MAT-0006']]
    ])
    expect(matterDueBucket(matter({ due_at: NOW + 7 * DAY }), NOW)).toBe('week')
    expect(matterDueBucket(matter({ due_at: NOW + 8 * DAY }), NOW)).toBe('later')
  })

  test('priority —— P0→P3 固定序（本仓 priority 非空，没有「未设优先级」这一档）', () => {
    const rows = [
      matter({ public_id: 'MAT-0001', priority: 'p3' }),
      matter({ public_id: 'MAT-0002', priority: 'p0' }),
      matter({ public_id: 'MAT-0003', priority: 'p3' })
    ]
    expect(shape(rows, 'priority')).toEqual([
      ['priority:p0', ['MAT-0002']],
      ['priority:p3', ['MAT-0001', 'MAT-0003']]
    ])
  })

  test('tag —— 每个标签一组（首次出现序）+ 无标签殿后；一行可进多组（设计 H3§2）', () => {
    const rows = [
      matter({ public_id: 'MAT-0001', tags: ['合规', '发布'] }),
      matter({ public_id: 'MAT-0002', tags: ['发布'] }),
      matter({ public_id: 'MAT-0003', tags: [] })
    ]
    expect(shape(rows, 'tag')).toEqual([
      ['tag:合规', ['MAT-0001']],
      ['tag:发布', ['MAT-0001', 'MAT-0002']],
      ['untagged', ['MAT-0003']]
    ])
  })

  test('tag —— 组 key 带命名空间前缀：标签名与语义状态组同名也不撞', () => {
    const [group] = groupMatters([matter({ tags: ['waiting'] })], 'tag', NOW)
    expect(group.key).toBe('tag:waiting')
  })

  test('none —— 单个无头组；空列表在任何维度下都不产出组', () => {
    expect(shape([matter({ public_id: 'MAT-0001' })], 'none')).toEqual([['all', ['MAT-0001']]])
    for (const mode of ['status', 'due', 'priority', 'tag', 'none'] as const) {
      expect(groupMatters([], mode, NOW)).toEqual([])
    }
  })

  test('空组不产出 —— 只出现命中的档，缺席的档整条不在结果里', () => {
    const keys = groupMatters([matter({ status: 'waiting' })], 'status', NOW).map(
      (group) => group.key
    )
    expect(keys).toEqual(['status:waiting'])
  })

  test('🔴 全覆盖：任何一行在任何维度下都至少落进一个组（漏一档 = 该行在清单里凭空消失）', () => {
    // 状态是最容易漏的一维：新增第 9 档 MatterStatus 而没进 MATTER_STATUS_GROUP_MEMBERS 时，
    // 那些行在默认分组下会一行不剩地看不见（而扁平列表时代不会）。
    const rows = MATTER_STATUSES.map((status, index) =>
      matter({ public_id: `MAT-${1000 + index}`, status, tags: index % 2 === 0 ? ['x'] : [] })
    )
    const ids = rows.map((row) => row.public_id)
    for (const mode of ['status', 'due', 'priority', 'tag', 'none'] as const) {
      expect(orderedMatterIds(groupMatters(rows, mode, NOW)).sort()).toEqual([...ids].sort())
    }
  })
})

describe('orderedMatterIds（详情上/下条导航序）', () => {
  test('按分组后的视觉顺序展平，而不是传入的扁平序', () => {
    const rows = [
      matter({ public_id: 'MAT-0001', status: 'blocked' }),
      matter({ public_id: 'MAT-0002', status: 'active' })
    ]
    expect(orderedMatterIds(groupMatters(rows, 'status', NOW))).toEqual(['MAT-0002', 'MAT-0001'])
    // 不分组时退化成传入序本身
    expect(orderedMatterIds(groupMatters(rows, 'none', NOW))).toEqual(['MAT-0001', 'MAT-0002'])
  })

  test('标签维度下同一事项只进导航序一次（indexOf 定位不能有重复 id）', () => {
    const rows = [
      matter({ public_id: 'MAT-0001', tags: ['合规', '发布'] }),
      matter({ public_id: 'MAT-0002', tags: ['发布'] })
    ]
    const groups = groupMatters(rows, 'tag', NOW)
    // 视觉上 MAT-0001 出现两次……
    expect(groups.flatMap((group) => group.matters.map((value) => value.public_id))).toEqual([
      'MAT-0001',
      'MAT-0001',
      'MAT-0002'
    ])
    // ……导航序里只留首次出现
    expect(orderedMatterIds(groups)).toEqual(['MAT-0001', 'MAT-0002'])
  })
})
