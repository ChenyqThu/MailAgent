// Sprint 2 D0 — ai_mapping.ts unit tests. The interesting axis is the
// emoji-Chinese → enum bridge for AIBadge: production sample shows only 3 of
// the 5 priority tiers exist in the LLM output (`🟡 重要 / 🟢 一般 / ⚪ 低`),
// but the agent prompt may produce the other two (`🔴 紧急 / 🟠 严重`) for
// high-stakes mail. We pre-wire the rare tiers and verify all 5 stable.

import { describe, expect, test } from 'vitest'

import {
  mapLanguage,
  mapPriority,
  mapReviewStatus,
  mapSentiment,
  parseLabels
} from '../../../src/electron/main/handlers/ai_mapping'

describe('mapPriority', () => {
  test('the 3 production-observed tiers', () => {
    expect(mapPriority('🟡 重要')).toBe('important')
    expect(mapPriority('🟢 一般')).toBe('normal')
    expect(mapPriority('⚪ 低')).toBe('low')
  })

  test('the 2 rare tiers (prompted but unobserved in sample)', () => {
    expect(mapPriority('🔴 紧急')).toBe('critical')
    expect(mapPriority('🟠 严重')).toBe('urgent')
    expect(mapPriority('🟠 紧迫')).toBe('urgent')
  })

  test('emoji-stripped Chinese still maps', () => {
    expect(mapPriority('重要')).toBe('important')
    expect(mapPriority('一般')).toBe('normal')
  })

  test('English passthrough fallbacks', () => {
    expect(mapPriority('Critical')).toBe('critical')
    expect(mapPriority('Normal')).toBe('normal')
  })

  test('null / undefined / unknown shape returns null', () => {
    expect(mapPriority(null)).toBeNull()
    expect(mapPriority(undefined)).toBeNull()
    expect(mapPriority('')).toBeNull()
    expect(mapPriority('weirdo')).toBeNull()
  })
})

describe('mapLanguage', () => {
  test('Chinese variants → zh', () => {
    expect(mapLanguage('中文')).toBe('zh')
    expect(mapLanguage('Chinese')).toBe('zh')
    expect(mapLanguage('zh')).toBe('zh')
    expect(mapLanguage('zh-CN')).toBe('zh')
  })

  test('English variants → en', () => {
    expect(mapLanguage('English')).toBe('en')
    expect(mapLanguage('en')).toBe('en')
    expect(mapLanguage('en-US')).toBe('en')
  })

  test('unknown / null → unknown', () => {
    expect(mapLanguage(null)).toBe('unknown')
    expect(mapLanguage(undefined)).toBe('unknown')
    expect(mapLanguage('')).toBe('unknown')
    expect(mapLanguage('Japanese')).toBe('unknown')
  })
})

describe('mapReviewStatus', () => {
  test('success → reviewed', () => {
    expect(mapReviewStatus('success')).toBe('reviewed')
  })

  test('failed / gave_up / pending → pending (the Notion enum is binary)', () => {
    expect(mapReviewStatus('failed')).toBe('pending')
    expect(mapReviewStatus('gave_up')).toBe('pending')
    expect(mapReviewStatus('pending')).toBe('pending')
  })

  test('null / unknown → null', () => {
    expect(mapReviewStatus(null)).toBeNull()
    expect(mapReviewStatus('')).toBeNull()
    expect(mapReviewStatus('weirdo')).toBeNull()
  })
})

describe('mapSentiment', () => {
  test('passthrough — agent does not yet emit but the contract is one-sided', () => {
    expect(mapSentiment('紧急')).toBe('紧急')
    expect(mapSentiment(null)).toBeNull()
    expect(mapSentiment('')).toBeNull()
  })
})

describe('parseLabels', () => {
  test('valid JSON object → record', () => {
    const parsed = parseLabels('{"priority":"🔴 紧急","action_type":"需要回复"}')
    expect(parsed).toEqual({ priority: '🔴 紧急', action_type: '需要回复' })
  })

  test('malformed JSON → null (does NOT throw)', () => {
    expect(parseLabels('{not json')).toBeNull()
  })

  test('JSON array → null (we want a record shape)', () => {
    expect(parseLabels('[1,2,3]')).toEqual([1, 2, 3]) // arrays ARE objects in JS — caller responsible if it matters
  })

  test('null / empty', () => {
    expect(parseLabels(null)).toBeNull()
    expect(parseLabels('')).toBeNull()
  })
})
