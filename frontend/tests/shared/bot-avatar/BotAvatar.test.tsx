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
import { cleanup, fireEvent, render } from '@testing-library/react'

import { BotAvatar } from '../../../src/shared/bot-avatar/BotAvatar'
import { staticFrame } from '../../../src/shared/bot-avatar/engine'
import { SHAPES } from '../../../src/shared/bot-avatar/shapes'
import { BLINK, POOLS } from '../../../src/shared/bot-avatar/states'
import { __staticBlinkClientCount } from '../../../src/shared/bot-avatar/staticBlink'
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
  test('渲染头 path + 两条眼 path，且不注册 ticker', () => {
    const { container } = render(<BotAvatar title="bot" size={24} />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('viewBox')).toBe('-150 -150 300 300')
    expect(svg?.getAttribute('width')).toBe('24')

    const expected = staticFrame(POOLS.idle[0], SHAPES.sphere)
    const head = container.querySelector<SVGPathElement>('[data-bot-head]')
    expect(head?.getAttribute('d')).toBe(expected.head)
    // 眼睛 clip 在头形内是 3D 错觉关键：clipPath 内容与头 path 共用同一串
    const clipContent = container.querySelector<SVGPathElement>('clipPath path')
    expect(clipContent?.getAttribute('d')).toBe(expected.head)

    const eyes = eyePaths(container)
    expect(eyes).toHaveLength(2)
    expect(eyes[0].getAttribute('d')).toBe(expected.eyes[0].d)
    expect(eyes[1].getAttribute('d')).toBe(expected.eyes[1].d)

    expect(__instanceCount()).toBe(0)
  })

  test('state 变化 = 离散换帧（池首表情；非球形连头轮廓一起变）', () => {
    const { container, rerender } = render(<BotAvatar state="idle" />)
    const idleFrame = staticFrame(POOLS.idle[0], SHAPES.sphere)
    expect(eyePaths(container)[0].getAttribute('d')).toBe(idleFrame.eyes[0].d)

    rerender(<BotAvatar state="thinking" />)
    const thinkingFrame = staticFrame(POOLS.thinking[0], SHAPES.sphere)
    expect(eyePaths(container)[0].getAttribute('d')).toBe(thinkingFrame.eyes[0].d)
    expect(thinkingFrame.eyes[0].d).not.toBe(idleFrame.eyes[0].d)

    // 3D 转头进头轮廓：sphere 姿态不变是几何事实，用 cube 验证
    const cube = render(<BotAvatar config={{ shape: 'cube' }} state="idle" />)
    const cubeIdleHead = cube.container
      .querySelector<SVGPathElement>('[data-bot-head]')
      ?.getAttribute('d')
    cube.rerender(<BotAvatar config={{ shape: 'cube' }} state="thinking" />)
    expect(
      cube.container.querySelector<SVGPathElement>('[data-bot-head]')?.getAttribute('d')
    ).not.toBe(cubeIdleHead)
    cube.unmount()
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

  test('flipX = 绕原点镜像（v2 中心坐标系）', () => {
    const { container } = render(<BotAvatar flipX />)
    const g = container.querySelector('g[transform]')
    expect(g?.getAttribute('transform')).toBe('scale(-1 1)')
  })

  test('title 走可访问名；无 title 时对 a11y 树隐藏', () => {
    const named = render(<BotAvatar title="AI 助手" />)
    expect(named.container.querySelector('svg')?.getAttribute('aria-label')).toBe('AI 助手')
    expect(named.container.querySelector('title')?.textContent).toBe('AI 助手')
    named.unmount()

    const anonymous = render(<BotAvatar />)
    expect(anonymous.container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  })

  test('复合形背层槽位：mickey 双耳 / cursor 锥体 / sphere 无', () => {
    const mickey = render(<BotAvatar config={{ shape: 'mickey' }} />)
    expect(mickey.container.querySelectorAll('[data-bot-back]')).toHaveLength(2)
    mickey.unmount()
    const cursor = render(<BotAvatar config={{ shape: 'cursor' }} />)
    expect(cursor.container.querySelectorAll('[data-bot-back]')).toHaveLength(1)
    cursor.unmount()
    const sphere = render(<BotAvatar config={{ shape: 'sphere' }} />)
    expect(sphere.container.querySelectorAll('[data-bot-back]')).toHaveLength(0)
  })

  test('组合身体槽位（0813 成品目录化）：freddy 背 3 前 3，DOM 序 = 背 → 头 → 眼 → 前', () => {
    const { container } = render(<BotAvatar config={{ shape: 'freddy' }} />)
    expect(container.querySelectorAll('[data-bot-back]')).toHaveLength(3)
    expect(container.querySelectorAll('[data-bot-front]')).toHaveLength(3)
    // 层序纪律（镜像 lab AvatarCanvas）：背层在头之前、前层在眼组之后
    const motion = container.querySelector('[data-bot-motion]')
    const children = Array.from(motion?.children ?? []).map((node) =>
      node.hasAttribute('data-bot-back')
        ? 'back'
        : node.hasAttribute('data-bot-head')
          ? 'head'
          : node.hasAttribute('data-bot-front')
            ? 'front'
            : 'eyes'
    )
    expect(children).toEqual(['back', 'back', 'back', 'head', 'eyes', 'front', 'front', 'front'])
    // 静态帧里空的前层槽写 ''（附属曲面全在头后时前层不画东西）
    const frame = staticFrame(0, SHAPES.freddy)
    expect(frame.back.length + frame.front.length).toBe(3)
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

describe('BotAvatar 静态档眨眼（blink registry 挂载纪律）', () => {
  test('reduced-motion（全局 setup 默认）下静态档不注册 blink registry', () => {
    const { unmount } = render(<BotAvatar state="idle" />)
    expect(__staticBlinkClientCount()).toBe(0)
    unmount()
  })

  test('非 reduce 静态档 + 可眨状态：注册 registry，卸载即注销', () => {
    stubNoReduceMatchMedia()
    const { unmount } = render(<BotAvatar state="idle" />)
    expect(__staticBlinkClientCount()).toBe(1)
    expect(__instanceCount()).toBe(0) // 仍是静态档：不碰共享 rAF ticker
    unmount()
    expect(__staticBlinkClientCount()).toBe(0)
  })

  test('BLINK=null 状态（sleeping 闭眼态）不注册', () => {
    stubNoReduceMatchMedia()
    expect(BLINK.sleeping).toBeNull()
    const { unmount } = render(<BotAvatar state="sleeping" />)
    expect(__staticBlinkClientCount()).toBe(0)
    unmount()
  })

  test('animated 档不走 blink registry（引擎自带眨眼排程）', () => {
    stubNoReduceMatchMedia()
    stubIntersectionObserver(true)
    const { unmount } = render(<BotAvatar animated state="idle" />)
    expect(__staticBlinkClientCount()).toBe(0)
    expect(__instanceCount()).toBe(1)
    unmount()
  })

  test('state 切到不可眨状态 = 注销；切回可眨状态 = 重新注册', () => {
    stubNoReduceMatchMedia()
    const { rerender, unmount } = render(<BotAvatar state="idle" />)
    expect(__staticBlinkClientCount()).toBe(1)
    rerender(<BotAvatar state="sleeping" />)
    expect(__staticBlinkClientCount()).toBe(0)
    rerender(<BotAvatar state="thinking" />)
    expect(__staticBlinkClientCount()).toBe(1)
    unmount()
    expect(__staticBlinkClientCount()).toBe(0)
  })
})

describe('BotAvatar mouseInteractive（编辑器预览）', () => {
  function pointermoveListenerDelta(run: () => () => void): { added: number; removed: number } {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const dispose = run()
    const count = (calls: unknown[][]): number =>
      calls.filter(([type]) => type === 'pointermove').length
    const added = count(addSpy.mock.calls)
    dispose()
    const removed = count(removeSpy.mock.calls)
    addSpy.mockRestore()
    removeSpy.mockRestore()
    return { added, removed }
  }

  test('animated + 可见：挂全局 pointermove，卸载对称摘除', () => {
    stubNoReduceMatchMedia()
    stubIntersectionObserver(true)
    const { added, removed } = pointermoveListenerDelta(() => {
      const { unmount } = render(<BotAvatar animated mouseInteractive />)
      return unmount
    })
    expect(added).toBe(1)
    expect(removed).toBe(1)
  })

  test('不可见 / 未 animated / reduced-motion：不挂监听', () => {
    // 不可见（IO 报 false）
    stubNoReduceMatchMedia()
    stubIntersectionObserver(false)
    let delta = pointermoveListenerDelta(() => {
      const { unmount } = render(<BotAvatar animated mouseInteractive />)
      return unmount
    })
    expect(delta.added).toBe(0)

    // 静态档（未 animated）
    stubIntersectionObserver(true)
    delta = pointermoveListenerDelta(() => {
      const { unmount } = render(<BotAvatar mouseInteractive />)
      return unmount
    })
    expect(delta.added).toBe(0)

    // reduced-motion（恢复全局 setup 的 reduce 环境）
    vi.unstubAllGlobals()
    delta = pointermoveListenerDelta(() => {
      const { unmount } = render(<BotAvatar animated mouseInteractive />)
      return unmount
    })
    expect(delta.added).toBe(0)
  })

  test('pointermove → 引擎收到 gaze（下一帧眼/头 path 随指针偏转）', () => {
    stubNoReduceMatchMedia()
    stubIntersectionObserver(true)
    // 受控 rAF：手动推帧，避免真异步
    let frameCb: FrameRequestCallback | null = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frameCb = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})

    const { container, unmount } = render(<BotAvatar animated mouseInteractive size={40} />)
    const eye = container.querySelector<SVGPathElement>('[data-bot-eye="0"]')
    // 基线：推一帧（首帧 dirty）
    frameCb?.(0)
    const before = eye?.getAttribute('d')

    // 指针打到视窗最右缘 —— gazeX 应饱和为正值，眼睛/头部 path 偏转
    fireEvent.pointerMove(window, { clientX: window.innerWidth, clientY: 0 })
    frameCb?.(16)
    const after = eye?.getAttribute('d')
    expect(after).not.toBe(before)
    unmount()
  })
})
