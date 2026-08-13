// v2 表情参数表形状闸 —— 27 表情 × 15 数值参数（0813 起 = avatar-lab studio 精修表，
// 替换第一版移植的 presets.ts calibrated 25 行老表）。索引 0-26 的语义被 states.ts
// POOLS 引用：改表 = 改所有引用该索引的状态的脸，本闸保证结构不静默漂（字段缺失/
// NaN 会让插值产出 NaN path）。
// 🔴 studio 文档里 expressions 数组是**乱序**的（按编辑历史排）——本表必须按 id
// 编号重排后索引才与 POOLS 对齐，「值 pin」测试钉住这次搬运没有把顺序搬错。

import { describe, expect, test } from 'vitest'

import { EXPRESSIONS, NEUTRAL_EXPRESSION } from '../../../src/shared/bot-avatar/expressions'
import { expressionFields } from '../../../src/shared/bot-avatar/geometry'

describe('bot-avatar 表情参数表', () => {
  test('形状钉死：27 表情，id 唯一且按索引编号', () => {
    expect(EXPRESSIONS).toHaveLength(27)
    const ids = EXPRESSIONS.map((e) => e.id)
    expect(new Set(ids).size).toBe(27)
    EXPRESSIONS.forEach((e, i) => {
      expect(e.id).toBe(`expression-${String(i).padStart(2, '0')}`)
    })
  })

  test('值 pin：studio 精修值而非 presets 老表，且乱序源已按 id 重排', () => {
    // studio 文档源序第 3 位是 expression-05、第 6 位是 expression-03 —— 若按源序
    // 直搬（没按 id 重排），下面按索引取值的断言全红。
    // expression-00：studio widthLeft 22.501…（presets 老表是 24.2）——证明换的是精修表
    expect(EXPRESSIONS[0].widthLeft).toBeCloseTo(22.501171874999997, 10)
    expect(EXPRESSIONS[0].positionYLeft).toBe(-20.5)
    // expression-01：studio headX -15.057…（老表 -35.6）
    expect(EXPRESSIONS[1].headX).toBeCloseTo(-15.057812500000004, 10)
    // expression-05：双眼不对称（挑眉脸）—— 乱序源里它排在第 3 位
    expect(EXPRESSIONS[5].widthLeft).toBeCloseTo(23.090625, 10)
    expect(EXPRESSIONS[5].widthRight).toBeCloseTo(49.924609375, 10)
    // expression-24：眼睛纬度 40（低头看）—— studio 表里唯一的大正纬度
    expect(EXPRESSIONS[24].positionYLeft).toBe(40)
    // expression-25/26：studio 新增两条（原 uuid id，按本仓惯例重编号）
    expect(EXPRESSIONS[25].leftAngle).toBeCloseTo(-36.244531249999994, 10)
    expect(EXPRESSIONS[26].headX).toBeCloseTo(-12.303515625, 10)
    // 26 与 8 参数同值是上游事实（差异只在本仓不收的 per-expression 动效字段）
    for (const field of expressionFields) {
      expect(EXPRESSIONS[26][field]).toBe(EXPRESSIONS[8][field])
    }
  })

  test('全部数值字段有限（15 字段 × 27 行 + 中性表情）', () => {
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
