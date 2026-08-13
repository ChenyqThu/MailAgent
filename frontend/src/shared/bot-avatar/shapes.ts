// 灵动 bot 头像 —— 形状注册表（WP2：8 形齐全）。
// 坐标系：viewBox `-15 -15 259 259`，头中心 (114.2705, 114.27)，球面半径 105
// （grokbot-engine-analysis.md §2）。眼睛必须 clip 在 body path 内 —— 转头时眼睛
// 滑出边缘被裁掉，是 3D 错觉的关键一环，任何新形状都要提供可作 clipPath 的闭合 path。
// 本文件是 WP4 跨语言 parity 闸（TS ↔ src/reports/wire.py 白名单）的抽取源，
// BOT_AVATAR_SHAPES 保持 `[...] as const` 字面量形式，勿改写成动态构造。
//
// 形状实现约定（原型 SHAPES tuple 是假的，这里是真做 —— analysis §6）：
// - 每形 path 画「全尺寸」（占满 0..228.54，与 blob 同级），身体的宽窄胖瘦由
//   eyeAnchor.bodyScaleX/Y 在 BotAvatar 里经 transform 施加（绕画布中心缩放，
//   body 与 clipPath 共用同一串 —— 三次贝塞尔在仿射变换下保持平滑，帽/角不会失真）；
// - 生成器只在模块加载时跑一次产出常量字符串，运行时零成本。

export const BOT_AVATAR_SHAPES = [
  'blob',
  'capsule',
  'squircle',
  'egg',
  'wedge',
  'hex',
  'cloud',
  'teardrop'
] as const

export type BotShape = (typeof BOT_AVATAR_SHAPES)[number]

/** SVG viewBox（照抄原型 —— EXPRESSIONS 轮廓点全部落在这套坐标系里，勿改） */
export const BOT_VIEW_BOX = '-15 -15 259 259'

/** body path 的横向跨度；flipX 镜像 = `translate(SPAN 0) scale(-1 1)`（原型 render()） */
export const BOT_BODY_SPAN = 228.541

/** 画布中心（bodyScale 的缩放原点；与引擎 HEAD_CX 同值） */
export const BOT_BODY_CENTER = BOT_BODY_SPAN / 2

/**
 * 每形状的眼睛布局参数，语义来自原型 SHAPES tuple `[name,x,y,sx,sy,eyeScale,turnAt,…]`
 * （grokbot-engine-analysis.md §3/§6）。offsetX/offsetY 进引擎 options（眼心在
 * 228.541 坐标系内平移）；bodyScaleX/Y 由 BotAvatar 施加在 body+clipPath 的 transform 上。
 * WP2 调参依据：防重叠约束 eyeScale ≤ (distance-5)/(halfWidth₁+halfWidth₂)
 * （halfWidth 取该形 eyeScale 缩放后的值 —— tests/shared/bot-avatar/shapes.test.tsx 钉死）。
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

/**
 * bodyScale 的施加串：绕画布中心的各向异性缩放。恒等缩放返回 undefined ——
 * blob 等 (1,1) 形状的 DOM 与 WP1 逐字节一致（既有测试按无 transform 断言）。
 * clipPath 内容按 userSpaceOnUse 在引用方坐标系解析，包 defs 的 <g> 不生效，
 * 所以这串要同时写在 body <path> 和 clipPath 内的 <path> 上（共用同一份）。
 */
export function bodyScaleTransform(anchor: BotEyeAnchor): string | undefined {
  if (anchor.bodyScaleX === 1 && anchor.bodyScaleY === 1) return undefined
  return (
    `translate(${BOT_BODY_CENTER} ${BOT_BODY_CENTER}) ` +
    `scale(${anchor.bodyScaleX} ${anchor.bodyScaleY}) ` +
    `translate(${-BOT_BODY_CENTER} ${-BOT_BODY_CENTER})`
  )
}

// ── path 生成器（模块内私有，加载期一次性求值）─────────────────────────────────
// 数字全部 toFixed(2)（与 blob 的两位小数风格一致）；输出只用 M/L/C/Z 绝对命令。

/** 四段三次贝塞尔逼近圆/椭圆的经典系数 */
const KAPPA = 0.5522847498

type Pt = readonly [number, number]

function fmt(n: number): string {
  const s = n.toFixed(2)
  return s === '-0.00' ? '0.00' : s
}

const pt = (p: Pt): string => `${fmt(p[0])} ${fmt(p[1])}`

/**
 * 圆角多边形：顶点按顺时针给出，每角一个半径（角内缩 + 三次贝塞尔圆角；
 * 控制点取 inset→顶点方向的 (1-KAPPA) 位 —— 90° 角时即精确圆弧近似，
 * 其余角度是平滑的 G1 倒角）。半径超过半边长时收边，防自交。
 */
