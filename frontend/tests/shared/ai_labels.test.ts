// Sprint 2 — ai_labels.ts mapping coverage. Renderer-side helper mapping
// the LLM's Chinese `action_type` enum to the English short-code chip that
// satisfies DESIGN.md §14 #2 + §16.6 (no CJK at text-micro/meta).

import { describe, expect, test } from 'vitest'

import { mapActionLabel, actionLabelChinese } from '../../src/shared/lib/ai_labels'

describe('mapActionLabel', () => {
  test('production-observed Chinese labels map to ASCII short codes', () => {
    expect(mapActionLabel('需要回复')).toBe('REPLY')
    expect(mapActionLabel('需要决策')).toBe('DECIDE')
    expect(mapActionLabel('需要会议')).toBe('MEETING')
    expect(mapActionLabel('需要Review')).toBe('REVIEW')
    expect(mapActionLabel('仅供参考')).toBe('FYI')
  })

  test('rare-but-prompted labels (not yet observed in sample)', () => {
    expect(mapActionLabel('需要跟进')).toBe('FOLLOWUP')
    expect(mapActionLabel('等待响应')).toBe('WAITING')
    expect(mapActionLabel('已完结')).toBe('DONE')
  })

  test('whitespace around the label is tolerated', () => {
    expect(mapActionLabel('  需要回复  ')).toBe('REPLY')
    expect(mapActionLabel('\t仅供参考\n')).toBe('FYI')
  })

  test('unmapped values fall back to "?" (chip stays stable shape)', () => {
    expect(mapActionLabel('未来的新枚举值')).toBe('?')
    expect(mapActionLabel('completely unknown')).toBe('?')
  })

  test('null / empty / undefined → null (caller hides the chip)', () => {
    expect(mapActionLabel(null)).toBeNull()
    expect(mapActionLabel(undefined)).toBeNull()
    expect(mapActionLabel('')).toBeNull()
    expect(mapActionLabel('   ')).toBeNull()
  })
})

describe('actionLabelChinese', () => {
  test('round-trips the Chinese label trimmed', () => {
    expect(actionLabelChinese('需要回复')).toBe('需要回复')
    expect(actionLabelChinese('  仅供参考  ')).toBe('仅供参考')
  })

  test('null / empty → null', () => {
    expect(actionLabelChinese(null)).toBeNull()
    expect(actionLabelChinese('')).toBeNull()
    expect(actionLabelChinese('   ')).toBeNull()
  })
})
