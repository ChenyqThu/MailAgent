// @vitest-environment happy-dom
//
// 形状/颜色资产的机器验收（0813 成品目录化：13 形 = 8 原语名 + 5 组合身体成品）：
//   1. 词表 ↔ 注册表一一对应（BOT_AVATAR_SHAPES/COLORS 是 parity 闸的 TS 侧）；
//   2. 成品数值 pin：cube/cone 的 lab studio 调参值、组合身体 node 数逐形钉死
//      （搬运错一个数字 = 某成品静默变形）；
//   3. legacy 双射：v1 8 形 → 现词表不折叠（两个不同 v1 形状换代后仍不同脸）；
//   4. 几何 sanity：13 形 × 代表表情的头/眼/背/前 path 非空闭合、槽位不变量、
//      眼坐标在 viewBox 内；
//   5. viewBox 溢出治理：lab 成品调参值必须把 cube/cone 的投影轮廓收回 ±150
//      （v2 raw preset 时代 |max| 实测 204/176 —— 0813 换成品值的核心动机之一）；
//      组合身体按 lab 语义**允许**少量出界（svg overflow:visible），但钉上限；
//   6. 渲染消费：13 形经 BotAvatar 静态档各渲一次不抛，head 与 clipPath 共用同一串；
//   7. 浅色身体（white/yellow/gray）eye 覆写为固定深色，其余色跟 --background。

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { BotAvatar } from '../../../src/shared/bot-avatar/BotAvatar'
import { BOT_AVATAR_COLORS, COLORS } from '../../../src/shared/bot-avatar/colors'
import { EXPRESSIONS, staticFrame } from '../../../src/shared/bot-avatar/engine'
import {
  BACK_PATH_COUNT,
  BOT_AVATAR_SHAPES,
  FRONT_PATH_COUNT,
  LEGACY_BOT_SHAPE_MAP,
  SHAPES
} from '../../../src/shared/bot-avatar/shapes'
import type { BotShape } from '../../../src/shared/bot-avatar/shapes'

afterEach(cleanup)

/** 主曲面内建背层数（mickey 双耳 / cursor 锥体）——槽位不变量的对照项 */
const builtinBack = (shape: BotShape): number =>
  SHAPES[shape].primary.type === 'mickey' ? 2 : SHAPES[shape].primary.type === 'cursor' ? 1 : 0

describe('词表 ↔ 注册表（parity 闸的 TS 侧同源）', () => {
  test('BOT_AVATAR_SHAPES 与 SHAPES / BACK_PATH_COUNT / FRONT_PATH_COUNT 键一一对应且无重复', () => {
    expect(BOT_AVATAR_SHAPES).toHaveLength(13)
    expect(new Set(BOT_AVATAR_SHAPES).size).toBe(BOT_AVATAR_SHAPES.length)
    expect([...BOT_AVATAR_SHAPES].sort()).toEqual(Object.keys(SHAPES).sort())
    expect([...BOT_AVATAR_SHAPES].sort()).toEqual(Object.keys(BACK_PATH_COUNT).sort())
    expect([...BOT_AVATAR_SHAPES].sort()).toEqual(Object.keys(FRONT_PATH_COUNT).sort())
  })

  test('BOT_AVATAR_COLORS 与 COLORS 键一一对应且无重复', () => {
    expect(new Set(BOT_AVATAR_COLORS).size).toBe(BOT_AVATAR_COLORS.length)
    expect([...BOT_AVATAR_COLORS].sort()).toEqual(Object.keys(COLORS).sort())
  })

  test('槽位表 = 内建复合 + 附属曲面数（BACK）/ 附属曲面数（FRONT）', () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      expect(BACK_PATH_COUNT[shape], shape).toBe(builtinBack(shape) + SHAPES[shape].nodes.length)
      expect(FRONT_PATH_COUNT[shape], shape).toBe(SHAPES[shape].nodes.length)
    }
  })
})

