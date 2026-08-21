// task 08-20 — notionDbSchema 契约校验器（纯函数，单源 = notionDbSchema.contract.json）。
//
// 覆盖：两档校验（required 缺失 → invalid+missing；recommended 缺失 → 仅 warnings）/
// 类型不符清单 / 签名分类（email·calendar·unknown）/ 双签名歧义（多 data source 场景
// 的「无法唯一识别」判据底座）。
// 🔴 新断言均做过变异验证（把被测逻辑临时改坏确认变红再还原，见任务执行记录）。

import { describe, expect, test } from 'vitest'

import {
  classifyDataSource,
  NOTION_API_VERSION,
  recommendedProperties,
  requiredProperties,
  validateDataSourceProperties,
  type NotionPropertyLike
} from '../../../src/shared/lib/notionDbSchema'

type Props = Record<string, NotionPropertyLike | undefined>

/** 按契约生成一套完整合法的 properties（required + recommended 全齐）。 */
function fullProps(role: 'email' | 'calendar'): Props {
  const out: Props = {}
  for (const p of requiredProperties(role)) out[p.name] = { type: p.type }
  for (const p of recommendedProperties(role)) out[p.name] = { type: p.type }
  return out
}

describe('contract shape', () => {
  test('Notion-Version 常量固定 2025-09-03（data source 语义）', () => {
    expect(NOTION_API_VERSION).toBe('2025-09-03')
  })

  test('契约字段数钉死（写入侧来源：pages.py+threads.py / calendar sync.py / notion_writer.py）', () => {
    expect(requiredProperties('email')).toHaveLength(17)
    expect(recommendedProperties('email')).toHaveLength(13)
    expect(requiredProperties('calendar')).toHaveLength(18)
    expect(recommendedProperties('calendar')).toHaveLength(0)
  })

  test('真名以写入侧代码为准（CLAUDE.md 旧表的 AI 前缀名不存在）', () => {
    const emailNames = new Set(
      [...requiredProperties('email'), ...recommendedProperties('email')].map((p) => p.name)
    )
    expect(emailNames.has('Priority')).toBe(true)
    expect(emailNames.has('Action Type')).toBe(true)
    expect(emailNames.has('Processing Status')).toBe(true)
    expect(emailNames.has('AI Priority')).toBe(false)
    expect(emailNames.has('AI Action')).toBe(false)
    expect(emailNames.has('AI Review Status')).toBe(false)
  })

  test('签名字段按 design 钉死', () => {
    const sig = (role: 'email' | 'calendar'): Record<string, string> =>
      Object.fromEntries(
        requiredProperties(role)
          .filter((p) => p.signature)
          .map((p) => [p.name, p.type])
      )
    expect(sig('email')).toEqual({ Subject: 'title', 'Message ID': 'rich_text' })
    expect(sig('calendar')).toEqual({ 'Event ID': 'rich_text', Time: 'date' })
  })
})

describe('validateDataSourceProperties（两档）', () => {
  test('required + recommended 全齐 → valid, missing/warnings 皆空', () => {
    const res = validateDataSourceProperties('email', fullProps('email'))
    expect(res.valid).toBe(true)
    expect(res.missing).toEqual([])
    expect(res.warnings).toEqual([])
  })

  test('required 缺字段 → invalid + 具体清单（名字 + 期望类型）', () => {
    const props = fullProps('email')
    delete props['Message ID']
    delete props['Parent Item']
    const res = validateDataSourceProperties('email', props)
    expect(res.valid).toBe(false)
    expect(res.missing).toContain('Message ID (rich_text)')
    expect(res.missing).toContain('Parent Item (relation)')
    expect(res.missing).toHaveLength(2)
    expect(res.warnings).toEqual([])
  })

  test('recommended 缺字段 → 只 warn 不拦（valid 保持 true）', () => {
    const props = fullProps('email')
    delete props['Priority']
    delete props['Reply Suggestion']
    const res = validateDataSourceProperties('email', props)
    expect(res.valid).toBe(true)
    expect(res.missing).toEqual([])
    expect(res.warnings).toContain('Priority (select)')
    expect(res.warnings).toContain('Reply Suggestion (rich_text)')
    expect(res.warnings).toHaveLength(2)
  })

  test('类型不符 → invalid + 清单里标出现有类型', () => {
    const props = fullProps('calendar')
    props['Time'] = { type: 'rich_text' }
    const res = validateDataSourceProperties('calendar', props)
    expect(res.valid).toBe(false)
    expect(res.missing).toEqual(['Time (date, 现为 rich_text)'])
  })
})

describe('classifyDataSource（按 schema 签名不按标题）', () => {
  test('邮件签名（Subject title + Message ID）→ email，字段不全也识别得出角色', () => {
    // 只有签名字段 —— 分类是签名判据，完整性由 validate 另管。
    expect(
      classifyDataSource({ Subject: { type: 'title' }, 'Message ID': { type: 'rich_text' } })
    ).toBe('email')
  })

  test('日历签名（Event ID + Time date）→ calendar', () => {
    expect(classifyDataSource({ 'Event ID': { type: 'rich_text' }, Time: { type: 'date' } })).toBe(
      'calendar'
    )
  })

  test('签名类型不符 → 不算命中（Subject 非 title 不是邮件库）', () => {
    expect(
      classifyDataSource({ Subject: { type: 'rich_text' }, 'Message ID': { type: 'rich_text' } })
    ).toBe('unknown')
  })

  test('双签名同时命中 → unknown（无法唯一识别，进选择器）', () => {
    expect(
      classifyDataSource({
        Subject: { type: 'title' },
        'Message ID': { type: 'rich_text' },
        'Event ID': { type: 'rich_text' },
        Time: { type: 'date' }
      })
    ).toBe('unknown')
  })

  test('两个签名都不命中 → unknown（Daily Digests 类第三库自然落选）', () => {
    expect(classifyDataSource({ Name: { type: 'title' }, Date: { type: 'date' } })).toBe('unknown')
  })
})
