// 部门分组（contactListModel 'dept' 档）—— owner 拍板的「组织架构框架」把 department
// 变成了路径（`EBG / ENBU / 产品部`）。分组键因此只取**第一级**：整串当键会让每条支线
// 各成一组，组多到没法扫。
//
// 钉四件事：
//   ① 一级键归并：同一级的不同支线并进一个组；
//   ② 组内按完整路径排（同支线的人挨在一起），同路径落回入参次序（= 当前 sort）；
//   ③ 老数据没有 ` / ` → 第一级 = 整串，行为与改造前逐字一致；
//   ④ 第一级为空（`  / ENBU` 这种脏值）进未分组，不画空标题的组。

import { describe, expect, test } from 'vitest'

import type { ContactRowDto } from '@shared/api/types/contact'
import { buildContactRows, type ContactListRow } from '@shared/components/contacts/contactListModel'

function row(id: number, department: string | null): ContactRowDto {
  return {
    id,
    display_name: `P${id}`,
    formal_name: null,
    organization: null,
    department,
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
    profile_eligible: false
  }
}

const labels = {
  kindGroup: (bucket: string) => `kind:${bucket}`,
  fn: (value: string) => value,
  level: (value: string) => value,
  self: '我',
  manager: (item: ContactRowDto) => String(item.manager_contact_id),
  ungrouped: '未分组'
}

function build(items: ContactRowDto[]): ContactListRow[] {
  return buildContactRows({
    items,
    view: 'known',
    groupBy: 'dept',
    kindFilter: new Set(['person']),
    collapsed: {},
    labels
  })
}

/** 组头 label → 该组成员 id（按渲染顺序）。 */
function groups(rows: ContactListRow[]): Array<{ label: string; ids: number[] }> {
  const out: Array<{ label: string; ids: number[] }> = []
  for (const row_ of rows) {
    if (row_.type === 'header') out.push({ label: row_.label, ids: [] })
    else out[out.length - 1]?.ids.push(row_.item.id)
  }
  return out
}

describe('contactListModel — 部门一级分组', () => {
  test('一级键归并：同一级的不同支线并进一个组，组头是第一级', () => {
    const rows = build([
      row(1, 'EBG / ENBU / 产品部'),
      row(2, 'EBG / 财务'),
      row(3, '商用产品研发处 / 系统部')
    ])

    const list = groups(rows)
    expect(list.map((g) => g.label)).toEqual(['EBG', '商用产品研发处'])
    // 两条支线并进同一个一级组（组内次序由 localeCompare 定，见下一条）。
    expect([...list[0]!.ids].sort()).toEqual([1, 2])
    expect(list[1]!.ids).toEqual([3])
  })

  // 🔴 断言的是**同支线连续 + 同路径保序**，不是某个绝对次序：具体名次取决于 ICU 的 zh
  // 排序规则（实测这套 ICU 把汉字排在拉丁字母之前），把它抄成期望值等于把 Node 的 ICU
  // 版本钉进测试 —— 换个运行时就红，而用户真正在意的是「同支线的人挨在一起」。
  test('组内同支线连续；同路径落回入参次序（当前 sort 不被打乱）', () => {
    // 入参次序故意打散，且 4 与 2 同路径 —— 它俩之间必须维持 4 在 2 前。
    const rows = build([
      row(1, 'EBG / 财务'),
      row(4, 'EBG / ENBU / 产品部'),
      row(2, 'EBG / ENBU / 产品部'),
      row(3, 'EBG / ENBU / 测试部')
    ])

    const ids = groups(rows)[0]!.ids
    expect([...ids].sort()).toEqual([1, 2, 3, 4])
    // 同路径的 4 与 2 紧挨着，且 4 在前（稳定排序保住入参次序）。
    expect(ids.indexOf(2) - ids.indexOf(4)).toBe(1)
    // 同支线（ENBU）的三个人连续，`财务` 不许插进他们中间。
    const enbu = [4, 2, 3].map((id) => ids.indexOf(id)).sort((a, b) => a - b)
    expect(enbu[2]! - enbu[0]!).toBe(2)
  })

  test('老数据没有 ` / `：第一级 = 整串，与改造前逐字一致', () => {
    const rows = build([row(1, '平台技术部'), row(2, '平台技术部'), row(3, '财务部')])

    const list = groups(rows)
    expect(list.map((g) => g.label)).toEqual(['平台技术部', '财务部'])
    expect(list[0]!.ids).toEqual([1, 2])
  })

  test('第一级为空 / 没有部门 → 未分组（不画空标题的组）', () => {
    const rows = build([row(1, 'EBG / ENBU'), row(2, ' / ENBU'), row(3, null), row(4, '   ')])

    const list = groups(rows)
    expect(list.map((g) => g.label)).toEqual(['EBG', '未分组'])
    // 空第一级、null、纯空白三种都归到未分组那一组。
    expect(list[1]!.ids).toEqual([2, 3, 4])
    expect(list.some((g) => g.label.trim() === '')).toBe(false)
  })

  // 🔴 组内重排只该在 dept 档发生 —— 别的分组档的组内次序就是当前 sort，动了就是回归。
  test('其他分组档的组内次序不受影响（company 档按入参序）', () => {
    const items = [
      { ...row(1, 'B / x'), organization: 'Acme' },
      { ...row(2, 'A / y'), organization: 'Acme' }
    ]
    const rows = buildContactRows({
      items,
      view: 'known',
      groupBy: 'company',
      kindFilter: new Set(['person']),
      collapsed: {},
      labels
    })

    // 若 dept 排序漏了 groupBy 判定，这里会被 department 排成 [2, 1]。
    expect(groups(rows)[0]!.ids).toEqual([1, 2])
  })
})
