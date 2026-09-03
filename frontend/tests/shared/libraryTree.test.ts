// @vitest-environment happy-dom
//
// 资料库文件夹树的**数据层**（task 09-03 P1-L4）：`components/library/tree.ts` 的
// build / flatten + `state/library-tree.ts` 的展开 / 选中 / 视图 / 排序。
//
// 这里钉的是 design §2.2 / §8.2 里几条会被静默改坏的不变量：
//   · 多根顺序：内置四根（TOP_LEVEL_SLUGS 去掉 .trash）→ 挂载分组 → 废纸篓；
//   · 内置四根**恒在**（服务端还没建目录时也要能点进去），不因服务端少返一行就消失；
//   · 同层级保持**服务端顺序**（投影区按月是服务端排好的，读侧再 sort 一次就乱）；
//   · 只读 / 不可用**向下传染**（投影根、ro 挂载、拔了的卷）；
//   · 父行缺失的文件夹不丢（升到自己的根下）——树是唯一导航面，丢一行 = 那批文件不可达。

import { beforeEach, describe, expect, test } from 'vitest'

import type { LibraryFolderNode, LibraryMount } from '@shared/api/types/library'
import {
  MOUNTS_GROUP_PATH,
  ancestorPaths,
  buildLibraryTree,
  flattenLibraryTree
} from '@shared/components/library/tree'
import { useLibraryTree, resetLibraryTreeState } from '@shared/state/library-tree'

function folder(path: string, overrides: Partial<LibraryFolderNode> = {}): LibraryFolderNode {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null
  return {
    path,
    parent_path: parent,
    name: path.slice(path.lastIndexOf('/') + 1),
    mount_id: 0,
    file_count: 0,
    ...overrides
  }
}

function mount(overrides: Partial<LibraryMount> = {}): LibraryMount {
  return {
    id: 1,
    label: '工作区',
    abs_path: '/Users/me/Documents/工作区',
    mode: 'rw',
    status: 'ok',
    file_count: 12,
    added_at: 1_756_000_000,
    ...overrides
  }
}

describe('buildLibraryTree — 多根', () => {
  test('内置四根恒在且按 slug 顺序，挂载分组在其后，废纸篓最后', () => {
    // 服务端只返了一个根 —— 另外三个仍要出现（目录还没建 ≠ 不能点进去）。
    const roots = buildLibraryTree({ folders: [folder('my-docs')], mounts: [] })

    expect(roots.map((n) => n.path)).toEqual([
      'mail-attachments',
      'chat-attachments',
      'agent-docs',
      'my-docs',
      MOUNTS_GROUP_PATH,
      '.trash'
    ])
    expect(roots[4].kind).toBe('group')
    expect(roots[5].kind).toBe('trash')
    expect(roots[0].kind).toBe('root')
  })

  test('挂载根挂在分组下，path = @label，分组角标 = 挂载数', () => {
    const mounts = [mount(), mount({ id: 2, label: '素材', mode: 'ro' })]
    const roots = buildLibraryTree({
      folders: [folder('@工作区/notes', { mount_id: 1, file_count: 3 })],
      mounts
    })
    const group = roots.find((n) => n.path === MOUNTS_GROUP_PATH)

    expect(group?.fileCount).toBe(2)
    expect(group?.children.map((n) => n.path)).toEqual(['@工作区', '@素材'])
    expect(group?.children[0].children.map((n) => n.path)).toEqual(['@工作区/notes'])
    expect(group?.children[0].mount?.abs_path).toBe('/Users/me/Documents/工作区')
  })
})

describe('buildLibraryTree — 层级与顺序', () => {
  test('同层级保持服务端顺序，不按名字重排', () => {
    const roots = buildLibraryTree({
      folders: [
        folder('mail-attachments/2026-08'),
        folder('mail-attachments/2026-07'),
        folder('mail-attachments/2026-09')
      ],
      mounts: []
    })
    const projection = roots[0]

    expect(projection.children.map((n) => n.name)).toEqual(['2026-08', '2026-07', '2026-09'])
  })

  test('父行缺失的文件夹升到自己的根下，不丢', () => {
    // 服务端只返了孙层（`my-docs/a` 这一行没返）。
    const roots = buildLibraryTree({ folders: [folder('my-docs/a/b')], mounts: [] })
    const myDocs = roots.find((n) => n.path === 'my-docs')

    expect(myDocs?.children.map((n) => n.path)).toEqual(['my-docs/a/b'])
  })

  test('根都认不出来的文件夹仍然进树（附在内置根之后）', () => {
    const roots = buildLibraryTree({ folders: [folder('未知根/x')], mounts: [] })

    expect(roots.map((n) => n.path)).toContain('未知根/x')
  })
})