function roundedPolygonPath(points: readonly Pt[], radii: number | readonly number[]): string {
  const n = points.length
  const radiusAt = (i: number): number => (typeof radii === 'number' ? radii : radii[i])
  const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]]
  const len = (v: Pt): number => Math.hypot(v[0], v[1])
  const scale = (v: Pt, s: number): Pt => [v[0] * s, v[1] * s]
  const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]]

  const cmds: string[] = []
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const v = points[i]
    const next = points[(i + 1) % n]
    const inVec = sub(v, prev)
    const outVec = sub(next, v)
    const rIn = Math.min(radiusAt(i), len(inVec) / 2)
    const rOut = Math.min(radiusAt(i), len(outVec) / 2)
    const inDir = scale(inVec, 1 / len(inVec))
    const outDir = scale(outVec, 1 / len(outVec))
    const inPt = add(v, scale(inDir, -rIn))
    const outPt = add(v, scale(outDir, rOut))
    const c1 = add(v, scale(inDir, -rIn * (1 - KAPPA)))
    const c2 = add(v, scale(outDir, rOut * (1 - KAPPA)))
    cmds.push(i === 0 ? `M${pt(inPt)}` : `L${pt(inPt)}`)
    cmds.push(`C${pt(c1)} ${pt(c2)} ${pt(outPt)}`)
  }
  return cmds.join('') + 'Z'
}

/**
 * Catmull-Rom 闭合样条 → 三次贝塞尔链（uniform，c1 = P₁+(P₂-P₀)/6）。
 * 有机轮廓（cloud / teardrop）用：给关键点即得 C1 连续的平滑闭合曲线。
 */
function smoothClosedPath(points: readonly Pt[]): string {
  const n = points.length
  const at = (i: number): Pt => points[(i + n) % n]
  const cmds: string[] = [`M${pt(points[0])}`]
  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    cmds.push(`C${pt(c1)} ${pt(c2)} ${pt(p2)}`)
  }
  return cmds.join('') + 'Z'
}

const S = BOT_BODY_SPAN
const C = BOT_BODY_CENTER

/**
 * 竖直胶囊（全宽 + 椭圆帽 + 直腰）。帽的 ry 取 bodyScale 后变正圆的预补偿值：
 * ry·bodyScaleY = (S/2)·bodyScaleX ⇒ 缩放后帽是精确半圆，腰仍是直线 —— 真胶囊。
 */
function stadiumPath(ry: number): string {
  const k = KAPPA
  const top = ry
  const bottom = S - ry
  return (
    `M${pt([0, top])}` +
    `C${pt([0, top - k * ry])} ${pt([C - k * C, 0])} ${pt([C, 0])}` +
    `C${pt([C + k * C, 0])} ${pt([S, top - k * ry])} ${pt([S, top])}` +
    `L${pt([S, bottom])}` +
    `C${pt([S, bottom + k * ry])} ${pt([C + k * C, S])} ${pt([C, S])}` +
    `C${pt([C - k * C, S])} ${pt([0, bottom + k * ry])} ${pt([0, bottom])}` +
    'Z'
  )
}

/** 立蛋：同 rx（全宽）、上高下矮两个半椭圆拼接 —— 赤道处切线同为竖直，G1 连续 */
function eggPath(topRy: number, bottomRy: number): string {
  const k = KAPPA
  const eq = topRy // 赤道（最宽处）y
  return (
    `M${pt([0, eq])}` +
    `C${pt([0, eq - k * topRy])} ${pt([C - k * C, 0])} ${pt([C, 0])}` +
    `C${pt([C + k * C, 0])} ${pt([S, eq - k * topRy])} ${pt([S, eq])}` +
    `C${pt([S, eq + k * bottomRy])} ${pt([C + k * C, eq + bottomRy])} ${pt([C, eq + bottomRy])}` +
    `C${pt([C - k * C, eq + bottomRy])} ${pt([0, eq + k * bottomRy])} ${pt([0, eq])}` +
    'Z'
  )
}

// 六边形（pointy-top）：外接圆半径取半跨 —— 高占满 0..228.54，宽 √3/2 · S ≈ 198
const HEX_POINTS: readonly Pt[] = (() => {
  const r = C
  const out: Pt[] = []
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (-90 + 60 * i)
    out.push([C + r * Math.cos(angle), C + r * Math.sin(angle)])
  }
  return out
})()

