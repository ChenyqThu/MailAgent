import { describe, expect, it } from 'vitest'

import {
  buildTriggerEnvelope,
  countEnabledTriggers,
  parseAgentOverrides,
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

// ── 0813 dogfood 轮 3 #10：事项级模型覆盖 ─────────────────────────────────────────
//
// 归一化规则与 Python `src/matters/triggers.py` 同源；跨语言的**形状**由
// `tests/fixtures/matter_trigger_envelope.json` 钉死（parity 测试两侧各读一次），
// 这里补本地的边角语义。
describe('parseAgentOverrides / buildTriggerEnvelope — 模型覆盖', () => {
  it('无该键 / v1 老行 / 坏 JSON → 全跟随（空对象）', () => {
    expect(parseAgentOverrides(null)).toEqual({})
    expect(parseAgentOverrides('{')).toEqual({})
    expect(parseAgentOverrides(JSON.stringify(V1))).toEqual({})
    expect(parseAgentOverrides(JSON.stringify({ v: 2, triggers: [] }))).toEqual({})
  })

  it('认不出的字段丢掉、剩下的照用（读侧宽容，run 不该被一段可选覆盖卡死）', () => {
    expect(
      parseAgentOverrides(
        JSON.stringify({ v: 2, triggers: [], agent: { model: 'p:m', effort: 'turbo' } })
      )
    ).toEqual({ model: 'p:m' })
  })

  it('🔴 fallback_models: [] 是「显式不设兜底」，不是「没配过」', () => {
    expect(
      parseAgentOverrides(JSON.stringify({ v: 2, triggers: [], agent: { fallback_models: [] } }))
    ).toEqual({ fallback_models: [] })
    const envelope = buildTriggerEnvelope([], undefined, { fallback_models: [] })
    expect(envelope?.agent).toEqual({ fallback_models: [] })
  })

  it('一项都没覆盖 ⇒ 不写 agent 键', () => {
    const envelope = buildTriggerEnvelope(
      [{ ...V1, id: 'a', enabled: true } as never],
      undefined,
      {}
    )
    expect(envelope).not.toBeNull()
    expect('agent' in envelope!).toBe(false)
  })

  it('🔴 触发方式清空但有覆盖 ⇒ envelope 仍然要写（否则刚配好的模型被静默抹掉）', () => {
    const envelope = buildTriggerEnvelope([], undefined, { model: 'p:m' })
    expect(envelope).not.toBeNull()
    expect(envelope!.triggers).toEqual([])
    expect(envelope!.agent).toEqual({ model: 'p:m' })
  })

  it('触发方式清空且没有覆盖 ⇒ 仍然写 null（老行为不变）', () => {
    expect(buildTriggerEnvelope([], undefined, {})).toBeNull()
    expect(buildTriggerEnvelope([])).toBeNull()
  })
})
