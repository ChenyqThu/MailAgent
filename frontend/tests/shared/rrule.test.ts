// Phase 4·#3 — RRULE builder 纯逻辑单测 (node 环境). build/parse/round-trip.

import { describe, expect, test } from 'vitest'

import {
  buildRRule,
  parseRRule,
  defaultRRuleState,
  type RRuleState
} from '../../src/shared/components/calendar/lib/rrule'

describe('buildRRule (Phase 4·#3)', () => {
  test('NONE → 空串', () => {
    expect(buildRRule(defaultRRuleState())).toBe('')
  })
  test('每天', () => {
    expect(buildRRule({ ...defaultRRuleState(), freq: 'DAILY' })).toBe('FREQ=DAILY')
  })
  test('每 2 周', () => {
    expect(buildRRule({ ...defaultRRuleState(), freq: 'WEEKLY', interval: 2 })).toBe(
      'FREQ=WEEKLY;INTERVAL=2'
    )
  })
  test('WEEKLY BYDAY 按 WEEKDAYS 顺序输出 (乱序输入也稳定)', () => {
    expect(
      buildRRule({ ...defaultRRuleState(), freq: 'WEEKLY', byday: ['FR', 'MO', 'WE'] })
    ).toBe('FREQ=WEEKLY;BYDAY=MO,WE,FR')
  })
  test('COUNT 结束', () => {
    expect(
      buildRRule({ ...defaultRRuleState(), freq: 'DAILY', end: 'count', count: 10 })
    ).toBe('FREQ=DAILY;COUNT=10')
  })
  test('UNTIL 结束 (UTC date-only)', () => {
    expect(
      buildRRule({ ...defaultRRuleState(), freq: 'WEEKLY', end: 'until', until: '2026-12-31' })
    ).toBe('FREQ=WEEKLY;UNTIL=20261231T235959Z')
  })
  test('interval=1 不输出 INTERVAL', () => {
    expect(buildRRule({ ...defaultRRuleState(), freq: 'MONTHLY', interval: 1 })).toBe(
      'FREQ=MONTHLY'
    )
  })
})

describe('parseRRule (Phase 4·#3)', () => {
  test('空 / null → NONE', () => {
    expect(parseRRule('').freq).toBe('NONE')
    expect(parseRRule(null).freq).toBe('NONE')
    expect(parseRRule(undefined).freq).toBe('NONE')
  })
  test('带 RRULE: 前缀', () => {
    expect(parseRRule('RRULE:FREQ=DAILY').freq).toBe('DAILY')
  })
  test('WEEKLY + BYDAY + COUNT', () => {
    const s = parseRRule('FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5')
    expect(s.freq).toBe('WEEKLY')
    expect(s.byday).toEqual(['MO', 'WE'])
    expect(s.end).toBe('count')
    expect(s.count).toBe(5)
  })
  test('UNTIL 解析回 date-only', () => {
    const s = parseRRule('FREQ=WEEKLY;UNTIL=20261231T235959Z')
    expect(s.end).toBe('until')
    expect(s.until).toBe('2026-12-31')
  })
  test('不支持的 FREQ → NONE (回退, 调用方 rruleDirty 防覆盖)', () => {
    expect(parseRRule('FREQ=HOURLY;INTERVAL=2').freq).toBe('NONE')
  })
  test('识别 FREQ 但忽略不支持的 part (BYMONTHDAY)', () => {
    const s = parseRRule('FREQ=MONTHLY;BYMONTHDAY=15')
    expect(s.freq).toBe('MONTHLY')
  })
})

describe('round-trip (Phase 4·#3)', () => {
  const cases: RRuleState[] = [
    { freq: 'DAILY', interval: 1, byday: [], end: 'never', count: 10, until: '' },
    { freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE', 'FR'], end: 'never', count: 10, until: '' },
    { freq: 'MONTHLY', interval: 1, byday: [], end: 'count', count: 6, until: '' },
    { freq: 'WEEKLY', interval: 1, byday: ['TU'], end: 'until', count: 10, until: '2026-06-30' }
  ]
  test.each(cases)('parseRRule(buildRRule(s)) 语义等价', (s) => {
    const rt = parseRRule(buildRRule(s))
    expect(rt.freq).toBe(s.freq)
    expect(rt.interval).toBe(s.interval)
    expect(rt.byday).toEqual(s.byday)
    expect(rt.end).toBe(s.end)
    if (s.end === 'count') expect(rt.count).toBe(s.count)
    if (s.end === 'until') expect(rt.until).toBe(s.until)
  })
})
