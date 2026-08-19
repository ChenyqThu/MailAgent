// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { SortableBoard } from '@shared/components/ui/SortableBoard'

/**
 * SortableBoard 的**接线**冒烟测试。
 *
 * 落位算法在 `boardOrder.test.ts` 直测；这里只验 dnd-kit 那几根线接对了：
 * 分组渲染、折叠组不渲染 items、`handleProps` 真的带着 dnd-kit 的 attributes 到了调用方、
 * 空组渲染了可命中的占位。
 *
 * ⚠️ **不验真实拖拽手感**：指针拖拽依赖 `getBoundingClientRect` 的真实几何，jsdom 里全是 0。
 * 拖起来跟不跟手、跨组落点准不准，只能靠真机 dogfood。
 */

afterEach(cleanup)

interface Row {
  id: string
  name: string
}

function renderBoard(overrides: Partial<React.ComponentProps<typeof SortableBoard<Row>>> = {}) {
  const onReorder = vi.fn()
  render(
    <SortableBoard<Row>
      groups={[
        { id: 'core', items: [{ id: '1', name: '甲' }] },
        { id: 'normal', items: [{ id: '2', name: '乙' }], collapsed: false }
      ]}
      getItemId={(row) => row.id}
      onReorder={onReorder}
      renderItem={(row, { handleProps }) => (
        <div>
          <span>{row.name}</span>
          <button type="button" {...handleProps} aria-label={`拖动 ${row.name}`} />
        </div>
      )}
      renderGroup={({ group, children, headerRef }) => (
        <section key={group.id}>
          <button ref={headerRef} type="button">
            组 {group.id}
          </button>
          {children}
        </section>
      )}
      {...overrides}
    />
  )
  return { onReorder }
}

describe('SortableBoard 接线', () => {
  it('两组都渲染，items 各归各组', () => {
    renderBoard()
    expect(screen.getByText('组 core')).toBeTruthy()
    expect(screen.getByText('组 normal')).toBeTruthy()
    expect(screen.getByText('甲')).toBeTruthy()
    expect(screen.getByText('乙')).toBeTruthy()
  })

  it('🔴 handleProps 带着 dnd-kit 的 attributes 到了调用方 —— 不挂就永远拖不动', () => {
    renderBoard()
    const handle = screen.getByLabelText('拖动 甲')
    // dnd-kit 的 useSortable().attributes 至少给这两个（role + tabIndex），
    // 断言它们在，等于断言「listeners 那一坨也一起过来了」。
    expect(handle.getAttribute('role')).toBe('button')
    expect(handle.getAttribute('aria-roledescription')).toBeTruthy()
  })

  it('折叠组不渲染 items，但标题还在（它是「拖上去展开」的落点）', () => {
    renderBoard({
      groups: [
        { id: 'core', items: [{ id: '1', name: '甲' }] },
        { id: 'normal', items: [{ id: '2', name: '乙' }], collapsed: true }
      ]
    })
    expect(screen.getByText('组 normal')).toBeTruthy()
    expect(screen.queryByText('乙')).toBeNull()
  })

  it('🔴 空组渲染占位 —— 没有可命中的面积就等于那个组消失了（拖出去回不来）', () => {
    renderBoard({
      groups: [
        { id: 'core', items: [] },
        { id: 'normal', items: [{ id: '2', name: '乙' }] }
      ],
      renderEmpty: () => <p>空组落点</p>
    })
    expect(screen.getByText('空组落点')).toBeTruthy()
  })

  it('renderItem 拿到的 dragging 在静止时为 false', () => {
    const seen: boolean[] = []
    renderBoard({
      renderItem: (row, { dragging, handleProps }) => {
        seen.push(dragging)
        return (
          <button type="button" {...handleProps} aria-label={`拖动 ${row.name}`}>
            {row.name}
          </button>
        )
      }
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((value) => value === false)).toBe(true)
  })
})