describe('buildLibraryTree — 只读 / 不可用向下传染', () => {
  test('投影根整棵只读', () => {
    const roots = buildLibraryTree({ folders: [folder('mail-attachments/2026-08')], mounts: [] })

    expect(roots[0].readonly).toBe(true)
    expect(roots[0].children[0].readonly).toBe(true)
    expect(roots.find((n) => n.path === 'my-docs')?.readonly).toBe(false)
  })

  test('ro 挂载整棵只读；rw 挂载可写', () => {
    const roots = buildLibraryTree({
      folders: [
        folder('@素材/logo', { mount_id: 2 }),
        folder('@工作区/notes', { mount_id: 1 })
      ],
      mounts: [mount(), mount({ id: 2, label: '素材', mode: 'ro' })]
    })
    const group = roots.find((n) => n.path === MOUNTS_GROUP_PATH)
    const [work, assets] = group?.children ?? []

    expect(work.readonly).toBe(false)
    expect(assets.readonly).toBe(true)
    expect(assets.children[0].readonly).toBe(true)
  })

  test('卷拔了的挂载整棵灰显（unavailable 向下传染）', () => {
    const roots = buildLibraryTree({
      folders: [folder('@移动硬盘/2025', { mount_id: 3 })],
      mounts: [mount({ id: 3, label: '移动硬盘', status: 'unavailable' })]
    })
    const disk = roots.find((n) => n.path === MOUNTS_GROUP_PATH)?.children[0]

    expect(disk?.unavailable).toBe(true)
    expect(disk?.children[0].unavailable).toBe(true)
  })
})

describe('flattenLibraryTree', () => {
  const roots = buildLibraryTree({
    folders: [folder('my-docs/a'), folder('my-docs/a/b')],
    mounts: [mount()]
  })

  test('只摊平展开的分支，depth 从 0 起', () => {
    const collapsed = flattenLibraryTree(roots, new Set())
    expect(collapsed.map((r) => r.path)).not.toContain('my-docs/a')
    expect(collapsed.every((r) => r.depth === 0)).toBe(true)

    const opened = flattenLibraryTree(roots, new Set(['my-docs', 'my-docs/a']))
    const paths = opened.map((r) => r.path)
    expect(paths).toContain('my-docs/a/b')
    expect(opened.find((r) => r.path === 'my-docs/a')?.depth).toBe(1)
    expect(opened.find((r) => r.path === 'my-docs/a/b')?.depth).toBe(2)
  })

  test('hasChildren 反映真实子节点（画不画 chevron 的唯一判据）', () => {
    const rows = flattenLibraryTree(roots, new Set(['my-docs']))

    expect(rows.find((r) => r.path === 'my-docs')?.hasChildren).toBe(true)
    expect(rows.find((r) => r.path === 'chat-attachments')?.hasChildren).toBe(false)
  })

  test('挂载根在分组展开后才出现，depth = 1', () => {
    expect(flattenLibraryTree(roots, new Set()).map((r) => r.path)).not.toContain('@工作区')

    const rows = flattenLibraryTree(roots, new Set([MOUNTS_GROUP_PATH]))
    expect(rows.find((r) => r.path === '@工作区')?.depth).toBe(1)
  })
})

describe('ancestorPaths', () => {
  test('库内路径逐段回溯，不含自身', () => {
    expect(ancestorPaths('my-docs/a/b')).toEqual(['my-docs', 'my-docs/a'])
    expect(ancestorPaths('my-docs')).toEqual([])
  })

  test('挂载路径额外带上挂载分组头（深链要先把分组展开）', () => {
    expect(ancestorPaths('@工作区/notes')).toEqual([MOUNTS_GROUP_PATH, '@工作区'])
  })
})

describe('library-tree store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetLibraryTreeState()
  })

  test('缺省展开内置根与挂载分组', () => {
    const { expanded } = useLibraryTree.getState()

    expect(expanded.has('my-docs')).toBe(true)
    expect(expanded.has(MOUNTS_GROUP_PATH)).toBe(true)
  })

  test('toggleExpanded 双向切换并持久化', () => {
    useLibraryTree.getState().toggleExpanded('my-docs')
    expect(useLibraryTree.getState().expanded.has('my-docs')).toBe(false)

    useLibraryTree.getState().toggleExpanded('my-docs')
    expect(useLibraryTree.getState().expanded.has('my-docs')).toBe(true)
    expect(window.localStorage.getItem('mailagent.library.tree.v1')).toContain('my-docs')
  })

  test('selectFolder 换文件夹会清掉选中的文件（内容区从预览切回网格）', () => {
    useLibraryTree.getState().selectFile(42)
    useLibraryTree.getState().selectFolder('my-docs/a')

    expect(useLibraryTree.getState().selectedPath).toBe('my-docs/a')
    expect(useLibraryTree.getState().selectedFileId).toBeNull()
  })

  test('revealPath 展开到目标的每一层祖先并选中它', () => {
    useLibraryTree.getState().toggleExpanded('my-docs') // 先收起
    useLibraryTree.getState().revealPath('my-docs/a/b')

    const state = useLibraryTree.getState()
    expect(state.expanded.has('my-docs')).toBe(true)
    expect(state.expanded.has('my-docs/a')).toBe(true)
    expect(state.selectedPath).toBe('my-docs/a/b')
  })

  test('视图与排序落盘，重放后回来', () => {
    useLibraryTree.getState().setView('list')
    useLibraryTree.getState().setSort('size', 'asc')

    resetLibraryTreeState()
    const state = useLibraryTree.getState()
    expect(state.view).toBe('list')
    expect(state.sortKey).toBe('size')
    expect(state.sortDir).toBe('asc')
  })
})
