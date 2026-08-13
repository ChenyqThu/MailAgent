// 灵动 bot 头像 v2 —— ambient 空闲微动（v1 无此能力：settle 后完全静止）。
// 公式移植自 avatar-lab `src/features/avatar/ambientMotion.ts`（AGPL-3.0 上游），
// 一处结构性偏离：avatar-lab 的动效模式是**每表情**作者态字段，MailAgent 改为
// **每状态**产品态配置（states.ts AMBIENT 表）——ambient 是「这个 agent 状态下
// 该不该显得活着」的产品语义，不该跟着单个表情走。
// 全部是以 elapsedMs 为自变量的纯函数（确定性 hash 噪声，无内部随机态），
// 同一 (expression, elapsed) 恒同输出 —— 测试可回放。

import type { BodyMotion, Expression, EyeMotion } from './geometry'

const smoothstep = (value: number): number => value * value * (3 - 2 * value)

/** 确定性伪随机（sin hash）：整数格点 → [-1, 1] */
const hash = (value: number): number => {
  const raw = Math.sin(value * 127.1 + 311.7) * 43758.5453
  return (raw - Math.floor(raw)) * 2 - 1
}

/** 每个表情有自己的噪声相位（不同表情的漂移不同步，多实例同屏不像复制品） */
const expressionSeed = (expression: Expression): number =>
  expression.headX * 0.71 + expression.headY * 1.13 + expression.headZ * 1.37

/** 格点间平滑插值噪声（slowDrift 的基元） */
const smoothNoise = (elapsedMs: number, axis: number, seed: number, interval: number): number => {
  const progress = elapsedMs / interval
  const step = Math.floor(progress)
  const blend = smoothstep(progress - step)
  const previous = hash(step * 3 + axis + seed)
  const next = hash((step + 1) * 3 + axis + seed)
  return previous + (next - previous) * blend
}

/** 眼睛微扫视：~1.1s 一跳，9% 时间窗内快速移动，带时间扭曲防机械感 */
const saccade = (elapsedMs: number, axis: number, seed: number): number => {
  const interval = 1100
  const warpedTime = elapsedMs + Math.sin(elapsedMs / 1700 + seed) * 280
  const step = Math.floor(warpedTime / interval)
  const progress = (((warpedTime % interval) + interval) % interval) / interval
  const blend = smoothstep(Math.min(progress / 0.09, 1))
  const previous = hash((step - 1) * 2 + axis + seed)
  const next = hash(step * 2 + axis + seed)
  const fadeIn = Math.min(elapsedMs / 240, 1)
  return (previous + (next - previous) * blend) * fadeIn
}

/** 身体平移漂移（作用在 SVG motion 层 translate 上，不进表情参数） */
export function ambientBodyOffset(
  expression: Expression,
  bodyMotion: BodyMotion,
  elapsedMs: number
): { x: number; y: number } {
  const seed = expressionSeed(expression)
  if (bodyMotion === 'slowDrift') {
    return {
      x: smoothNoise(elapsedMs, 3, seed, 2900) * 1.45,
      y: smoothNoise(elapsedMs, 4, seed, 3700) * 1.1
    }
  }
  if (bodyMotion === 'shake') {
    const time = elapsedMs / 1000
    return {
      x: (Math.sin(time * 31) + Math.sin(time * 53) * 0.45) * 1.35,
      y: (Math.sin(time * 37) + Math.sin(time * 61) * 0.4) * 1.1
    }
  }
  return { x: 0, y: 0 }
}

/** 把 ambient 微动叠加进表情参数（眼睛位置抖动 + 头部角度漂移），返回新对象 */
export function applyAmbientMotion(
  expression: Expression,
  eyeMotion: EyeMotion,
  bodyMotion: BodyMotion,
  elapsedMs: number
): Expression {
  const next = { ...expression }
  const seed = expressionSeed(expression)

  if (eyeMotion === 'microSaccades') {
    const x = saccade(elapsedMs, 0, seed) * 1.5
    const y = saccade(elapsedMs, 1, seed) * 0.9
    next.positionXLeft += x
    next.positionXRight += x
    next.positionYLeft += y
    next.positionYRight += y
  } else if (eyeMotion === 'shake') {
    const time = elapsedMs / 1000
    const x = (Math.sin(time * 47) + Math.sin(time * 71) * 0.45) * 1.2
    const y = (Math.sin(time * 59) + Math.sin(time * 83) * 0.4) * 0.8
    next.positionXLeft += x
    next.positionXRight += x
    next.positionYLeft += y
    next.positionYRight += y
  }

  if (bodyMotion === 'slowDrift') {
    next.headX += smoothNoise(elapsedMs, 0, seed, 2600) * 0.8
    next.headY += smoothNoise(elapsedMs, 1, seed, 3300) * 1.15
    next.headZ += smoothNoise(elapsedMs, 2, seed, 4100) * 0.45
  } else if (bodyMotion === 'shake') {
    const time = elapsedMs / 1000
    next.headX += (Math.sin(time * 31) + Math.sin(time * 53) * 0.45) * 1.15
    next.headY += (Math.sin(time * 37) + Math.sin(time * 61) * 0.4) * 1.35
    next.headZ += Math.sin(time * 43) * 0.7
  }

  return next
}
