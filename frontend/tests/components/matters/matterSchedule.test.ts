import { describe, expect, it } from 'vitest'

import {
  countEnabledTriggers,
  parseMatterSchedule
} from '@shared/components/matters/matterSchedule'

const RULE = {
  freq: 'daily',
  interval: 3,
  weekdays: [1],
  monthMode: 'date',
  monthDay: 1,
  ordinal: 1,
  weekday: 1,
  hour: 9,
  minute: 0,
  clamp: false
}
const V1 = { kind: 'schedule', rule: RULE, anchor: '2026-08-01', timezone: 'UTC' }

describe('parseMatterSchedule', () => {
  it('reads the legacy single-object shape', () => {
    expect(parseMatterSchedule(JSON.stringify(V1))?.anchor).toBe('2026-08-01')
  })

  it('reads a v2 envelope', () => {
    // 回归钉死：存储升成 envelope 后，只认 v1 的解析会把每个新建事项都读成"没有排程"。
    const envelope = { v: 2, triggers: [{ ...V1, id: 'mtr_a', enabled: true }] }
    expect(parseMatterSchedule(JSON.stringify(envelope))?.anchor).toBe('2026-08-01')
  })

  it('skips disabled and non-schedule entries', () => {
    const envelope = {
      v: 2,
      triggers: [
        { id: 'mtr_c', kind: 'condition', enabled: true, condition: 'health_down' },
        { ...V1, id: 'mtr_off', enabled: false, anchor: '2020-01-01' },
        { ...V1, id: 'mtr_on', enabled: true }
      ]
    }
    expect(parseMatterSchedule(JSON.stringify(envelope))?.anchor).toBe('2026-08-01')
  })

  it('returns null for absent, malformed, or schedule-less input', () => {
    expect(parseMatterSchedule(null)).toBeNull()
    expect(parseMatterSchedule('not json')).toBeNull()
    expect(
      parseMatterSchedule(
        JSON.stringify({ v: 2, triggers: [{ id: 'm', kind: 'manual', enabled: true }] })
      )
    ).toBeNull()
  })
})

describe('countEnabledTriggers', () => {
  it('counts a legacy row as one', () => {
    expect(countEnabledTriggers(JSON.stringify(V1))).toBe(1)
  })

  it('counts only enabled entries', () => {
    const envelope = {
      v: 2,
      triggers: [
        { ...V1, id: 'a', enabled: true },
        { id: 'b', kind: 'condition', enabled: true, condition: 'health_down' },
        { id: 'c', kind: 'manual', enabled: false }
      ]
    }
    expect(countEnabledTriggers(JSON.stringify(envelope))).toBe(2)
  })

  it('is zero for absent or malformed input', () => {
    expect(countEnabledTriggers(null)).toBe(0)
    expect(countEnabledTriggers('{')).toBe(0)
  })
})
