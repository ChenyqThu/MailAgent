// @vitest-environment happy-dom

// Sprint 19 polish — TranslatedBody streaming markdown auto-balance test.
//
// LLM stream 期间 chunk 到一半可能含 unclosed `**bold` 或 `\`code\``,
// 之前 renderInline regex 要闭合 → 屏幕显示 raw `**xxx` 直到下个 chunk
// 到 closing `**` 才突然 bold (视觉跳动). autoBalanceTrailingMarkers
// preprocess 让 streaming 中也立即 bold 显示, stream done 后行为一致.

import { describe, expect, test } from 'vitest'
import { __testing } from '../../src/shared/components/email/TranslatedBody'

const { autoBalanceTrailingMarkers, markdownToSafeHtml } = __testing

describe('autoBalanceTrailingMarkers (PR-2g polish)', () => {
  test('完整 bold 不动', () => {
    expect(autoBalanceTrailingMarkers('**bold**')).toBe('**bold**')
  })

  test('unclosed bold append **', () => {
    expect(autoBalanceTrailingMarkers('AI 标签是 **重要')).toBe('AI 标签是 **重要**')
  })

  test('多 bold 段末尾 unclosed', () => {
    expect(autoBalanceTrailingMarkers('**A** and **B** plus **C')).toBe(
      '**A** and **B** plus **C**'
    )
  })

  test('完整 inline code 不动', () => {
    expect(autoBalanceTrailingMarkers('use `git status` here')).toBe('use `git status` here')
  })

  test('unclosed code append `', () => {
    expect(autoBalanceTrailingMarkers('use `git status here')).toBe('use `git status here`')
  })

  test('混合 unclosed bold + code 都补', () => {
    const out = autoBalanceTrailingMarkers('运行 `redis-cli 并查看 **状态')
    // 双星 count = 1 odd → append **; 反引号 count = 1 odd → append `
    expect(out).toBe('运行 `redis-cli 并查看 **状态**`')
  })

  test('偶数 bold count 不动', () => {
    expect(autoBalanceTrailingMarkers('**a** **b** **c**')).toBe('**a** **b** **c**')
  })

  test('空 / 空白 no-op', () => {
    expect(autoBalanceTrailingMarkers('')).toBe('')
    expect(autoBalanceTrailingMarkers('   ')).toBe('   ')
  })
})

describe('markdownToSafeHtml 流式 bold 立即 render', () => {
  test('完整 bold → <strong>', () => {
    const html = markdownToSafeHtml('please **note** this')
    expect(html).toContain('<strong>note</strong>')
  })

  test('unclosed bold 流式中立即 bold (auto-close)', () => {
    const html = markdownToSafeHtml('AI 标签是 **重要')
    expect(html).toContain('<strong>重要</strong>')
    // 不残留 raw '**'
    expect(html).not.toMatch(/\*\*/)
  })

  test('unclosed code 流式中立即 code', () => {
    const html = markdownToSafeHtml('use `git status here')
    expect(html).toContain('<code>git status here</code>')
  })

  test('多个 bold 段都正确 render', () => {
    const html = markdownToSafeHtml('**A** and **B** plus **C')
    expect((html.match(/<strong>/g) ?? []).length).toBe(3)
  })

  test('空字符串 no-op', () => {
    expect(markdownToSafeHtml('')).toBe('')
  })
})
