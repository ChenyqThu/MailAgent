// BotFaceEngine v2 单测 —— 全部走注入的 {random, now}，零真实定时器零 DOM。
// 时间由测试显式喂给 tick(now)，断言的是「参数化过渡 + 3D 投影」管线本身，
// 不是 rAF 的调度巧合。
// 状态选型说明：settle 语义只在 AMBIENT = none/none 的状态成立（ambient 活跃
// 状态**有意**不 settle，30fps 限频常驻），所以静止类断言用 powering-down
// （pool [13,22] / cadence [6000,9000] / 无眨眼 / 无 ambient）。

import { describe, expect, test } from 'vitest'

import {
  BotFaceEngine,
  EXPRESSIONS,
  blinkScaleAt,
  easeProgress,
  staticFrame
} from '../../../src/shared/bot-avatar/engine'
import { SHAPES } from '../../../src/shared/bot-avatar/shapes'
import { AMBIENT, POOLS } from '../../../src/shared/bot-avatar/states'
import type { EngineFrame } from '../../../src/shared/bot-avatar/types'

const SPHERE = SHAPES.sphere

/** 完全静止的引擎：无眨眼排程、无 ambient、表情定时最早 6000ms */
const quietEngine = (): BotFaceEngine =>
  new BotFaceEngine({ surface: SPHERE, initialState: 'powering-down', random: () => 0, now: () => 0 })

/** 以 16ms 步长推进引擎到 endMs，返回最后一个非 null 帧 */
function advance(engine: BotFaceEngine, fromMs: number, endMs: number): EngineFrame | null {
  let last: EngineFrame | null = null
  for (let t = fromMs; t <= endMs; t += 16) {
    const frame = engine.tick(t)
    if (frame) last = frame
  }
  return last
}

describe('blinkScaleAt（闭快睁慢曲线）', () => {
  test('两端全开、0.42 处谷底全闭', () => {
    expect(blinkScaleAt(0)).toBe(1)
    expect(blinkScaleAt(1)).toBe(1)
    expect(blinkScaleAt(0.42)).toBeCloseTo(0, 10)
  })

  test('闭合段二次加速、睁开段二次减速（0.21/0.71 对称点都是 0.75）', () => {
    expect(blinkScaleAt(0.21)).toBeCloseTo(0.75, 10)
    expect(blinkScaleAt(0.71)).toBeCloseTo(1 - 0.25, 10)
  })
})

describe('easeProgress（三种过渡缓动）', () => {
  test('端点：三种缓动 p=0 → 0 附近、p=1 → 1 附近', () => {
    expect(easeProgress(0, 'smooth')).toBe(0)
    expect(easeProgress(1, 'smooth')).toBe(1)
    expect(easeProgress(0, 'snappy')).toBe(0)
    expect(easeProgress(1, 'snappy')).toBe(1)
    expect(easeProgress(0, 'spring')).toBeCloseTo(0, 10)
    expect(easeProgress(1, 'spring')).toBeCloseTo(1, 2)
  })

  test('spring 有过冲（某处 > 1）——回弹感的来源', () => {
    let max = 0
    for (let p = 0; p <= 1; p += 0.01) max = Math.max(max, easeProgress(p, 'spring'))
    expect(max).toBeGreaterThan(1)
  })
})

describe('staticFrame（静态档一帧）', () => {
  test('两只眼可见、settled、头部 path 闭合、无 ambient 平移', () => {
    const frame = staticFrame(0, SPHERE)
    expect(frame.settled).toBe(true)
    expect(frame.eyes).toHaveLength(2)
    for (const eye of frame.eyes) {
      expect(eye.visible).toBe(true)
      expect(eye.d.startsWith('M')).toBe(true)
      expect(eye.d.endsWith('Z')).toBe(true)
    }
    expect(frame.head.startsWith('M')).toBe(true)
    expect(frame.head.endsWith('Z')).toBe(true)
    expect(frame.offsetX).toBe(0)
    expect(frame.offsetY).toBe(0)
  })

  test('模块级缓存：同 (surface, index) 恒同引用；不同表情不同帧', () => {
    expect(staticFrame(0, SPHERE)).toBe(staticFrame(0, SPHERE))
    expect(staticFrame(0, SPHERE)).not.toBe(staticFrame(8, SPHERE))
    expect(staticFrame(0, SPHERE).eyes[0].d).not.toBe(staticFrame(8, SPHERE).eyes[0].d)
  })

  test('表情的头部姿态进头轮廓：非球形（cube）不同表情头 path 不同（3D 转头的证据）', () => {
    // sphere 是各向同性：任何姿态投影都是同一个圆（解析解），所以转头证据用 cube
    expect(staticFrame(0, SHAPES.cube).head).not.toBe(staticFrame(8, SHAPES.cube).head)
    // 球形头轮廓姿态不变，但眼睛贴着球面滑动 —— 眼 path 必变
    expect(staticFrame(0, SPHERE).eyes[0].d).not.toBe(staticFrame(8, SPHERE).eyes[0].d)
  })
})

