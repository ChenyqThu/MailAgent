// 灵动 bot 头像 v2 —— 形状词表：9 个成品形状（avatar-lab studio 成品目录）。
// 0813 owner 拍板「直接照搬库、不要自己做的形状」：词表 = avatar-lab
// `defaultStudioDocument.json` 里 10 个成品 avatar 的调参几何 + 组合身体
// （多 primitive 附属曲面），**没有 lab 成品对应物的自编形状全部退役**
// （cylinder/diamond/mickey/cursor —— 存量 avatar_json 经 LEGACY_BOT_SHAPE_MAP
// 读侧换脸，不迁移不回写）。lab 成品 → 本仓词表的映射（slug 沿用几何家族名，
// owner 明示不在乎名字 —— 改名会让全部存量行走 legacy 映射、徒增一次换脸）：
//   Grok bot / Strobi → sphere（🔴 lab 源数据里二者仅 depth 差 0.0367：
//     240 vs 240.03671875，视觉不可分辨 —— owner 拍板合并成一个条目，
//     所以 lab 10 成品对应本词表 9 形；不是漏搬）
//   Nova → capsule（= 出厂 capsule preset 逐字）
//   Cubee → cube · Citrus → cone（原 raw preset 尺寸会溢出 viewBox，成品调参值根治）
//   Freddy / Sunee / Kirby / Cloudee / Onee → 同名形状（前四者带组合身体）
// 颜色**不**随 lab（owner：按现有色板），身体/眼睛 fill 仍走 colors.ts。
// 本文件是跨语言 parity 闸（TS ↔ src/reports/wire.py 白名单，
// tests/config/test_bot_avatar_vocab_parity.py）的抽取源，
// BOT_AVATAR_SHAPES 保持 `[...] as const` 字面量形式，勿改写成动态构造。

import { surfacePresets } from './surfaces'
import type { SurfaceConfig } from './surfaces'
import type { BodyNodeDef } from './geometry'

export const BOT_AVATAR_SHAPES = [
  'sphere',
  'capsule',
  'cone',
  'cube',
  'freddy',
  'sunee',
  'kirby',
  'cloudee',
  'onee'
] as const

export type BotShape = (typeof BOT_AVATAR_SHAPES)[number]

/** 几何坐标系的基准半径（画布中心 (0,0)，几何层全部以此为基）。
 *  🔴 这是**坐标系**，不是取景窗：所有投影仍然在 ±150 空间里算，改它 = 改几何。 */
export const BOT_VIEW_BOX = '-150 -150 300 300'

/**
 * 每形状的 **viewBox（取景窗）半径**。0814 dogfood：owner「外框仍然是方形，对特殊形状
 * 会被裁切的，稍微比例调小，确保不会碰到」。
 *
 * 放大取景窗 = 同样大小的 px 盒子里内容渲得小一点，正是「比例调小」；**几何一个字不动**
 * （形状数值仍是 lab 成品逐字，勿手调 —— 见本文件头）。
 *
 * 🔴 只有几何本身溢出的形状才放大，其余恒 150 —— **sphere 是默认且最常用的形象，
 * 它的观感一个像素都不许变**（`ChatFabAvatar` 的 56px 尺寸推导正是建立在
 * 「sphere 轮廓 122 / 半宽 150 ≈ 81%」上的）。
 *
 * 取值 = 该形状「27 表情 × gaze 四角（±10° yaw / ±7° pitch）」的保守 |坐标| 上界
 * ÷ 0.95（留 5% 不贴边）后向上取偶。实测上界：
 *   sphere 122.3 · capsule 138.2 · cube 129.7 · cloudee 124.8 · onee 111.3（均安全）
 *   cone 150.6 · freddy 146.0 · kirby 167.9 · sunee 188.9（前二贴边、后二显著溢出）
 * 判据与 `tests/shared/bot-avatar/shapes.test.tsx` 的 `pathMaxAbs` 同源，
 * 那里会复算并断言「上界 ≤ 本表 × 0.95」—— 改几何或改本表而不同步必红。
 */
export const SHAPE_VIEW_RADIUS: Record<BotShape, number> = {
  sphere: 150,
  capsule: 150,
  cone: 160,
  cube: 150,
  freddy: 154,
  sunee: 200,
  kirby: 178,
  cloudee: 150,
  onee: 150
}

/** 形状 → svg viewBox 串（`BotAvatar` 的渲染入口；基准形状恒等于 `BOT_VIEW_BOX`） */
export const shapeViewBox = (shape: BotShape): string => {
  const radius = SHAPE_VIEW_RADIUS[shape]
  return `${-radius} ${-radius} ${radius * 2} ${radius * 2}`
}

