// G-16 —— 干系人候选推导。设计原型那份候选来自 mock 的联系人库；这里的可行子集只认
// **已关联资料 metadata 里真实出现过的地址**，推不出就诚实地空着（由手输入口兜底）。

import { describe, expect, test } from 'vitest'

import type { MatterResourceListItem, MatterStakeholder } from '@shared/api/types/matter'
import {
  deriveStakeholderCandidates,
  parseAddressList
} from '@shared/components/matters/matterStakeholderCandidates'

function resource(id: number, metadata: Record<string, unknown>): MatterResourceListItem {
  return {
    resource: {
      id,
      kind: 'email',
      provider: 'mailagent',
      external_key: `email:${id}`,
      canonical_url: null,
      title: `Mail ${id}`,
      metadata,
      revision: null,
      content_hash: null,
      permission_state: null,
      sync_state: null,
      access_policy: 'allowed',
      last_checked_at: null,
      created_at: 0,
      updated_at: 0,
      available: true
    },
    link: {
      id,
      matter_id: 1,
      resource_id: id,
      relation_type: null,
      pinned: false,
      added_by_kind: 'user',
      added_by_id: null,
      confidence: null,
      provenance: {},
      confirmed_at: 1,
      sub_state: 'none',
      deleted_at: null,
      created_at: 0,
      updated_at: 0
    }
  } as unknown as MatterResourceListItem
}

function stakeholder(email: string): MatterStakeholder {
  return { id: 1, email_normalized: email } as unknown as MatterStakeholder
}

describe('parseAddressList', () => {
  test('挖出地址与显示名；不是地址的片段丢掉', () => {
    expect(parseAddressList('Foo Bar <A@B.com>, c@d.com, 无地址')).toEqual([
      { email: 'a@b.com', displayName: 'Foo Bar' },
      { email: 'c@d.com', displayName: null }
    ])
  })
})

describe('deriveStakeholderCandidates', () => {
  test('从 sender / to_addr / cc_addr 汇总，去重并补显示名', () => {
    const rows = deriveStakeholderCandidates(
      [
        resource(1, { sender: 'peer@vendor.com', to_addr: 'me@ourco.com, ally@ourco.com' }),
        resource(2, { sender: 'Peer Name <peer@vendor.com>', cc_addr: 'legal@ourco.com' })
      ],
      []
    )
    expect(rows.map((row) => row.email)).toEqual([
      'ally@ourco.com',
      'legal@ourco.com',
      'me@ourco.com',
      'peer@vendor.com'
    ])
    // 第一条出现时没有显示名，第二条补上了。
    expect(rows.find((row) => row.email === 'peer@vendor.com')?.displayName).toBe('Peer Name')
  })

  test('已经是干系人的剔掉（大小写不敏感）', () => {
    const rows = deriveStakeholderCandidates(
      [resource(1, { sender: 'Peer@Vendor.com', to_addr: 'me@ourco.com' })],
      [stakeholder('peer@vendor.com')]
    )
    expect(rows.map((row) => row.email)).toEqual(['me@ourco.com'])
  })

  test('metadata 里没有地址 → 空列（不编造候选）', () => {
    expect(deriveStakeholderCandidates([resource(1, { thread_id: 't-1' })], [])).toEqual([])
    expect(deriveStakeholderCandidates([], [])).toEqual([])
  })
})
