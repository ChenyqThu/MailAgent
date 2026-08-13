// 灵动 bot 头像 —— 共享类型出口。
// 数据/引擎层（shapes/colors/states/engine/ticker）不 import React，本文件同样纯类型。
// BotShape/BotColor/BotState 的权威定义在各自数据文件（值与类型同源，供 WP4 parity
// 闸抽取），这里只做转出口，消费方可统一从 types 拿。

import type { BotColor } from './colors'
import type { BotShape } from './shapes'

export type { BotColor } from './colors'
export type { BotShape } from './shapes'
export type { BotState } from './states'

/** 单个轮廓点 [x, y]（viewBox -15 -15 259 259 坐标系，两位小数） */
export type BotPoint = readonly [number, number]

/** 单只眼的完整轮廓多边形（点数恒 48 —— morph 逐点插值的前提，测试钉死） */
export type EyeRing = readonly BotPoint[]

/** 一个表情 = 两只眼的轮廓；大小/位置/旋转差异全部烘焙在点里 */
export type ExpressionFrame = readonly [EyeRing, EyeRing]

/**
 * avatar_json 的第三种 kind（prd §5.1）。WP1 只定前端类型；
 * wire.py 白名单分支与 parity 闸在 WP4 落地。
 */
export interface BotAvatarBotConfig {
  type: 'bot'
  shape: BotShape
  color: BotColor
}

/** 引擎每帧对单只眼的输出——组件只做 setAttribute，不参与任何几何计算 */
export interface EyeFrame {
  /** 'M x y L … Z' 折线闭合 path */
  d: string
  /** `translate(x y) scale(sx sy) translate(-cx -cy)`（绕眼心缩放） */
  transform: string
  /** 球面转到脑后（depth ≤ 0.02）时隐藏（grokbot-engine-analysis.md §4.4） */
  hidden: boolean
}

export interface EngineFrame {
  eyes: readonly EyeFrame[]
  /** morph 已收敛且无眨眼进行中 —— ticker 据此跳帧（settle 后零重绘，prd §4.6-1） */
  settled: boolean
}
