// 灵动 bot 头像 v2 —— 形状词表：8 种 3D 参数曲面原语（v1 是 8 个手绘 2D path）。
// 每个形状 = 一份 SurfaceConfig（surfaces.ts 出厂尺寸），身体轮廓/眼睛贴合全部
// 由 geometry.ts 按曲面实时求出 —— 不再有 eyeAnchor 手工调参层。
// 本文件是跨语言 parity 闸（TS ↔ src/reports/wire.py 白名单，
// tests/config/test_bot_avatar_vocab_parity.py）的抽取源，
// BOT_AVATAR_SHAPES 保持 `[...] as const` 字面量形式，勿改写成动态构造。

import { surfacePresets } from './surfaces'
import type { SurfaceConfig } from './surfaces'

export const BOT_AVATAR_SHAPES = [
  'sphere',
  'capsule',
  'cylinder',
  'cone',
  'cube',
  'diamond',
  'mickey',
  'cursor'
] as const

export type BotShape = (typeof BOT_AVATAR_SHAPES)[number]

/** SVG viewBox（v2 坐标系：画布中心 (0,0)，几何层全部以此为基） */
export const BOT_VIEW_BOX = '-150 -150 300 300'

/** 形状 → 曲面参数。当前恒等引用出厂 preset；要给某形状调身材改这里（勿动 preset） */
export const SHAPES: Record<BotShape, SurfaceConfig> = {
  sphere: surfacePresets.sphere,
  capsule: surfacePresets.capsule,
  cylinder: surfacePresets.cylinder,
  cone: surfacePresets.cone,
  cube: surfacePresets.cube,
  diamond: surfacePresets.diamond,
  mickey: surfacePresets.mickey,
  cursor: surfacePresets.cursor
}

/**
 * v1 8 形 → v2 8 形的读侧双射（agentAvatarIdentity.ts 消费）。
 * 存量 avatar_json 里的 v1 形状名渲染期换脸、不迁移不回写；写侧（wire.py 白名单
 * 与编辑器）只认 v2 词表。双射保证 v1 时代两个不同形状的 agent 换代后仍不同脸。
 */
export const LEGACY_BOT_SHAPE_MAP: Record<string, BotShape> = {
  blob: 'sphere',
  capsule: 'capsule',
  squircle: 'cube',
  egg: 'cylinder',
  wedge: 'cone',
  hex: 'diamond',
  cloud: 'mickey',
  teardrop: 'cursor'
}

/** 每形状的背层复合 path 数（mickey 双耳 / cursor 锥体）；组件据此渲染固定槽位 */
export const BACK_PATH_COUNT: Record<BotShape, number> = {
  sphere: 0,
  capsule: 0,
  cylinder: 0,
  cone: 0,
  cube: 0,
  diamond: 0,
  mickey: 2,
  cursor: 1
}
