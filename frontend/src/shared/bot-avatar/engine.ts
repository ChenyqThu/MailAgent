// 灵动 bot 头像 —— framework-agnostic 引擎（零 React / 零 GSAP / 零外部依赖）。
// 公式 1:1 移植自原型 index.html L3654-3827，逐条对照 grokbot-engine-analysis.md §4；
// 有意的偏离只有三处，均已就地注释：
//   1. 构造器直接以池首表情落定（morph=1），不像原型 boot 时空跑一次同帧弹簧；
//   2. setState 对相同状态是 no-op（React 重渲染不得重置表情/重排定时器）;
//   3. 定时用 nextAt 时间戳由 tick 检查，不用 setTimeout —— 时间可注入，测试确定性，
//      且挂在共享 ticker 上时暂停/恢复天然一致。

import EXPRESSIONS_DATA from './expressions.json'
import { BLINK, EXPR_CADENCE, POOLS } from './states'
import type { BotState } from './states'
import type { EngineFrame, ExpressionFrame, EyeFrame } from './types'

/** 25 表情 × 2 眼 × 48 点（脚本抽取自原型，tests/shared/bot-avatar 钉死形状） */
export const EXPRESSIONS = EXPRESSIONS_DATA as unknown as readonly ExpressionFrame[]

// —— 几何 / 时序常量（原型硬编码值，来源标注 grokbot-engine-analysis.md 小节）——
const HEAD_CX = 114.2705 // §4.4 头中心 x
const SPHERE_RADIUS = 105 // §4.4 球面半径
const GAZE_X_UNITS = 13.2 // §4.3 gazeX ∈ [-1,1] → 平移单位
const GAZE_Y_UNITS = 8.4 // §4.3
const BLINK_DURATION_MS = 320 // §4.2
const BLINK_CLOSE_PORTION = 0.42 // §4.2 闭眼快（42%）睁眼慢（58%）
const BLINK_MIN_SCALE = 0.04 // §4.2 scaleY 下限
const DEFAULT_SPRING_FREQUENCY = 7 // §4.1 f 默认 7（原型滑块范围 4-12）
const MAX_DT_S = 0.1 // §4.1 dt 上限（后台回来第一帧不许爆冲）
const SCALE_MIN = 0.02 // §4.4 scale clamp 下限
const SCALE_MAX = 2.4 // §4.4 scale clamp 上限
const DEPTH_VISIBLE_MIN = 0.02 // §4.4 depth ≤ 0.02 隐藏（转到脑后）
// 弹簧收敛判定阈值（原型无此概念——它每帧无条件重绘；settle 语义是本模块为
// 「空闲零重绘」新增的，阈值取 toFixed(2) 输出粒度之下，收敛瞬间对产出无感）
const MORPH_SETTLE_EPS = 0.001
const VELOCITY_SETTLE_EPS = 0.01

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v))

type Ring = ReadonlyArray<ReadonlyArray<number>>

function centroid(ring: Ring): readonly [number, number] {
  let x = 0
  let y = 0
  for (const p of ring) {
    x += p[0]
    y += p[1]
  }
  return [x / ring.length, y / ring.length]
}

function ringPath(ring: Ring): string {
  return 'M' + ring.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z'
}

/**
 * 眨眼曲线（§4.2）。t = 眨眼进度 0..1（320ms 归一化），只压 scaleY。
 * 导出成纯函数是为了单测端点，引擎内部经 blinkStart 时间戳调用。
 */
export function blinkScaleAt(t: number): number {
  return Math.max(
    t < BLINK_CLOSE_PORTION
      ? 1 - t / BLINK_CLOSE_PORTION
      : (t - BLINK_CLOSE_PORTION) / (1 - BLINK_CLOSE_PORTION),
    BLINK_MIN_SCALE
  )
}

interface EyeProjection {
  gazeX: number
  gazeY: number
  turn: number
  blink: number
  eyeScale: number
}

/** 球面投影 + 眨眼/gaze 合成（§4.3/§4.4，原型 render() 逐行对应） */
function projectEyes(rings: ReadonlyArray<Ring>, p: EyeProjection): EyeFrame[] {
  return rings.map((ring) => {
    const [cx, cy] = centroid(ring)
    const offset = cx - HEAD_CX
    const baseLongitude = Math.asin(clamp(offset / SPHERE_RADIUS, -1, 1))
    const longitude = baseLongitude + p.turn
    const depth = Math.cos(longitude)
    // 近侧眼变宽 / 远侧眼压缩；分子分母都垫 0.02 下限，比值永不爆炸（§4.4）
    const perspective =
      Math.max(depth, DEPTH_VISIBLE_MIN) / Math.max(Math.cos(baseLongitude), DEPTH_VISIBLE_MIN)
    const x = HEAD_CX + SPHERE_RADIUS * Math.sin(longitude) + p.gazeX
    const y = cy + p.gazeY
    const sx = clamp(perspective * p.eyeScale, SCALE_MIN, SCALE_MAX)
    const sy = clamp(p.blink * p.eyeScale, SCALE_MIN, SCALE_MAX)
    return {
      d: ringPath(ring),
      // 先平移到目标点、绕眼心缩放（尾部 translate(-cx -cy) 把缩放原点挪到眼心）
      transform: `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})`,
      hidden: depth <= DEPTH_VISIBLE_MIN
    }
  })
}

