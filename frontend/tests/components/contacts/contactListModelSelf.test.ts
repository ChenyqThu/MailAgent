// WP-3（task 08-14）——「我」置顶成单独一组；WP-6 B 收窄成**只在「全部」视图**
//（「往来的人」里自己不是往来对象，后端已把 is_self 排除）。
// 没有 self 行时输出与该改动前逐字相同（回归闸：这条错了 = 所有既有列表形状被动过）。

import { describe, expect, test } from 'vitest'

import type { ContactRowDto } from '@shared/api/types/contact'
import {
  buildContactRows,
  SELF_GROUP_KEY,
  type ContactGroupBy,
  type ContactKindBucket,
  type ContactListRow
} from '@shared/components/contacts/contactListModel'

function row(id: number, patch: Partial<ContactRowDto> = {}): ContactRowDto {
  return {
    id,
    display_name: `P${id}`,
    formal_name: null,
    organization: 'ACME',
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
    manager_contact_id: null,
    manager_display_name: null,
    profile_summary: null,
    profile_min: 50,
    profile_eligible: false,
    ...patch
  }
}

const labels = {
  kindGroup: (bucket: string) => `kind:${bucket}`,
  fn: (value: string) => value,
  level: (value: string) => value,
  self: '我',
  manager: (item: ContactRowDto) => `${item.manager_contact_id} 的下级`,
  ungrouped: '未分组'
}

function build(
  items: ContactRowDto[],
  options: {
    view?: 'known' | 'all'
    groupBy?: ContactGroupBy
    collapsed?: Record<string, boolean>
    kindFilter?: ContactKindBucket[]
  } = {}
): ContactListRow[] {
  return buildContactRows({
    items,
    view: options.view ?? 'known',
    groupBy: options.groupBy ?? 'none',
    kindFilter: new Set(options.kindFilter ?? ['person', 'robot', 'list', 'hidden']),
    collapsed: options.collapsed ?? {},
    labels
  })
}

const ids = (rows: ContactListRow[]): number[] =>
  rows.flatMap((r) => (r.type === 'contact' ? [r.item.id] : []))
const headerKeys = (rows: ContactListRow[]): string[] =>
  rows.flatMap((r) => (r.type === 'header' ? [r.key] : []))

describe('contactListModel —「我」置顶组', () => {
  const me = row(9, { is_self: true, sent_to_count: 0, mail_count: 0 })

  test('没有 self 行时输出与改动前逐字相同（不凭空多出组头）', () => {
    const plain = [row(1), row(2)]
    expect(build(plain)).toEqual([
      { type: 'contact', key: 'c:1', item: plain[0] },
      { type: 'contact', key: 'c:2', item: plain[1] }
    ])
    expect(headerKeys(build(plain, { view: 'all' }))).toEqual(['kind:person'])
  })

  test('all + 不分组：「我」成组恒排最前，其余保持原序', () => {
    const rows = build([row(1), me, row(2)], { view: 'all' })
    expect(rows[0]).toMatchObject({ type: 'header', key: SELF_GROUP_KEY, label: '我', count: 1 })
    expect(ids(rows)).toEqual([9, 1, 2])
  })

  test('🔴 known 视图不摘置顶组（WP-6 B）—— 混进来的 self 行也只当普通行', () => {
    // 后端 known 视图已排除 is_self；这里钉的是「即便混进来也不多出组头」，
    // 判据回退（`view === 'all'` 条件被去掉）时本测必红。
    const rows = build([row(1), me, row(2)])
    expect(headerKeys(rows)).toEqual([])
    expect(ids(rows)).toEqual([1, 9, 2])
  })

  test('属性分组档下「我」仍在最前，且不混进业务分组', () => {
    const rows = build([row(1), me, row(2, { organization: 'Initech' })], {
      view: 'all',
      groupBy: 'company'
    })
    expect(headerKeys(rows)).toEqual([SELF_GROUP_KEY, 'org:ACME', 'org:Initech'])
    expect(ids(rows)).toEqual([9, 1, 2])
    // 组计数不把「我」算进公司组
    const acme = rows.find((r) => r.type === 'header' && r.key === 'org:ACME')
    expect(acme && acme.type === 'header' ? acme.count : -1).toBe(1)
  })

  test('known 的属性分组档下「我」照常落进业务分组（不再单摘）', () => {
    const rows = build([row(1), me, row(2, { organization: 'Initech' })], {
      groupBy: 'company'
    })
    expect(headerKeys(rows)).toEqual(['org:ACME', 'org:Initech'])
    const acme = rows.find((r) => r.type === 'header' && r.key === 'org:ACME')
    expect(acme && acme.type === 'header' ? acme.count : -1).toBe(2)
  })

  test('「全部」视图的 kind 分段里也不再出现「我」（它在置顶组）', () => {
    const rows = build([row(1), me, row(2, { kind: 'robot' })], { view: 'all' })
    expect(headerKeys(rows)).toEqual([SELF_GROUP_KEY, 'kind:person', 'kind:robot'])
    const person = rows.find((r) => r.type === 'header' && r.key === 'kind:person')
    expect(person && person.type === 'header' ? person.count : -1).toBe(1)
  })

  test('「全部」视图的 chips 仍然管得住「我」（关掉「人」它一起消失）', () => {
    const rows = build([row(1), me], { view: 'all', kindFilter: ['robot'] })
    expect(rows).toEqual([])
  })

  test('置顶组默认展开，可折叠', () => {
    const rows = build([row(1), me], { view: 'all', collapsed: { [SELF_GROUP_KEY]: true } })
    expect(ids(rows)).toEqual([1])
    const header = rows.find((r) => r.type === 'header' && r.key === SELF_GROUP_KEY)
    expect(header && header.type === 'header' ? header.collapsed : false).toBe(true)
  })
})
