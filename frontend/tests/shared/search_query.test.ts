// Sprint 3 §2.1 — FTS5 query normaliser unit tests.
// CLAUDE.md "Phase 3" + SearchPage covers the integration; this file pins
// the pure logic so a regression in the regexes / token-split flips fail
// here with a clearer message than the rendered React tree.

import { describe, expect, test } from 'vitest'
import { normalizeFtsQuery } from '../../src/shared/lib/search_query'

describe('normalizeFtsQuery', () => {
  test.each([
    // pass-through cases
    ['', ''],
    ['   ', ''],
    ['redis', 'redis'],
    ['redis timeout', 'redis timeout'],
    ['user@example.com', 'user@example.com'],
    // explicit wildcard / phrase syntax stays untouched
    ['产品*', '产品*'],
    ['"prod down"', '"prod down"'],
    ['"产品评审"', '"产品评审"'],
    // FTS5 operators bypass CJK wildcard injection
    ['redis AND 产品', 'redis AND 产品'],
    ['本周 OR 上周', '本周 OR 上周'],
    ['notion NOT spam', 'notion NOT spam'],
    ['redis NEAR(timeout, 5)', 'redis NEAR(timeout, 5)'],
    // bare CJK gets `*` on last whitespace-separated token
    ['产品', '产品*'],
    ['本周 产品', '本周 产品*'],
    ['  产品  ', '产品*'],
    // mixed CJK + ASCII where last token is CJK → wildcard
    ['redis 产品', 'redis 产品*'],
    // mixed where last token is ASCII → don't touch
    ['产品 redis', '产品 redis']
  ])('normalizeFtsQuery(%j) → %j', (input, expected) => {
    expect(normalizeFtsQuery(input)).toBe(expected)
  })
})
