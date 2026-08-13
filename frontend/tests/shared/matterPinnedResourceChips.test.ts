// G-21 —— composer 上每份置顶资料一颗可移除 chip；移除 = 把那份摘录从**本轮上下文快照**里
// 剔掉（不是解除关联）。
//
// 🔴 这个文件盯的是**同源**：屏幕上说带了几份、chip 行摆了几颗、真正塞进 prompt 的有几份，
// 必须来自同一份 payload。历史上这类「UI 层单独藏一个元素、payload 照发」的写法就是界面在
// 撒谎——用户以为自己拿掉了那份资料，模型手里其实还有。

import { describe, expect, test } from 'vitest'

import type { MatterContextSnapshotPayload } from '../../src/shared/api/matters'
import {
  applyResourceExclusions,
  toActiveMatterContext,
  toChipCounts
} from '../../src/shared/components/matters/useMatterContextSnapshot'

function resource(id: number, title: string): MatterContextSnapshotPayload['resources'][number] {
  return {
    id,
    kind: 'doc',
    provider: 'notion',
    external_key: `notion:${id}`,
    title,
    canonical_url: null,
    revision: null,
    access_policy: 'inherit',
    metadata: {},
    excerpt: `摘录 ${id}`
  }
}

function payload(): MatterContextSnapshotPayload {
  return {
    matter: {
      id: 1,
      public_id: 'MAT-0001',
      title: 'Ship the release',
      type: null,
      tags: [],
      status: 'active',
      health: 'unknown',
      priority: 'p1',
      due_at: null,
      waiting_context: null,
      description: '',
      current_summary: null,
      version: 1,
      summary_accepted_at: null
    },
    items: [],
    stakeholders: [],
    resources: [resource(11, 'RFP'), resource(12, '合同'), resource(13, '会议纪要')],
    events: []
  } as MatterContextSnapshotPayload
}

describe('applyResourceExclusions', () => {
  test('drops exactly the removed chips and leaves the rest untouched', () => {
    const filtered = applyResourceExclusions(payload(), new Set([12]))
    expect(filtered.resources.map((item) => item.id)).toEqual([11, 13])
  })

  test('an empty / missing exclusion set returns the very same object (no needless re-render)', () => {
    const source = payload()
    expect(applyResourceExclusions(source, undefined)).toBe(source)
    expect(applyResourceExclusions(source, new Set())).toBe(source)
  })

  test('chip counts and the injected excerpts move together', () => {
    const filtered = applyResourceExclusions(payload(), new Set([11, 13]))
    // 屏幕上的数字…
    expect(toChipCounts(payload()).pinnedResources).toBe(3)
    expect(toChipCounts(filtered).pinnedResources).toBe(1)
    // …与真正进 prompt 的那份摘录列表，来自同一个 payload。
    expect(toActiveMatterContext(filtered).resources.map((item) => item.excerpt)).toEqual(['摘录 12'])
  })

  test('unknown ids are inert (a stale removal cannot empty the context)', () => {
    const filtered = applyResourceExclusions(payload(), new Set([999]))
    expect(filtered.resources).toHaveLength(3)
  })
})
