// 灵动 bot 头像 v2 —— framework-agnostic 引擎（零 React / 零 GSAP / 零外部依赖）。
// 渲染管线自 v1 的「烘焙轮廓 + 弹簧 morph」换代为「参数化表情 + 3D 姿态投影」
// （参照 avatar-lab standalone runtime，AGPL-3.0 上游，出处见 frontend/docs/bot-avatar.md）：
//   过渡 = 15 个表情参数逐字段插值（spring/smooth/snappy 缓动 + 角度就近解析），
//   每帧经 poseFromExpression → renderAvatar 重投影出头/眼 path。
// 保留 v1 的三条工程纪律（勿回退）：
//   1. setState 对相同状态是 no-op（React 重渲染不得重置表情/重排定时器）；
//   2. 定时用 nextAt 时间戳由 tick 检查，不用 setTimeout —— 时间可注入，测试确定性，
//      且挂在共享 ticker 上时暂停/恢复天然一致；
//   3. settle 语义：无事可做时 tick 返回 null，空闲零重绘 —— v2 的新边界是
//      ambient 活跃的状态永不 settle，由引擎内部 30fps 限频兜功耗。

import { ambientBodyOffset, applyAmbientMotion } from './ambient'
import { EXPRESSIONS } from './expressions'
import {
  clamp,
  expressionFields,
  nearestEquivalentAngle,
  poseFromExpression,
  renderAvatar
} from './geometry'
import type { Expression } from './geometry'
import { AMBIENT, BLINK, EXPR_CADENCE, POOLS } from './states'
import type { BotState } from './states'
import type { BotShapeDef } from './shapes'
import type { EngineFrame } from './types'

export { EXPRESSIONS } from './expressions'

// ── 时序常量 ────────────────────────────────────────────────────────────────
/** 状态切换的过渡（应激感：短 + spring 回弹） */
const STATE_SWITCH_TRANSITION_MS = 420
const STATE_SWITCH_EASE: TransitionEase = 'spring'
/** 池内表情轮换的过渡（闲适感：smooth） */
const POOL_ROTATE_TRANSITION_MS = 500
const POOL_ROTATE_EASE: TransitionEase = 'smooth'
/**
 * 状态最短驻留（去抖闸，0813 owner 反馈「刚切换中状态又变了就跳」）：
 * 驻留未满时到达的新状态只**排队**（队列仅保留最新目标，不播中间状态），
 * 期满由 tick 一次性切到最新目标；目标折回当前状态则撤销排队（净零切换）。
 * 取 600ms 的依据：≥ 状态切换过渡 420ms（spring 在 p=1 处 exp(-6)≈0.25% 已收敛）
 * + ~180ms 观感余量 —— 保证上一次转头至少完整播完才允许下一次重定向；同时
 * < 最短表情轮换节奏（searching 1000ms）与 showcase 巡演 2400ms，不会系统性
 * 顶掉池内轮换/巡演节拍。状态展示滞后上限即 600ms（驻留是产品拍板的可接受代价）。
 * 模块内常量，勿 env 化 / 勿做成配置项。
 */
const STATE_MIN_DWELL_MS = 600
/** 手动 blink()（无状态眨眼档时）的时长兜底 */
const DEFAULT_BLINK_DURATION_MS = 280
/** ambient 活跃时的重绘上限（30fps —— avatar-lab runtime 同款节流） */
const AMBIENT_FRAME_INTERVAL_MS = 1000 / 30

// ── gaze 常量（v2 重实现：v1 是纯眼睛平移，v2 头部朝向 + 眼睛偏移叠加）─────────
/** gazeX ∈ [-1,1] → 头部 yaw（度） */
const GAZE_HEAD_YAW_DEG = 10
/** gazeY ∈ [-1,1] → 头部 pitch（度；负号 = 指针在下方时低头） */
const GAZE_HEAD_PITCH_DEG = 7
/** gaze → 眼睛在脸面坐标内的平移 */
const GAZE_EYE_X_UNITS = 5
const GAZE_EYE_Y_UNITS = 3.5

