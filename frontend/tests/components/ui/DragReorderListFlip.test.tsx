// @vitest-environment happy-dom
//
// DragReorderList 的**落下 FLIP 闸**：松手那一刻，每行的屏幕位置必须连续
// （FLIP 的定义就是「先量 First，再让布局变，再把行 Invert 回原来的屏幕像素」）。
//
// 病（改动前，owner 在打包 app 上 dogfood 复现）：松手后卡片先硬跳回**拖拽前**的
// 位置，再用 200ms 动画走到新位置 —— 「先回原位再突然换位」。
// 根因：FLIP 的 Invert 用 `row.getBoundingClientRect()` 量「新布局位置」，但上一行
// 的 `mv.jump(0)` **不会当帧写进 DOM**（motion 的样式写走 rAF frameloop：
// MotionValue 变更 → VisualElement.scheduleRender → frame.render），于是量到的
// rect 仍带着拖拽/让位留下的旧 transform，每行的 dy 整整差掉一个旧 transform。
//
// 本闸怎么复现这件事：给 happy-dom 装一个**合成布局**——行的
// getBoundingClientRect 返回「flow 位置 + 当前真的写在 inline style 上的
// translateY」，offsetTop 只给 flow 位置。motion 在 happy-dom 里的写时序与浏览器
// 一致（实测：`mv.jump(37)` 后同步读 inline transform 仍是 'none'，过 rAF 才变
// translateY(37px)），所以「旧 transform 还挂在 DOM 上」这个前提是真的，不是模型
// 假设出来的 —— 用例里有一条断言专门盯死它，防止哪天前提没了闸变成空转。
//
// ⚠️ 必须走**指针**路径：键盘路径提交时所有行的 transform 都是 0，没有旧值可污染，
// 天然测不出这个病（原有的 DragReorderListControlled.test.tsx 正是键盘路径）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import * as React from 'react'

import { DragReorderList, type ReorderItem } from '@shared/components/ui/DragReorderList'

/* ── 合成布局：行高 48 + gap 8，列表顶在 100 ─────────────────────────── */
const H = 48
const GAP = 8
const SLOT = H + GAP
const LIST_TOP = 100

const isRow = (el: Element): el is HTMLElement =>
  el instanceof HTMLElement && el.hasAttribute('data-reorder-item')

/** 该行在 DOM 里的 flow 序（= 它现在占的槽位）。 */
function flowIndex(el: HTMLElement): number {
  return [...(el.parentElement?.children ?? [])].filter(isRow).indexOf(el)
}

/** 真的写在 inline style 上的 translateY —— 也就是浏览器这一帧画出来的位移。 */
function paintedY(el: HTMLElement): number {
  const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform)
  return m ? Number(m[1]) : 0
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

let restore: (() => void)[] = []

function installLayout(): void {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (isRow(this)) return rect(LIST_TOP + flowIndex(this) * SLOT + paintedY(this), H)
    if (this.getAttribute('role') === 'list') {
      const n = [...this.children].filter(isRow).length
      return rect(LIST_TOP, n * SLOT - GAP)
    }
    return rect(0, 0)
  }
  restore.push(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
  })

  const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement): number {
      // offsetTop 是纯布局量，transform 不参与 —— 浏览器就是这个语义。
      return isRow(this) ? flowIndex(this) * SLOT : 0
    }
  })
  restore.push(() => {
    if (originalOffsetTop) Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop)
    else Reflect.deleteProperty(HTMLElement.prototype, 'offsetTop')
  })

  // 合成 PointerEvent 没有真实 pointer，capture API 在 happy-dom 里也不存在；
  // 它只影响事件路由，与 FLIP 计算无关。
  const el = Element.prototype as unknown as Record<string, unknown>
  const saved = {
    set: el.setPointerCapture,
    release: el.releasePointerCapture,
    has: el.hasPointerCapture
  }
  el.setPointerCapture = (): void => {}
  el.releasePointerCapture = (): void => {}
  el.hasPointerCapture = (): boolean => true
  restore.push(() => {
    el.setPointerCapture = saved.set
    el.releasePointerCapture = saved.release
    el.hasPointerCapture = saved.has
  })
}

