// @vitest-environment happy-dom
//
// WP2 形状/颜色资产的机器验收：
//   1. 词表 ↔ 注册表一一对应（BOT_AVATAR_SHAPES/COLORS 是 WP4 parity 闸的 TS 侧）；
//   2. 防重叠闸：8 形 × 25 表情全组合 eyeScale ≤ (distance-5)/(halfWidth₁+halfWidth₂)
//      —— 形状调参的硬验收（prd §4.3），halfWidth 取该形 eyeScale 缩放后的半宽；
//   3. 几何 sanity：path 非空/闭合、数字全在 viewBox 内、占幅与 blob 同级；
//   4. 渲染消费：8 形经 BotAvatar 静态档各渲一次不抛，bodyScale 施加在 body+clipPath
//      共用串上（blob 恒等缩放 = 无 transform，DOM 与 WP1 逐字节一致）；
//   5. 浅色身体（white/yellow/gray）eye 覆写为固定深色，其余色跟 --background。

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { BotAvatar } from '../../../src/shared/bot-avatar/BotAvatar'
import { BOT_AVATAR_COLORS, COLORS } from '../../../src/shared/bot-avatar/colors'
import { EXPRESSIONS, staticFrame } from '../../../src/shared/bot-avatar/engine'
import {
  BOT_AVATAR_SHAPES,
  SHAPES,
  bodyScaleTransform
} from '../../../src/shared/bot-avatar/shapes'

afterEach(cleanup)

describe('词表 ↔ 注册表（WP4 parity 闸的 TS 侧同源）', () => {
  test('BOT_AVATAR_SHAPES 与 SHAPES 键一一对应且无重复', () => {
    expect(new Set(BOT_AVATAR_SHAPES).size).toBe(BOT_AVATAR_SHAPES.length)
    expect([...BOT_AVATAR_SHAPES].sort()).toEqual(Object.keys(SHAPES).sort())
  })

  test('BOT_AVATAR_COLORS 与 COLORS 键一一对应且无重复', () => {
    expect(new Set(BOT_AVATAR_COLORS).size).toBe(BOT_AVATAR_COLORS.length)
    expect([...BOT_AVATAR_COLORS].sort()).toEqual(Object.keys(COLORS).sort())
  })
})

type Ring = ReadonlyArray<ReadonlyArray<number>>

function centroidX(ring: Ring): number {
  return ring.reduce((acc, p) => acc + p[0], 0) / ring.length
}
function centroidY(ring: Ring): number {
  return ring.reduce((acc, p) => acc + p[1], 0) / ring.length
}
function halfWidth(ring: Ring): number {
  const xs = ring.map((p) => p[0])
  return (Math.max(...xs) - Math.min(...xs)) / 2
}

describe('防重叠闸：8 形 × 25 表情（eyeScale 调参的机器验收）', () => {
  // eyeScale 绕各自眼心缩放（engine transform 尾部 translate(-cx -cy)）——眼心距不随
  // 缩放变化；offsetX/offsetY 平移整个眼组，同样不改变眼心距。
  for (const shape of BOT_AVATAR_SHAPES) {
    test(`${shape}`, () => {
      const k = SHAPES[shape].eyeAnchor.eyeScale
      EXPRESSIONS.forEach((frame, i) => {
        const [left, right] = frame
        const distance = Math.hypot(
          centroidX(right) - centroidX(left),
          centroidY(right) - centroidY(left)
        )
        const scaledHalfWidths = k * halfWidth(left) + k * halfWidth(right)
        const bound = (distance - 5) / scaledHalfWidths
        expect(k, `${shape} × expression#${i}: eyeScale ${k} > bound ${bound.toFixed(4)}`)
          .toBeLessThanOrEqual(bound + 1e-9)
      })
    })
  }
})