export type TransitionEase = 'spring' | 'smooth' | 'snappy'

/** 过渡缓动（avatar-lab runtime easeProgress 逐字）；spring 会过冲 >1 产生回弹 */
export function easeProgress(progress: number, ease: TransitionEase): number {
  if (ease === 'smooth') return progress * progress * (3 - 2 * progress)
  if (ease === 'snappy') return 1 - (1 - progress) ** 3
  return 1 - Math.exp(-6 * progress) * Math.cos(8 * progress)
}

/**
 * 眨眼曲线（avatar-lab runtime：闭眼 42% 二次加速、睁眼 58% 二次减速）。
 * t = 眨眼进度 0..1；返回值进 renderAvatar 的 blink 参数（1 = 全睁）。
 * v1 是线性 + scaleY 压缩；v2 配合眼几何的高度插值（5px 下限），眨眼中眼形保持圆角。
 */
export function blinkScaleAt(t: number): number {
  if (t <= 0.42) {
    const closeProgress = t / 0.42
    return 1 - closeProgress * closeProgress
  }
  const openProgress = (t - 0.42) / 0.58
  return 1 - (1 - openProgress) ** 2
}

/** 目标表情的角度族折到与当前值就近的等价角（防转头绕远路） */
function resolveTargetExpression(target: Expression, current: Expression): Expression {
  return {
    ...target,
    headX: nearestEquivalentAngle(target.headX, current.headX),
    headY: nearestEquivalentAngle(target.headY, current.headY),
    headZ: nearestEquivalentAngle(target.headZ, current.headZ),
    leftAngle: nearestEquivalentAngle(target.leftAngle, current.leftAngle),
    rightAngle: nearestEquivalentAngle(target.rightAngle, current.rightAngle)
  }
}

/** 逐字段插值（eased 可 >1：spring 过冲直接外推，几何层天然吃得下） */
function lerpExpression(from: Expression, to: Expression, eased: number): Expression {
  const out = { ...from }
  for (const field of expressionFields) {
    out[field] = from[field] + (to[field] - from[field]) * eased
  }
  return out
}

// ── 静态档 ──────────────────────────────────────────────────────────────────

/** 静态帧缓存：列表位点数百个同款 22px 实例只算一次几何（key = 形状定义身份 × 表情）。
 *  组合身体的附属曲面也在缓存帧内（SHAPES 的 def 是模块级单例，WeakMap 键稳定），
 *  静态位点对复合形状仍是「同 shape×表情只算一次几何」。 */
const staticFrameCache = new WeakMap<BotShapeDef, Map<number, EngineFrame>>()

/**
 * 静态档一帧：表情原样、无过渡/gaze/眨眼/ambient。
 * 列表位点与 reduced-motion 回退都走这里 —— 不建引擎实例、零定时器。
 */
export function staticFrame(expressionIndex: number, shapeDef: BotShapeDef): EngineFrame {
  let perShape = staticFrameCache.get(shapeDef)
  if (!perShape) {
    perShape = new Map()
    staticFrameCache.set(shapeDef, perShape)
  }
  const cached = perShape.get(expressionIndex)
  if (cached) return cached
  const geometry = renderAvatar(
    poseFromExpression(EXPRESSIONS[expressionIndex]),
    shapeDef.primary,
    1,
    shapeDef.nodes
  )
  const frame: EngineFrame = {
    head: geometry.headPath,
    back: geometry.backPaths,
    front: geometry.frontPaths,
    eyes: [
      { d: geometry.leftPath, visible: geometry.leftVisible },
      { d: geometry.rightPath, visible: geometry.rightVisible }
    ],
    offsetX: 0,
    offsetY: 0,
    settled: true
  }
  perShape.set(expressionIndex, frame)
  return frame
}

// ── 引擎 ────────────────────────────────────────────────────────────────────