beforeEach(() => {
  // 全局 setup 把 prefers-reduced-motion 钉成 reduce（GSAP 组件测试需要），
  // 但 reduced 时 DragReorderList 整段 FLIP 是硬切的 —— 本闸必须测真实动画路径。
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false
  }))
  installLayout()
})

afterEach(() => {
  cleanup()
  for (const fn of restore.reverse()) fn()
  restore = []
  vi.unstubAllGlobals()
})

/* ── harness：FolderPicker 同款受控用法（useState + useMemo 派生 items） ── */

function Harness({ ids }: { ids: string[] }): React.ReactElement {
  const [order, setOrder] = React.useState<readonly string[]>(ids)
  const items = React.useMemo<ReorderItem[]>(
    () => order.map((id) => ({ id, label: id })),
    [order]
  )
  return (
    <DragReorderList
      items={items}
      onReorder={(list) => setOrder(list.map((i) => i.id))}
    />
  )
}

const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-reorder-item]')]
const shownOrder = (): string[] => rows().map((r) => r.dataset.id!)

/** 每行此刻在屏幕上的位置（含 transform）—— 用户眼睛看到的那个位置。 */
function screenTops(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows()) out[r.dataset.id!] = Math.round(r.getBoundingClientRect().top * 100) / 100
  return out
}

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
/** 等 motion 的 glide 跑完（MOVE = 200ms），让「松手前」是个静止的干净状态。 */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 320))

/** 抓住第 index 行，往下拖 slots 格，等让位动画跑完后松手。 */
async function dragDown(index: number, slots: number): Promise<void> {
  const row = rows()[index]!
  const startY = LIST_TOP + index * SLOT + H / 2
  fireEvent.pointerDown(row, { pointerId: 1, button: 0, clientY: startY })
  await frame()
  fireEvent.pointerMove(row, { pointerId: 1, clientY: startY + 6 })
  await frame()
  fireEvent.pointerMove(row, { pointerId: 1, clientY: startY + slots * SLOT })
  await settle()
}

describe('DragReorderList —— 落下时的 FLIP 连续性（指针路径）', () => {
  test('🔴 下移一格：松手前后每行的屏幕位置必须一模一样（不许先弹回原位）', async () => {
    render(<Harness ids={['a', 'b', 'c', 'd']} />)
    const restTops = screenTops()
    expect(restTops).toEqual({ a: 100, b: 156, c: 212, d: 268 })

    await dragDown(0, 1)

    // 前提自检：让位跑完后，a 停在 b 的槽、b 让到 a 的槽，且这两行的位移**确实**
    // 还挂在 DOM 的 inline transform 上（旧 transform 就是污染源；哪天它不在了，
    // 本闸会在这里红，而不是变成一个恒绿的摆设）。
    const beforeDrop = screenTops()
    expect(beforeDrop).toEqual({ a: 156, b: 100, c: 212, d: 268 })
    expect(rows().map((r) => r.style.transform)).toEqual([
      `translateY(${SLOT}px)`,
      `translateY(${-SLOT}px)`,
      'none',
      'none'
    ])

    fireEvent.pointerUp(rows()[0]!, { pointerId: 1, clientY: LIST_TOP + H / 2 + SLOT })
    await frame()
    await frame()

    expect(shownOrder()).toEqual(['b', 'a', 'c', 'd'])
    // 位置连续 = 落下即落位。差一个 SLOT 就是 owner 报的「先回原位」。
    expect(screenTops()).toEqual(beforeDrop)

    // 而且因为该动的都已经动到位，Invert 是 0 —— 再等几帧也不该有任何位移。
    await settle()
    expect(screenTops()).toEqual(beforeDrop)
  })

  test('🔴 下移两格：三行都要连续（多行让位时同样不许回弹）', async () => {
    render(<Harness ids={['a', 'b', 'c', 'd']} />)

    await dragDown(0, 2)

    const beforeDrop = screenTops()
    expect(beforeDrop).toEqual({ a: 212, b: 100, c: 156, d: 268 })

    fireEvent.pointerUp(rows()[0]!, { pointerId: 1, clientY: LIST_TOP + H / 2 + 2 * SLOT })
    await frame()
    await frame()

    expect(shownOrder()).toEqual(['b', 'c', 'a', 'd'])
    expect(screenTops()).toEqual(beforeDrop)
    await settle()
    expect(screenTops()).toEqual(beforeDrop)
  })
})
