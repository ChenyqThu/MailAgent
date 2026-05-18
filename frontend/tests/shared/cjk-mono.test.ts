// Sprint 5 Day 1 (opus M carry-forward) — locale-conditional class swap.
//
// `useCjkMonoSwap` returns the original mono className for English/Latin
// locales, and the CJK-safe sans className (default `text-aux`) when
// `i18n.language` starts with zh/ja/ko. Mocks i18next to drive both
// branches without a full Suspense / provider setup.

import { describe, expect, test, vi } from 'vitest'

import { isCjkLocale, useCjkMonoSwap } from '../../src/shared/i18n/cjk-mono'

vi.mock('react-i18next', () => ({
  useTranslation: (): { i18n: { language: string } } => ({
    i18n: { language: globalThis.__TEST_LOCALE__ as string }
  })
}))

declare global {
  // eslint-disable-next-line no-var
  var __TEST_LOCALE__: string
}

describe('isCjkLocale', () => {
  test.each(['zh', 'zh-CN', 'ZH-cn', 'zh_TW', 'ja', 'ja-JP', 'ko', 'ko-KR'])(
    'detects CJK locale %s',
    (locale) => {
      expect(isCjkLocale(locale)).toBe(true)
    }
  )

  test.each(['en', 'en-US', 'fr', 'de-DE', '', null, undefined])(
    'returns false for non-CJK locale %s',
    (locale) => {
      expect(isCjkLocale(locale as string | null | undefined)).toBe(false)
    }
  )
})

describe('useCjkMonoSwap', () => {
  test('returns the mono className unchanged for en-US', () => {
    globalThis.__TEST_LOCALE__ = 'en-US'
    const klass = useCjkMonoSwap('text-micro font-mono uppercase tracking-wider')
    expect(klass).toBe('text-micro font-mono uppercase tracking-wider')
  })

  test('returns the cjk className for zh-CN (default text-aux)', () => {
    globalThis.__TEST_LOCALE__ = 'zh-CN'
    const klass = useCjkMonoSwap('text-micro font-mono uppercase tracking-wider')
    expect(klass).toBe('text-aux')
  })

  test('honours a custom cjk class', () => {
    globalThis.__TEST_LOCALE__ = 'ja-JP'
    const klass = useCjkMonoSwap('text-meta font-mono', 'text-aux font-sans')
    expect(klass).toBe('text-aux font-sans')
  })
})
