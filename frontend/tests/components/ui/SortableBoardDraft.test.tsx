// @vitest-environment happy-dom
//
// SortableBoard 的**乐观顺序生命周期**闸：落下即新顺序 → props 追上才交还控制权 →
// 写入失败回滚。
//
// 病：落下那一刻就把 draft 清掉（改动前）⇒ 那一帧渲染的还是服务端旧顺序，卡片先弹回
// 原位，几百毫秒后 mutation 回来才跳到新位 —— owner 报的「落下先回原位再突然换位」。
//
// ⚠️ 这里把 `DndContext` 换成一个只透传 children 的壳，好直接调它的 onDragStart /
// onDragEnd —— 真实指针拖拽依赖 `getBoundingClientRect` 的真实几何，jsdom/happy-dom
// 里全是 0，拖不动。被测的是组件自己的状态机（finish → draft → viewGroups），
// 不是 dnd-kit 的命中（那部分在 `boardCollision.test.ts` 直测）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import type { SortableBoardOrder } from '@shared/components/ui/SortableBoard'

const dnd = vi.hoisted(() => ({
  captured: null as null | {
    onDragStart(event: { active: { id: string } }): void
    onDragEnd(event: { active: { id: string }; over: { id: string } | null }): void
    onDragCancel(): void
  }
}))

vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>()
  return {
    ...actual,
    DndContext: (props: Record<string, unknown> & { children: React.ReactNode }) => {
      dnd.captured = props as unknown as typeof dnd.captured
      return <>{props.children}</>
    }
  }
})

const { SortableBoard } = await import('@shared/components/ui/SortableBoard')

afterEach(cleanup)

function renderBoard(core: string[], normal: string[], commitFailedAt = 0) {
  const onReorder = vi.fn<(order: SortableBoardOrder) => void>()
  const view = render(
    <SortableBoard<string>
      groups={[
        { id: 'core', items: core },
        { id: 'normal', items: normal }
      ]}
      getItemId={(item) => item}
      onReorder={onReorder}
      commitFailedAt={commitFailedAt}
      renderItem={(item, { handleProps }) => (
        <button type="button" {...handleProps} aria-label={`拖动 ${item}`}>
          {item}
        </button>
      )}
      renderGroup={({ group, children }) => (
        <section key={group.id} data-testid={`group-${group.id}`}>
          {children}
        </section>
      )}
      renderEmpty={() => <p>空</p>}
    />
  )
  const rerender = (next: { core: string[]; normal: string[]; commitFailedAt?: number }): void => {
    view.rerender(
      <SortableBoard<string>
        groups={[
          { id: 'core', items: next.core },
          { id: 'normal', items: next.normal }
        ]}
        getItemId={(item) => item}
        onReorder={onReorder}
        commitFailedAt={next.commitFailedAt ?? commitFailedAt}
        renderItem={(item, { handleProps }) => (
          <button type="button" {...handleProps} aria-label={`拖动 ${item}`}>
            {item}
          </button>
        )}
        renderGroup={({ group, children }) => (
          <section key={group.id} data-testid={`group-${group.id}`}>
            {children}
          </section>
        )}
        renderEmpty={() => <p>空</p>}
      />
    )
  }
  return { onReorder, rerender }
}

/** 一组当前渲染出来的 item（拼成一串好断言）。 */
const shown = (groupId: string): string => screen.getByTestId(`group-${groupId}`).textContent ?? ''

/** 把「拖起 b、落到 a 上（= 跨组进 core，插在 a 前面）」走一遍。 */
function dragBOntoA(): void {
  act(() => dnd.captured!.onDragStart({ active: { id: 'b' } }))
  act(() => dnd.captured!.onDragEnd({ active: { id: 'b' }, over: { id: 'a' } }))
}

describe('SortableBoard —— 落下后的乐观顺序', () => {
  test('🔴 落下即是新顺序 —— props 还没变（mutation 在飞）也不许弹回原位', () => {
    const { onReorder } = renderBoard(['a'], ['b', 'c'])
    expect(shown('core')).toBe('a')

    dragBOntoA()

    // props 一个字没变，但界面已经是落下后的样子。
    expect(shown('core')).toBe('ba')
    expect(shown('normal')).toBe('c')
    expect(onReorder).toHaveBeenCalledTimes(1)
  })

  test('props 追上来 → 交还控制权，顺序不变（无二次跳变）', () => {
    const { rerender } = renderBoard(['a'], ['b', 'c'])
    dragBOntoA()
    // 服务端落地：props 变成落下后的那份。
    rerender({ core: ['b', 'a'], normal: ['c'] })
    expect(shown('core')).toBe('ba')

    // 交还控制权之后，props 才是唯一权威 —— 别处改了顺序要立刻反映出来。
    rerender({ core: ['a', 'b'], normal: ['c'] })
    expect(shown('core')).toBe('ab')
  })

  test('🔴 写入失败（commitFailedAt 递增）→ 回滚到 props，不许把错顺序一直挂着', () => {
    const { rerender } = renderBoard(['a'], ['b', 'c'])
    dragBOntoA()
    expect(shown('core')).toBe('ba')

    // props 永远追不上（写挂了），只有这个信号能把乐观顺序摘掉。
    rerender({ core: ['a'], normal: ['b', 'c'], commitFailedAt: 1 })
    expect(shown('core')).toBe('a')
    expect(shown('normal')).toBe('bc')
  })

  test('拖起又放回原位 → 不提交，也不留乐观顺序', () => {
    const { onReorder, rerender } = renderBoard(['a'], ['b', 'c'])
    act(() => dnd.captured!.onDragStart({ active: { id: 'b' } }))
    act(() => dnd.captured!.onDragEnd({ active: { id: 'b' }, over: { id: 'b' } }))
    expect(onReorder).not.toHaveBeenCalled()

    // draft 已经放手：props 一变界面就跟着变。
    rerender({ core: ['a', 'c'], normal: ['b'] })
    expect(shown('core')).toBe('ac')
  })

  test('拖拽取消（Esc）→ 回到 props 顺序', () => {
    const { onReorder } = renderBoard(['a'], ['b', 'c'])
    act(() => dnd.captured!.onDragStart({ active: { id: 'b' } }))
    act(() => dnd.captured!.onDragCancel())
    expect(onReorder).not.toHaveBeenCalled()
    expect(shown('core')).toBe('a')
    expect(shown('normal')).toBe('bc')
  })
})
