// 「背景与目标」分段解析 / 序列化（08-18 owner 推翻裁决 D5）。
//
// 存储仍是单个 `matter.description`，两段靠 `## 背景` / `## 目标` 分开 —— 所以读态渲染、
// 编辑态预填、保存三处必须用同一套判据。这里直测那一处纯函数。

import { describe, expect, test } from 'vitest'

import {
  parseMatterDescription,
  serializeMatterDescription
} from '@shared/components/matters/matterDescription'

describe('parseMatterDescription', () => {
  test('splits on the 背景 / 目标 headings', () => {
    const parsed = parseMatterDescription(
      '## 背景\n三方排期互相不认。\n\n## 目标\n拿到一份都认的排期。'
    )
    expect(parsed).toEqual({
      background: '三方排期互相不认。',
      goal: '拿到一份都认的排期。',
      legacy: false
    })
  })

  test('keeps 目标 first when the author wrote it first', () => {
    const parsed = parseMatterDescription('## 目标\nG\n\n## 背景\nB')
    expect(parsed.background).toBe('B')
    expect(parsed.goal).toBe('G')
    expect(parsed.legacy).toBe(false)
  })

  test('a single 目标 heading leaves 背景 empty (and is not legacy)', () => {
    const parsed = parseMatterDescription('## 目标\n只写了目标')
    expect(parsed).toEqual({ background: '', goal: '只写了目标', legacy: false })
  })

  test('a single 背景 heading leaves 目标 empty (and is not legacy)', () => {
    const parsed = parseMatterDescription('## 背景\n只写了背景')
    expect(parsed).toEqual({ background: '只写了背景', goal: '', legacy: false })
  })

  // 🔴 老数据的判据：一个小标题都没有 ⇒ 整串算「目标」（老字段本来就叫「核心目标」）。
  test('legacy text without any heading becomes 目标, not 背景', () => {
    const parsed = parseMatterDescription('**背景重点** 客户要在 Q3 上线。')
    expect(parsed).toEqual({
      background: '',
      goal: '**背景重点** 客户要在 Q3 上线。',
      legacy: true
    })
  })

  test('empty description is not flagged as legacy', () => {
    expect(parseMatterDescription('')).toEqual({ background: '', goal: '', legacy: false })
    expect(parseMatterDescription('   \n\n ')).toEqual({
      background: '',
      goal: '',
      legacy: false
    })
  })

  test('prose before the first heading goes to 背景', () => {
    const parsed = parseMatterDescription('开场白\n## 目标\nG')
    expect(parsed.background).toBe('开场白')
    expect(parsed.goal).toBe('G')
    expect(parsed.legacy).toBe(false)
  })

  test('repeated headings merge instead of dropping content', () => {
    const parsed = parseMatterDescription('## 背景\nB1\n\n## 目标\nG\n\n## 背景\nB2')
    expect(parsed.background).toBe('B1\n\nB2')
    expect(parsed.goal).toBe('G')
  })

  test('a heading-looking line that carries extra text is body, not a heading', () => {
    const parsed = parseMatterDescription('## 背景补充\nX')
    expect(parsed).toEqual({ background: '', goal: '## 背景补充\nX', legacy: true })
  })

  test('markdown body under a heading survives verbatim', () => {
    const parsed = parseMatterDescription('## 背景\n- 一\n- 二\n\n### 细节\n正文\n\n## 目标\nG')
    expect(parsed.background).toBe('- 一\n- 二\n\n### 细节\n正文')
    expect(parsed.goal).toBe('G')
  })
})

describe('serializeMatterDescription', () => {
  test('writes both sections separated by a blank line', () => {
    expect(serializeMatterDescription({ background: 'B', goal: 'G' })).toBe(
      '## 背景\nB\n\n## 目标\nG'
    )
  })

  // 🔴 空段整段省略 —— 不留一个孤零零的 `## 背景` 让读态渲染出空分区。
  test('omits an empty section entirely', () => {
    expect(serializeMatterDescription({ background: '', goal: 'G' })).toBe('## 目标\nG')
    expect(serializeMatterDescription({ background: 'B', goal: '   ' })).toBe('## 背景\nB')
  })

  test('both empty yields an empty string', () => {
    expect(serializeMatterDescription({ background: '', goal: '' })).toBe('')
    expect(serializeMatterDescription({ background: ' \n ', goal: '\n' })).toBe('')
  })

  test('round-trips a two-section description', () => {
    const original = '## 背景\nB1\nB2\n\n## 目标\nG'
    expect(serializeMatterDescription(parseMatterDescription(original))).toBe(original)
  })

  test('legacy text round-trips into the 目标 section', () => {
    const parsed = parseMatterDescription('老的核心目标一句话')
    expect(serializeMatterDescription(parsed)).toBe('## 目标\n老的核心目标一句话')
  })
})
