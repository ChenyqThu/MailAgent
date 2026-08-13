// @vitest-environment happy-dom
//
// v2 形状/颜色资产的机器验收：
//   1. 词表 ↔ 注册表一一对应（BOT_AVATAR_SHAPES/COLORS 是 parity 闸的 TS 侧）；
//   2. legacy 双射：v1 8 形 → v2 8 形不折叠（两个不同 v1 形状换代后仍不同脸）；
//   3. 几何 sanity：8 形 × 代表表情的头/眼 path 非空闭合、眼坐标在 viewBox 内、
//      背层槽位数与 BACK_PATH_COUNT 一致；
//   4. 渲染消费：8 形经 BotAvatar 静态档各渲一次不抛，head 与 clipPath 共用同一串；
//   5. 浅色身体（white/yellow/gray）eye 覆写为固定深色，其余色跟 --background。

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { BotAvatar } from '../../../src/shared/bot-avatar/BotAvatar'
import { BOT_AVATAR_COLORS, COLORS } from '../../../src/shared/bot-avatar/colors'
import { EXPRESSIONS, staticFrame } from '../../../src/shared/bot-avatar/engine'
import {
  BACK_PATH_COUNT,
  BOT_AVATAR_SHAPES,
  LEGACY_BOT_SHAPE_MAP,
  SHAPES
} from '../../../src/shared/bot-avatar/shapes'

afterEach(cleanup)

describe('词表 ↔ 注册表（parity 闸的 TS 侧同源）', () => {
  test('BOT_AVATAR_SHAPES 与 SHAPES / BACK_PATH_COUNT 键一一对应且无重复', () => {
    expect(new Set(BOT_AVATAR_SHAPES).size).toBe(BOT_AVATAR_SHAPES.length)
    expect([...BOT_AVATAR_SHAPES].sort()).toEqual(Object.keys(SHAPES).sort())
    expect([...BOT_AVATAR_SHAPES].sort()).toEqual(Object.keys(BACK_PATH_COUNT).sort())
  })

  test('BOT_AVATAR_COLORS 与 COLORS 键一一对应且无重复', () => {
    expect(new Set(BOT_AVATAR_COLORS).size).toBe(BOT_AVATAR_COLORS.length)
    expect([...BOT_AVATAR_COLORS].sort()).toEqual(Object.keys(COLORS).sort())
  })

  test('SHAPES 的曲面类型与形状名一致（词表即 SurfaceType 词表）', () => {
    for (const shape of BOT_AVATAR_SHAPES) {
      expect(SHAPES[shape].type).toBe(shape)
    }
  })
})

describe('legacy 双射（v1 → v2 读侧换脸）', () => {
  test('v1 8 形全覆盖，值全部落在 v2 词表内，且是双射（不折叠）', () => {
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

describe('几何 sanity：8 形 × 代表表情', () => {
  // 代表表情取 0（idle 池首，带 27.8° yaw —— 顺带覆盖「转头后仍可渲染」）与 13（近正视）
  const SAMPLE_EXPRESSIONS = [0, 13]

  for (const shape of BOT_AVATAR_SHAPES) {
    test(`${shape}：头/眼 path 闭合，背层数对表，眼坐标在 viewBox 内`, () => {
      for (const index of SAMPLE_EXPRESSIONS) {
        const frame = staticFrame(index, SHAPES[shape])
        expect(frame.head.startsWith('M'), `${shape}#${index} head`).toBe(true)
        expect(frame.head.endsWith('Z'), `${shape}#${index} head`).toBe(true)
        expect(frame.head.includes('NaN')).toBe(false)
        expect(frame.back).toHaveLength(BACK_PATH_COUNT[shape])
        for (const back of frame.back) {
          expect(back.startsWith('M')).toBe(true)
          expect(back.includes('NaN')).toBe(false)
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

  test('形状身份可分：8 形对同一表情产出 8 种头轮廓', () => {
    const heads = new Set(BOT_AVATAR_SHAPES.map((shape) => staticFrame(13, SHAPES[shape]).head))
    expect(heads.size).toBe(BOT_AVATAR_SHAPES.length)
  })

  test('25 表情 × sphere 全量渲染无 NaN（POOLS 全索引可安全消费）', () => {
    EXPRESSIONS.forEach((_, index) => {
      const frame = staticFrame(index, SHAPES.sphere)
      expect(frame.head.includes('NaN'), `expr#${index}`).toBe(false)
      expect(frame.eyes[0].d.includes('NaN'), `expr#${index}`).toBe(false)
      expect(frame.eyes[1].d.includes('NaN'), `expr#${index}`).toBe(false)
    })
  })
})

describe('渲染消费：8 形经 BotAvatar 静态档', () => {
  for (const shape of BOT_AVATAR_SHAPES) {
    test(`${shape} 渲染不抛，head 与 clipPath 共用同一串`, () => {
      const { container } = render(<BotAvatar config={{ shape }} size={24} />)
      const frame = staticFrame(0, SHAPES[shape])
      const head = container.querySelector<SVGPathElement>('[data-bot-head]')
      expect(head?.getAttribute('d')).toBe(frame.head)
      const clip = container.querySelector<SVGPathElement>('clipPath path')
      expect(clip?.getAttribute('d')).toBe(frame.head)
      expect(container.querySelectorAll('[data-bot-eye]').length).toBe(2)
      expect(container.querySelectorAll('[data-bot-back]').length).toBe(BACK_PATH_COUNT[shape])
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
