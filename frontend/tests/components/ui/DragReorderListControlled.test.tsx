// @vitest-environment happy-dom
//
// DragReorderList 的**受控模式**闸：落下即新顺序 → props 追上才交还控制权 → 写入失败回滚。
//
// 病（改动前）：受控时 `setItems` 只回调 `onReorder`、本地什么都不存 ⇒ 那一帧 `items`
// 还是旧顺序，行先弹回原位；而且 `items` 引用没变，连 FLIP 的 useLayoutEffect 都不会跑
// —— 落下那段 glide 直接没了。侧边栏文件夹排序（FolderPicker）就在受控模式下用它。
//
// ⚠️ 走**键盘**路径（grip 聚焦 → Space 抓起 → ↓ 移动）而不是指针：指针路径要真实
// `getBoundingClientRect` 算 slot 高度，happy-dom 里全是 0。键盘路径直接调 `commitOrder`，
// 与指针落下共用同一个提交出口，正是本闸要测的那一段。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DragReorderList, type ReorderItem } from '@shared/components/ui/DragReorderList'

afterEach(cleanup)

const items = (...ids: string[]): ReorderItem[] => ids.map((id) => ({ id, label: id }))

function renderList(initial: ReorderItem[], commitFailedAt?: number) {
  const onReorder = vi.fn<(next: ReorderItem[]) => void>()
  const view = render(
    <DragReorderList items={initial} onReorder={onReorder} commitFailedAt={commitFailedAt} />
  )
  const rerender = (next: ReorderItem[], failed?: number): void => {
    view.rerender(
      <DragReorderList
        items={next}
        onReorder={onReorder}
        commitFailedAt={failed ?? commitFailedAt}
      />
    )
  }
  return { onReorder, rerender }
}

/** 当前渲染出来的顺序。 */
const shown = (): string[] =>
  [...document.querySelectorAll('[data-reorder-item]')].map((row) => row.getAttribute('data-id')!)

/** 抓起第 index 行并往下移一格（键盘路径）。 */
function moveDown(index: number): void {
  const grip = screen.getAllByRole('button')[index]!
  fireEvent.keyDown(grip, { key: ' ' })
  fireEvent.keyDown(grip, { key: 'ArrowDown' })
}

describe('DragReorderList —— 受控模式的乐观顺序', () => {
  test('🔴 落下即是新顺序 —— 消费方还没把新 items 传回来也不许弹回原位', () => {
    const { onReorder } = renderList(items('a', 'b', 'c'))
    expect(shown()).toEqual(['a', 'b', 'c'])

    moveDown(0)

    // props 一个字没变，界面已经是移动后的样子。
    expect(shown()).toEqual(['b', 'a', 'c'])
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder.mock.calls[0]![0].map((item) => item.id)).toEqual(['b', 'a', 'c'])
  })

  test('props 追上来 → 交还控制权（之后 props 才是唯一权威）', () => {
    const { rerender } = renderList(items('a', 'b', 'c'))
    moveDown(0)
    rerender(items('b', 'a', 'c'))
    expect(shown()).toEqual(['b', 'a', 'c'])

    // 交还之后，别处改顺序要立刻反映出来。
    rerender(items('c', 'b', 'a'))
    expect(shown()).toEqual(['c', 'b', 'a'])
  })

  test('🔴 写入失败（commitFailedAt 递增）→ 回滚到 props', () => {
    const { rerender } = renderList(items('a', 'b', 'c'), 0)
    moveDown(0)
    expect(shown()).toEqual(['b', 'a', 'c'])

    rerender(items('a', 'b', 'c'), 1)
    expect(shown()).toEqual(['a', 'b', 'c'])
  })

  test('🔴 props 换成另一批成员（增删项）→ 乐观覆盖过期作废，新成员必须看得见', () => {
    const { rerender } = renderList(items('a', 'b', 'c'))
    moveDown(0)
    expect(shown()).toEqual(['b', 'a', 'c'])

    // 用户又勾选了一个文件夹：新集合与乐观覆盖的成员不同 ⇒ 必须放手。
    rerender(items('a', 'b', 'c', 'd'))
    expect(shown()).toEqual(['a', 'b', 'c', 'd'])
  })

  test('非受控模式（不传 items）不受影响：自己存自己的顺序', () => {
    render(<DragReorderList defaultItems={items('x', 'y')} />)
    const grip = screen.getAllByRole('button')[0]!
    fireEvent.keyDown(grip, { key: ' ' })
    fireEvent.keyDown(grip, { key: 'ArrowDown' })
    expect(shown()).toEqual(['y', 'x'])
  })
})