// 圆角三角（顶点朝上）：底边略出画布再被大圆角收回来，成品视觉重心贴中带下
const WEDGE_POINTS: readonly Pt[] = [
  [C, 2],
  [237, 206],
  [-8.5, 206]
]

// 云朵：三个顶部鼓包（左小/中大/右小）+ 圆润底盘，Catmull-Rom 过点成形
const CLOUD_POINTS: readonly Pt[] = [
  [0, 128],
  [12, 86],
  [46, 56],
  [80, 72],
  [116, 28],
  [152, 70],
  [186, 62],
  [216, 84],
  [228.54, 122],
  [222, 166],
  [196, 202],
  [152, 219],
  [108, 224],
  [64, 217],
  [26, 196],
  [5, 164]
]

// 水滴：软尖顶 + 近圆底（底部沿半径 ~100 的圆采样，上段向尖收拢）
const TEARDROP_POINTS: readonly Pt[] = [
  [114.27, 2],
  [158, 38],
  [196.2, 68.6],
  [214.27, 126],
  [185, 196.7],
  [114.27, 226],
  [43.6, 196.7],
  [14.27, 126],
  [32.4, 68.6],
  [70, 38]
]

export const SHAPES: Record<BotShape, BotShapeDef> = {
  blob: {
    // 原型唯一真实生效的 body path（index.html #body-path，1:1 照抄）
    path: 'M228.541 114.228C228.541 130.133 225.184 145.994 218.738 160.534C212.674 174.217 203.904 186.669 193.065 196.988C155.933 232.34 99.497 238.596 55.5255 212.24C45.097 205.99 35.6851 198.072 27.7451 188.866C19.1926 178.953 12.3686 167.569 7.65781 155.351C2.60712 142.264 0 128.257 0 114.228C0 98.3219 3.35751 82.4611 9.80315 67.9215C15.8672 54.2382 24.6377 41.7862 35.4767 31.4668C72.6081 -3.88483 129.044 -10.1413 173.016 16.2153C183.444 22.4653 192.856 30.3829 200.796 39.5896C209.349 49.5018 216.173 60.8859 220.883 73.1037C225.934 86.1906 228.541 100.198 228.541 114.228Z',
    eyeAnchor: { offsetX: 0, offsetY: 0, bodyScaleX: 1, bodyScaleY: 1, eyeScale: 1, turnAt: false }
  },
  // 胶囊/药丸（Grok 截图选中形）：帽 ry 预补偿 = (S/2)·(0.64/0.92) ≈ 79.49
  capsule: {
    path: stadiumPath((C * 0.64) / 0.92),
    eyeAnchor: {
      offsetX: 0,
      offsetY: 0,
      bodyScaleX: 0.64,
      bodyScaleY: 0.92,
      eyeScale: 0.81,
      turnAt: false
    }
  },
  squircle: {
    path: roundedPolygonPath(
      [
        [0, 0],
        [S, 0],
        [S, S],
        [0, S]
      ],
      64
    ),
    eyeAnchor: { offsetX: 0, offsetY: 0, bodyScaleX: 1, bodyScaleY: 1, eyeScale: 1, turnAt: false }
  },
  // 蛋形：上半 132 / 下半 96.54（合计占满 228.54），宽处在中带偏下
  egg: {
    path: eggPath(132, S - 132),
    eyeAnchor: {
      offsetX: 0,
      offsetY: 2,
      bodyScaleX: 0.77,
      bodyScaleY: 0.97,
      eyeScale: 0.93,
      turnAt: false
    }
  },
  wedge: {
    path: roundedPolygonPath(WEDGE_POINTS, [46, 38, 38]),
    eyeAnchor: {
      offsetX: 0,
      offsetY: 24,
      bodyScaleX: 0.7,
      bodyScaleY: 0.7,
      eyeScale: 0.79,
      turnAt: false
    }
  },
  hex: {
    path: roundedPolygonPath(HEX_POINTS, 22),
    eyeAnchor: {
      offsetX: 0,
      offsetY: 0,
      bodyScaleX: 0.91,
      bodyScaleY: 0.91,
      eyeScale: 1,
      turnAt: false
    }
  },
  cloud: {
    path: smoothClosedPath(CLOUD_POINTS),
    eyeAnchor: {
      offsetX: 0,
      offsetY: 4,
      bodyScaleX: 0.79,
      bodyScaleY: 0.7,
      eyeScale: 0.81,
      turnAt: true
    }
  },
  teardrop: {
    path: smoothClosedPath(TEARDROP_POINTS),
    eyeAnchor: {
      offsetX: 0,
      offsetY: 22,
      bodyScaleX: 0.79,
      bodyScaleY: 0.79,
      eyeScale: 0.88,
      turnAt: false
    }
  }
}
