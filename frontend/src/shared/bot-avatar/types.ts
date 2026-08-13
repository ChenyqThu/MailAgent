// 灵动 bot 头像 —— 共享类型出口。
// 数据/引擎层（shapes/colors/states/engine/ticker/geometry/surfaces）不 import React，
// 本文件同样纯类型。BotShape/BotColor/BotState 的权威定义在各自数据文件（值与类型
// 同源，供 parity 闸抽取），这里只做转出口，消费方可统一从 types 拿。

import type { BotColor } from './colors'
import type { BotShape } from './shapes'

export type { BotColor } from './colors'
export type { BotShape, BotShapeDef } from './shapes'
export type { BotState } from './states'
export type { BodyNodeDef, Expression, EyeMotion, BodyMotion } from './geometry'
export type { SurfaceConfig, SurfaceType } from './surfaces'

/**
 * avatar_json 的第三种 kind。0813 成品目录化后 shape 词表为 9 个 lab 成品形状
 * （对应 lab 10 成品：Strobi 与 Grok bot 视觉不可分辨、owner 拍板并入 sphere；
 * wire.py 白名单 + parity 闸同源）；组合身体是形状名在 TS 侧的派生数据
 * （SHAPES[shape].nodes），wire 结构不变仍是 {type,shape,color}。v1 8 形、
 * v2 退役 4 形（cylinder/diamond/mickey/cursor）与 strobi 经 shapes.ts
 * LEGACY_BOT_SHAPE_MAP 读侧换脸。
 */
export interface BotAvatarBotConfig {
  type: 'bot'
  shape: BotShape
  color: BotColor
}

/** 引擎每帧对单只眼的输出——path 点已含姿态/透视/眨眼，组件只做 setAttribute */
export interface EyeFrame {
  /** 'M x y L … Z' 折线闭合 path（画布中心坐标系） */
  d: string
  /** 眼睛随头转到背面（法线和 ≤ 0）时隐藏 */
  visible: boolean
}

export interface EngineFrame {
  /** 头部轮廓 path（同一串同时写进眼睛的 clipPath） */
  head: string
  /** 背层 path（头后附属曲面；无组合身体的形状为空数组） */
  back: readonly string[]
  /** 前层 path（转到头前的附属曲面，渲染在眼睛之上；多数帧为空） */
  front: readonly string[]
  eyes: readonly EyeFrame[]
  /** ambient 身体漂移的整体平移（作用在 motion 层 transform 上） */
  offsetX: number
  offsetY: number
  /** 过渡已收敛、无眨眼、无 ambient —— ticker 据此跳帧（settle 后零重绘） */
  settled: boolean
}
