// @vitest-environment happy-dom
//
// SectionAnchorNav — 通用页内区块锚点导航 (scrollspy) 组件。
//
// 覆盖 4 条契约:
//   1. 候选清单渲染 + 运行时过滤 (目标不存在 / offsetHeight === 0) + 全滤空返回 null。
//   2. 点击 → 目标元素 scrollIntoView; reduced-motion 下 behavior 为 'auto'。
//   3. active 条目携带 aria-current="location" —— 含「滚到底时最后一个短区块
//      也能 active」这条 (否则末尾条目永远高亮不到)。
//   4. 区块从 0 高变有高后重扫出现 (由 ResizeObserver 回调驱动)。
//
// happy-dom 没有 ResizeObserver, 且 offsetHeight / scrollTop / clientHeight /
// scrollHeight / getBoundingClientRect 全返回 0 —— 本文件自行 stub 这些几何量,
// 并用可手动触发的 FakeResizeObserver 驱动重扫。
// 全局 tests/setup.ts 已强制 prefers-reduced-motion: reduce。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { SectionAnchorNav } from '../../src/shared/components/ui/section-anchor-nav'

// ─── ResizeObserver 替身 (happy-dom 不实现) ──────────────────────────────────

const roInstances: FakeResizeObserver[] = []

class FakeResizeObserver {
  readonly callback: () => void
  observed = new Set<Element>()
  disconnected = 0

  constructor(callback: () => void) {
    this.callback = callback
    roInstances.push(this)
  }

  observe(el: Element): void {
    this.observed.add(el)
  }

  unobserve(el: Element): void {
    this.observed.delete(el)
  }

  disconnect(): void {
    this.disconnected += 1
    this.observed.clear()
  }

  /** 手动触发一次「尺寸变了」。 */
  fire(): void {
    this.callback()
  }
}

// ─── 几何量 stub ────────────────────────────────────────────────────────────

function setHeight(el: HTMLElement, offsetHeight: number): void {
  Object.defineProperty(el, 'offsetHeight', { value: offsetHeight, configurable: true })
}

function setRectTop(el: HTMLElement, top: number, height = 100): void {
  el.getBoundingClientRect = (): DOMRect =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect
}

function setScrollMetrics(
  el: HTMLElement,
  m: { scrollTop: number; clientHeight: number; scrollHeight: number }
): void {
  for (const [key, value] of Object.entries(m)) {
    Object.defineProperty(el, key, { value, configurable: true, writable: true })
  }
}

/** 造一个滚动容器 + 若干带 id 的区块。height=0 模拟 flag 关掉的区块。 */
function mountPage(sections: Array<{ id: string; height: number; top: number }>): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  setRectTop(container, 0, 500)
  setScrollMetrics(container, { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 })
  for (const s of sections) {
    const el = document.createElement('div')
    el.id = s.id
    container.appendChild(el)
    setHeight(el, s.height)
    setRectTop(el, s.top, s.height)
  }
  return container
}

const ITEMS = [
  { id: 'sec-a', label: 'Section A' },
  { id: 'sec-b', label: 'Section B' },
  { id: 'sec-c', label: 'Section C' }
]

function navLabels(): string[] {
  return screen.queryAllByRole('button').map((b) => b.textContent ?? '')
}

