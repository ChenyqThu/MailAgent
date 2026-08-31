// P4a agent-config lane — 配置页纯逻辑 helper 的单测（变异验证 ③ 的落点：把
// testSubjectsAgainst 的 regex 应用改坏（如恒 true / 不用 pattern）必须红）。
import { describe, expect, test } from 'vitest'

import {
  compileSubjectRegex,
  parseNotionDatabaseId,
  testSubjectsAgainst
} from '../../src/shared/components/agents/settings/lib'

describe('compileSubjectRegex', () => {
  test('合法正则 → ok', () => {
    const r = compileSubjectRegex('周报|weekly')
    expect(r.ok).toBe(true)
  })

  test('非法正则 → ok=false 且带错误信息', () => {
    const r = compileSubjectRegex('([unclosed')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })
})

describe('testSubjectsAgainst（re.search 语义：无锚点子串命中）', () => {
  test('逐条命中判定与输入顺序对齐', () => {
    const hits = testSubjectsAgainst('周报', [
      '【周报】W35 项目进展',
      'Re: 会议纪要',
      '2026 周报汇总',
      ''
    ])
    expect(hits).toEqual([true, false, true, false])
  })

  test('真实正则（交替 + 锚点）按 pattern 判，不是子串包含', () => {
    const hits = testSubjectsAgainst('^\\[W\\d+\\]', ['[W35] progress', 'progress [W35]'])
    // 锚点生效：只有开头命中的那条为 true —— 若实现退化成 includes/恒 true，这里必红。
    expect(hits).toEqual([true, false])
  })

  test('pattern 编译失败 → null（区别于全部未命中）', () => {
    expect(testSubjectsAgainst('([bad', ['x'])).toBeNull()
  })
})

describe('parseNotionDatabaseId', () => {
  test('空串 → empty', () => {
    expect(parseNotionDatabaseId('  ')).toEqual({ kind: 'empty' })
  })

  test('32 位裸 hex → id', () => {
    expect(parseNotionDatabaseId('f8455e24c3b1432aab206d23301f02b8')).toEqual({
      kind: 'id',
      id: 'f8455e24c3b1432aab206d23301f02b8'
    })
  })

  test('带连字符 uuid → id（原样保留，不静默改写）', () => {
    const dashed = 'f8455e24-c3b1-432a-ab20-6d23301f02b8'
    expect(parseNotionDatabaseId(dashed)).toEqual({ kind: 'id', id: dashed })
  })

  test('Notion 链接 → url + 提取出的 32-hex（取 query 前最后一段）', () => {
    const parsed = parseNotionDatabaseId(
      'https://www.notion.so/tp-link/f8455e24c3b1432aab206d23301f02b8?v=e3734264073d444496d01bec71d9452e'
    )
    expect(parsed).toEqual({ kind: 'url', id: 'f8455e24c3b1432aab206d23301f02b8' })
  })

  test('标题里的 hex 片段与 ID 连成一串时，取串尾 32 位（ID 恒在末尾）', () => {
    const parsed = parseNotionDatabaseId(
      'https://www.notion.so/ws/abcdef-db-f8455e24c3b1432aab206d23301f02b8'
    )
    expect(parsed).toEqual({ kind: 'url', id: 'f8455e24c3b1432aab206d23301f02b8' })
  })

  test('随手打的字符串 → invalid', () => {
    expect(parseNotionDatabaseId('我的项目库')).toEqual({ kind: 'invalid' })
    expect(parseNotionDatabaseId('https://example.com/nothing-here')).toEqual({ kind: 'invalid' })
  })
})