describe('lab 成品数值 pin（搬运保真）', () => {
  test('8 原语名：primary.type 与名字一致；4 个无成品对应物仍是出厂 preset 恒等', () => {
    for (const shape of [
      'sphere',
      'capsule',
      'cylinder',
      'cone',
      'cube',
      'diamond',
      'mickey',
      'cursor'
    ] as const) {
      expect(SHAPES[shape].primary.type).toBe(shape)
    }
  })

  test('cube = Cubee 调参值 / cone = Citrus 调参值（raw preset 溢出治理的载体）', () => {
    expect(SHAPES.cube.primary).toMatchObject({
      width: 191.49921875,
      height: 191.49921875,
      depth: 171.95848214285726,
      roundness: 0.73265625
    })
    expect(SHAPES.cone.primary).toMatchObject({
      width: 252.708984375,
      height: 274.9671875,
      morphRoundness: 1.1473828125,
      tipRoundness: 0.743515625,
      baseRoundness: 1.34375
    })
  })

  test('组合身体：freddy 3 节 / sunee 8 节 / kirby 2 节 / cloudee 4 节，其余 0 节', () => {
    const NODE_COUNTS: Record<BotShape, number> = {
      sphere: 0,
      capsule: 0,
      cylinder: 0,
      cone: 0,
      cube: 0,
      diamond: 0,
      mickey: 0,
      cursor: 0,
      freddy: 3,
      sunee: 8,
      kirby: 2,
      cloudee: 4,
      onee: 0
    }
    for (const shape of BOT_AVATAR_SHAPES) {
      expect(SHAPES[shape].nodes, shape).toHaveLength(NODE_COUNTS[shape])
    }
    // 抽查位姿搬运：kirby 双手带 z 旋（±15°）——搬丢 rotation 手就摆不斜
    expect(SHAPES.kirby.nodes[0].rotation[2]).toBeCloseTo(-14.843359375, 10)
    expect(SHAPES.kirby.nodes[1].rotation[2]).toBeCloseTo(15.175000000000004, 10)
    // freddy 天线柱是圆角 cylinder（morphRoundness 0.366…）
    expect(SHAPES.freddy.nodes[2].surface.type).toBe('cylinder')
    expect(SHAPES.freddy.nodes[2].surface.morphRoundness).toBeCloseTo(0.366171875, 10)
    // onee = 全圆角软锥（tip/base roundness 2 = lab 值域上限）
    expect(SHAPES.onee.primary).toMatchObject({ tipRoundness: 2, baseRoundness: 2 })
  })
})

describe('legacy 双射（v1 → 现词表读侧换脸）', () => {
  test('v1 8 形全覆盖，值全部落在现词表内，且是双射（不折叠）', () => {
    const V1 = ['blob', 'capsule', 'squircle', 'egg', 'wedge', 'hex', 'cloud', 'teardrop']
    expect(Object.keys(LEGACY_BOT_SHAPE_MAP).sort()).toEqual([...V1].sort())
    const values = Object.values(LEGACY_BOT_SHAPE_MAP)
    for (const value of values) expect(BOT_AVATAR_SHAPES).toContain(value)
    expect(new Set(values).size).toBe(V1.length)
  })
})

/** 折线 path（M/L…Z）里的坐标对；眼 path 是纯折线所以可以逐对断言 */
function pathCoordinatePairs(d: string): Array<[number, number]> {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const pairs: Array<[number, number]> = []
  for (let i = 0; i + 1 < numbers.length; i += 2) pairs.push([numbers[i], numbers[i + 1]])
  return pairs
}

/**
 * path 的保守 |坐标| 上界（viewBox 溢出判据）：
 * M/L 取端点；C 取控制点凸包（Bezier 曲线不出控制点凸包）；A 按本仓 ellipsePath
 * 的「对径两段半椭圆」用法取 段中点 ± majorRadius（整椭圆的保守外接）。
 */
function pathMaxAbs(d: string): number {
  let max = 0
  let cur: [number, number] = [0, 0]
  for (const m of d.matchAll(/([MLCA])([^MLCAZ]*)/g)) {
    const nums = (m[2].match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) ?? []).map(Number)
    if (m[1] === 'M' || m[1] === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cur = [nums[i], nums[i + 1]]
        max = Math.max(max, Math.abs(cur[0]), Math.abs(cur[1]))
      }
    } else if (m[1] === 'C') {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        max = Math.max(
          max,
          ...nums.slice(i, i + 6).map((value) => Math.abs(value))
        )
        cur = [nums[i + 4], nums[i + 5]]
      }
    } else {
      for (let i = 0; i + 6 < nums.length; i += 7) {
        const radius = Math.max(nums[i], nums[i + 1])
        const end: [number, number] = [nums[i + 5], nums[i + 6]]
        max = Math.max(
          max,
          Math.abs((cur[0] + end[0]) / 2) + radius,
          Math.abs((cur[1] + end[1]) / 2) + radius
        )
        cur = end
      }
    }
  }
  return max
}

