// 同步文件夹树的纯函数测（原 SidebarFolderTree.test.tsx 的前两段，随 task 08-27 P1
// Lane B 把 helpers 从 `components/layout/sidebarFolderTree.helpers` 搬到
// `lib/folderTree` 一起搬过来，断言逐字未改）。
//
// 覆盖: whitelist 过滤 / parent 链层级 / 父未勾子升顶层 / 路径 / 🔴 数组序（不排序）
//       + discover 未就绪的本地 seed 树 + 摊平。

import { describe, expect, test } from 'vitest'

import type { FolderInfo } from '../../src/shared/api/types'
import {
  buildFolderTree,
  buildSeedFolderInfos,
  flattenFolderTree
} from '../../src/shared/lib/folderTree'

function fi(
  imap: string,
  display: string,
  parent: string | null,
  count: number | null
): FolderInfo {
  return {
    imap_name: imap,
    display_name: display,
    delimiter: '/',
    special_use: null,
    is_system: false,
    has_children: false,
    parent,
    message_count: count
  }
}

describe('buildFolderTree — 纯函数', () => {
  test('whitelist 过滤: 只保留勾选的文件夹', () => {
    const folders = [fi('Jira', 'Jira', null, 10), fi('Notion', 'Notion', null, 20)]
    const tree = buildFolderTree(folders, ['Jira'])
    expect(tree).toHaveLength(1)
    expect(tree[0].displayName).toBe('Jira')
  })

  test('parent 链: 勾选的子挂在勾选的父下 — 叶子名切末段, 过滤用全路径', () => {
    // 后端真实返回: display_name 含完整路径 (含 delimiter)。
    const folders = [fi('Proj', '项目', null, null), fi('Proj/Q2', '项目/2026 Q2', 'Proj', 156)]
    const tree = buildFolderTree(folders, ['Proj', 'Proj/Q2'])
    expect(tree).toHaveLength(1)
    // 父行叶子名 = "项目" (无斜线, 直接用末段)。
    expect(tree[0].displayName).toBe('项目')
    expect(tree[0].fullDisplayName).toBe('项目')
    expect(tree[0].children).toHaveLength(1)
    // 子行 label = 叶子名 "2026 Q2" (切掉 "项目/" 前缀)。
    expect(tree[0].children[0].displayName).toBe('2026 Q2')
    // 过滤 key (fullDisplayName) = 完整路径 "项目/2026 Q2"。
    expect(tree[0].children[0].fullDisplayName).toBe('项目/2026 Q2')
    // path 各段也用叶子名 (面包屑渲染)。
    expect(tree[0].children[0].path).toEqual(['项目', '2026 Q2'])
  })

  test('父未勾、子勾 → 子升为顶层 (不丢)', () => {
    const folders = [fi('Proj', '项目', null, null), fi('Proj/Q2', '项目/2026 Q2', 'Proj', 156)]
    const tree = buildFolderTree(folders, ['Proj/Q2'])
    expect(tree).toHaveLength(1)
    // 父未勾 → path 只含叶子段。
    expect(tree[0].displayName).toBe('2026 Q2')
    expect(tree[0].fullDisplayName).toBe('项目/2026 Q2')
    expect(tree[0].path).toEqual(['2026 Q2'])
  })

  test('顶层路径 = 单段', () => {
    const tree = buildFolderTree([fi('Jira', 'Jira', null, 10)], ['Jira'])
    expect(tree[0].path).toEqual(['Jira'])
    expect(tree[0].displayName).toBe('Jira')
    expect(tree[0].fullDisplayName).toBe('Jira')
  })

  // ── 排序 task: whitelist 数组序 = 自定义显示顺序 ─────────────────────────
  test('顶层按 whitelist 数组序排, 不跟 discover 的服务端 LIST 序', () => {
    // folders 是服务端 LIST 序 (A,B,C); whitelist 自定义序是 C,A,B。
    const folders = [fi('A', 'Alpha', null, 1), fi('B', 'Beta', null, 2), fi('C', 'Gamma', null, 3)]
    const tree = buildFolderTree(folders, ['C', 'A', 'B'])
    expect(tree.map((n) => n.imapName)).toEqual(['C', 'A', 'B'])
  })

  test('子节点在同层级内也按 whitelist 序排', () => {
    const folders = [
      fi('Proj', '项目', null, null),
      fi('Proj/X', '项目/X', 'Proj', 1),
      fi('Proj/Y', '项目/Y', 'Proj', 2)
    ]
    // 服务端序 X,Y; 自定义序把 Y 排前面。
    const tree = buildFolderTree(folders, ['Proj', 'Proj/Y', 'Proj/X'])
    expect(tree).toHaveLength(1)
    expect(tree[0].children.map((n) => n.imapName)).toEqual(['Proj/Y', 'Proj/X'])
  })

  test('父未勾升顶层的子, 与其它顶层混排时仍按 whitelist 序', () => {
    const folders = [
      fi('Proj', '项目', null, null),
      fi('Proj/Q2', '项目/2026 Q2', 'Proj', 5),
      fi('Jira', 'Jira', null, 9)
    ]
    // Proj 未勾 → Proj/Q2 升顶层。服务端 LIST 序里 Proj/Q2 在 Jira 之前, 自定义序
    // 要求反过来 —— 断言必须能分辨"排过序"与"照抄服务端序"(否则测试恒绿)。
    const tree = buildFolderTree(folders, ['Jira', 'Proj/Q2'])
    expect(tree.map((n) => n.imapName)).toEqual(['Jira', 'Proj/Q2'])
  })

  test('whitelist 含已不存在的文件夹 → 跳过且不打乱其余顺序', () => {
    const folders = [fi('A', 'Alpha', null, 1), fi('B', 'Beta', null, 2)]
    const tree = buildFolderTree(folders, ['B', 'GONE', 'A'])
    expect(tree.map((n) => n.imapName)).toEqual(['B', 'A'])
  })
})

