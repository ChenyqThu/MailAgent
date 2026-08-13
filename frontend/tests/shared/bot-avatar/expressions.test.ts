// v2 表情参数表形状闸 —— 25 表情 × 15 数值参数（v1 是烘焙点云 expressions.json，
// 已随引擎换代退役）。索引 0-24 的语义被 states.ts POOLS 引用：改表 = 改所有引用
// 该索引的状态的脸，本闸保证结构不静默漂（字段缺失/NaN 会让插值产出 NaN path）。

import { describe, expect, test } from 'vitest'

import { EXPRESSIONS, NEUTRAL_EXPRESSION } from '../../../src/shared/bot-avatar/expressions'
import { expressionFields } from '../../../src/shared/bot-avatar/geometry'

describe('bot-avatar 表情参数表', () => {
  test('形状钉死：25 表情，id 唯一且按索引编号', () => {
    expect(EXPRESSIONS).toHaveLength(25)
    const ids = EXPRESSIONS.map((e) => e.id)
    expect(new Set(ids).size).toBe(25)
    EXPRESSIONS.forEach((e, i) => {
      expect(e.id).toBe(`expression-${String(i).padStart(2, '0')}`)
    })
  })

  test('全部数值字段有限（15 字段 × 25 行 + 中性表情）', () => {
    for (const expression of [...EXPRESSIONS, NEUTRAL_EXPRESSION]) {
      for (const field of expressionFields) {
        expect(Number.isFinite(expression[field]), `${expression.id}.${field}`).toBe(true)
      }
    }
  })

  test('眼睛尺寸为正、perspective 恒 1（透视基线，改它是全局视觉决策）', () => {
    for (const expression of EXPRESSIONS) {
      expect(expression.widthLeft).toBeGreaterThan(0)
      expect(expression.widthRight).toBeGreaterThan(0)
      expect(expression.heightLeft).toBeGreaterThan(0)
      expect(expression.heightRight).toBeGreaterThan(0)
      expect(expression.spacing).toBeGreaterThan(0)
      expect(expression.perspective).toBe(1)
    }
  })
})
