// composer 上「已注入的上下文」里那个置顶资料计数的**同源**闸：屏幕上说带了几份，与真正
// 塞进 prompt 的那份摘录列表，必须来自同一个 payload。历史上这类「UI 层单独藏一个元素、
// payload 照发」的写法就是界面在撒谎——用户以为自己拿掉了那份资料，模型手里其实还有。
//
// 🔴 G-21 的「每份置顶资料一颗可移除 chip」已随 D15（0813 dogfood）退役：唯一的移除入口
// 没了，剔除参数 `excludedResourceIds` / `applyResourceExclusions` 随之成为死代码并已删除。
// 这里只剩仍然活着的两个投影 —— 它们的同源关系才是这个文件真正要钉的东西。

import { describe, expect, test } from 'vitest'

import type { MatterContextSnapshotPayload } from '../../src/shared/api/matters'
import {
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
      background: '',
      goal: '',
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

describe('matter context snapshot projections', () => {
  test('chip counts and the injected excerpts come from the same payload', () => {
    const source = payload()
    // 屏幕上的数字…
    expect(toChipCounts(source).pinnedResources).toBe(3)
    // …与真正进 prompt 的那份摘录列表，逐条对齐。
    expect(toActiveMatterContext(source).resources.map((item) => item.excerpt)).toEqual([
      '摘录 11',
      '摘录 12',
      '摘录 13'
    ])
  })

  test('an empty payload projects zeros, not a placeholder count', () => {
    const source = { ...payload(), resources: [] } as MatterContextSnapshotPayload
    expect(toChipCounts(source).pinnedResources).toBe(0)
    expect(toActiveMatterContext(source).resources).toEqual([])
  })
})