describe('参数化过渡', () => {
  test('切表情后途中帧介于起终点之间，500ms 后落定为目标静态帧', () => {
    const engine = quietEngine()
    engine.tick(0)
    engine.selectExpression(22) // powering-down 池 [13, 22]
    const from = staticFrame(13, SPHERE)
    const to = staticFrame(22, SPHERE)

    const mid = engine.tick(120)
    expect(mid).not.toBeNull()
    expect(mid?.eyes[0].d).not.toBe(from.eyes[0].d)
    expect(mid?.eyes[0].d).not.toBe(to.eyes[0].d)
    expect(mid?.settled).toBe(false)

    const done = advance(engine, 136, 700)
    expect(done?.settled).toBe(true)
    expect(done?.eyes[0].d).toBe(to.eyes[0].d)
    expect(done?.eyes[1].d).toBe(to.eyes[1].d)
    expect(done?.head).toBe(to.head)
    // 落定后无事可做
    expect(engine.tick(720)).toBeNull()
  })

  test('产出不含 NaN（插值/投影全链数值健康）', () => {
    const engine = quietEngine()
    engine.selectExpression(22)
    for (let t = 16; t <= 600; t += 100) {
      const frame = engine.tick(t)
      if (!frame) continue
      expect(frame.head.includes('NaN')).toBe(false)
      expect(frame.eyes[0].d.includes('NaN')).toBe(false)
    }
  })
})

describe('眨眼', () => {
  test('手动 blink()：曲线推进、280ms 走完自动回满并 settle', () => {
    const engine = quietEngine()
    engine.tick(0) // 排掉初始 dirty 帧
    const openD = staticFrame(13, SPHERE).eyes[0].d
    engine.blink() // now() 注入为 0 → blinkStart=0，powering-down 无眨眼档 → 默认 280ms
    const mid = engine.tick(118) // t≈0.42 谷底附近，眼高被压
    expect(mid).not.toBeNull()
    expect(mid?.eyes[0].d).not.toBe(openD)
    const done = engine.tick(300)
    expect(done?.settled).toBe(true)
    expect(done?.eyes[0].d).toBe(openD)
    expect(engine.tick(320)).toBeNull()
  })

  test('眨眼进行中重复 blink() 不重置进度', () => {
    const engine = quietEngine()
    engine.tick(0)
    engine.blink()
    const at140 = engine.tick(140)?.eyes[0].d
    engine.blink() // 已在眨 → 忽略；若重置，进度会回到闭合段
    const at150 = engine.tick(150)?.eyes[0].d
    // 150ms 已在睁开段（>0.42×280=118ms）：若被重置则会回到更闭的形状
    expect(at140).not.toBe(at150)
    const done = engine.tick(300)
    expect(done?.settled).toBe(true)
  })

  test('按状态档排程：surprised 在 minInterval（random=0）处自动眨眼，时长 220ms', () => {
    const engine = new BotFaceEngine({
      surface: SPHERE,
      initialState: 'surprised', // blink [1800, 3500, 220]，ambient none/none
      random: () => 0,
      now: () => 0
    })
    engine.tick(0)
    expect(engine.tick(1000)).toBeNull() // 未到期
    const start = engine.tick(1801) // blink 到期
    expect(start).not.toBeNull()
    const open = staticFrame(POOLS.surprised[0], SPHERE).eyes[0].d
    const mid = engine.tick(1801 + 90)
    expect(mid?.eyes[0].d).not.toBe(open)
    const done = advance(engine, 1900, 2100) // 1801+220=2021 结束
    expect(done?.settled).toBe(true)
    expect(done?.eyes[0].d).toBe(open)
  })
})

