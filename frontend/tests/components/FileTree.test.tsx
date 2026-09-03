// @vitest-environment happy-dom
//
// `ui/FileTree`（beui.dev `file-tree` 收编版，task 09-03 P1-L4）。
//
// 收编时相对上游改了三处，这里各钉一条：
//   ① 数据递归渲染（上游是 JSX children 声明式；我们的树来自 API）；
//   ② 剥掉 `SharedLayoutBg` 的两处 `filter: blur(6px)`（DESIGN §8「filter 永不过渡」）；
//   ③ spring / 曲线单源 `@shared/lib/motion-tokens`（上游 `@/lib/ease`）。
// 另钉 design §2.2 的退化档：单文件夹超过 `TREE_VIRTUALIZE_THRESHOLD` 退成虚拟列表，
// 并**放弃** layoutId pill（虚拟化会回收行，pill 会闪跳）。
//
// 键盘一段照上游的 treeview 语义：↓/↑ 移焦点、→ 展开或进子层、← 收起或回父层、Enter 选中。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { FileTree, type FileTreeNode } from '@shared/components/ui/FileTree'

afterEach(() => cleanup())

const NODES: readonly FileTreeNode[] = [
  {
    value: 'my-docs',
    name: '我的文档',
    type: 'folder',
    children: [
      { value: 'my-docs/a', name: 'a', type: 'folder', children: [
        { value: 'my-docs/a/note.md', name: 'note.md', type: 'file' }
      ] },
      { value: 'my-docs/readme.md', name: 'readme.md', type: 'file' }
    ]
  },
  { value: '.trash', name: '废纸篓', type: 'folder' }
]

function rowNames(): string[] {
  return screen.getAllByRole('treeitem').map((el) => el.textContent ?? '')
}

describe('数据递归渲染', () => {
  test('只渲染展开分支的行，aria-level 跟着 depth 走', () => {
    render(<FileTree nodes={NODES} expandedIds={['my-docs']} ariaLabel="资料库" />)

    expect(rowNames()).toEqual(['我的文档', 'a', 'readme.md', '废纸篓'])
    expect(screen.getByRole('treeitem', { name: '我的文档' }).getAttribute('aria-level')).toBe('1')
    expect(screen.getByRole('treeitem', { name: 'a' }).getAttribute('aria-level')).toBe('2')
    // 折叠的分支整支不进 DOM。
    expect(screen.queryByRole('treeitem', { name: 'note.md' })).toBeNull()
  })

  test('folder 行带 aria-expanded，file 行不带', () => {
    render(<FileTree nodes={NODES} expandedIds={['my-docs']} />)

    expect(screen.getByRole('treeitem', { name: '我的文档' }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByRole('treeitem', { name: 'readme.md' }).getAttribute('aria-expanded')).toBeNull()
  })

  test('icon / trailing 两个槽位由调用方填（角标、锁、警示都走 trailing）', () => {
    render(
      <FileTree
        nodes={[{ value: 'r', name: '根', type: 'folder', trailing: <span>12</span> }]}
      />
    )

    expect(screen.getByText('12')).toBeTruthy()
  })
})

describe('选中与展开', () => {
  test('点文件夹既选中又切换展开态（受控时只回调，不自己改）', () => {
    const onValueChange = vi.fn()
    const onExpandedChange = vi.fn()
    render(
      <FileTree
        nodes={NODES}
        value={null}
        expandedIds={[]}
        onValueChange={onValueChange}
        onExpandedChange={onExpandedChange}
      />
    )

    fireEvent.click(screen.getByRole('treeitem', { name: '我的文档' }))

    expect(onValueChange).toHaveBeenCalledWith('my-docs')
    expect(onExpandedChange).toHaveBeenCalledWith(['my-docs'])
    // 受控：父层没换 props，行仍是折叠的。
    expect(screen.queryByRole('treeitem', { name: 'a' })).toBeNull()
  })

  test('选中行 aria-selected=true，并挂一枚 layoutId pill', () => {
    render(<FileTree nodes={NODES} value="my-docs" expandedIds={[]} />)

    expect(screen.getByRole('treeitem', { name: '我的文档' }).getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(document.querySelectorAll('[data-shared-layout-pill]').length).toBe(1)
  })

  test('disabled 行不可选、不展开', () => {
    const onValueChange = vi.fn()
    render(
      <FileTree
        nodes={[{ value: 'x', name: '不可用', type: 'folder', disabled: true, children: [
          { value: 'x/y', name: 'y', type: 'file' }
        ] }]}
        expandedIds={[]}
        onValueChange={onValueChange}
      />
    )

    const row = screen.getByRole('treeitem', { name: '不可用' })
    expect(row.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(row)
    expect(onValueChange).not.toHaveBeenCalled()
  })
})

describe('键盘', () => {
  function renderKeyboard(): { onExpandedChange: ReturnType<typeof vi.fn> } {
    const onExpandedChange = vi.fn()
    render(
      <FileTree nodes={NODES} defaultExpandedIds={['my-docs']} onExpandedChange={onExpandedChange} />
    )
    return { onExpandedChange }
  }

  test('↓ / ↑ 在摊平后的行之间移动焦点', () => {
    renderKeyboard()
    const first = screen.getByRole('treeitem', { name: '我的文档' })
    first.focus()

    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'a' }))

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)
  })

  test('← 收起当前文件夹，→ 展开它', () => {
    const { onExpandedChange } = renderKeyboard()
    const row = screen.getByRole('treeitem', { name: '我的文档' })
    row.focus()

    fireEvent.keyDown(row, { key: 'ArrowLeft' })
    expect(onExpandedChange).toHaveBeenLastCalledWith([])

    fireEvent.keyDown(screen.getByRole('treeitem', { name: '我的文档' }), { key: 'ArrowRight' })
    expect(onExpandedChange).toHaveBeenLastCalledWith(['my-docs'])
  })

  test('Enter 选中', () => {
    const onValueChange = vi.fn()
    render(<FileTree nodes={NODES} expandedIds={['my-docs']} onValueChange={onValueChange} />)
    const row = screen.getByRole('treeitem', { name: 'readme.md' })
    row.focus()

    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onValueChange).toHaveBeenCalledWith('my-docs/readme.md')
  })
})

