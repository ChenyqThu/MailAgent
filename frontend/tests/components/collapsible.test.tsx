// @vitest-environment happy-dom
//
// 折叠区统一原语（@shared/components/ui/collapsible）。
//
// 覆盖三条它存在的理由：
//   1. chevron 方向语义单源（折叠 -rotate-90 / 展开 rotate-0）；
//   2. 高度过渡靠 grid-rows 0fr↔1fr，**内容恒挂载** —— 卸载的子树没法做退场动画；
//   3. 折叠态必须 `inert`：height:0 不影响可聚焦性，手抄版只挂 aria-hidden，
//      键盘用户会 tab 进一个看不见的区域。这是抽单源时顺带修掉的真 bug。

import { describe, expect, test } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { useState } from 'react'

import { CollapseChevron, CollapsibleRegion } from '@shared/components/ui/collapsible'

function Harness({ defaultOpen = false }: { defaultOpen?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="body"
        onClick={() => setOpen((v) => !v)}
      >
        <CollapseChevron expanded={open} />
        toggle
      </button>
      <CollapsibleRegion expanded={open} id="body">
        <button type="button">inner</button>
      </CollapsibleRegion>
    </div>
  )
}

function region(): HTMLElement {
  const el = document.getElementById('body')
  if (!el) throw new Error('region missing')
  return el
}

describe('CollapsibleRegion', () => {
  test('内容恒挂载：折叠态子元素仍在 DOM 里（退场动画的前提）', () => {
    render(<Harness />)
    expect(screen.getByText('inner')).toBeTruthy()
    cleanup()
  })

  test('折叠态：grid-rows-[0fr] + inert + opacity-0', () => {
    render(<Harness />)
    const el = region()
    expect(el.className).toContain('grid-rows-[0fr]')
    expect(el.hasAttribute('inert')).toBe(true)
    expect(el.firstElementChild?.className).toContain('opacity-0')
    cleanup()
  })

  test('展开态：grid-rows-[1fr] + 不带 inert（false 必须渲染成缺席，不是 inert="false"）', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const el = region()
    expect(el.className).toContain('grid-rows-[1fr]')
    // HTML 布尔属性任何值都算 true —— inert="false" 会把展开的区域也关掉。
    expect(el.hasAttribute('inert')).toBe(false)
    expect(el.firstElementChild?.className).toContain('opacity-100')
    cleanup()
  })

  test('内层带 min-h-0 + overflow-hidden（grid item 默认 min-height:auto，不写就塌不下去）', () => {
    render(<Harness />)
    const inner = region().firstElementChild
    expect(inner?.className).toContain('min-h-0')
    expect(inner?.className).toContain('overflow-hidden')
    cleanup()
  })

  test('两态都带 motion-reduce:transition-none', () => {
    render(<Harness defaultOpen />)
    const el = region()
    expect(el.className).toContain('motion-reduce:transition-none')
    expect(el.firstElementChild?.className).toContain('motion-reduce:transition-none')
    cleanup()
  })
})

describe('CollapseChevron', () => {
  test('折叠 -rotate-90 / 展开不带旋转类', () => {
    const { rerender, container } = render(<CollapseChevron expanded={false} />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('-rotate-90')
    rerender(<CollapseChevron expanded />)
    expect(container.querySelector('svg')?.getAttribute('class')).not.toContain('-rotate-90')
    cleanup()
  })
})