describe('gaze（头部朝向 + 眼睛偏移）', () => {
  test('setGaze 后眼睛偏转；重复同值无脏帧；越界收边', () => {
    const engine = quietEngine()
    const baseline = engine.tick(0)
    engine.setGaze(1, 0)
    const shifted = engine.tick(16)
    expect(shifted).not.toBeNull()
    expect(shifted?.eyes[0].d).not.toBe(baseline?.eyes[0].d)
    // clamp：5 与 1 等价 → 无脏帧
    engine.setGaze(5, 0)
    expect(engine.tick(32)).toBeNull()
    // 归零恢复
    engine.setGaze(0, 0)
    const back = engine.tick(48)
    expect(back?.eyes[0].d).toBe(baseline?.eyes[0].d)
  })

  test('gaze 的头部朝向分量进头轮廓（cube 可见；sphere 轮廓姿态不变是几何事实）', () => {
    const engine = new BotFaceEngine({
      surface: SHAPES.cube,
      initialState: 'powering-down',
      random: () => 0,
      now: () => 0
    })
    const baseline = engine.tick(0)
    engine.setGaze(1, 0)
    const shifted = engine.tick(16)
    expect(shifted?.head).not.toBe(baseline?.head)
  })
})

describe('ambient（空闲微动，v2 净新增）', () => {
  test('idle（slowDrift）永不 settle：30fps 限频出帧，帧间画面在变', () => {
    expect(AMBIENT.idle.body).toBe('slowDrift')
    const engine = new BotFaceEngine({
      surface: SPHERE,
      initialState: 'idle',
      random: () => 0,
      now: () => 0
    })
    const first = engine.tick(0)
    expect(first).not.toBeNull()
    expect(first?.settled).toBe(false)
    // 30fps 限频：33ms 内不出帧
    expect(engine.tick(10)).toBeNull()
    expect(engine.tick(20)).toBeNull()
    const second = engine.tick(40)
    expect(second).not.toBeNull()
    // 漂移在动：隔一段时间的两帧眼睛位置不同（sphere 头轮廓姿态不变，证据在眼）
    const later = engine.tick(1500)
    expect(later).not.toBeNull()
    expect(later?.eyes[0].d).not.toBe(second?.eyes[0].d)
  })

  test('完全静止态（powering-down）settle 后零出帧（性能地板不回退）', () => {
    const engine = quietEngine()
    expect(engine.tick(0)).not.toBeNull() // 首帧（挂载写 DOM）
    for (let t = 16; t < 5900; t += 500) {
      expect(engine.tick(t)).toBeNull()
    }
  })
})