/** 形状定义 = 主曲面 + 组合身体（附属曲面，各带独立位姿；渲染语义见 geometry.ts） */
export interface BotShapeDef {
  primary: SurfaceConfig
  nodes: readonly BodyNodeDef[]
}

const solo = (primary: SurfaceConfig): BotShapeDef => ({ primary, nodes: [] })

/**
 * 形状 → 几何定义。成品形状的数值**逐字**取自 avatar-lab studio 文档
 * `library.avatars`（勿手调 —— owner 拍板用上游调参过的成品；要给某形状调身材
 * 先回 lab studio 调完回抄）。
 */
export const SHAPES: Record<BotShape, BotShapeDef> = {
  // Grok bot（lab 成品几何 = 出厂 sphere preset 逐字）；Strobi 与之仅 depth 差
  // 0.0367（240.03671875），视觉不可分辨 —— owner 拍板合并进本条目
  sphere: solo(surfacePresets.sphere),
  // Nova（= 出厂 capsule preset 逐字）
  capsule: solo(surfacePresets.capsule),
  // Citrus
  cone: solo({
    type: 'cone',
    width: 252.708984375,
    height: 274.9671875,
    depth: 225,
    roundness: 0,
    morphRoundness: 1.1473828125,
    tipRoundness: 0.743515625,
    baseRoundness: 1.34375
  }),
  // Cubee
  cube: solo({
    type: 'cube',
    width: 191.49921875,
    height: 191.49921875,
    depth: 171.95848214285726,
    roundness: 0.73265625
  }),
  // Freddy（圆角方脑袋 + 头顶双球与天线柱）
  freddy: {
    primary: {
      type: 'cube',
      width: 174.732421875,
      height: 149.474609375,
      depth: 125.596484375,
      roundness: 0.7621875
    },
    nodes: [
      {
        surface: {
          type: 'sphere',
          width: 81.60000000000001,
          height: 81.60000000000001,
          depth: 37.96875000000001,
          roundness: 1
        },
        position: [-82, -72, -18],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 81.60000000000001,
          height: 81.60000000000001,
          depth: 37.024609375000004,
          roundness: 1
        },
        position: [82, -72, -18],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'cylinder',
          width: 59.483593750000004,
          height: 63.461328124999994,
          depth: 73.10000000000001,
          roundness: 1.5026171875,
          morphRoundness: 0.366171875
        },
        position: [-1.021484375, -72, -18],
        rotation: [0, 0, 0]
      }
    ]
  },
  // Sunee（压扁太阳盘 + 8 道太阳芒）
  sunee: {
    primary: {
      type: 'sphere',
      width: 182.95728256225593,
      height: 185.5484375,
      depth: 100.01221191461767,
      roundness: 1
    },
    nodes: [
      {
        surface: { type: 'sphere', width: 60, height: 60, depth: 24.375287224264703, roundness: 1 },
        position: [-94.48309236361106, -95.44637036124786, -10.398419675330803],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 59.57851562500001,
          height: 59.57851562500001,
          depth: 24.204057179245304,
          roundness: 1
        },
        position: [-6.440040491385305, -133.984012454223, -10.398419675330803],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 81.60000000000001,
          height: 81.60000000000001,
          depth: 33.150390625,
          roundness: 1
        },
        position: [89.09066821815593, -114.30101031028101, -10.398419675330803],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 70.12148437500001,
          height: 70.12148437500001,
          depth: 28.487188703873578,
          roundness: 1
        },
        position: [132.2484739833418, -11.704819633353354, -10.398419675330803],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 61.89843750000001,
          height: 61.89843750000001,
          depth: 25.146536546594966,
          roundness: 1
        },
        position: [-138.13379284351342, -1.1847860044189815, -10.398419675330803],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 61.11328125000001,
          height: 61.11328125000001,
          depth: 24.827563061433676,
          roundness: 1
        },
        position: [-103.29429634246448, 92.4041125555865, -10.398419675330803],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 61.726171875000006,
          height: 61.726171875000006,
          depth: 25.076552811790915,
          roundness: 1
        },
        position: [-2.4878844479075983, 133.06983674233183, -10.398419675330803],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 64.116796875,
          height: 64.116796875,
          depth: 26.047755662132705,
          roundness: 1
        },
        position: [109.54168183067505, 83.98361858650364, -10.398419675330803],
        rotation: [0, 0, 0]
      }
    ]
  },
  // Kirby（圆球 + 两只斜置椭球小手）
  kirby: {
    primary: { type: 'sphere', width: 240, height: 240, depth: 240, roundness: 1 },
    nodes: [
      {
        surface: {
          type: 'sphere',
          width: 108.11015625000002,
          height: 81.60000000000001,
          depth: 81.60000000000001,
          roundness: 1
        },
        position: [-103.30437876033604, 30.4449714479682, -9.784765625],
        rotation: [0, 0, -14.843359375]
      },
      {
        surface: {
          type: 'sphere',
          width: 108.11015625000002,
          height: 81.60000000000001,
          depth: 81.60000000000001,
          roundness: 1
        },
        position: [98.15429266544173, 32.55003025735345, -9.784765625],
        rotation: [0, 0, 15.175000000000004]
      }
    ]
  },
  // Cloudee（小球心 + 4 团云朵）
  cloudee: {
    primary: {
      type: 'sphere',
      width: 159.787109375,
      height: 159.787109375,
      depth: 159.77982741038028,
      roundness: 1
    },
    nodes: [
      {
        surface: {
          type: 'sphere',
          width: 81.60000000000001,
          height: 81.60000000000001,
          depth: 81.60000000000001,
          roundness: 1
        },
        position: [-54.211163573292225, -19.983270576375716, -18],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 108.64140625000002,
          height: 87.10000590491492,
          depth: 90.99923895827905,
          roundness: 1
        },
        position: [-64.06931629506641, 18.35102511266605, -18],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 97.79101562500003,
          height: 96.8381380478929,
          depth: 89.56416057242059,
          roundness: 1
        },
        position: [61.23234219342984, 18.962019686907013, -18],
        rotation: [0, 0, 0]
      },
      {
        surface: {
          type: 'sphere',
          width: 94.34892531002268,
          height: 94.3451962078319,
          depth: 100.53515625000001,
          roundness: 1
        },
        position: [41.48876642638391, -37.63883372407813, -17.99133043155456],
        rotation: [0, 0, 0]
      }
    ]
  },
  // Onee（矮胖软锥）
  onee: solo({
    type: 'cone',
    width: 250,
    height: 182.006640625,
    depth: 225,
    roundness: 0,
    morphRoundness: 1.2003515624999999,
    tipRoundness: 2,
    baseRoundness: 2
  })
}

