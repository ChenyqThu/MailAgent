import { describe, expect, test } from 'vitest'

import {
  escapeLikeValue,
  parseSearchQuery,
  tokenizeSearchQuery
} from '../../src/shared/lib/search_query_parser'

describe('search query parser', () => {
  test('tokenize keeps quoted spaces', () => {
    const { tokens, warnings } = tokenizeSearchQuery('from:"Alice Zhang" "weekly report" redis')

    expect(tokens).toEqual(['from:"Alice Zhang"', '"weekly report"', 'redis'])
    expect(warnings).toEqual([])
  })

  test('unclosed quote warns and splits plainly', () => {
    const { tokens, warnings } = tokenizeSearchQuery('"weekly report')

    expect(tokens).toEqual(['"weekly', 'report'])
    expect(warnings).toEqual(['unclosed_quote'])
  })

  test('plain text query is fast-path passthrough', () => {
    const parsed = parseSearchQuery('redis timeout')

    expect(parsed.is_plain_passthrough).toBe(true)
    expect(parsed.fts_terms).toEqual([{ value: 'redis' }, { value: 'timeout' }])
  })

  test('quoted field value and text term', () => {
    const parsed = parseSearchQuery('from:"Alice Zhang" redis')

    expect(parsed.is_plain_passthrough).toBe(false)
    expect(parsed.fts_terms).toEqual([{ value: 'redis' }])
    expect(parsed.filters).toHaveLength(1)
    expect(parsed.filters[0]?.params).toEqual(['%Alice Zhang%', '%Alice Zhang%'])
  })

  test('negative field and phrase terms', () => {
    const parsed = parseSearchQuery('-from:noreply -"weekly report"')

    expect(parsed.neg_filters[0]?.params).toEqual(['%noreply%', '%noreply%'])
    expect(parsed.neg_fts_terms).toEqual([{ value: 'weekly report', is_phrase: true }])
  })

  test('OR groups field and text', () => {
    const fieldParsed = parseSearchQuery('from:alice OR from:bob')
    const textParsed = parseSearchQuery('redis OR timeout')

    expect(fieldParsed.or_filter_groups).toHaveLength(1)
    expect(fieldParsed.or_filter_groups[0]?.map((p) => p.params[0])).toEqual(['%alice%', '%bob%'])
    expect(textParsed.fts_or_groups).toEqual([[{ value: 'redis' }, { value: 'timeout' }]])
  })

  test('cross-class OR downgrades to AND with warning', () => {
    const parsed = parseSearchQuery('from:alice OR redis')

    expect(parsed.warnings).toEqual(['unsupported_or:cross_class'])
    expect(parsed.filters).toHaveLength(1)
    expect(parsed.fts_terms).toEqual([{ value: 'redis' }])
  })

  test('unknown field downgrades to quoted text compile path', () => {
    const parsed = parseSearchQuery('foo:bar')

    expect(parsed.is_plain_passthrough).toBe(false)
    expect(parsed.fts_terms).toEqual([{ value: 'foo:bar', force_quoted: true }])
    expect(parsed.warnings).toEqual([])
  })

  test('empty and unknown values warn and drop', () => {
    const empty = parseSearchQuery('from:')
    const unknownIs = parseSearchQuery('is:archived')

    expect(empty.filters).toEqual([])
    expect(empty.warnings).toEqual(['empty_value:from'])
    expect(unknownIs.filters).toEqual([])
    expect(unknownIs.warnings).toEqual(['unknown_value:is:archived'])
  })

  test('date-only values are local day boundaries in UTC', () => {
    const parsed = parseSearchQuery('after:2026-06-01 before:2026-06-01', {
      now: '2026-06-13T12:00:00',
      tzOffsetMinutes: 480
    })

    expect(parsed.filters[0]?.params).toEqual(['2026-05-31T16:00:00+00:00'])
    expect(parsed.filters[1]?.params).toEqual(['2026-06-01T16:00:00+00:00'])
  })

  test('relative date uses injected now and timezone', () => {
    const parsed = parseSearchQuery('newer_than:7d', {
      now: '2026-06-13T12:00:00',
      tzOffsetMinutes: 480
    })

    expect(parsed.filters[0]?.params).toEqual(['2026-06-06T04:00:00+00:00'])
  })

  test('relative date invalid unit warns and drops', () => {
    const parsed = parseSearchQuery('newer_than:7n redis')

    expect(parsed.filters).toEqual([])
    expect(parsed.warnings).toEqual(['invalid_relative_date:newer_than:7n'])
    expect(parsed.fts_terms.map((term) => term.value)).toEqual(['redis'])
  })

  test('LIKE escape and parameterization for injection payload', () => {
    const payload = "x%' OR 1=1 --_"
    const parsed = parseSearchQuery(`subject:"${payload}"`)
    const predicate = parsed.filters[0]!

    expect(predicate.sql).not.toContain(payload)
    expect(predicate.sql).toContain('?')
    expect(predicate.params).toEqual([`%${escapeLikeValue(payload)}%`])
    expect(predicate.params[0]).toBe("%x\\%' OR 1=1 --\\_%")
  })
})