beforeEach(() => {
  roInstances.length = 0
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('SectionAnchorNav — 候选过滤', () => {
  test('渲染候选清单; 缺失 / 零高的条目被过滤掉', () => {
    // sec-b 高度 0 (flag 门控 return null 的形态), sec-d 压根不在 DOM 里。
    const container = mountPage([
      { id: 'sec-a', height: 100, top: 0 },
      { id: 'sec-b', height: 0, top: 100 },
      { id: 'sec-c', height: 100, top: 100 }
    ])

    render(
      <SectionAnchorNav
        items={[...ITEMS, { id: 'sec-d', label: 'Section D' }]}
        scrollContainerRef={{ current: container }}
        ariaLabel="page sections"
      />
    )

    expect(screen.getByRole('navigation', { name: 'page sections' })).toBeTruthy()
    expect(navLabels()).toEqual(['Section A', 'Section C'])
  })

  test('候选全部被过滤 → 返回 null (不渲染 nav)', () => {
    const container = mountPage([{ id: 'sec-a', height: 0, top: 0 }])

    render(<SectionAnchorNav items={ITEMS} scrollContainerRef={{ current: container }} />)

    expect(screen.queryByRole('navigation')).toBeNull()
    expect(navLabels()).toEqual([])
  })

  test('区块从 0 高变有高 → ResizeObserver 驱动重扫, 条目出现', async () => {
    const container = mountPage([
      { id: 'sec-a', height: 100, top: 0 },
      { id: 'sec-b', height: 0, top: 100 },
      { id: 'sec-c', height: 100, top: 100 }
    ])

    render(<SectionAnchorNav items={ITEMS} scrollContainerRef={{ current: container }} />)
    expect(navLabels()).toEqual(['Section A', 'Section C'])

    // flag 打开 → 原本 0 高的 wrapper 有了内容。
    const secB = document.getElementById('sec-b') as HTMLElement
    setHeight(secB, 120)
    expect(roInstances.length).toBeGreaterThan(0)
    roInstances[0]?.fire()

    await waitFor(() => {
      expect(navLabels()).toEqual(['Section A', 'Section B', 'Section C'])
    })
  })

  test('卸载时 observer 全部 disconnect', () => {
    const container = mountPage([{ id: 'sec-a', height: 100, top: 0 }])
    const { unmount } = render(
      <SectionAnchorNav items={ITEMS} scrollContainerRef={{ current: container }} />
    )
    expect(roInstances[0]?.disconnected).toBe(0)

    unmount()

    expect(roInstances[0]?.disconnected).toBe(1)
    expect(roInstances[0]?.observed.size).toBe(0)
  })
})

describe('SectionAnchorNav — 跳转', () => {
  test('点击 → 目标元素 scrollIntoView; reduced-motion 下 behavior 为 auto', () => {
    const container = mountPage([
      { id: 'sec-a', height: 100, top: 0 },
      { id: 'sec-c', height: 100, top: 600 }
    ])
    const target = document.getElementById('sec-c') as HTMLElement
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView

    render(<SectionAnchorNav items={ITEMS} scrollContainerRef={{ current: container }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Section C' }))

    // tests/setup.ts 强制 prefers-reduced-motion: reduce → 'auto' 而非 'smooth'。
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })
})

describe('SectionAnchorNav — active 追踪', () => {
  function currentIds(): string[] {
    return screen
      .queryAllByRole('button')
      .filter((b) => b.getAttribute('aria-current') === 'location')
      .map((b) => b.textContent ?? '')
  }

  test('滚动切换 active, 且恒只有一个条目带 aria-current="location"', async () => {
    // 判定线 = 容器 rect.top(0) + 24px。
    const container = mountPage([
      { id: 'sec-a', height: 300, top: 0 },
      { id: 'sec-b', height: 300, top: 300 },
      { id: 'sec-c', height: 300, top: 900 }
    ])

    render(<SectionAnchorNav items={ITEMS} scrollContainerRef={{ current: container }} />)

    // 初始: 只有 sec-a 盖住判定线。
    expect(currentIds()).toEqual(['Section A'])

    // 向下滚 600 —— sec-b 越过判定线, sec-c 还没到。
    setRectTop(document.getElementById('sec-a') as HTMLElement, -600, 300)
    setRectTop(document.getElementById('sec-b') as HTMLElement, -300, 300)
    setRectTop(document.getElementById('sec-c') as HTMLElement, 300, 300)
    setScrollMetrics(container, { scrollTop: 600, clientHeight: 500, scrollHeight: 2000 })
    fireEvent.scroll(container)

    await waitFor(() => {
      expect(currentIds()).toEqual(['Section B'])
    })
  })

  test('滚到底 → 最后一个条目 active (末尾短区块顶不到判定线也要能高亮)', async () => {
    const container = mountPage([
      { id: 'sec-a', height: 900, top: 0 },
      { id: 'sec-b', height: 900, top: 900 },
      // 末区块很短, 停在判定线下方 —— 纯几何判定永远选不到它。
      { id: 'sec-c', height: 20, top: 480 }
    ])

    render(<SectionAnchorNav items={ITEMS} scrollContainerRef={{ current: container }} />)
    expect(currentIds()).toEqual(['Section A'])

    // scrollTop 触底: scrollHeight(2000) - clientHeight(500) - scrollTop(1500) === 0。
    setRectTop(document.getElementById('sec-a') as HTMLElement, -1500, 900)
    setRectTop(document.getElementById('sec-b') as HTMLElement, -600, 900)
    setRectTop(document.getElementById('sec-c') as HTMLElement, 480, 20)
    setScrollMetrics(container, { scrollTop: 1500, clientHeight: 500, scrollHeight: 2000 })
    fireEvent.scroll(container)

    await waitFor(() => {
      expect(currentIds()).toEqual(['Section C'])
    })
  })

  test('点击条目立即置 active (乐观), 不必等滚动事件', () => {
    const container = mountPage([
      { id: 'sec-a', height: 300, top: 0 },
      { id: 'sec-b', height: 300, top: 300 },
      { id: 'sec-c', height: 300, top: 900 }
    ])

    render(<SectionAnchorNav items={ITEMS} scrollContainerRef={{ current: container }} />)
    expect(currentIds()).toEqual(['Section A'])

    fireEvent.click(screen.getByRole('button', { name: 'Section C' }))

    expect(currentIds()).toEqual(['Section C'])
  })
})