export interface BotEngineOptions {
  /** 形状定义（shapes.ts SHAPES[shape]：主曲面 + 组合身体） */
  surface: BotShapeDef
  initialState?: BotState
  /** 随机源注入口 —— 测试确定性；默认 Math.random */
  random?: () => number
  /** 时钟注入口（毫秒，performance.now 时基）；用于构造期/setState/手动 blink 的排程基点 */
  now?: () => number
}

interface TransitionState {
  from: Expression
  to: Expression
  startedAt: number
  durationMs: number
  ease: TransitionEase
}

export class BotFaceEngine {
  private readonly surface: BotShapeDef
  private readonly random: () => number
  private readonly now: () => number

  private stateValue: BotState
  private expressionValue: number
  /** 过渡终点落定后的「当前表情」（过渡中显示帧由 transition 插值得出） */
  private displayed: Expression
  private transition: TransitionState | null = null
  private blinkStart: number | null = null
  private blinkDurationMs = DEFAULT_BLINK_DURATION_MS
  private gazeXValue = 0
  private gazeYValue = 0
  /** gaze 变过但还没出过帧；首帧也算脏（挂载即产出一帧） */
  private dirty = true
  private nextExpressionAt: number | null = null
  private nextBlinkAt: number | null = null
  /** 当前状态的进入时刻 —— 驻留闸基点（构造/每次提交切换时重置） */
  private stateEnteredAt: number
  /** 驻留期内到达的最新目标状态；只保留最新（去抖，不是补偿），期满由 tick 提交 */
  private pendingState: BotState | null = null
  /** ambient 噪声的时间基点（ambient 配置变化时重置，防状态切换瞬间跳变） */
  private ambientStartedAt: number
  private lastAmbientRenderAt = 0

