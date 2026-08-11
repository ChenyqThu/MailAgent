import { describe, expect, it } from 'vitest'

import {
  parseTriggerEntries,
  serializeTriggerEntries
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
const V1 = { v: 1, kind: 'schedule', rule: RULE, anchor: '2026-08-01', timezone: 'UTC' }

describe('trigger entries', () => {
  it('lifts a legacy single object into one entry', () => {
    const entries = parseTriggerEntries(JSON.stringify(V1))
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('schedule')
    expect(entries[0].enabled).toBe(true)
  })

  it('reads a v2 envelope and keeps every kind', () => {
    const envelope = {
      v: 2,
      triggers: [
        { ...V1, id: 'a', enabled: true },
        { id: 'b', kind: 'condition', enabled: false, condition: 'health_down' },
        { id: 'c', kind: 'manual', enabled: true }
      ]
    }
    const entries = parseTriggerEntries(JSON.stringify(envelope))
    expect(entries.map((entry) => entry.kind)).toEqual(['schedule', 'condition', 'manual'])
    expect(entries[1].enabled).toBe(false)
  })

  it('drops shapeless entries rather than passing them through', () => {
    const envelope = { v: 2, triggers: [{ kind: 'manual' }, null, 'nope'] }
    expect(parseTriggerEntries(JSON.stringify(envelope))).toEqual([])
  })

  it('serializes to a v2 envelope, and an empty list clears the column', () => {
    const entries = parseTriggerEntries(JSON.stringify(V1))
    const raw = serializeTriggerEntries(entries)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string).v).toBe(2)
    expect(serializeTriggerEntries([])).toBeNull()
  })

  it('round-trips without losing entries', () => {
    const envelope = {
      v: 2,
      triggers: [
        { ...V1, id: 'a', enabled: true },
        { id: 'b', kind: 'event', enabled: true, event_type: 'resource_linked_mail' }
      ]
    }
    const once = parseTriggerEntries(JSON.stringify(envelope))
    const twice = parseTriggerEntries(serializeTriggerEntries(once))
    expect(twice).toEqual(once)
  })

  it('returns nothing for absent or malformed input', () => {
    expect(parseTriggerEntries(null)).toEqual([])
    expect(parseTriggerEntries('{')).toEqual([])
  })
})
