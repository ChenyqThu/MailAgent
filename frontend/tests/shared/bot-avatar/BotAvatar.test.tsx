// @vitest-environment happy-dom
//
// BotAvatar 组件契约 —— 双档纪律是重点：
//   静态档（默认/reduced-motion）零 ticker 注册（列表数百实例的性能地板）；
//   动画档只在「显式 animated ∧ 非 reduce ∧ 可见」三条件齐时挂共享 ticker。
// 全局 setup 强制 prefers-reduced-motion: reduce（tests/setup.ts）——正好是
// reduced-motion 分支的天然环境；测真动画路径时 stubGlobal 覆盖 matchMedia
// （useExitAnimation.test.tsx 先例），并补一个立即回调的 IntersectionObserver
// （happy-dom 的 IO 是不触发回调的哑实现，而真浏览器 observe 后必发首次回调）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { BotAvatar } from '../../../src/shared/bot-avatar/BotAvatar'
import { staticFrame } from '../../../src/shared/bot-avatar/engine'
import { SHAPES } from '../../../src/shared/bot-avatar/shapes'
import { POOLS } from '../../../src/shared/bot-avatar/states'
import { __instanceCount } from '../../../src/shared/bot-avatar/ticker'

function stubNoReduceMatchMedia(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null
      }) as unknown as MediaQueryList
  )
}

/** 真浏览器 observe() 必发一次初始回调；happy-dom 不发 —— 用可控 stub 补齐该语义 */
function stubIntersectionObserver(isIntersecting: boolean): void {
  class ImmediateIO {
    private readonly cb: IntersectionObserverCallback
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb
    }
    observe(target: Element): void {
      this.cb(
        [{ isIntersecting, target } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      )
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('IntersectionObserver', ImmediateIO)
}

function eyePaths(container: HTMLElement): SVGPathElement[] {
  return Array.from(container.querySelectorAll<SVGPathElement>('[data-bot-eye]'))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BotAvatar 静态档（默认）', () => {
  test('渲染 body path + 两条眼 path，且不注册 ticker', () => {
    const { container } = render(<BotAvatar title="bot" size={24} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('-15 -15 259 259')
    expect(svg?.getAttribute('width')).toBe('24')

    const body = container.querySelector(`path[d="${SHAPES.blob.path}"]`)
    expect(body).not.toBeNull()

    const eyes = eyePaths(container)
    expect(eyes).toHaveLength(2)
    const expected = staticFrame(POOLS.idle[0])
    expect(eyes[0].getAttribute('d')).toBe(expected.eyes[0].d)
    expect(eyes[1].getAttribute('d')).toBe(expected.eyes[1].d)

    expect(__instanceCount()).toBe(0)
  })

  test('state 变化 = 离散换帧（池首表情）', () => {
    const { container, rerender } = render(<BotAvatar state="idle" />)
    const idleD = eyePaths(container)[0].getAttribute('d')
    expect(idleD).toBe(staticFrame(POOLS.idle[0]).eyes[0].d)

    rerender(<BotAvatar state="thinking" />)
    const thinkingD = eyePaths(container)[0].getAttribute('d')
    expect(thinkingD).toBe(staticFrame(POOLS.thinking[0]).eyes[0].d)
    expect(thinkingD).not.toBe(idleD)
  })

  test('clipPath id 每实例唯一，眼组各自引用自家 id', () => {
    const { container } = render(
      <div>
        <BotAvatar />
        <BotAvatar />
      </div>
    )
    const clips = Array.from(container.querySelectorAll('clipPath'))
    expect(clips).toHaveLength(2)
    const ids = clips.map((c) => c.id)
    expect(ids[0]).not.toBe(ids[1])

    const groups = Array.from(container.querySelectorAll('g[clip-path]')).map((g) =>
      g.getAttribute('clip-path')
    )
    expect(groups).toEqual([`url(#${ids[0]})`, `url(#${ids[1]})`])
  })

  test('flipX 输出原型镜像串（translate(228.541 0) scale(-1 1)）', () => {
    const { container } = render(<BotAvatar flipX />)
    const g = container.querySelector('g[transform]')
    expect(g?.getAttribute('transform')).toBe('translate(228.541 0) scale(-1 1)')
  })

  test('title 走可访问名；无 title 时对 a11y 树隐藏', () => {
    const named = render(<BotAvatar title="AI 助手" />)
    expect(named.container.querySelector('svg')?.getAttribute('aria-label')).toBe('AI 助手')
    expect(named.container.querySelector('title')?.textContent).toBe('AI 助手')
    named.unmount()

    const anonymous = render(<BotAvatar />)
    expect(anonymous.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })
})

describe('BotAvatar 动画档', () => {
  test('reduced-motion（全局 setup 默认）下 animated 退化为静态：零 ticker 注册', () => {
    render(<BotAvatar animated />)
    expect(__instanceCount()).toBe(0)
  })

  test('非 reduce + 可见：注册共享 ticker，卸载即注销', () => {
    stubNoReduceMatchMedia()
    stubIntersectionObserver(true)
    const { unmount } = render(<BotAvatar animated />)
    expect(__instanceCount()).toBe(1)
    unmount()
    expect(__instanceCount()).toBe(0)
  })

  test('不可见时不注册（IntersectionObserver 可见性裁剪）', () => {
    stubNoReduceMatchMedia()
    stubIntersectionObserver(false)
    const { unmount } = render(<BotAvatar animated />)
    expect(__instanceCount()).toBe(0)
    unmount()
    expect(__instanceCount()).toBe(0)
  })

  test('多个 animated 实例各占一席，互不挤占', () => {
    stubNoReduceMatchMedia()
    stubIntersectionObserver(true)
    const { unmount } = render(
      <div>
        <BotAvatar animated />
        <BotAvatar animated />
      </div>
    )
    expect(__instanceCount()).toBe(2)
    unmount()
    expect(__instanceCount()).toBe(0)
  })
})