/**
 * 静态档一帧：表情原样（morph=1）、无 gaze/转头/眨眼。
 * 列表位点与 reduced-motion 回退都走这里 —— 不建引擎实例、零定时器。
 */
export function staticFrame(expressionIndex: number, eyeScale = 1): EngineFrame {
  const rings = EXPRESSIONS[expressionIndex]
  return {
    eyes: projectEyes(rings, { gazeX: 0, gazeY: 0, turn: 0, blink: 1, eyeScale }),
    settled: true
  }
}

export interface BotEngineOptions {
  initialState?: BotState
  /** 弹簧频率 f（§4.1），默认 7 */
  frequency?: number
  /** 形状层的眼睛整体缩放（shapes.ts eyeAnchor.eyeScale） */
  eyeScale?: number
  /** 随机源注入口 —— 测试确定性；默认 Math.random */
  random?: () => number
  /** 时钟注入口（毫秒，performance.now 时基）；只用于构造期/手动 blink 的排程基点 */
  now?: () => number
}

export class BotFaceEngine {
  private readonly random: () => number
  private readonly now: () => number
  private readonly frequency: number
  private readonly eyeScale: number

  private stateValue: BotState
  private expressionValue: number
  /** 弹簧起点：上一次切换瞬间「正在显示」的帧快照（可变工作副本） */
  private currentRings: number[][][]
  private targetRings: ExpressionFrame
  private morph = 1
  private velocity = 0
  private lastTick: number | null = null
  private blinkStart: number | null = null
  private gazeXValue = 0
  private gazeYValue = 0
  private turnValue = 0
  /** gaze/turn 变过但还没出过帧；首帧也算脏（挂载即产出一帧） */
  private dirty = true
  private nextExpressionAt: number | null = null
  private nextBlinkAt: number | null = null

  constructor(opts: BotEngineOptions = {}) {
    this.random = opts.random ?? Math.random
    this.now =
      opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
    this.frequency = opts.frequency ?? DEFAULT_SPRING_FREQUENCY
    this.eyeScale = opts.eyeScale ?? 1
    this.stateValue = opts.initialState ?? 'idle'
    // 直接以池首表情落定（morph=1）：原型 boot 会对同一帧空跑一次弹簧，纯视觉 no-op
    const head = POOLS[this.stateValue][0]
    this.expressionValue = head
    this.targetRings = EXPRESSIONS[head]
    this.currentRings = copyRings(EXPRESSIONS[head])
    const t = this.now()
    // 排程顺序镜像原型 setState：先眨眼后表情（随机源消费顺序是测试契约的一部分）
    this.scheduleBlink(t)
    this.scheduleExpression(t)
  }

  get state(): BotState {
    return this.stateValue
  }

  get expression(): number {
    return this.expressionValue
  }

  /** 状态切换（§4.5）：立即切池首表情 + 重排两类定时 */
  setState(next: BotState): void {
    // 偏离原型：同态重设是 no-op —— React 重渲染/effect 重跑不得重启 morph 或重排定时
    if (next === this.stateValue) return
    this.stateValue = next
    this.selectExpression(POOLS[next][0])
    const t = this.now()
    this.scheduleBlink(t)
    this.scheduleExpression(t)
  }

  /** 切换表情：从「当前显示帧」起弹（§4.1 —— currentRings 取显示快照，不是上个目标） */
  selectExpression(index: number): void {
    this.currentRings = this.displayedRings()
    this.targetRings = EXPRESSIONS[index]
    this.expressionValue = index
    this.morph = 0
    this.velocity = 0
  }

  /** gaze ∈ [-1,1]²，越界收边（§4.3） */
  setGaze(x: number, y: number): void {
    const nx = clamp(x, -1, 1)
    const ny = clamp(y, -1, 1)
    if (nx !== this.gazeXValue || ny !== this.gazeYValue) {
      this.gazeXValue = nx
      this.gazeYValue = ny
      this.dirty = true
    }
  }

  /** 转头弧度（§4.4）；spin 类演出由调用方驱动本值 */
  setTurn(radians: number): void {
    if (radians !== this.turnValue) {
      this.turnValue = radians
      this.dirty = true
    }
  }

