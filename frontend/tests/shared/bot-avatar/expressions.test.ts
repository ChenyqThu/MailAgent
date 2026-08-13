// expressions.json 形状闸 —— 25 表情 × 2 眼 × 48 点。
// 点数恒等是弹簧 morph 逐点 lerp 的前提（grokbot-engine-analysis.md §4.1）：
// 任何一只眼点数漂移，morph 会读到 undefined 直接产出 NaN path。数据由脚本
// 从原型 HTML 抽取，勿手改 —— 本闸保证重抽/替换数据集时形状契约不破。

import { describe, expect, test } from 'vitest'

import EXPRESSIONS from '../../../src/shared/bot-avatar/expressions.json'

describe('bot-avatar expressions.json', () => {
  test('形状钉死：25 表情 × 2 眼 × 48 点', () => {
    expect(EXPRESSIONS).toHaveLength(25)
    for (const frame of EXPRESSIONS) {
      expect(frame).toHaveLength(2)
      for (const ring of frame) {
        expect(ring).toHaveLength(48)
      }
    }
  })

  test('全部点是有限数值对', () => {
    for (const frame of EXPRESSIONS) {
      for (const ring of frame) {
        for (const point of ring) {
          expect(point).toHaveLength(2)
          expect(Number.isFinite(point[0])).toBe(true)
          expect(Number.isFinite(point[1])).toBe(true)
        }
      }
    }
  })
})
