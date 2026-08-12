import { describe, expect, it } from 'vitest'

import {
  parseRunActions,
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

describe('run actions（跟进时执行四项）', () => {
  it('没配过 / v1 行 / 坏 JSON 都回落到出厂默认前两项', () => {
    expect(parseRunActions(null)).toEqual(['summary', 'items'])
    expect(parseRunActions(JSON.stringify(V1))).toEqual(['summary', 'items'])
    expect(parseRunActions('{')).toEqual(['summary', 'items'])
    expect(parseRunActions(JSON.stringify({ v: 2, triggers: [] }))).toEqual(['summary', 'items'])
  })

  it('读出显式配置，剔除未知值与重复', () => {
    const raw = JSON.stringify({ v: 2, triggers: [], actions: ['draft', 'nope', 'draft'] })
    expect(parseRunActions(raw)).toEqual(['draft'])
    // 全是未知值 ⇒ 与"没配过"同义，回落默认而不是空数组（空数组会让跟进什么都不做）。
    expect(parseRunActions(JSON.stringify({ v: 2, triggers: [], actions: ['nope'] }))).toEqual([
      'summary',
      'items'
    ])
  })

  it('与默认相同时不写 actions 键 —— 让"没配过"和"配成默认"在库里长得一样', () => {
    const entries = parseTriggerEntries(JSON.stringify(V1))
    const asDefault = serializeTriggerEntries(entries, ['summary', 'items'])
    expect(JSON.parse(asDefault as string).actions).toBeUndefined()
    const custom = serializeTriggerEntries(entries, ['proposal'])
    expect(JSON.parse(custom as string).actions).toEqual(['proposal'])
  })

  it('往返不丢勾选', () => {
    const entries = parseTriggerEntries(JSON.stringify(V1))
    const raw = serializeTriggerEntries(entries, ['draft', 'proposal'])
    expect(parseRunActions(raw)).toEqual(['draft', 'proposal'])
  })
})