  /** 手动触发一次眨眼（已在眨则忽略，与原型「重设 blinkStart」略异——避免长按连点冻在闭眼） */
  blink(): void {
    if (this.blinkStart === null) this.blinkStart = this.now()
  }

  /**
   * 推进一帧。返回 null = 本帧无事可做（弹簧已收敛、无眨眼、无脏位、无到期定时），
   * 共享 ticker 据此跳过 DOM 写入 —— 空闲表情间隙零重绘。
   */
  tick(now: number): EngineFrame | null {
    const last = this.lastTick ?? now
    this.lastTick = now
    const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_DT_S)

    // 到期定时（原型用 setTimeout；这里由 tick 检查 nextAt，见文件头偏离 3）
    let timerFired = false
    if (this.nextExpressionAt !== null && now >= this.nextExpressionAt) {
      const pool = POOLS[this.stateValue]
      const alternatives = pool.filter((i) => i !== this.expressionValue)
      // 单元素池（如 waking）没有替代帧：原型此时重选池首（同帧弹簧，视觉静止）
      this.selectExpression(
        alternatives.length
          ? alternatives[Math.floor(this.random() * alternatives.length)]
          : pool[0]
      )
      this.scheduleExpression(now)
      timerFired = true
    }
    if (this.nextBlinkAt !== null && now >= this.nextBlinkAt) {
      this.blinkStart = now
      this.scheduleBlink(now)
      timerFired = true
    }

    const springActive = this.morph !== 1 || this.velocity !== 0
    if (springActive) {
      // 临界阻尼弹簧 ζ=1（§4.1）
      this.velocity +=
        (-2 * this.frequency * this.velocity - this.frequency * this.frequency * (this.morph - 1)) *
        dt
      this.morph += this.velocity * dt
      // NaN 防护（§4.1）：frequency/dt 异常时直接落定终态
      if (!Number.isFinite(this.morph) || !Number.isFinite(this.velocity)) {
        this.morph = 1
        this.velocity = 0
      }
      // 收敛判定（原型每帧无条件重绘所以不需要）：在输出精度以下时钉到终态
      if (
        Math.abs(this.morph - 1) < MORPH_SETTLE_EPS &&
        Math.abs(this.velocity) < VELOCITY_SETTLE_EPS
      ) {
        this.morph = 1
        this.velocity = 0
      }
    }

    const blinking = this.blinkStart !== null
    if (!springActive && !blinking && !this.dirty && !timerFired) return null
    const frame = this.buildFrame(now)
    this.dirty = false
    return frame
  }

  /** 当前状态的一帧快照（不推进时间）。组件在 React 重渲染后用它回写 DOM。 */
  snapshot(now: number = this.now()): EngineFrame {
    return this.buildFrame(now)
  }

  private buildFrame(now: number): EngineFrame {
    // blinkScale 先算——它会在眨眼走完时清掉 blinkStart，settled 要读清理后的值
    const blink = this.consumeBlinkScale(now)
    const eyes = projectEyes(this.displayedRings(), {
      gazeX: this.gazeXValue * GAZE_X_UNITS,
      gazeY: this.gazeYValue * GAZE_Y_UNITS,
      turn: this.turnValue,
      blink,
      eyeScale: this.eyeScale
    })
    const settled = this.morph === 1 && this.velocity === 0 && this.blinkStart === null
    return { eyes, settled }
  }

  /** §4.2：眨眼进行中返回曲线值；走完清 blinkStart 回 1（镜像原型 blinkScale()） */
  private consumeBlinkScale(now: number): number {
    if (this.blinkStart === null) return 1
    const t = (now - this.blinkStart) / BLINK_DURATION_MS
    if (t >= 1) {
      this.blinkStart = null
      return 1
    }
    return blinkScaleAt(t)
  }

  /** 逐点 lerp（§4.1）：displayed = current + (target - current) · clamp(morph, 0, 1) */
  private displayedRings(): number[][][] {
    const t = clamp(this.morph, 0, 1)
    return this.currentRings.map((ring, eye) =>
      ring.map((p, i) => [
        p[0] + (this.targetRings[eye][i][0] - p[0]) * t,
        p[1] + (this.targetRings[eye][i][1] - p[1]) * t
      ])
    )
  }

  private scheduleExpression(now: number): void {
    const cadence = EXPR_CADENCE[this.stateValue]
    this.nextExpressionAt = now + cadence[0] + this.random() * (cadence[1] - cadence[0])
  }

  private scheduleBlink(now: number): void {
    const cadence = BLINK[this.stateValue]
    this.nextBlinkAt =
      cadence === null ? null : now + cadence[0] + this.random() * (cadence[1] - cadence[0])
  }
}

function copyRings(frame: ExpressionFrame): number[][][] {
  return frame.map((ring) => ring.map((p) => [p[0], p[1]]))
}
