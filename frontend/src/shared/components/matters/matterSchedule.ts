import { MATTER_DEFAULT_RUN_ACTIONS, MATTER_RUN_ACTIONS } from '@shared/api/types/matter'
import type {
  MatterAgentOverrides,
  MatterRunAction,
  MatterTriggerEnvelope
} from '@shared/api/types/matter'
import { isScheduleValue } from '@shared/components/agents/schedule/types'
import type { ScheduleValue } from '@shared/components/agents/schedule/types'
import { isEffortTier } from '@shared/modelCatalog/effortTiers'

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
 *
 * 🔴 每个解析器都分两层：`*Value` 吃**已解析的值**，无后缀的吃 **DB 列字符串**。写侧
 * builder（`buildTriggerEnvelope`）产出的是对象，预览路径直接走 `*Value` —— 为了迁就
 * 只吃字符串的旧签名而 `JSON.stringify` 一次再 parse 回来，正是把"写侧是对象"这件事
 * 藏起来的那种绕法。
 */
function decodeColumn(raw: string | null | undefined): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function parseMatterScheduleValue(value: unknown): ScheduleValue | null {
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

export function parseMatterSchedule(raw: string | null | undefined): ScheduleValue | null {
  return parseMatterScheduleValue(decodeColumn(raw))
}

/** 该事项配了几条启用中的触发器（v1 行恒为 0 或 1）。 */
export function countEnabledTriggers(raw: string | null | undefined): number {
  const value = decodeColumn(raw)
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
  return parseTriggerEntriesValue(decodeColumn(raw))
}

export function parseTriggerEntriesValue(value: unknown): MatterTriggerEntry[] {
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
  return parseRunActionsValue(decodeColumn(raw))
}

export function parseRunActionsValue(value: unknown): MatterRunAction[] {
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

/** 事项级模型覆盖：从库里的内容取。无该键 / v1 行 / 形状不对 → `{}`（= 三项全跟随）。
 *
 *  归一化规则与 Python `triggers.parse_agent_overrides` 同源（读侧宽容：认不出的字段整个丢掉，
 *  剩下的照用 —— 跟进 run 不该因为一段可选覆盖认不出来就跑不起来）。🔴 `fallback_models: []`
 *  是**显式不设兜底**，与"没配过"不是一回事，所以判的是键在不在。 */
export function parseAgentOverrides(raw: string | null | undefined): MatterAgentOverrides {
  return parseAgentOverridesValue(decodeColumn(raw))
}

export function parseAgentOverridesValue(value: unknown): MatterAgentOverrides {
  const agent = (value as { agent?: unknown } | null)?.agent
  if (typeof agent !== 'object' || agent === null) return {}
  const raw = agent as { model?: unknown; effort?: unknown; fallback_models?: unknown }
  const picked: MatterAgentOverrides = {}
  if (typeof raw.model === 'string' && raw.model.trim()) picked.model = raw.model.trim()
  if (typeof raw.effort === 'string' && isEffortTier(raw.effort.trim())) {
    picked.effort = raw.effort.trim()
  }
  if (Array.isArray(raw.fallback_models)) {
    picked.fallback_models = raw.fallback_models
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
  }
  return picked
}

/** 三项都没覆盖 ⇒ 不写 `agent` 键（同 actions 的纪律：让"没配过"和"配成默认"长得一样）。 */
function agentOverridesForEnvelope(
  overrides: MatterAgentOverrides | undefined
): MatterAgentOverrides | null {
  if (!overrides) return null
  const payload: MatterAgentOverrides = {}
  if (overrides.model) payload.model = overrides.model
  if (overrides.effort) payload.effort = overrides.effort
  if (overrides.fallback_models) payload.fallback_models = [...overrides.fallback_models]
  return Object.keys(payload).length > 0 ? payload : null
}

/** PATCH body 里 `schedule_json` 的值。空列表写 null（后端据此清空排程）。
 *
 *  🔴 返回**对象**，不是 JSON 字符串：pydantic `MatterPatchWithScheduleRequest.schedule_json`
 *  的类型是 `dict[str, Any] | None`，发字符串会在 FastAPI 校验层 422，把整条 PATCH（含
 *  agent_enabled / profile / instructions）一起打掉。这里改名就是为了让返回值的形状写在
 *  名字上 —— 老名字 `serializeTriggerEntries` 读起来像"序列化成字符串"，正是当初抄错的诱因。
 *  两侧形状由 `tests/fixtures/matter_trigger_envelope.json` 跨语言钉死。
 *
 *  actions 与出厂默认相同则**不写这个键** —— 让"没配过"和"配成默认"在库里长得一样，
 *  将来改默认能跟着走（同 Python `dump_trigger_set` 的纪律）。 */
export function buildTriggerEnvelope(
  entries: readonly MatterTriggerEntry[],
  actions?: readonly MatterRunAction[],
  agent?: MatterAgentOverrides
): MatterTriggerEnvelope | null {
  const agentPayload = agentOverridesForEnvelope(agent)
  // 🔴 「一条 trigger 都没有」不再无条件写 null —— 只有模型覆盖也空才写。否则把触发方式全删掉
  // （改成纯手动跟进）会把刚配好的模型/effort/fallback 一起抹掉，而界面上看不出任何异常。
  // Python `normalize_trigger_json` 同款判据。
  if (entries.length === 0 && agentPayload === null) return null
  const envelope: MatterTriggerEnvelope = { v: 2, triggers: [...entries] }
  if (actions && !sameActions(actions, MATTER_DEFAULT_RUN_ACTIONS)) {
    envelope.actions = [...actions]
  }
  if (agentPayload) envelope.agent = agentPayload
  return envelope
}
