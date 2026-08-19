import { describe, expect, it } from 'vitest'

import { diffGoalChecks } from '@shared/components/matters/goalChecksDiff'

/**
 * S3 —— 完成标志提案的 diff。
 *
 * 提案发的是**整表替换**（完整清单，不是 delta），但 owner 要判断的是「相对现在动了什么」。
 * 🔴 判据必须是**文本**不是下标：agent 重排顺序或在中间插一条，按下标比会把整份清单
 * 读成「全改了」，owner 就没法审了。
 */
describe('diffGoalChecks', () => {
  const before = [
    { t: '合同已签署', done: false },
    { t: '款项已到账', done: false }
  ]

  it('新增', () => {
    const diff = diffGoalChecks(before, [...before, { t: '交付验收', done: false }])
    expect(diff.added.map((c) => c.t)).toEqual(['交付验收'])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toBe(2)
  })

  it('删除', () => {
    const diff = diffGoalChecks(before, [before[0]])
    expect(diff.removed.map((c) => c.t)).toEqual(['款项已到账'])
    expect(diff.added).toEqual([])
  })

  it('勾选态翻转算 toggled，不算增删', () => {
    const diff = diffGoalChecks(before, [{ t: '合同已签署', done: true }, before[1]])
    expect(diff.toggled.map((c) => c.t)).toEqual(['合同已签署'])
    expect(diff.toggled[0].done).toBe(true)
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toBe(1)
  })

  it('🔴 重排顺序不算任何变化（按文本比，不按下标）', () => {
    const diff = diffGoalChecks(before, [before[1], before[0]])
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
    expect(diff.toggled).toEqual([])
    expect(diff.unchanged).toBe(2)
  })

  it('🔴 在中间插一条只报那一条（下标比会报「全改了」）', () => {
    const diff = diffGoalChecks(before, [before[0], { t: '插进来的', done: false }, before[1]])
    expect(diff.added.map((c) => c.t)).toEqual(['插进来的'])
    expect(diff.removed).toEqual([])
    expect(diff.unchanged).toBe(2)
  })

  it('坏形状被丢弃而不是崩掉（提案 payload 是 unknown）', () => {
    const diff = diffGoalChecks(before, [null, 'x', { t: '  ' }, { t: '真的', done: true }, {}])
    expect(diff.added.map((c) => c.t)).toEqual(['真的'])
    expect(diff.removed.map((c) => c.t)).toEqual(['合同已签署', '款项已到账'])
  })

  it('两侧都不是数组 → 空 diff', () => {
    expect(diffGoalChecks(undefined, null)).toEqual({
      added: [],
      removed: [],
      toggled: [],
      unchanged: 0
    })
  })

  it('done 缺省视为 false（与后端 normalize_goal_checks 同款）', () => {
    const diff = diffGoalChecks([{ t: 'a', done: false }], [{ t: 'a' }])
    expect(diff.toggled).toEqual([])
    expect(diff.unchanged).toBe(1)
  })
})