describe('几何 sanity：path 形状与占幅', () => {
  const NUMBER_RE = /-?\d+(?:\.\d+)?/g

  for (const shape of BOT_AVATAR_SHAPES) {
    test(`${shape} path 闭合且坐标全在 viewBox 内`, () => {
      const path = SHAPES[shape].path
      expect(path.length).toBeGreaterThan(0)
      expect(path.startsWith('M')).toBe(true)
      expect(path.endsWith('Z')).toBe(true)
      // 全部是绝对命令（M/L/C），path 里的数字即坐标对：粗查 min/max 落在
      // viewBox -15 -15 259 259（即 x/y ∈ [-15, 244]）内 —— 不做精确曲线包络
      const numbers = (path.match(NUMBER_RE) ?? []).map(Number)
      expect(numbers.length).toBeGreaterThanOrEqual(4)
      expect(numbers.length % 2).toBe(0)
      const xs = numbers.filter((_, i) => i % 2 === 0)
      const ys = numbers.filter((_, i) => i % 2 === 1)
      for (const v of xs) expect(v, `${shape} x=${v}`).toBeGreaterThanOrEqual(-15)
      for (const v of xs) expect(v, `${shape} x=${v}`).toBeLessThanOrEqual(244)
      for (const v of ys) expect(v, `${shape} y=${v}`).toBeGreaterThanOrEqual(-15)
      for (const v of ys) expect(v, `${shape} y=${v}`).toBeLessThanOrEqual(244)
      // 占幅与 blob 同级（bodyScale 前的全尺寸 path）：长边 ≥ 195，两边都 ≥ 150
      const w = Math.max(...xs) - Math.min(...xs)
      const h = Math.max(...ys) - Math.min(...ys)
      expect(Math.max(w, h), `${shape} span ${w.toFixed(1)}×${h.toFixed(1)}`).toBeGreaterThanOrEqual(195)
      expect(Math.min(w, h), `${shape} span ${w.toFixed(1)}×${h.toFixed(1)}`).toBeGreaterThanOrEqual(150)
    })
  }
})

const TRANSLATE_RE = /translate\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)/

describe('渲染消费：8 形经 BotAvatar 静态档', () => {
  for (const shape of BOT_AVATAR_SHAPES) {
    test(`${shape} 渲染不抛，body 与 clipPath 共用 bodyScale`, () => {
      const { container } = render(<BotAvatar config={{ shape }} size={24} />)
      // 同一 d 出现两次：clipPath 内容 + body（眼睛 clip 在头形内是 3D 错觉关键）
      const bodyLike = container.querySelectorAll<SVGPathElement>(`path[d="${SHAPES[shape].path}"]`)
      expect(bodyLike.length).toBe(2)
      const expected = bodyScaleTransform(SHAPES[shape].eyeAnchor) ?? null
      for (const node of bodyLike) {
        expect(node.getAttribute('transform')).toBe(expected)
      }
      expect(container.querySelectorAll('[data-bot-eye]').length).toBe(2)
    })
  }

  test('恒等缩放（blob）无 transform；capsule 是绕中心的 0.64/0.92', () => {
    expect(bodyScaleTransform(SHAPES.blob.eyeAnchor)).toBeUndefined()
    const capsule = bodyScaleTransform(SHAPES.capsule.eyeAnchor)
    expect(capsule).toContain('scale(0.64 0.92)')
    expect(capsule).toContain('translate(114.2705 114.2705)')
  })

  test('eyeAnchor offset 进引擎：wedge 眼组相对 blob 下移 24', () => {
    const blobEye = staticFrame(0, 1, 0, 0).eyes[0]
    const wedgeAnchor = SHAPES.wedge.eyeAnchor
    const wedgeEye = staticFrame(
      0,
      wedgeAnchor.eyeScale,
      wedgeAnchor.offsetX,
      wedgeAnchor.offsetY
    ).eyes[0]
    const blobXY = blobEye.transform.match(TRANSLATE_RE)
    const wedgeXY = wedgeEye.transform.match(TRANSLATE_RE)
    expect(blobXY).not.toBeNull()
    expect(wedgeXY).not.toBeNull()
    if (!blobXY || !wedgeXY) return
    expect(Number(wedgeXY[1]) - Number(blobXY[1])).toBeCloseTo(wedgeAnchor.offsetX, 5)
    expect(Number(wedgeXY[2]) - Number(blobXY[2])).toBeCloseTo(wedgeAnchor.offsetY, 5)
  })
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
