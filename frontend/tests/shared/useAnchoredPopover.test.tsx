// @vitest-environment happy-dom
//
// TitleBar chrome 浮层的横向落点（`useAnchoredPopover`）。
//
// 为什么值得测：这套几何原来是四份各自为政的代码（两份现算 right、一份 88px 魔数、铃铛
// 干脆没有），错位在 jsdom 里永远不会自己暴露 —— 只有把「右对齐 / 视口夹取 / 视口变化后
// 重算」三条写成断言，收敛后才不会有人再退回魔数。
//
// 🔴 最后一条（transform 不污染测量）是**防回闸**：浮层此刻正被进场动画挂着 scale/translate，
// 用 getBoundingClientRect() 量它就会拿到变换后的几何。改成 rect 口径这条必须红。

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { createRef } from 'react'

import { useAnchoredPopover } from '@shared/hooks/useAnchoredPopover'

afterEach(cleanup)

function refTo(node: HTMLElement | null): React.RefObject<HTMLElement | null> {
  const ref = createRef<HTMLElement | null>() as React.RefObject<HTMLElement | null>
  ref.current = node
  return ref
}

/** 只有 right 有用，其余补齐 DOMRect 形状。 */
function stubRect(el: HTMLElement, right: number): void {
  el.getBoundingClientRect = (): DOMRect =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: right,
      right,
      bottom: 28,
      width: 0,
      height: 28,
      toJSON: () => ({})
    }) as DOMRect
}

/** 浮层的**布局**几何（offsetWidth/offsetTop），transform 不影响它们。 */
function stubLayout(el: HTMLElement, width: number, top: number): void {
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'offsetTop', { value: top, configurable: true })
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

/** rAF 节流的重算跑完（resize/scroll 路径）。 */
async function flushFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

let trigger: HTMLElement
let popover: HTMLElement
// 稳定的 ref 对象（真实调用点是 useRef）：每次渲染换新 ref 会让 effect 的依赖每轮都变。
let triggerRef: React.RefObject<HTMLElement | null>
let popoverRef: React.RefObject<HTMLElement | null>

beforeEach(() => {
  setViewport(1000, 768)
  trigger = document.createElement('button')
  popover = document.createElement('div')
  document.body.append(trigger, popover)
  stubRect(trigger, 900)
  stubLayout(popover, 380, 44)
  triggerRef = refTo(trigger)
  popoverRef = refTo(popover)
})

describe('useAnchoredPopover', () => {
  test('右对齐触发器：right = 视口宽 − 触发器右缘（不是 .theme-popover 写死的 12px）', () => {
    const { result } = renderHook(() => useAnchoredPopover(triggerRef, popoverRef, true))
    expect(result.current?.right).toBe(100)
  })

  test('窄窗口下浮层左缘不越界：右对齐会把 380px 面板顶出去时，回推到留白处', () => {
    // 触发器右缘 300 ⇒ 纯右对齐要 right=700，面板左缘落到 -80。
    stubRect(trigger, 300)
    const { result } = renderHook(() => useAnchoredPopover(triggerRef, popoverRef, true))
    // 1000 − 8(gutter) − 380(面板宽) = 612 ⇒ 左缘正好压在 8px 留白上。
    expect(result.current?.right).toBe(612)
    expect(1000 - (result.current?.right ?? 0) - 380).toBe(8)
  })

  test('视口变化后重算：resize 之后跟着触发器的新位置走', async () => {
    const { result } = renderHook(() => useAnchoredPopover(triggerRef, popoverRef, true))
    expect(result.current?.right).toBe(100)

    // 窗口变窄，按钮跟着往左走（右簇是右对齐的，右缘到视口右的距离变了）。
    stubRect(trigger, 700)
    setViewport(900, 768)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await flushFrame()
    expect(result.current?.right).toBe(200)
  })

  test('可用高度按浮层实际落点收口；视口极矮时不压成一条缝', async () => {
    const { result } = renderHook(() => useAnchoredPopover(triggerRef, popoverRef, true))
    expect(result.current?.maxHeight).toBe(768 - 44 - 8)

    setViewport(1000, 100)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await flushFrame()
    // 100 − 44 − 8 = 48 → 低于可用下限，取 160。
    expect(result.current?.maxHeight).toBe(160)
  })

  test('active=false → 恒 null（不挂监听、不留残影）', () => {
    const { result } = renderHook(() => useAnchoredPopover(triggerRef, popoverRef, false))
    expect(result.current).toBeNull()
  })

  test('触发器消失（响应式换掉那颗钮）→ 收成 null，不停在旧坐标', async () => {
    const { result } = renderHook(() => useAnchoredPopover(triggerRef, popoverRef, true))
    expect(result.current).not.toBeNull()

    trigger.remove()
    triggerRef.current = null
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    await flushFrame()
    expect(result.current).toBeNull()
  })

  test('🔴 浮层侧量的是布局量：进场 transform 把 rect 扭成什么样都不影响落点', () => {
    // 进场那一帧的真实处境：scale(0.97) + translateY(-8) 已经挂上，rect 全是变换后的值。
    popover.getBoundingClientRect = (): DOMRect =>
      ({
        x: 0,
        y: -999,
        top: -999,
        left: 0,
        right: 9999,
        bottom: 0,
        width: 9999,
        height: 0,
        toJSON: () => ({})
      }) as DOMRect
    const { result } = renderHook(() => useAnchoredPopover(triggerRef, popoverRef, true))
    expect(result.current?.right).toBe(100)
    expect(result.current?.maxHeight).toBe(768 - 44 - 8)
  })
})
