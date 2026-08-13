// BotFaceEngine 物理/调度单测 —— 全部走注入的 {random, now}，零真实定时器零 DOM。
// 时间由测试显式喂给 tick(now)，所以断言的是公式本身（grokbot-engine-analysis.md §4），
// 不是 rAF 的调度巧合。

import { describe, expect, test } from 'vitest'

import {
  BotFaceEngine,
  EXPRESSIONS,
  blinkScaleAt,
  staticFrame
} from '../../../src/shared/bot-avatar/engine'
import { POOLS } from '../../../src/shared/bot-avatar/states'
import type { EngineFrame } from '../../../src/shared/bot-avatar/types'

/** transform 串解析：`translate(x y) scale(sx sy) translate(-cx -cy)` */
function parseTransform(t: string): { x: number; y: number; sx: number; sy: number } {
  const m = t.match(/^translate\((-?[\d.]+) (-?[\d.]+)\) scale\((-?[\d.]+) (-?[\d.]+)\)/)
  if (!m) throw new Error(`unparseable transform: ${t}`)
  return { x: Number(m[1]), y: Number(m[2]), sx: Number(m[3]), sy: Number(m[4]) }
}

/** 以 16ms 步长推进引擎到 endMs，返回最后一个非 null 帧 */
function advance(engine: BotFaceEngine, fromMs: number, endMs: number): EngineFrame | null {
  let last: EngineFrame | null = null
  for (let t = fromMs; t <= endMs; t += 16) {
    const frame = engine.tick(t)
    if (frame) last = frame
  }
  return last
}

// 构造期不消费随机（idle 的 blink/expr 定时用 random=0 → 最早 6000ms 才触发），
// 测试里推进都 < 2.5s，定时器不会干扰弹簧/眨眼断言
const quietEngine = (): BotFaceEngine =>
  new BotFaceEngine({ initialState: 'idle', random: () => 0, now: () => 0 })

describe('blinkScaleAt（§4.2 曲线端点）', () => {
  test('两端全开：t=0 与 t=1 都是 1', () => {
    expect(blinkScaleAt(0)).toBe(1)
    expect(blinkScaleAt(1)).toBe(1)
  })

  test('闭合谷底吃 0.04 下限（t→0.42 两侧）', () => {
    expect(blinkScaleAt(0.42)).toBe(0.04)
    expect(blinkScaleAt(0.4199)).toBe(0.04)
    expect(blinkScaleAt(0.43)).toBeCloseTo(Math.max((0.43 - 0.42) / 0.58, 0.04), 10)
  })

  test('闭眼快睁眼慢：闭合段斜率绝对值 > 睁开段', () => {
    const closeRate = Math.abs(blinkScaleAt(0.1) - blinkScaleAt(0)) / 0.1
    const openRate = Math.abs(blinkScaleAt(0.9) - blinkScaleAt(0.8)) / 0.1
    expect(closeRate).toBeGreaterThan(openRate)
  })
})

describe('staticFrame（静态档一帧）', () => {
  test('两只眼、无隐藏、settled、缩放恒 1', () => {
    const frame = staticFrame(0)
    expect(frame.settled).toBe(true)
    expect(frame.eyes).toHaveLength(2)
    for (const eye of frame.eyes) {
      expect(eye.hidden).toBe(false)
      expect(eye.d.startsWith('M')).toBe(true)
      expect(eye.d.endsWith('Z')).toBe(true)
      const { sx, sy } = parseTransform(eye.transform)
      expect(sx).toBeCloseTo(1, 4)
      expect(sy).toBeCloseTo(1, 4)
    }
  })

  test('eyeScale 直通缩放（shapes eyeAnchor 的挂点）', () => {
    const frame = staticFrame(0, 0.8)
    for (const eye of frame.eyes) {
      const { sx, sy } = parseTransform(eye.transform)
      expect(sx).toBeCloseTo(0.8, 4)
      expect(sy).toBeCloseTo(0.8, 4)
    }
  })
})