/**
 * 退役形状名 → 现词表的读侧换脸（agentAvatarIdentity.ts 消费）。
 * 存量 avatar_json 里的旧形状名渲染期换脸、不迁移不回写；写侧（wire.py 白名单
 * 与编辑器）只认现词表。三组键：
 *   - v1 8 形（2D path 时代）：保持**双射** —— v1 时代两个不同形状的 agent
 *     换代后仍不同脸（egg→kirby：kirby 主体 = 240 光球、剪影圆润，是 9 形里
 *     离蛋形最近的没被占用者）；
 *   - v2 退役 4 形（0813 自编原语退役）：按几何相似度就近入座，与 v1 键可共享
 *     目标（键多于形，结构上无法整体双射）——
 *       cylinder→capsule（同为竖直圆润柱体家族）
 *       diamond→sunee（同为带尖角的放射剪影；与 v1 hex 系谱一致）
 *       mickey→cloudee（同为圆主体+圆瓣多球剪影；与 v1 cloud 系谱一致）
 *       cursor→onee（同为尖头软锥；与 v1 teardrop 系谱一致）
 *   - strobi（在词表里只存在了一批：与 Grok bot 仅 depth 差 0.0367，owner 拍板
 *     合并）→ sphere（几何本就几乎相同，零观感变化）。
 */
export const LEGACY_BOT_SHAPE_MAP: Record<string, BotShape> = {
  // v1 8 形（双射）
  blob: 'sphere',
  capsule: 'capsule',
  squircle: 'cube',
  egg: 'kirby',
  wedge: 'cone',
  hex: 'sunee',
  cloud: 'cloudee',
  teardrop: 'onee',
  // v2 退役 4 形（自编原语，0813「只留 lab 成品」拍板后退役）
  cylinder: 'capsule',
  diamond: 'sunee',
  mickey: 'cloudee',
  cursor: 'onee',
  // strobi：短暂在词表（批 AA），owner 拍板与 sphere 合并
  strobi: 'sphere'
}

const countRecord = (count: (def: BotShapeDef) => number): Record<BotShape, number> =>
  Object.fromEntries(BOT_AVATAR_SHAPES.map((shape) => [shape, count(SHAPES[shape])])) as Record<
    BotShape,
    number
  >

/** 每形状的背层 path 槽位数（= 附属曲面数；组件据此渲染固定槽位）。
 *  附属曲面逐帧在背/前层间迁移（z 排序），槽位按「全在背层」的最大值开，空槽写 ''。
 *  （0813 自编形状退役后不再有内建复合背层 —— mickey 双耳/cursor 锥体已随词表退役。） */
export const BACK_PATH_COUNT: Record<BotShape, number> = countRecord((def) => def.nodes.length)

/** 每形状的前层 path 槽位数（= 附属曲面数；多数形状为 0，多数帧为空槽） */
export const FRONT_PATH_COUNT: Record<BotShape, number> = countRecord((def) => def.nodes.length)