  constructor(opts: BotEngineOptions) {
    this.surface = opts.surface
    this.random = opts.random ?? Math.random
    this.now =
      opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))
    this.stateValue = opts.initialState ?? 'idle'
    // 直接以池首表情落定（无 boot 过渡），镜像 v1 构造语义
    const head = POOLS[this.stateValue][0]
    this.expressionValue = head
    this.displayed = { ...EXPRESSIONS[head] }
    const t = this.now()
    this.ambientStartedAt = t
    this.stateEnteredAt = t
    // 排程顺序：先眨眼后表情（随机源消费顺序是测试契约的一部分，镜像 v1）
    this.scheduleBlink(t)
    this.scheduleExpression(t)
  }

  get state(): BotState {
    return this.stateValue
  }

  get expression(): number {
    return this.expressionValue
  }

  /**
   * 状态切换（经驻留闸）：当前状态驻留满 STATE_MIN_DWELL_MS 才立即向池首过渡
   * （spring）+ 重排两类定时；驻留未满则排队（只保留最新目标），期满由 tick 提交
   * —— 快速抖动（thinking↔calling-tool↔writing）不再逐次重定向甩头。
   */
  setState(next: BotState): void {
    // 同态重设是 no-op —— React 重渲染/effect 重跑不得重启过渡或重排定时；
    // 驻留期内对同一排队目标重设同样 no-op（不得推迟提交时刻）
    if (this.pendingState !== null ? next === this.pendingState : next === this.stateValue) return
    // 目标折回当前已显示状态：撤销排队即可，净零切换（不播被跳过的中间态）
    if (next === this.stateValue) {
      this.pendingState = null
      return
    }
    const t = this.now()
    if (t - this.stateEnteredAt < STATE_MIN_DWELL_MS) {
      this.pendingState = next
      return
    }
    this.pendingState = null
    this.commitState(next, t)
  }

  /** 真正执行状态切换（setState 立即路径与 tick 驻留到期路径共用）；t = 提交时刻 */
  private commitState(next: BotState, t: number): void {
    const prevAmbient = AMBIENT[this.stateValue]
    this.stateValue = next
    this.stateEnteredAt = t
    this.beginTransition(POOLS[next][0], STATE_SWITCH_TRANSITION_MS, STATE_SWITCH_EASE, t)
    const nextAmbient = AMBIENT[next]
    if (prevAmbient.eyes !== nextAmbient.eyes || prevAmbient.body !== nextAmbient.body) {
      this.ambientStartedAt = t
    }
    this.scheduleBlink(t)
    this.scheduleExpression(t)
  }

  /** 手动切换表情（编辑器/测试）：从「当前显示帧」起过渡 */
  selectExpression(index: number): void {
    this.beginTransition(index, POOL_ROTATE_TRANSITION_MS, POOL_ROTATE_EASE)
  }

  /** gaze ∈ [-1,1]²，越界收边；头部朝向 + 眼睛偏移在 buildFrame 里叠加 */
  setGaze(x: number, y: number): void {
    const nx = clamp(x, -1, 1)
    const ny = clamp(y, -1, 1)
    if (nx !== this.gazeXValue || ny !== this.gazeYValue) {
      this.gazeXValue = nx
      this.gazeYValue = ny
      this.dirty = true
    }
  }

  /** 手动触发一次眨眼（已在眨则忽略 —— 长按连点不得冻在闭眼） */
  blink(): void {
    if (this.blinkStart === null) {
      this.blinkStart = this.now()
      this.blinkDurationMs = BLINK[this.stateValue]?.[2] ?? DEFAULT_BLINK_DURATION_MS
    }
  }

  /**
   * 推进一帧。返回 null = 本帧无事可做（过渡收敛、无眨眼、无脏位、无到期定时、
   * ambient 静止或未到 30fps 节拍），共享 ticker 据此跳过 DOM 写入。
   */
  tick(now: number): EngineFrame | null {
    // 到期定时（v1 纪律：tick 检查 nextAt，不用 setTimeout）
    let timerFired = false
    // 驻留闸到期：一次性切到排队的最新目标（提交在过期定时检查之前 ——
    // commitState 会重排两类定时，新排的 nextAt 必在未来，本 tick 不会连环触发）
    if (this.pendingState !== null && now - this.stateEnteredAt >= STATE_MIN_DWELL_MS) {
      const next = this.pendingState
      this.pendingState = null
      this.commitState(next, now)
      timerFired = true
    }
    if (this.nextExpressionAt !== null && now >= this.nextExpressionAt) {
      const pool = POOLS[this.stateValue]
      const alternatives = pool.filter((i) => i !== this.expressionValue)
      // 单元素池（如 waking）没有替代帧：重选池首（同帧过渡，视觉静止）
      this.beginTransition(
        alternatives.length
          ? alternatives[Math.floor(this.random() * alternatives.length)]
          : pool[0],
        POOL_ROTATE_TRANSITION_MS,
        POOL_ROTATE_EASE
      )
      this.scheduleExpression(now)
      timerFired = true
    }
    if (this.nextBlinkAt !== null && now >= this.nextBlinkAt) {
      const cadence = BLINK[this.stateValue]
      this.blinkStart = now
      this.blinkDurationMs = cadence?.[2] ?? DEFAULT_BLINK_DURATION_MS
      this.scheduleBlink(now)
      timerFired = true
    }

    // 过渡落定检查（提交发生在 tick，snapshot 不可变）
    if (this.transition && now - this.transition.startedAt >= this.transition.durationMs) {
      this.displayed = this.transition.to
      this.transition = null
      timerFired = true // 落定那一帧必须产出（钉住终态）
    }
    const transitionActive = this.transition !== null

    // 眨眼走完清场（同样只在 tick 提交）
    let blinking = false
    if (this.blinkStart !== null) {
      if (now - this.blinkStart >= this.blinkDurationMs) {
        this.blinkStart = null
        timerFired = true // 睁眼终态帧
      } else {
        blinking = true
      }
    }

    const ambient = AMBIENT[this.stateValue]
    const ambientActive = ambient.eyes !== 'none' || ambient.body !== 'none'

    let needFrame = transitionActive || blinking || this.dirty || timerFired
    if (!needFrame && ambientActive) {
      needFrame = now - this.lastAmbientRenderAt >= AMBIENT_FRAME_INTERVAL_MS
    }
    if (!needFrame) return null

    if (ambientActive) this.lastAmbientRenderAt = now
    const frame = this.buildFrame(now)
    this.dirty = false
    return frame
  }

  /** 当前状态的一帧快照（不推进定时/不提交状态）。组件在 React 重渲染后用它回写 DOM。 */
  snapshot(now: number = this.now()): EngineFrame {
    return this.buildFrame(now)
  }

  private buildFrame(now: number): EngineFrame {
    let expr = this.displayedExpressionAt(now)

    const ambient = AMBIENT[this.stateValue]
    const ambientActive = ambient.eyes !== 'none' || ambient.body !== 'none'
    const ambientElapsed = now - this.ambientStartedAt
    // ambient 相位以「落定表情」为种子（相位稳定），叠加作用在显示帧上
    const seedExpression = this.displayed
    if (ambientActive) {
      expr = applyAmbientMotion(expr, ambient.eyes, ambient.body, ambientElapsed)
    }

    // gaze：头部朝向 + 眼睛偏移叠加（additive，不与表情/ambient 冲突）
    if (this.gazeXValue !== 0 || this.gazeYValue !== 0) {
      expr = { ...expr }
      expr.headY += this.gazeXValue * GAZE_HEAD_YAW_DEG
      expr.headX -= this.gazeYValue * GAZE_HEAD_PITCH_DEG
      const eyeX = this.gazeXValue * GAZE_EYE_X_UNITS
      const eyeY = this.gazeYValue * GAZE_EYE_Y_UNITS
      expr.positionXLeft += eyeX
      expr.positionXRight += eyeX
      expr.positionYLeft += eyeY
      expr.positionYRight += eyeY
    }

    const blink = this.blinkValueAt(now)
    const geometry = renderAvatar(
      poseFromExpression(expr),
      this.surface.primary,
      blink,
      this.surface.nodes
    )
    const offset = ambientActive
      ? ambientBodyOffset(seedExpression, ambient.body, ambientElapsed)
      : { x: 0, y: 0 }

    const settled = this.transition === null && this.blinkStart === null && !ambientActive
    return {
      head: geometry.headPath,
      back: geometry.backPaths,
      front: geometry.frontPaths,
      eyes: [
        { d: geometry.leftPath, visible: geometry.leftVisible },
        { d: geometry.rightPath, visible: geometry.rightVisible }
      ],
      offsetX: offset.x,
      offsetY: offset.y,
      settled
    }
  }

  /** 过渡插值出「此刻显示的表情」；无过渡时即落定表情（纯函数，不提交） */
  private displayedExpressionAt(now: number): Expression {
    if (!this.transition) return this.displayed
    const linear = clamp((now - this.transition.startedAt) / this.transition.durationMs, 0, 1)
    if (linear >= 1) return this.transition.to
    const eased = easeProgress(linear, this.transition.ease)
    return lerpExpression(this.transition.from, this.transition.to, eased)
  }

  private blinkValueAt(now: number): number {
    if (this.blinkStart === null) return 1
    const t = (now - this.blinkStart) / this.blinkDurationMs
    if (t >= 1) return 1
    return blinkScaleAt(clamp(t, 0, 1))
  }

  /** 从「当前显示帧」起向目标表情过渡（角度就近解析）；
   *  startedAt 可显式传入（tick 驻留到期路径用 tick 的 now，保持时基一致） */
  private beginTransition(
    index: number,
    durationMs: number,
    ease: TransitionEase,
    startedAt: number = this.now()
  ): void {
    const from = this.displayedExpressionAt(startedAt)
    const to = resolveTargetExpression(EXPRESSIONS[index], from)
    this.expressionValue = index
    this.displayed = to
    this.transition = { from, to, startedAt, durationMs, ease }
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