describe('弹簧 morph（§4.1）', () => {
  test('切表情后若干 tick 收敛到目标帧（settled=true 且 path 等于目标静态帧）', () => {
    const engine = quietEngine()
    engine.selectExpression(8)
    // f=7 临界阻尼的特征时间 ~1/7s，2s 足够收敛
    const last = advance(engine, 16, 2000)
    expect(last).not.toBeNull()
    expect(last?.settled).toBe(true)
    const target = staticFrame(8)
    expect(last?.eyes[0].d).toBe(target.eyes[0].d)
    expect(last?.eyes[1].d).toBe(target.eyes[1].d)
  })

  test('morph 途中帧介于起终点之间（真的在插值，不是瞬切）', () => {
    const engine = quietEngine()
    const from = staticFrame(0).eyes[0].d
    const to = staticFrame(8).eyes[0].d
    engine.tick(0) // 建立时基：首个 tick 无 lastTick，dt=0（镜像原型首帧），弹簧不推进
    engine.selectExpression(8)
    const mid = engine.tick(48) // 48ms 处，远未收敛
    expect(mid).not.toBeNull()
    expect(mid?.eyes[0].d).not.toBe(from)
    expect(mid?.eyes[0].d).not.toBe(to)
  })

  test('NaN 复位：frequency 为 NaN 时直接落定终态，产出不含 NaN', () => {
    const engine = new BotFaceEngine({
      initialState: 'idle',
      frequency: Number.NaN,
      random: () => 0,
      now: () => 0
    })
    engine.selectExpression(8)
    const frame = engine.tick(16)
    expect(frame).not.toBeNull()
    expect(frame?.settled).toBe(true)
    expect(frame?.eyes[0].d).toBe(staticFrame(8).eyes[0].d)
    expect(frame?.eyes[0].d.includes('NaN')).toBe(false)
    expect(frame?.eyes[0].transform.includes('NaN')).toBe(false)
  })
})

describe('眨眼（§4.2 引擎路径）', () => {
  test('blink() 后曲线推进、320ms 走完自动回 1 并 settle', () => {
    const engine = quietEngine()
    engine.tick(0) // 排掉初始 dirty 帧
    engine.blink() // now() 注入为 0 → blinkStart=0
    // t=160/320=0.5 → 睁开段 (0.5-0.42)/0.58
    const mid = engine.tick(160)
    expect(mid).not.toBeNull()
    expect(parseTransform(mid?.eyes[0].transform ?? '').sy).toBeCloseTo((0.5 - 0.42) / 0.58, 3)
    // t≥1 → 眨眼结束：本帧回满、settled
    const done = engine.tick(340)
    expect(done?.settled).toBe(true)
    expect(parseTransform(done?.eyes[0].transform ?? '').sy).toBeCloseTo(1, 4)
    // 结束后无事可做
    expect(engine.tick(360)).toBeNull()
  })

  test('眨眼进行中重复 blink() 不重置进度', () => {
    const engine = quietEngine()
    engine.tick(0)
    engine.blink()
    engine.tick(160)
    engine.blink() // 已在眨 → 忽略；若重置，t 会回到闭合段
    const frame = engine.tick(240) // t=0.75 → (0.33)/0.58
    expect(parseTransform(frame?.eyes[0].transform ?? '').sy).toBeCloseTo((0.75 - 0.42) / 0.58, 3)
  })
})