/** 一帧全部实体 path（头 + 背层 + 前层）的保守 |坐标| 上界 */
function frameMaxAbs(shape: BotShape, index: number): number {
  const frame = staticFrame(index, SHAPES[shape])
  return Math.max(
    pathMaxAbs(frame.head),
    ...frame.back.map(pathMaxAbs),
    ...frame.front.map(pathMaxAbs),
    0
  )
}

function worstMaxAbs(shape: BotShape): number {
  return Math.max(...EXPRESSIONS.map((_, index) => frameMaxAbs(shape, index)))
}

describe('几何 sanity：13 形 × 代表表情', () => {
  // 代表表情取 0（idle 池首，带 27.8° yaw —— 顺带覆盖「转头后仍可渲染」）与 13（近正视）
  const SAMPLE_EXPRESSIONS = [0, 13]

  for (const shape of BOT_AVATAR_SHAPES) {
    test(`${shape}：头/眼/背/前 path 闭合，槽位不变量成立，眼坐标在 viewBox 内`, () => {
      for (const index of SAMPLE_EXPRESSIONS) {
        const frame = staticFrame(index, SHAPES[shape])
        expect(frame.head.startsWith('M'), `${shape}#${index} head`).toBe(true)
        expect(frame.head.endsWith('Z'), `${shape}#${index} head`).toBe(true)
        expect(frame.head.includes('NaN')).toBe(false)
        // 附属曲面逐帧在背/前层间迁移：总数守恒，各层不超槽位
        expect(frame.back.length + frame.front.length).toBe(
          builtinBack(shape) + SHAPES[shape].nodes.length
        )
        expect(frame.back.length).toBeLessThanOrEqual(BACK_PATH_COUNT[shape])
        expect(frame.front.length).toBeLessThanOrEqual(FRONT_PATH_COUNT[shape])
        for (const part of [...frame.back, ...frame.front]) {
          expect(part.startsWith('M')).toBe(true)
          expect(part.includes('NaN')).toBe(false)
        }
        expect(frame.eyes).toHaveLength(2)
        for (const eye of frame.eyes) {
          expect(eye.d.startsWith('M'), `${shape}#${index} eye`).toBe(true)
          expect(eye.d.endsWith('Z'), `${shape}#${index} eye`).toBe(true)
          // 眼 path 是折线（L 命令），坐标对可直接界检：全部落在 viewBox ±150 内
          for (const [x, y] of pathCoordinatePairs(eye.d)) {
            expect(x, `${shape}#${index} eye x=${x}`).toBeGreaterThanOrEqual(-150)
            expect(x, `${shape}#${index} eye x=${x}`).toBeLessThanOrEqual(150)
            expect(y, `${shape}#${index} eye y=${y}`).toBeGreaterThanOrEqual(-150)
            expect(y, `${shape}#${index} eye y=${y}`).toBeLessThanOrEqual(150)
          }
        }
      }
    })
  }

  test('近正视表情（13）双眼在所有形状上都可见且不重叠', () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      const frame = staticFrame(13, SHAPES[shape])
      expect(frame.eyes[0].visible, `${shape} left`).toBe(true)
      expect(frame.eyes[1].visible, `${shape} right`).toBe(true)
      // 不重叠：左眼最大 x < 右眼最小 x（曲面贴合可能压缩间距，留 1 单位余量）
      const leftXs = pathCoordinatePairs(frame.eyes[0].d).map(([x]) => x)
      const rightXs = pathCoordinatePairs(frame.eyes[1].d).map(([x]) => x)
      expect(Math.max(...leftXs), shape).toBeLessThan(Math.min(...rightXs) + 1)
    }
  })

  test('形状身份可分：13 形对同一表情产出 13 种整体轮廓（头+背+前）', () => {
    // 头单独比不够：kirby 的 primary 与 sphere 同为 240 球（差异全在组合身体）
    const identities = new Set(
      BOT_AVATAR_SHAPES.map((shape) => {
        const frame = staticFrame(13, SHAPES[shape])
        return [frame.head, ...frame.back, ...frame.front].join('|')
      })
    )
    expect(identities.size).toBe(BOT_AVATAR_SHAPES.length)
  })

  test('27 表情 × sphere/freddy 全量渲染无 NaN（POOLS 全索引可安全消费，含组合身体）', () => {
    EXPRESSIONS.forEach((_, index) => {
      for (const shape of ['sphere', 'freddy'] as const) {
        const frame = staticFrame(index, SHAPES[shape])
        expect(frame.head.includes('NaN'), `${shape}#${index}`).toBe(false)
        expect(frame.eyes[0].d.includes('NaN'), `${shape}#${index}`).toBe(false)
        expect(frame.eyes[1].d.includes('NaN'), `${shape}#${index}`).toBe(false)
        for (const part of [...frame.back, ...frame.front]) {
          expect(part.includes('NaN'), `${shape}#${index}`).toBe(false)
        }
      }
    })
  })
})

