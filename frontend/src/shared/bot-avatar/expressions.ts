// 灵动 bot 头像 v2 —— 25 表情参数表。
// 数据移植自 avatar-lab `src/features/avatar/presets.ts` 的 calibrated 表（AGPL-3.0
// 上游，出处注记见 frontend/docs/bot-avatar.md）。这替换了 v1 的 expressions.json
// （烘焙 48 点轮廓，描摹自 Grok 对外发布页——该红旗随本次换代解除）。
// 表情索引 0-24 的语义与 v1 完全同源（states.ts POOLS 的索引引用不变）：
// 同一套表情，v2 用 15 个参数（头部姿态 + 双眼几何）参数化重制。
// 每行：[headX, headY, headZ, widthL, widthR, heightL, heightR, spacing,
//        eyeLatitude(positionY 双眼同值), leftAngle, rightAngle]
// 改任何一行都在改「某个表情长什么样」——所有引用该索引的状态池同时变脸，先过设计评审。

import type { Expression } from './geometry'

const calibrated: number[][] = [
  [7.3, 27.8, -16.1, 24.2, 27.6, 38.9, 40.7, 54.3, -20.5, 0, 0],
  [-35.6, 0.7, -8.5, 29.4, 27.3, 49.5, 49.8, 57.7, -42, 0, 0],
  [-36.2, 13.1, 15.5, 44.3, 51.3, 74.2, 76, 68.7, -40.7, 0, 0],
  [15.6, -16.5, -11.3, 54, 51, 49.6, 48.5, 70.9, 30.1, 0, 0],
  [3.4, 13, 8.9, 42.6, 44, 17.3, 16, 57.9, 4.9, 0, 0],
  [-17.7, -1.4, -8.8, 29.5, 19.2, 51.6, 41.9, 56.3, 0, 0, 90],
  [14.8, 14.5, 5.5, 22.9, 22.2, 32.4, 33.4, 50.9, 39.2, 0, 0],
  [25.7, 16.5, -13.5, 48.5, 48.3, 33.5, 33, 53.3, 41.3, 61.3, -80],
  [-22.8, -15.9, 6.2, 44.5, 43.9, 32.3, 24.6, 54.9, -42, -60.9, 69.2],
  [-11.6, 8.3, -12.7, 42.5, 22.1, 41.8, 22.2, 61.7, 12.3, 0, 0],
  [20.3, 7, 8.7, 30.2, 28.1, 48.8, 49.2, 56.8, 39.9, 0, 0],
  [17.5, -15.2, -8.7, 51, 49.2, 75.3, 73.4, 70.2, 41.6, 0, 0],
  [-10.4, 15.2, 11.8, 50.6, 51.6, 50, 50.7, 69.5, 16.7, 0, 0],
  [-6, -7.7, -9.4, 43.6, 42.8, 15.5, 18.1, 57.9, 3.5, 0, 0],
  [0.2, -3.1, 9, 29.6, 16.8, 51.5, 41.3, 56.4, -7.8, 0, 90],
  [-16.2, 38.4, 2.4, 23.7, 26.2, 32.7, 34.6, 53.9, -41.1, 0, 0],
  [3.5, -16.1, 15.8, 51, 48.5, 34.9, 33, 55.1, 41.9, 80, -62.2],
  [-17.3, 11.2, -9.1, 24.2, 44.5, 44.5, 32.2, 55, -36.5, 18.5, 67.9],
  [-0.7, 3.6, 12.2, 42.1, 22.2, 41.7, 22.1, 60.4, -9.1, 0, 0],
  [-25.3, -12.4, -13.3, 30.5, 26.8, 49.9, 48.8, 56.2, -35.8, 0, 0],
  [-41.1, 20.2, 18.8, 44.6, 53, 74.9, 77.8, 70.8, -40.6, 0, 0],
  [-14.6, -12.5, -16.1, 51.4, 50.5, 50.1, 49.4, 69, -20, 0, 0],
  [10, 2.7, 8.8, 42.9, 43.3, 16.4, 17.8, 57.9, 2.7, 0, 0],
  [-17.8, 10, -6.3, 28.8, 17.3, 51.4, 42.7, 56.6, -9.8, 0, 90],
  [-29.6, 7.5, 10.1, 21.5, 23.2, 32, 33.5, 51.2, -37.4, 0, 0]
]

/** 25 个表情（索引与 states.ts POOLS 引用同源；tests/shared/bot-avatar 钉结构） */
export const EXPRESSIONS: readonly Expression[] = calibrated.map(
  (
    [
      headX,
      headY,
      headZ,
      widthLeft,
      widthRight,
      heightLeft,
      heightRight,
      spacing,
      latitude,
      leftAngle,
      rightAngle
    ],
    index
  ) => ({
    id: `expression-${String(index).padStart(2, '0')}`,
    headX,
    headY,
    headZ,
    widthLeft,
    widthRight,
    heightLeft,
    heightRight,
    spacing,
    positionXLeft: 0,
    positionXRight: 0,
    positionYLeft: latitude,
    positionYRight: latitude,
    leftAngle,
    rightAngle,
    perspective: 1
  })
)

/** 中性表情（正视、双眼对称）——引擎无状态兜底与测试基线用 */
export const NEUTRAL_EXPRESSION: Expression = {
  id: 'expression-neutral',
  headX: 0,
  headY: 0,
  headZ: 0,
  widthLeft: 20,
  widthRight: 20,
  heightLeft: 50,
  heightRight: 50,
  spacing: 35,
  positionXLeft: 0,
  positionXRight: 0,
  positionYLeft: -7,
  positionYRight: -7,
  leftAngle: 0,
  rightAngle: 0,
  perspective: 1
}
