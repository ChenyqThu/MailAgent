// Search-module 1:1 mockup-search.html — highlightTerms / extractTerms unit tests.
//
// Covers the palette's subject-highlight pipeline; backend snippet() already
// emits `<mark>` for body matches so it goes through DOMPurify directly
// without this util.

import { describe, expect, test } from 'vitest'

import { extractTerms, highlightTerms } from '../../src/shared/lib/highlight_terms'

describe('extractTerms', () => {
  test('empty / whitespace-only → empty array', () => {
    expect(extractTerms('')).toEqual([])
    expect(extractTerms('   ')).toEqual([])
  })

  test('strips trailing wildcard suffix (CJK normalisation artefact)', () => {
    expect(extractTerms('产品*')).toEqual(['产品'])
    expect(extractTerms('term*')).toEqual(['term'])
  })

  test('strips quotes (phrase queries become individual terms)', () => {
    expect(extractTerms('"redis timeout"')).toEqual(['redis', 'timeout'])
  })

  test('drops FTS5 boolean operators', () => {
    expect(extractTerms('redis AND timeout')).toEqual(['redis', 'timeout'])
    expect(extractTerms('A OR B NOT C')).toEqual(['A', 'B', 'C'])
    expect(extractTerms('alpha NEAR(beta, 5)')).toEqual(['alpha', 'beta,', '5'])
  })

  test('mixed CJK + English passes through', () => {
    expect(extractTerms('redis 产品')).toEqual(['redis', '产品'])
  })
})

describe('highlightTerms', () => {
  test('null / undefined text returns empty string', () => {
    expect(highlightTerms(null, [])).toBe('')
    expect(highlightTerms(undefined, ['x'])).toBe('')
  })

  test('empty terms array returns entity-encoded text unchanged', () => {
    expect(highlightTerms('plain text', [])).toBe('plain text')
    expect(highlightTerms('<b>bold</b>', [])).toBe('&lt;b&gt;bold&lt;/b&gt;')
  })

  test('wraps single English match', () => {
    expect(highlightTerms('redis is slow', ['redis'])).toBe('<mark>redis</mark> is slow')
  })

  test('is case-insensitive', () => {
    expect(highlightTerms('Notion API broke', ['notion'])).toBe(
      '<mark>Notion</mark> API broke'
    )
  })

  test('wraps multiple distinct terms', () => {
    const out = highlightTerms('redis and notion both fail', ['redis', 'notion'])
    expect(out).toBe('<mark>redis</mark> and <mark>notion</mark> both fail')
  })

  test('CJK match wraps correctly', () => {
    expect(highlightTerms('本周产品评审', ['产品'])).toBe('本周<mark>产品</mark>评审')
  })

  test('regex special chars in the term match literally', () => {
    expect(highlightTerms('foo.bar?baz', ['foo.bar'])).toBe('<mark>foo.bar</mark>?baz')
    expect(highlightTerms('a+b=c', ['a+b'])).toBe('<mark>a+b</mark>=c')
  })

  test('HTML in source is entity-encoded (XSS defense)', () => {
    // The text source could contain user-controlled HTML — must not leak.
    const out = highlightTerms('<script>alert(1)</script> notion', ['notion'])
    expect(out).not.toContain('<script>')
    expect(out).toContain('&lt;script&gt;')
    expect(out).toContain('<mark>notion</mark>')
  })

  test('longer terms win over shorter prefixes (de-dupe + sort)', () => {
    const out = highlightTerms('notionapi rocks', ['notion', 'notionapi'])
    expect(out).toBe('<mark>notionapi</mark> rocks')
  })

  test('duplicate terms collapse', () => {
    const out = highlightTerms('redis redis', ['redis', 'redis', 'redis'])
    expect(out).toBe('<mark>redis</mark> <mark>redis</mark>')
  })

  test('mixed CJK + English terms in one pass', () => {
    const out = highlightTerms('redis 产品 deadline', ['redis', '产品'])
    expect(out).toBe('<mark>redis</mark> <mark>产品</mark> deadline')
  })
})
