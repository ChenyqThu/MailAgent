// @vitest-environment happy-dom
//
// 静态档眨眼 registry 单测 —— 全部走 vitest 假时钟（显式 toFake：setTimeout/rAF/
// performance 一起接管，sinon 的 rAF 以 16ms 粒度随 advanceTimersByTime 推进、
// 回调收到假时钟时间戳），零真实计时零 sleep。随机源 mock 成 0 → 每次采样恒取
// BLINK 表 [min,max] 的 min，到期时刻完全确定。
// 纪律断言是重点：间隙真 idle（眨完只剩一枚臂向下次眨眼的 timeout，无 rAF 常驻）、
// 并发上限、走完严格回写 staticFrame 缓存帧（与 animated 档同保真度的另一半是
// blinkEyes 走 renderAvatar 高度插值 —— 由「眨眼中 d ≠ scaleY(基线)」间接可证，
// 这里钉「基线严格还原」这条更硬的）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { staticFrame } from '../../../src/shared/bot-avatar/engine'
import { SHAPES } from '../../../src/shared/bot-avatar/shapes'
import { BLINK, POOLS } from '../../../src/shared/bot-avatar/states'
import type { BotState } from '../../../src/shared/bot-avatar/states'
import {
  __staticBlinkActiveCount,
  __staticBlinkClientCount,
  registerStaticBlink,
  unregisterStaticBlink
} from '../../../src/shared/bot-avatar/staticBlink'
import type { StaticBlinkClient } from '../../../src/shared/bot-avatar/staticBlink'

const SPHERE = SHAPES.sphere
const SVG_NS = 'http://www.w3.org/2000/svg'

interface Harness {
  client: StaticBlinkClient
  nodes: SVGPathElement[]
  base: readonly { d: string }[]
}

/** 造一个带真实 SVG path 节点的客户端（节点预写基线帧，模拟 React 首次渲染） */
function makeClient(state: BotState = 'idle'): Harness {
  const base = staticFrame(POOLS[state][0], SPHERE).eyes
  const nodes = base.map((eye) => {
    const node = document.createElementNS(SVG_NS, 'path') as SVGPathElement
    node.setAttribute('d', eye.d)
    return node
  })
  return {
    client: { state, surface: SPHERE, expressionIndex: POOLS[state][0], eyes: () => nodes },
    nodes,
    base
  }
}

// idle 的眨眼档 [6000, 14000, 280]（random=0 → 恒 6000ms 后眨、时长 280ms）
const IDLE_MIN = 6000
const IDLE_DURATION = 280

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'Date'
    ]
  })
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  // 每条测试自己 unregister 干净（模块级单例，跨测试共享）；这里只还原时钟/随机源
  expect(__staticBlinkClientCount()).toBe(0)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('staticBlink registry', () => {
  test('按状态 [min,max] 排程：min 前纹丝不动，到点开始眨，走完严格回到缓存基线帧', () => {
    const { client, nodes, base } = makeClient('idle')
    expect(BLINK.idle).toEqual([6000, 14000, 280])
    registerStaticBlink(client)
    expect(__staticBlinkClientCount()).toBe(1)

    vi.advanceTimersByTime(IDLE_MIN - 1)
    expect(__staticBlinkActiveCount()).toBe(0)
    expect(nodes[0].getAttribute('d')).toBe(base[0].d)

    vi.advanceTimersByTime(1) // 到期：进入眨眼窗口
    expect(__staticBlinkActiveCount()).toBe(1)
    vi.advanceTimersByTime(150) // 窗口中段（t≈0.54，接近谷底）
    expect(nodes[0].getAttribute('d')).not.toBe(base[0].d)
    expect(nodes[1].getAttribute('d')).not.toBe(base[1].d)

    vi.advanceTimersByTime(IDLE_DURATION) // 窗口走完
    expect(__staticBlinkActiveCount()).toBe(0)
    // 严格回写 staticFrame 缓存帧（不是"近似回去"）
    expect(nodes[0].getAttribute('d')).toBe(base[0].d)
    expect(nodes[1].getAttribute('d')).toBe(base[1].d)

    unregisterStaticBlink(client)
  })

  test('间隙真 idle：眨完无 rAF 常驻、只剩一枚臂向下次眨眼的 timeout；注销后归零', () => {
    const { client } = makeClient('idle')
    registerStaticBlink(client)
    expect(vi.getTimerCount()).toBe(1) // 注册后：仅调度 timeout

    vi.advanceTimersByTime(IDLE_MIN + IDLE_DURATION + 100) // 完整眨完一次
    expect(__staticBlinkActiveCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(1) // 间隙：无 pending rAF，只有下次眨眼的 timeout

    unregisterStaticBlink(client)
    expect(vi.getTimerCount()).toBe(0) // 全空：零 timer 零 rAF
  })

  test('并发上限 2：同刻到期的第 3 个实例顺延重试补眨（不丢）', () => {
    const a = makeClient('idle')
    const b = makeClient('idle')
    const c = makeClient('idle')
    registerStaticBlink(a.client)
    registerStaticBlink(b.client)
    registerStaticBlink(c.client)

    vi.advanceTimersByTime(IDLE_MIN) // 三个同时到期（random=0 全是 6000）
    expect(__staticBlinkActiveCount()).toBe(2) // cap 钉住

    // 400ms 顺延重试：前两个已走完（280ms），第三个补上
    vi.advanceTimersByTime(400)
    expect(__staticBlinkActiveCount()).toBe(1)
    vi.advanceTimersByTime(150)
    expect(c.nodes[0].getAttribute('d')).not.toBe(c.base[0].d) // 补眨的是 c
    // a/b 已还原基线
    expect(a.nodes[0].getAttribute('d')).toBe(a.base[0].d)
    expect(b.nodes[0].getAttribute('d')).toBe(b.base[0].d)

    unregisterStaticBlink(a.client)
    unregisterStaticBlink(b.client)
    unregisterStaticBlink(c.client)
  })

  test('中途注销撒手：不再有任何后续写入（React 已接管 DOM），rAF/timer 全停', () => {
    const { client, nodes } = makeClient('idle')
    registerStaticBlink(client)
    vi.advanceTimersByTime(IDLE_MIN + 48) // 眨眼进行中
    expect(__staticBlinkActiveCount()).toBe(1)
    const mid = nodes[0].getAttribute('d')

    unregisterStaticBlink(client)
    expect(__staticBlinkActiveCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(nodes[0].getAttribute('d')).toBe(mid) // 注销后帧原样冻结，无回写
  })

  test('BLINK=null 的状态（sleeping）拒绝注册：零客户端零 timer', () => {
    const { client } = makeClient('sleeping')
    expect(BLINK.sleeping).toBeNull()
    registerStaticBlink(client)
    expect(__staticBlinkClientCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