describe('调度器', () => {
  test('构造即池首表情', () => {
    const engine = new BotFaceEngine({
      surface: SPHERE,
      initialState: 'thinking',
      random: () => 0,
      now: () => 0
    })
    expect(engine.expression).toBe(POOLS.thinking[0])
  })

  test('表情轮换只从当前池选、且不连续重复同帧', () => {
    // thinking cadence [2000,3600]，每次跳 3601ms 保证定时必到期
    const seq = [0.9, 0.1, 0.5, 0.7, 0.3, 0.99, 0.42, 0.66]
    let i = 0
    const engine = new BotFaceEngine({
      surface: SPHERE,
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
    const engine = new BotFaceEngine({
      surface: SPHERE,
      initialState: 'waking',
      random: () => 0,
      now: () => 0
    })
    expect(POOLS.waking).toHaveLength(1)
    engine.tick(0)
    const frame = engine.tick(801) // waking cadence 恒 800ms
    expect(frame).not.toBeNull()
    expect(engine.expression).toBe(POOLS.waking[0])
  })

  test('setState（驻留已满）立即向目标池首过渡并重排；同态 setState 是 no-op', () => {
    let clock = 0
    const engine = new BotFaceEngine({
      surface: SPHERE,
      initialState: 'powering-down',
      random: () => 0,
      now: () => clock
    })
    engine.tick(0)
    expect(engine.tick(16)).toBeNull() // 已静止

    engine.setState('powering-down') // 同态：不得触发任何新帧
    expect(engine.tick(32)).toBeNull()

    clock = 700 // 驻留（600ms）已满 → 走立即路径
    engine.setState('surprised')
    expect(engine.state).toBe('surprised')
    expect(engine.expression).toBe(POOLS.surprised[0])
    // 池首 ≠ powering-down 池首 → 过渡启动，出帧
    expect(engine.tick(748)).not.toBeNull()
  })
})

describe('状态驻留闸（min-dwell 去抖，0813）', () => {
  // 全部用可变假时钟（now: () => clock）+ 显式 tick(now)，零真实计时。
  // 状态选型：powering-down（无眨眼/无 ambient）保证驻留期内 tick 恒 null，
  // 「无新帧」断言干净；目标态 surprised(池首 3) / thinking(池首 8) 池首互异，
  // 「中间态从未上脸」可由 expression 直接判。
  const dwellEngine = (): { engine: BotFaceEngine; setClock: (t: number) => void } => {
    let clock = 0
    const engine = new BotFaceEngine({
      surface: SPHERE,
      initialState: 'powering-down',
      random: () => 0,
      now: () => clock
    })
    return {
      engine,
      setClock: (t: number) => {
        clock = t
      }
    }
  }

  test('抖动序列 A→B→A→C：驻留期内不切换，期满一次性切到 C（不播中间态 B）', () => {
    const { engine, setClock } = dwellEngine()
    engine.tick(0)
    const poolHeadA = POOLS['powering-down'][0]

    setClock(100)
    engine.setState('surprised') // B：驻留未满 → 排队
    expect(engine.state).toBe('powering-down')
    expect(engine.expression).toBe(poolHeadA)

    setClock(150)
    engine.setState('powering-down') // 折回 A → 撤销排队

    setClock(200)
    engine.setState('thinking') // C：替换队列目标（只保留最新）
    expect(engine.state).toBe('powering-down')

    // 驻留期内：B/C 都没开始播，无过渡无新帧
    expect(engine.tick(300)).toBeNull()
    expect(engine.expression).toBe(poolHeadA)
    expect(engine.tick(599)).toBeNull()

    // 期满：一次性切到 C（B 从未上脸）
    setClock(620)
    const frame = engine.tick(620)
    expect(frame).not.toBeNull()
    expect(engine.state).toBe('thinking')
    expect(engine.expression).toBe(POOLS.thinking[0])
  })

  test('最终状态不丢：排队目标期满必达，且提交后驻留重新起算', () => {
    const { engine, setClock } = dwellEngine()
    engine.tick(0)

    setClock(50)
    engine.setState('surprised')
    engine.tick(400)
    expect(engine.state).toBe('powering-down') // 期满前仍是旧状态

    setClock(600)
    engine.tick(600) // 600 - 0 ≥ 600 → 提交
    expect(engine.state).toBe('surprised')
    expect(engine.expression).toBe(POOLS.surprised[0])

    // 提交后驻留重臂：紧跟着的新目标再次排队而非立即切
    setClock(700)
    engine.setState('thinking')
    expect(engine.state).toBe('surprised')
    engine.tick(1100) // 1100 - 600 = 500 < 600 → 未到期
    expect(engine.state).toBe('surprised')
    engine.tick(1200) // 1200 - 600 = 600 → 提交
    expect(engine.state).toBe('thinking')
  })

  test('驻留期内重复 setState 同一目标幂等：提交时刻仍按状态进入时刻起算', () => {
    const { engine, setClock } = dwellEngine()
    engine.tick(0)

    setClock(100)
    engine.setState('surprised')
    setClock(550)
    engine.setState('surprised') // 重复排队不得推迟提交（React 重渲染逐次灌入的形态）
    setClock(610)
    engine.tick(610) // 610 - 0 ≥ 600 → 提交（若重复排队重置了基点，此刻不会切）
    expect(engine.state).toBe('surprised')
  })

  test('A→B→A 折返：撤销排队，期满后零过渡零新帧', () => {
    const { engine, setClock } = dwellEngine()
    engine.tick(0)

    setClock(100)
    engine.setState('surprised')
    setClock(200)
    engine.setState('powering-down') // 折回当前态 → 队列清空
    expect(engine.tick(650)).toBeNull() // 期满也无事发生
    expect(engine.state).toBe('powering-down')
    expect(engine.tick(700)).toBeNull()
  })

  test('期满后 pending 尚未被 tick 消费时，新 setState 直接提交最新目标', () => {
    const { engine, setClock } = dwellEngine()
    engine.tick(0)

    setClock(100)
    engine.setState('surprised') // 排队
    setClock(700) // 驻留已满，但两次 tick 之间（pending 还没被消费）
    engine.setState('thinking') // 立即路径：提交最新目标，作废排队的 surprised
    expect(engine.state).toBe('thinking')
    expect(engine.expression).toBe(POOLS.thinking[0])
  })
})

describe('EXPRESSIONS 数据挂载', () => {
  test('引擎侧看到 25 个参数化表情（与 expressions.test.ts 互为印证）', () => {
    expect(EXPRESSIONS).toHaveLength(25)
  })
})
