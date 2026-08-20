// WP5 —— 按汇报线分组（contactListModel 'manager' 档）：组 key = 上级 id、
// label 走 labels.manager 注入、未设上级走 ungrouped 通道恒置底、组头可折叠。

import { describe, expect, test } from 'vitest'

import type { ContactRowDto } from '@shared/api/types/contact'
import { buildContactRows, type ContactListRow } from '@shared/components/contacts/contactListModel'

function row(
  id: number,
  managerContactId: number | null,
  managerDisplayName: string | null
): ContactRowDto {
  return {
    id,
    display_name: `P${id}`,
    formal_name: null,
    organization: null,
    department: null,
    role_title: null,
    function: null,
    seniority: null,
    gender: null,
    kind: 'person',
    hidden_at: null,
    is_self: false,
    mail_count: 10,
    sent_to_count: 1,
    first_seen_at: null,
    last_seen_at: null,
    email_count: 1,
    primary_email: `p${id}@x.com`,
    manager_contact_id: managerContactId,
    manager_display_name: managerDisplayName,
    profile_summary: null,
    profile_min: 50,
    profile_eligible: false
  }
}

const labels = {
  kindGroup: (bucket: string) => `kind:${bucket}`,
  fn: (value: string) => value,
  level: (value: string) => value,
  self: '我',
  manager: (item: ContactRowDto) =>
    `${item.manager_display_name ?? String(item.manager_contact_id)} 的下级`,
  ungrouped: '未设上级'
}

function build(items: ContactRowDto[], collapsed: Record<string, boolean> = {}): ContactListRow[] {
  return buildContactRows({
    items,
    view: 'known',
    groupBy: 'manager',
    kindFilter: new Set(['person']),
    collapsed,
    labels
  })
}

describe('contactListModel — 按汇报线分组', () => {
  const items = [
    row(1, 100, 'Boss'), // Boss 组 ×2
    row(2, 100, 'Boss'),
    row(3, 200, null), // 无名上级 → id 兜底（labels.manager 负责）
    row(4, null, null), // 未设上级 → ungrouped
    row(5, null, null)
  ]

  test('组 key = mgr:{id}；label 走 labels.manager；未设上级组置底', () => {
    const rows = build(items)
    const headers = rows.filter((r) => r.type === 'header')
    expect(headers.map((h) => h.key)).toEqual(['mgr:100', 'mgr:200', 'ungrouped'])
    expect(headers.map((h) => (h.type === 'header' ? h.label : ''))).toEqual([
      'Boss 的下级',
      '200 的下级',
      '未设上级'
    ])
    expect(headers.map((h) => (h.type === 'header' ? h.count : 0))).toEqual([2, 1, 2])
  })

  test('未设上级组即便人数最多也恒末尾（ungrouped 通道）', () => {
    const many = [row(1, 100, 'Boss'), row(2, null, null), row(3, null, null), row(4, null, null)]
    const headers = build(many).filter((r) => r.type === 'header')
    expect(headers.map((h) => h.key)).toEqual(['mgr:100', 'ungrouped'])
  })

  test('组内成员按 items 原序展开；折叠只收起该组成员', () => {
    const open = build(items)
    const bossMembers = open
      .filter((r) => r.type === 'contact')
      .map((r) => (r.type === 'contact' ? r.item.id : 0))
    expect(bossMembers).toEqual([1, 2, 3, 4, 5])

    const collapsed = build(items, { 'mgr:100': true })
    const visible = collapsed
      .filter((r) => r.type === 'contact')
      .map((r) => (r.type === 'contact' ? r.item.id : 0))
    expect(visible).toEqual([3, 4, 5])
    const bossHeader = collapsed.find((r) => r.type === 'header' && r.key === 'mgr:100')
    expect(bossHeader && bossHeader.type === 'header' ? bossHeader.collapsed : false).toBe(true)
  })
})