describe('超阈值退化成虚拟列表', () => {
  const BIG: readonly FileTreeNode[] = Array.from({ length: 600 }, (_unused, i) => ({
    value: `f/${i}`,
    name: `第 ${i} 行`,
    type: 'file' as const
  }))

  test('行数 > 阈值：DOM 里只有一屏左右的行，且不再有 layoutId pill', () => {
    render(<FileTree nodes={BIG} value="f/0" virtualizeThreshold={500} />)

    const rows = screen.getAllByRole('treeitem')
    // 下界防「视口塌成 0 只渲染两三行」，上界防「其实没虚拟化」。
    expect(rows.length).toBeGreaterThan(5)
    expect(rows.length).toBeLessThan(200)
    expect(screen.getByRole('tree').getAttribute('data-virtualized')).toBe('true')
    expect(document.querySelector('[data-shared-layout-pill]')).toBeNull()
  })

  test('阈值以内不虚拟化，全部行都在 DOM 里', () => {
    render(<FileTree nodes={BIG.slice(0, 40)} virtualizeThreshold={500} />)

    expect(screen.getAllByRole('treeitem').length).toBe(40)
    expect(screen.getByRole('tree').getAttribute('data-virtualized')).toBe('false')
  })
})

describe('收编纪律（源码级）', () => {
  const dir = resolve(__dirname, '../../src/shared/components/ui')
  const names = ['FileTree.tsx', 'SharedLayoutBg.tsx']
  // 只看代码行 —— 头注里必须能照原样引用上游那两处写法（「剥掉了什么」是收编台账的
  // 一部分），断言里连注释一起扫会逼着后人把出处写糊。
  const sources = names.map((name) => ({
    name,
    raw: readFileSync(resolve(dir, name), 'utf8'),
    code: readFileSync(resolve(dir, name), 'utf8')
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
      })
      .join('\n')
  }))

  test('两处 blur(6px) 已剥干净 —— DESIGN §8「filter 永不过渡」', () => {
    for (const { code } of sources) {
      expect(code).not.toMatch(/blur\(/)
      expect(code).not.toMatch(/filter:/)
    }
  })

  test('spring / 曲线单源 motion-tokens，没有上游的 @/lib/ease，也没有内联 spring 参数', () => {
    for (const { code } of sources) {
      expect(code).not.toContain('@/lib/ease')
      expect(code).not.toMatch(/stiffness|damping|mass:/)
    }
    expect(sources.map((s) => s.raw).join('\n')).toContain('@shared/lib/motion-tokens')
  })
})
