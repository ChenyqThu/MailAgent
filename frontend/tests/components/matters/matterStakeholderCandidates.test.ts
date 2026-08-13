// G-16 —— 干系人候选推导。设计原型那份候选来自 mock 的联系人库；这里的可行子集只认
// **已关联资料 metadata 里真实出现过的地址**，推不出就诚实地空着（由手输入口兜底）。

import { describe, expect, test } from 'vitest'

import type {
  MatterContact,
  MatterContactCandidate,
  MatterResourceListItem,
  MatterStakeholder
} from '@shared/api/types/matter'
import {
  buildStakeholderPickerPools,
  deriveStakeholderCandidates,
  filterStakeholderPool,
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

// ---- W-C 三分组池 ----------------------------------------------------------

function contact(email: string, patch: Partial<MatterContact> = {}): MatterContact {
  return {
    id: 1,
    email_normalized: email,
    display_name: null,
    organization: null,
    created_at: 0,
    updated_at: 0,
    matter_count: 0,
    last_contact_at: null,
    ...patch
  }
}

function candidate(email: string, patch: Partial<MatterContactCandidate> = {}): MatterContactCandidate {
  return {
    email,
    display_name: null,
    mail_count: 1,
    last_seen_at: null,
    contact_id: null,
    ...patch
  }
}

describe('buildStakeholderPickerPools', () => {
  test('三组互斥：本事项往来 > 联系人库 > 邮件提取；已是干系人的全部剔掉', () => {
    const pools = buildStakeholderPickerPools(
      [{ email: 'peer@vendor.com', displayName: null }],
      [
        contact('peer@vendor.com', { id: 1, display_name: 'Peer', matter_count: 2 }),
        contact('lib@ourco.com', { id: 2, display_name: 'Lib Person', matter_count: 1 }),
        contact('taken@ourco.com', { id: 3 })
      ],
      [
        candidate('peer@vendor.com', { mail_count: 9 }),
        candidate('lib@ourco.com', { mail_count: 5 }),
        candidate('fresh@vendor.com', { mail_count: 3, display_name: 'Fresh' })
      ],
      [stakeholder('taken@ourco.com')]
    )
    expect(pools.fromMatter.map((p) => p.email)).toEqual(['peer@vendor.com'])
    expect(pools.library.map((p) => p.email)).toEqual(['lib@ourco.com'])
    expect(pools.extracted.map((p) => p.email)).toEqual(['fresh@vendor.com'])
    // 往来组条目被库信息补全（全局一份的名字优先于邮件头解析名）
    expect(pools.fromMatter[0]).toMatchObject({
      displayName: 'Peer',
      matterCount: 2,
      source: 'matter'
    })
    expect(pools.extracted[0]).toMatchObject({ mailCount: 3, source: 'email_scan' })
  })

  test('全空输入 → 三组皆空（不编造）', () => {
    const pools = buildStakeholderPickerPools([], [], [], [])
    expect(pools).toEqual({ fromMatter: [], library: [], extracted: [] })
  })
})

describe('filterStakeholderPool', () => {
  const pool = [
    {
      email: 'alice@x.com',
      displayName: 'Alice',
      organization: 'ACME',
      source: 'library' as const,
      matterCount: 1,
      mailCount: null,
      lastSeenAt: null
    },
    {
      email: 'bob@y.com',
      displayName: null,
      organization: null,
      source: 'library' as const,
      matterCount: 1,
      mailCount: null,
      lastSeenAt: null
    }
  ]

  test('命中邮箱 / 姓名 / 组织（大小写不敏感）；空搜索原样返回', () => {
    expect(filterStakeholderPool(pool, '').map((p) => p.email)).toEqual([
      'alice@x.com',
      'bob@y.com'
    ])
    expect(filterStakeholderPool(pool, 'ACME').map((p) => p.email)).toEqual(['alice@x.com'])
    expect(filterStakeholderPool(pool, 'bob@').map((p) => p.email)).toEqual(['bob@y.com'])
    expect(filterStakeholderPool(pool, 'nobody')).toEqual([])
  })
})