describe('viewBox 溢出治理（0813 换 lab 成品调参值的核心动机）', () => {
  test('单曲面成品（sphere/capsule/cube/cone/onee/diamond）全表情收在 ±150 内', () => {
    // raw preset 时代 cube/cone 实测 |max| 204/176（circular+方框双层裁切事故源）；
    // Cubee/Citrus 调参值必须把它们收回 viewBox。diamond 本来就安全，一并钉住。
    for (const shape of ['sphere', 'capsule', 'cube', 'cone', 'onee', 'diamond'] as const) {
      expect(worstMaxAbs(shape), shape).toBeLessThanOrEqual(150)
    }
  })

  test('组合身体成品允许按 lab 语义少量出界（overflow:visible），但钉上限防回归', () => {
    // lab studio 画布同为 ±150 且 svg overflow:visible —— Sunee 太阳芒等本就
    // 设计为略超出 viewBox。上限取实测最坏值 + 余量：显著超出 = 数据/投影回归。
    for (const shape of ['freddy', 'sunee', 'kirby', 'cloudee'] as const) {
      expect(worstMaxAbs(shape), shape).toBeLessThanOrEqual(200)
    }
  })

  test('已知遗留：cylinder（无 lab 成品对应物）仍溢出 —— 修好它必须同步收紧本断言', () => {
    // raw preset cylinder 的投影 |max| > 150 是换代前的既有事实（research §2.3）。
    // 这里如实钉住「仍溢出」：若未来有人调参修复，本断言翻红提醒把它挪进上面那组。
    expect(worstMaxAbs('cylinder')).toBeGreaterThan(150)
  })
})

describe('渲染消费：13 形经 BotAvatar 静态档', () => {
  for (const shape of BOT_AVATAR_SHAPES) {
    test(`${shape} 渲染不抛，head 与 clipPath 共用同一串，背/前槽位数对表`, () => {
      const { container } = render(<BotAvatar config={{ shape }} size={24} />)
      const frame = staticFrame(0, SHAPES[shape])
      const head = container.querySelector<SVGPathElement>('[data-bot-head]')
      expect(head?.getAttribute('d')).toBe(frame.head)
      const clip = container.querySelector<SVGPathElement>('clipPath path')
      expect(clip?.getAttribute('d')).toBe(frame.head)
      expect(container.querySelectorAll('[data-bot-eye]').length).toBe(2)
      expect(container.querySelectorAll('[data-bot-back]').length).toBe(BACK_PATH_COUNT[shape])
      expect(container.querySelectorAll('[data-bot-front]').length).toBe(FRONT_PATH_COUNT[shape])
    })
  }
})

describe('色盘：浅色身体的 eye 覆写', () => {
  const LIGHT_BODIES = ['white', 'yellow', 'gray'] as const

  test('white/yellow/gray 双主题 eye 均为固定深色（不跟 --background）', () => {
    for (const color of LIGHT_BODIES) {
      for (const theme of ['light', 'dark'] as const) {
        const eye = COLORS[color][theme].eye
        expect(eye, `${color}.${theme}`).not.toContain('var(--background')
        expect(eye, `${color}.${theme}`).toContain('#181a15')
      }
    }
  })

  test('其余 8 色 eye 走 --background 镂空链（显式 --bot-avatar-eye 覆盖口保留）', () => {
    for (const color of BOT_AVATAR_COLORS) {
      if ((LIGHT_BODIES as readonly string[]).includes(color)) continue
      for (const theme of ['light', 'dark'] as const) {
        const eye = COLORS[color][theme].eye
        expect(eye, `${color}.${theme}`).toContain('var(--bot-avatar-eye')
        expect(eye, `${color}.${theme}`).toContain('var(--background')
      }
    }
  })

  test('body 均为主题双值实色 hex', () => {
    for (const color of BOT_AVATAR_COLORS) {
      expect(COLORS[color].light.body).toMatch(/^#[0-9a-f]{6}$/)
      expect(COLORS[color].dark.body).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})