describe('球面投影（§4.4）', () => {
  test('转头隐藏：大角度时远侧眼先转到脑后（depth ≤ 0.02）', () => {
    // 几何依据（实测 expressions.json expr0 = idle 池首）：眼心 x ≈ 136.6 / 185.7，
    // 基准经度 ≈ 0.215 / 0.748 rad —— 眼 1 更靠球缘，turn=1.0 时它先越过
    // |longitude| ≈ 1.55 的可见边界，眼 0 仍可见；turn=π 双眼都在脑后
    const engine = quietEngine()
    engine.tick(0)

    engine.setTurn(1.0)
    const partial = engine.tick(1)
    expect(partial).not.toBeNull()
    expect(partial?.eyes[0].hidden).toBe(false)
    expect(partial?.eyes[1].hidden).toBe(true)

    engine.setTurn(Math.PI)
    const behind = engine.tick(2)
    expect(behind?.eyes.every((e) => e.hidden)).toBe(true)

    engine.setTurn(0)
    const back = engine.tick(3)
    expect(back?.eyes.every((e) => !e.hidden)).toBe(true)
  })

  test('gaze 平移：gazeX=1 → 眼心 x 偏移 +13.2 单位（§4.3）', () => {
    const engine = quietEngine()
    const baseline = engine.tick(0)
    const baseX = parseTransform(baseline?.eyes[0].transform ?? '').x
    engine.setGaze(1, 0)
    const shifted = engine.tick(1)
    expect(parseTransform(shifted?.eyes[0].transform ?? '').x).toBeCloseTo(baseX + 13.2, 2)
    // 越界收边：gaze 输入 clamp 到 [-1,1]
    engine.setGaze(5, 0)
    expect(engine.tick(2)).toBeNull() // clamp 后与当前值相同 → 无脏帧
  })
})

describe('调度器（§4.5）', () => {
  test('构造即池首表情', () => {
    const engine = new BotFaceEngine({ initialState: 'thinking', random: () => 0, now: () => 0 })
    expect(engine.expression).toBe(POOLS.thinking[0])
  })

  test('表情轮换只从当前池选、且不连续重复同帧', () => {
    // 伪随机循环序列：覆盖池内不同落点；thinking cadence [2000,3600]，
    // 每次跳 3601ms 保证定时必到期
    const seq = [0.9, 0.1, 0.5, 0.7, 0.3, 0.99, 0.42, 0.66]
    let i = 0
    const engine = new BotFaceEngine({
      initialState: 'thinking',
      random: () => seq[i++ % seq.length],
      now: () => 0
    })
    const pool = POOLS.thinking
    let prev = engine.expression
    for (let fire = 1; fire <= 30; fire++) {
      engine.tick(fire * 3601)
      const current = engine.expression
      expect(pool).toContain(current)
      expect(current).not.toBe(prev)
      prev = current
    }
  })

  test('单元素池（waking）到期重选自身，不崩不越界', () => {
    const engine = new BotFaceEngine({ initialState: 'waking', random: () => 0, now: () => 0 })
    expect(POOLS.waking).toHaveLength(1)
    engine.tick(0)
    const frame = engine.tick(801) // waking cadence 恒 800ms
    expect(frame).not.toBeNull()
    expect(engine.expression).toBe(POOLS.waking[0])
  })

  test('setState 立即切目标池首并重排；同态 setState 是 no-op', () => {
    const engine = quietEngine()
    engine.tick(0)
    expect(engine.tick(16)).toBeNull() // 已静止

    engine.setState('idle') // 同态：不得触发任何新帧
    expect(engine.tick(32)).toBeNull()

    engine.setState('thinking')
    expect(engine.state).toBe('thinking')
    expect(engine.expression).toBe(POOLS.thinking[0])
    // 池首 ≠ idle 池首 → 弹簧启动，出帧
    expect(engine.tick(48)).not.toBeNull()
  })

  test('settled 语义：空闲间隙 tick 返回 null（共享 ticker 零重绘的依据）', () => {
    const engine = quietEngine()
    expect(engine.tick(0)).not.toBeNull() // 首帧（挂载写 DOM）
    // idle 最早定时 = blink 6000ms（random=0），之前全部跳帧
    for (let t = 16; t < 5900; t += 500) {
      expect(engine.tick(t)).toBeNull()
    }
  })
})

describe('EXPRESSIONS 数据挂载', () => {
  test('引擎侧看到 25 帧（与 expressions.test.ts 的 JSON 闸互为印证）', () => {
    expect(EXPRESSIONS).toHaveLength(25)
  })
})
