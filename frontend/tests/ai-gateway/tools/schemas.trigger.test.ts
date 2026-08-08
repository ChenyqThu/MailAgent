// issue #65 — the custom-agent trigger ALLOWLIST must admit kind:'schedule' (the structured
// recurrence the Settings schedule builder produces). It has existed backend-side since the 07-24
// schedule batch, but was missing from this zod union, so `.strict()` rejected it and the
// conversational CRUD tools could only DOWNGRADE a schedule agent to cron.
//
// Division of labour: the kind SET and the 10 rule KEYS are locked against the Python authority
// (src/agents/trigger.py + schedule_rule._RULE_KEYS) by tests/api/test_trigger_kind_parity.py —
// that gate reads both sources and reds on drift. This file covers what a regex gate cannot: that
// the shapes actually parse, and that the strictness (10 keys exactly, mandatory timezone,
// 0=Sunday weekday domain) really holds. Semantic depth (real calendar dates, IANA timezone
// existence, croniter validity) stays server-side by design — same discipline as cron.

import { describe, expect, test } from 'vitest'

import {
  customAgentCreateSchema,
  customAgentTriggerSchema,
  customAgentUpdateSchema
} from '../../../src/ai-gateway/tools/schemas'

/** A contract-§1-legal rule: all 10 keys present, including the ones `freq:'weekly'` ignores. */
const RULE = {
  freq: 'weekly',
  interval: 2,
  weekdays: [1, 5],
  monthMode: 'date',
  monthDay: 1,
  ordinal: 'last',
  weekday: 0,
  hour: 9,
  minute: 30,
  clamp: false
}

const SCHEDULE = {
  kind: 'schedule',
  rule: RULE,
  anchor: '2026-07-24',
  timezone: 'America/Los_Angeles'
}

/** Parse a schedule trigger with `patch` merged in, through the real create entry point. */
const createAccepts = (patch: Record<string, unknown> = {}): boolean =>
  customAgentCreateSchema.safeParse({ id: 'x', trigger: { ...SCHEDULE, ...patch } }).success

const withRule = (rule: unknown): boolean => createAccepts({ rule })

describe('customAgentTriggerSchema — kind:"schedule" (issue #65)', () => {
  test('a legal schedule trigger parses on both create and update', () => {
    expect(customAgentTriggerSchema.safeParse(SCHEDULE).success).toBe(true)
    expect(customAgentCreateSchema.safeParse({ id: 'x', trigger: SCHEDULE }).success).toBe(true)
    expect(customAgentUpdateSchema.safeParse({ agent_id: 'x', trigger: SCHEDULE }).success).toBe(
      true
    )
  })

  test('the rule is exactly 10 keys — a missing one and an extra one are both rejected', () => {
    for (const key of Object.keys(RULE)) {
      const short = { ...RULE } as Record<string, unknown>
      delete short[key]
      expect(withRule(short), `dropping rule.${key} should be rejected`).toBe(false)
    }
    expect(withRule({ ...RULE, extra: 1 })).toBe(false)
  })

  test('rule value domains are closed (weekday 0=Sun..6=Sat, enums, no bare numbers for ordinal)', () => {
    expect(withRule({ ...RULE, weekdays: [7] })).toBe(false)
    expect(withRule({ ...RULE, weekday: 7 })).toBe(false)
    expect(withRule({ ...RULE, freq: 'hourly' })).toBe(false)
    expect(withRule({ ...RULE, monthMode: 'weekday' })).toBe(false)
    expect(withRule({ ...RULE, ordinal: 5 })).toBe(false)
    expect(withRule({ ...RULE, ordinal: 'first' })).toBe(false)
    expect(withRule({ ...RULE, interval: 0 })).toBe(false)
    expect(withRule({ ...RULE, hour: 24 })).toBe(false)
    expect(withRule({ ...RULE, minute: 60 })).toBe(false)
    expect(withRule({ ...RULE, clamp: 'false' })).toBe(false)
    // the shapes a builder legitimately produces still parse
    expect(withRule({ ...RULE, ordinal: 4, monthMode: 'nth', freq: 'monthly' })).toBe(true)
    expect(withRule({ ...RULE, freq: 'daily', weekdays: [] })).toBe(true)
  })

  test('timezone is mandatory (no cron-style empty→UTC fallback) and anchor is a YYYY-MM-DD date', () => {
    expect(createAccepts({ timezone: '' })).toBe(false)
    const noTz = { ...SCHEDULE } as Record<string, unknown>
    delete noTz.timezone
    expect(customAgentTriggerSchema.safeParse(noTz).success).toBe(false)
    expect(createAccepts({ anchor: '2026-7-24' })).toBe(false)
    expect(createAccepts({ anchor: '07/24/2026' })).toBe(false)
    const noAnchor = { ...SCHEDULE } as Record<string, unknown>
    delete noAnchor.anchor
    expect(customAgentTriggerSchema.safeParse(noAnchor).success).toBe(false)
  })

  test('the branch is `.strict()` — an unknown top-level trigger key is rejected', () => {
    expect(createAccepts({ cron: '0 9 * * 1-5' })).toBe(false)
  })

  test('cron / email_filter did not regress, and an unknown kind is still refused', () => {
    expect(
      customAgentCreateSchema.safeParse({
        id: 'x',
        trigger: { kind: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' }
      }).success
    ).toBe(true)
    expect(
      customAgentUpdateSchema.safeParse({
        agent_id: 'x',
        trigger: { kind: 'email_filter', subject_pattern: 'DMS.*审批' }
      }).success
    ).toBe(true)
    expect(
      customAgentTriggerSchema.safeParse({ kind: 'webhook', url: 'https://x.test' }).success
    ).toBe(false)
  })
})

describe('customAgentTriggerSchema — calendar triggers', () => {
  test('accepts calendar event change and before-start payloads', () => {
    expect(
      customAgentTriggerSchema.safeParse({
        kind: 'calendar_event_change',
        title_pattern: 'Planning',
        calendar_ids: ['Work']
      }).success
    ).toBe(true)
    expect(
      customAgentTriggerSchema.safeParse({
        kind: 'calendar_before_start',
        lead_seconds: 86400,
        attendee_pattern: '@example\\.com'
      }).success
    ).toBe(true)
  })

  test.each([59, 2592001, 60.5])('rejects invalid lead_seconds=%s', (lead_seconds) => {
    expect(
      customAgentTriggerSchema.safeParse({ kind: 'calendar_before_start', lead_seconds }).success
    ).toBe(false)
  })
})
