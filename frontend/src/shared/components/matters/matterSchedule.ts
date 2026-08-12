import { MATTER_DEFAULT_RUN_ACTIONS, MATTER_RUN_ACTIONS } from '@shared/api/types/matter'
import type { MatterRunAction } from '@shared/api/types/matter'
import { isScheduleValue } from '@shared/components/agents/schedule/types'
import type { ScheduleValue } from '@shared/components/agents/schedule/types'

/**
 * `matter.schedule_json` 的解析单源。
 *
 * 这一列的**内容**在 P6-B 升成了 v2 envelope（多 trigger 并存、单条可启停）：
 *
 *     { "v": 2, "triggers": [{ "id": "...", "kind": "schedule", "enabled": true, ... }] }
 *
 * 老形状（单个 schedule 对象）仍然合法、仍在库里，读侧惰性兼容、不改写库。
 *
 * 🔴 这两处解析以前是两份重复的 `isScheduleValue(JSON.parse(raw))`，只认 v1 —— 存储升级后
 * 它们会把 v2 行读成"没有排程"，而新建事项默认就是 v2，等于每个新事项的绑定卡都谎报未排期。
 * 收成一份，两种形状都认。
 */
export function parseMatterSchedule(raw: string | null | undefined): ScheduleValue | null {
  if (!raw) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (isScheduleValue(value)) return value
  const triggers = (value as { triggers?: unknown } | null)?.triggers
  if (!Array.isArray(triggers)) return null
  // 现有绑定卡只呈现单条排程：取第一条启用的 schedule。多 trigger 的完整编辑面是增量，
  // 在它落地之前，这里至少要如实显示"有排程"而不是空。
  for (const entry of triggers) {
    const candidate = entry as { kind?: unknown; enabled?: unknown }
    if (candidate?.kind !== 'schedule') continue
    if (candidate.enabled === false) continue
    if (isScheduleValue(entry)) return entry
  }
  return null
}

/** 该事项配了几条启用中的触发器（v1 行恒为 0 或 1）。 */
export function countEnabledTriggers(raw: string | null | undefined): number {
  if (!raw) return 0
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return 0
  }
  if (isScheduleValue(value)) return 1
  const triggers = (value as { triggers?: unknown } | null)?.triggers
  if (!Array.isArray(triggers)) return 0
  return triggers.filter((entry) => (entry as { enabled?: unknown })?.enabled !== false).length
}

export type MatterTriggerKind = 'schedule' | 'event' | 'condition' | 'manual'

/** 一条触发规则。schedule 形态的字段与 `ScheduleValue` 同形（rule/anchor/timezone），
 *  所以它可以直接喂给既有的 ScheduleBuilder。 */
export interface MatterTriggerEntry {
  id: string
  kind: MatterTriggerKind
  enabled?: boolean
  rule?: unknown
  anchor?: string
  timezone?: string
  event_type?: string
  condition?: string
  [key: string]: unknown
}

/** 把库里存的内容解析成 entry 列表。v1 单对象升成单条，形状非法回空列表。 */
export function parseTriggerEntries(raw: string | null | undefined): MatterTriggerEntry[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (isScheduleValue(value)) {
    return [{ ...value, id: 'mtr_legacy', kind: 'schedule', enabled: true }]
  }
  const triggers = (value as { triggers?: unknown } | null)?.triggers
  if (!Array.isArray(triggers)) return []
  return triggers.filter(
    (entry): entry is MatterTriggerEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { id?: unknown }).id === 'string'
  )
}

/** 「跟进时执行」四项：从库里的内容取。无该键 / v1 行 → 出厂默认前两项。
 *  归一化规则与 Python `triggers.parse_run_actions` 同源（保序去重、剔未知、空回落默认）。 */
export function parseRunActions(raw: string | null | undefined): MatterRunAction[] {
  if (!raw) return [...MATTER_DEFAULT_RUN_ACTIONS]
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return [...MATTER_DEFAULT_RUN_ACTIONS]
  }
  const actions = (value as { actions?: unknown } | null)?.actions
  if (!Array.isArray(actions)) return [...MATTER_DEFAULT_RUN_ACTIONS]
  const picked: MatterRunAction[] = []
  for (const entry of actions) {
    if (
      typeof entry === 'string' &&
      (MATTER_RUN_ACTIONS as readonly string[]).includes(entry) &&
      !picked.includes(entry as MatterRunAction)
    ) {
      picked.push(entry as MatterRunAction)
    }
  }
  return picked.length > 0 ? picked : [...MATTER_DEFAULT_RUN_ACTIONS]
}

function sameActions(a: readonly MatterRunAction[], b: readonly MatterRunAction[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** 写回库的形状。空列表写 null（后端据此清空排程）。
 *  actions 与出厂默认相同则**不写这个键** —— 让"没配过"和"配成默认"在库里长得一样，
 *  将来改默认能跟着走（同 Python `dump_trigger_set` 的纪律）。 */
export function serializeTriggerEntries(
  entries: readonly MatterTriggerEntry[],
  actions?: readonly MatterRunAction[]
): string | null {
  if (entries.length === 0) return null
  const envelope: Record<string, unknown> = { v: 2, triggers: entries }
  if (actions && !sameActions(actions, MATTER_DEFAULT_RUN_ACTIONS)) {
    envelope.actions = [...actions]
  }
  return JSON.stringify(envelope)
}