// ── seed 树 (task 08-20-perf-shell-prefetch-sidebar §③) ────────────────────
describe('buildSeedFolderInfos — discover 未就绪的本地 seed', () => {
  test('display_name = decodeImapUtf7(imap_name) (= email_metadata.mailbox 的值)', () => {
    const seeds = buildSeedFolderInfos(['DMS&VvpO9lPRXgM-', 'Jira'])
    expect(seeds.map((s) => s.display_name)).toEqual(['DMS固件发布', 'Jira'])
    expect(seeds.map((s) => s.imap_name)).toEqual(['DMS&VvpO9lPRXgM-', 'Jira'])
  })

  test('🔴 顺序红线: seed 树同层级按 whitelist 数组序, 绝不按名排序', () => {
    // 自定义序 (Zeta 在 Alpha 前) 与字母序相反 —— sorted() 类变异必红。
    const tree = buildFolderTree(buildSeedFolderInfos(['Zeta', 'Alpha', 'Mid']), [
      'Zeta',
      'Alpha',
      'Mid'
    ])
    expect(tree.map((n) => n.imapName)).toEqual(['Zeta', 'Alpha', 'Mid'])
  })

  test("parent 取 '/' 前缀里最长的 whitelist 成员 → 层级与 discover 树一致", () => {
    const wl = ['Proj', 'Proj/Q2']
    const tree = buildFolderTree(buildSeedFolderInfos(wl), wl)
    expect(tree).toHaveLength(1)
    expect(tree[0].imapName).toBe('Proj')
    expect(tree[0].children.map((n) => n.imapName)).toEqual(['Proj/Q2'])
    // 叶子名切末段, 过滤 key 用完整 display_name (与 discover 树同构)。
    expect(tree[0].children[0].displayName).toBe('Q2')
    expect(tree[0].children[0].fullDisplayName).toBe('Proj/Q2')
  })

  test('中间层未勾选 → 挂到更上层的 whitelist 祖先 (同 nearestSyncedParent 语义)', () => {
    const wl = ['A', 'A/B/C'] // A/B 不在 whitelist
    const tree = buildFolderTree(buildSeedFolderInfos(wl), wl)
    expect(tree).toHaveLength(1)
    expect(tree[0].imapName).toBe('A')
    expect(tree[0].children.map((n) => n.imapName)).toEqual(['A/B/C'])
  })

  test('父不在 whitelist → 顶层平铺 (不丢)', () => {
    const wl = ['Proj/Q2']
    const tree = buildFolderTree(buildSeedFolderInfos(wl), wl)
    expect(tree).toHaveLength(1)
    expect(tree[0].fullDisplayName).toBe('Proj/Q2')
  })
})

// ── 摊平（下拉面板不做展开/收起，整棵树平铺）─────────────────────────────
describe('flattenFolderTree', () => {
  test('深度优先: 父在前、子紧随, 深度随层级递增', () => {
    const folders = [
      fi('Proj', '项目', null, null),
      fi('Proj/Q2', '项目/2026 Q2', 'Proj', 5),
      fi('Jira', 'Jira', null, 9)
    ]
    const flat = flattenFolderTree(buildFolderTree(folders, ['Proj', 'Proj/Q2', 'Jira']))
    expect(flat.map((f) => [f.node.imapName, f.depth])).toEqual([
      ['Proj', 0],
      ['Proj/Q2', 1],
      ['Jira', 0]
    ])
  })
})
