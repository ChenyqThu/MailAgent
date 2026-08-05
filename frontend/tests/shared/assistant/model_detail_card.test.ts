// 能力卡的定位算式与数字格式化（08-05 dogfood-3）。
//
// 为什么抽出来单测：happy-dom 的 `getBoundingClientRect` 恒 0，渲染断言测不动定位；而定位
// 正是这张卡最容易悄悄坏的地方 —— 消费场地的真实宽度是 浮窗 448 / 侧栏 320-720 / agent 面
// 704 / popout 整窗，四个场地里只要有一个把卡推出视口，用户看到的就是「hover 没反应」。

import { describe, expect, test } from 'vitest'

import {
  MODEL_CARD_GAP,
  MODEL_CARD_MARGIN,
  MODEL_CARD_MAX_H,
  MODEL_CARD_WIDTH,
  formatPrice,
  formatTokens,
  placeDetailCard
} from '@shared/assistant/components/modelDetailCard.lib'

/** 选择器弹层：264px 宽、贴在 composer 上方。 */
function menuAt(left: number, bottom: number): { menu: DOMRectLike } {
  return { menu: { left, right: left + 264, bottom } }
}
type DOMRectLike = { left: number; right: number; bottom: number }

describe('placeDetailCard — 三档水平定位', () => {
  test('右边放得下 → 右展开（默认档，与参考产品一致）', () => {
    const p = placeDetailCard(menuAt(400, 700), { width: 1440, height: 900 })
    expect(p.left).toBe(400 + 264 + MODEL_CARD_GAP)
  })

  test('右边放不下 → 翻到左边（邮件面板贴窗口右缘时的常态）', () => {
    // 1280 宽窗口、弹层右缘 1264：右侧只剩 16px。
    const p = placeDetailCard(menuAt(1000, 700), { width: 1280, height: 900 })
    expect(p.left).toBe(1000 - MODEL_CARD_GAP - MODEL_CARD_WIDTH)
  })

  test('两边都放不下（很窄的窗口）→ 夹进视口，不许出界', () => {
    const p = placeDetailCard(menuAt(20, 500), { width: 420, height: 700 })
    expect(p.left).toBeGreaterThanOrEqual(MODEL_CARD_MARGIN)
    expect(p.left + MODEL_CARD_WIDTH).toBeLessThanOrEqual(420 - MODEL_CARD_MARGIN)
  })

  test('任何场地宽度下都不出界（浮窗 448 / 侧栏 320·400·720 / agent 704 / 整窗）', () => {
    for (const width of [448, 320, 400, 720, 704, 1024, 1440, 1920]) {
      // 弹层可能贴左、居中、贴右三种位置。
      for (const left of [12, Math.max(12, width / 2 - 132), Math.max(12, width - 276)]) {
        const p = placeDetailCard(menuAt(left, 600), { width, height: 800 })
        expect(p.left, `width=${width} left=${left}`).toBeGreaterThanOrEqual(MODEL_CARD_MARGIN)
        // 视口比卡还窄时只能保证左边不出界（这台机器上不存在，但算式不该产生 NaN/负数）。
        if (width >= MODEL_CARD_WIDTH + 2 * MODEL_CARD_MARGIN) {
          expect(p.left + MODEL_CARD_WIDTH, `width=${width} left=${left}`).toBeLessThanOrEqual(
            width - MODEL_CARD_MARGIN
          )
        }
      }
    }
  })
})

describe('placeDetailCard — 垂直锚到弹层底边', () => {
  test('卡底与弹层底对齐（锚到 hover 行会让卡随光标每换一行跳一次）', () => {
    const p = placeDetailCard(menuAt(400, 700), { width: 1440, height: 900 })
    expect(p.bottom).toBe(900 - 700)
  })

  test('弹层贴着视口底时留安全边距', () => {
    const p = placeDetailCard(menuAt(400, 900), { width: 1440, height: 900 })
    expect(p.bottom).toBe(MODEL_CARD_MARGIN)
  })

  test('maxHeight 兜住「向上长出屏幕」，且恒 ≤ 卡的高度上限', () => {
    const tall = placeDetailCard(menuAt(400, 880), { width: 1440, height: 900 })
    expect(tall.maxHeight).toBe(MODEL_CARD_MAX_H)
    const short = placeDetailCard(menuAt(400, 300), { width: 1440, height: 320 })
    expect(short.maxHeight).toBeLessThanOrEqual(MODEL_CARD_MAX_H)
    expect(short.maxHeight + short.bottom).toBeLessThanOrEqual(320)
  })
})

describe('formatTokens', () => {
  test.each([
    [1_000_000, '1M'],
    [1_050_000, '1.1M'],
    [200_000, '200K'],
    [64_000, '64K'],
    [8192, '8K'],
    [512, '512']
  ])('%i → %s', (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })
})

describe('formatPrice', () => {
  test.each([
    [0, '$0'],
    [3, '$3.00'],
    [0.3, '$0.300'],
    // 🔴 cache_read 常见 0.005 这种量级：两位小数会直接抹成 $0.00（= 免费，是谎）。
    [0.005, '$0.0050'],
    [15, '$15.00']
  ])('%s → %s', (input, expected) => {
    expect(formatPrice(input)).toBe(expected)
  })
})
