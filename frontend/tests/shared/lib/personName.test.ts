// 人名 initials 单源（personName.ts::contactInitials）行为闸。
//
// 背景：小尺寸头像圆里 2 个中文字放不下（compose 收件人 chip 18px 圆，「刘宇皓」
// 渲染成两个字挤满整圆、贴边溢出）。修复：size 感知——size < INITIALS_SINGLE_GLYPH_MAX_SIZE
// 时中文只取首字（姓）；size 省略 = 现行为（后 2 字）不回退；拉丁 2 字母不受影响
// （字形窄，18px 圆里本来就放得下）。
import { describe, expect, test } from 'vitest'

import { INITIALS_SINGLE_GLYPH_MAX_SIZE, contactInitials } from '../../../src/shared/lib/personName'

describe('contactInitials', () => {
  test('中文 3 字名 + 小尺寸（18px） → 只取首字（姓）', () => {
    expect(contactInitials('刘宇皓', 'liu@example.com', 18)).toBe('刘')
  })

  test('同名 + 大尺寸（32px） → 后 2 字（现行为不回退）', () => {
    expect(contactInitials('刘宇皓', 'liu@example.com', 32)).toBe('宇皓')
  })

  test('中文名 + 阈值边界（size = INITIALS_SINGLE_GLYPH_MAX_SIZE）→ 达到阈值即用后 2 字', () => {
    expect(contactInitials('刘宇皓', 'liu@example.com', INITIALS_SINGLE_GLYPH_MAX_SIZE)).toBe(
      '宇皓'
    )
    expect(contactInitials('刘宇皓', 'liu@example.com', INITIALS_SINGLE_GLYPH_MAX_SIZE - 1)).toBe(
      '刘'
    )
  })

  test('size 省略 → 后 2 字（现行为）', () => {
    expect(contactInitials('刘宇皓', 'liu@example.com')).toBe('宇皓')
  })

  test('拉丁双词 + 小尺寸（18px） → 两个首字母，不被砍成单字', () => {
    expect(contactInitials('John Doe', 'john@example.com', 18)).toBe('JD')
  })

  test('裸邮箱（无 name）→ 取 local-part', () => {
    expect(contactInitials('', 'alice@example.com')).toBe('AL')
    expect(contactInitials('', 'alice@example.com', 18)).toBe('AL')
  })

  test('空串（无 name 无 email）→ 兜底 "?"', () => {
    expect(contactInitials('', '')).toBe('?')
  })
})

// 干系人卡 mockup 验收用例（`frontend/mockups/stakeholder/initials.ts::INITIALS_CASES`
// 逐条搬来）。起因：`Lucien Chen（陈源泉）` 被取成「泉）」—— 一见中文就 slice(-2)，
// 把全角右括号也算进名字了。
describe('contactInitials —— 括注（英文名（中文名））', () => {
  const CASES: [name: string, want: string][] = [
    ['Lucien Chen（陈源泉）', 'LC'],
    ['Echo Liu', 'EL'],
    ['唐铭阳', '铭阳'],
    ['孙晓宇', '晓宇'],
    ['陈源泉（Lucien）', '源泉'],
    ['曾东彪', '东彪'],
    ['（陈源泉）', '源泉'],
    ['Jean-Paul Sartre', 'JS'],
    ['赖涵', '赖涵']
  ]

  test.each(CASES)('%s → %s', (name, want) => {
    expect(contactInitials(name, 'someone@example.com')).toBe(want)
  })

  test('剥完括注是中文 + 小尺寸 → 仍只取姓（size 语义不被括注处理吃掉）', () => {
    expect(contactInitials('陈源泉（Lucien）', 'chen@example.com', 18)).toBe('陈')
  })

  test('剥完括注是拉丁 → 走拉丁分支，不受 size 影响', () => {
    expect(contactInitials('Lucien Chen（陈源泉）', 'chen@example.com', 18)).toBe('LC')
  })

  test('中文名后缀非 CJK 字符（未配对括号 / 混排）→ 只在 CJK 字里取', () => {
    expect(contactInitials('陈源泉)', 'chen@example.com')).toBe('源泉')
    expect(contactInitials('陈源泉 Lucien', 'chen@example.com')).toBe('源泉')
  })
})
