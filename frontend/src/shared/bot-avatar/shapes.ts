// 灵动 bot 头像 —— 形状注册表。
// v1 只有 blob（原型现成 body path）；WP2 扩到 8 形（capsule/squircle/egg/wedge/hex/cloud/teardrop）。
// 坐标系：viewBox `-15 -15 259 259`，头中心 (114.2705, 114.27)，球面半径 105
// （grokbot-engine-analysis.md §2）。眼睛必须 clip 在 body path 内 —— 转头时眼睛
// 滑出边缘被裁掉，是 3D 错觉的关键一环，任何新形状都要提供可作 clipPath 的闭合 path。
// 本文件是 WP4 跨语言 parity 闸（TS ↔ src/reports/wire.py 白名单）的抽取源，
// BOT_SHAPES 保持 `[...] as const` 字面量形式，勿改写成动态构造。

export const BOT_SHAPES = ['blob'] as const

export type BotShape = (typeof BOT_SHAPES)[number]

/** SVG viewBox（照抄原型 —— EXPRESSIONS 轮廓点全部落在这套坐标系里，勿改） */
export const BOT_VIEW_BOX = '-15 -15 259 259'

/** body path 的横向跨度；flipX 镜像 = `translate(SPAN 0) scale(-1 1)`（原型 render()） */
export const BOT_BODY_SPAN = 228.541

/**
 * 每形状的眼睛布局参数，语义来自原型 SHAPES tuple `[name,x,y,sx,sy,eyeScale,turnAt,…]`
 * （grokbot-engine-analysis.md §3/§6 —— 原型里形状目录是假的，tuple 是为真实现预留）。
 * WP2 调参依据：防重叠约束 eyeScale ≤ (distance-5)/(halfWidth₁+halfWidth₂)。
 */
export interface BotEyeAnchor {
  offsetX: number
  offsetY: number
  bodyScaleX: number
  bodyScaleY: number
  /** 眼睛整体缩放（进引擎的 baseScale 因子） */
  eyeScale: number
  /** 该形状是否参与转头（扁形转头会穿帮时关掉） */
  turnAt: boolean
}

export interface BotShapeDef {
  /** 闭合 body path，同时用作眼睛的 clipPath */
  path: string
  eyeAnchor: BotEyeAnchor
}

export const SHAPES: Record<BotShape, BotShapeDef> = {
  blob: {
    // 原型唯一真实生效的 body path（index.html #body-path，1:1 照抄）
    path: 'M228.541 114.228C228.541 130.133 225.184 145.994 218.738 160.534C212.674 174.217 203.904 186.669 193.065 196.988C155.933 232.34 99.497 238.596 55.5255 212.24C45.097 205.99 35.6851 198.072 27.7451 188.866C19.1926 178.953 12.3686 167.569 7.65781 155.351C2.60712 142.264 0 128.257 0 114.228C0 98.3219 3.35751 82.4611 9.80315 67.9215C15.8672 54.2382 24.6377 41.7862 35.4767 31.4668C72.6081 -3.88483 129.044 -10.1413 173.016 16.2153C183.444 22.4653 192.856 30.3829 200.796 39.5896C209.349 49.5018 216.173 60.8859 220.883 73.1037C225.934 86.1906 228.541 100.198 228.541 114.228Z',
    eyeAnchor: { offsetX: 0, offsetY: 0, bodyScaleX: 1, bodyScaleY: 1, eyeScale: 1, turnAt: false }
  }
}
