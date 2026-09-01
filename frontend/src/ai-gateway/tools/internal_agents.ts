// task 08-14 — 内建 agent 工具面（`internal_agent_*`）。
//
// 收的缺口：`custom_agent_list` 硬过滤 `type === 'custom'`，而一个从没建过 custom agent 的库里
// 那份清单**恒为空** —— 与此同时 `report_agent` 表里五个内建 agent（日报 / 周报 / 搜索 /
// 预处理 / 项目周报同步）真实存在、正在跑，主 agent 却一个都看不见。本家族补上这一面。
//
// 与 `custom_agent_*` 的分工：那边是「你自建的 agent」，这边是「内建 agent」。两边的 description
// 互指，避免模型只调一个就以为列全了。
//
// 🔴 只返回**真有消费者**的字段（PRD D1）。本任务调研在同一张表上撞到三个死键：
//   1. `preprocess.prompt` —— v1.1.0 起 persona 层已移除，运行时「一律忽略」
//      （src/llm_agent/preprocess_config.py 模块注释）。
//   2. `preprocess.enabled` —— 运行时读配置的 SELECT 压根不含该列；设置页那个开关绑的是
//      env `LLM_AGENT_ENABLED`。
//   3. `report` 顶层 `cadence` / `hours` / `weekday` —— 新形状下 `cadence_of` 以 `rule.freq`
//      为权威，顶层是「降级镜像、运行时死数据」（src/reports/store.py）。
//   4. `report.kos_enrich` —— 由 PR4 的死列闸**自动**抓到（前三个是人肉 grep 找的）：全仓只有
//      存取链（wire 读写 / store 列 / 报告配置页的开关），报告生成流程里没有任何一处读它改变
//      行为。既有的 UI 开关是预存 dead code，本任务只是不把它加进模型的写面（指出不删）。
// 把死键当有效配置呈现，会让模型（进而让 owner）以为改得动某个其实纹丝不动的东西 —— 审批卡
// 照弹、行为零变化。所以它们在这里既不返回、也（PR2 起）不可写。
//
// class capability_change（同 custom_agent_*）：改内建 agent 的排程 / 模型 / prompt 是对助手
// 自身能力面的改动，故 manual-only，headless run 结构性拿不到。

import type { Tool } from 'ai'
import { z } from 'zod'

import { DomainError, type MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import { triggerSummary } from './agents'
import { customAgentTriggerSchema } from './schemas'
import {
  auditedReadTool,
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolApprovalPrefs,
  type GatewayToolAuditCollector
} from './types'
import type { AgentContextMode } from './policy'
import type { ReportAgentConfig, ReportConfigPatch, ReportSchedule } from '@shared/api/types'
import { writeReportSchedule } from '@shared/lib/scheduleWire'

/** 本家族的入参 schema 就近定义（`agent_catalog.ts` 先例），**不**放进共享的 `schemas.ts`：
 *  那个文件由 PostToolUse formatter 全量重排，任何一次编辑都会顺带改写四处无关的 matter
 *  schema —— 与「每一行 diff 都能对应到请求」相抵，也白白扩大与并行分支的冲突面。 */
const internalAgentListSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50)
})

/** 🔴 get 的投影是 per-type 的，只交出真有运行时消费者的字段；死列（preprocess 的 prompt /
 *  enabled、report 顶层的 cadence 镜像）既不返回也（PR2 起）不可写 —— 否则模型会以为自己
 *  能改动某个纹丝不动的东西。 */
const internalAgentGetSchema = z.object({
  agent_id: z.string().min(1).max(128)
})

/** 🔴 排程 `rule` 的 10 个键被 `tests/api/test_trigger_kind_parity.py` 锁在 `schemas.ts` 的
 *  `customAgentTriggerSchema` 上（抽取器只认那一处）。这里**取用**它的 schedule 分支而不是抄
 *  一份：抄一份那道闸看不见，将来 Python 加第 11 个键时只有一边会红。取不到就直接抛 —— 宁可
 *  启动即炸，也不要静默退化成一个宽松的 rule 契约。 */
const scheduleRuleSchema = (() => {
  const branch = customAgentTriggerSchema.options.find(
    (option) => option.shape.kind.value === 'schedule'
  )
  if (!branch || !('rule' in branch.shape)) {
    throw new Error(
      'customAgentTriggerSchema lost its schedule branch — internal_agent_update cannot reuse the rule contract'
    )
  }
  return branch.shape.rule
})()

const agentIdField = z.string().min(1).max(128)
const titleField = z.string().min(1).max(200).optional()
const modelField = z.string().max(128).optional()
/** null / '' → 后端重置为内置默认 prompt（`ReportConfigPatch.prompt` 语义）。 */
const promptField = z.string().max(20_000).nullable().optional()
const docsField = z.array(z.string().min(1).max(32)).max(8).optional()

/**
 * internal_agent_update —— per-type 白名单（PRD D1）。
 *
 * 每一支只列**该 type 真有运行时消费者**的字段，`.strict()` 让别的字段连解析都过不去。于是
 * 三个死键是**结构性**拒绝，而不是运行时才报错：
 *   · `preprocess.prompt` —— 那一支根本没有 prompt 字段（persona 层 v1.1.0 已移除）。
 *   · `preprocess.enabled` —— 同上；真开关是 env `LLM_AGENT_ENABLED`。
 *   · report 顶层 `cadence`/`hours`/`weekday` —— schedule 只收 rule/anchor/timezone，
 *     镜像由 `writeReportSchedule` 服务端语义统一产出。
 * 另外全类共同排除 `tool_policy` / `budget` / `avatar` / project_progress 的 Notion 库 id
 * （env 权威）—— 它们不在任何一支里，故 wire body 也不可能带上。
 *
 * `type` 是判别键，模型必须先 `internal_agent_get` 才写得出；run 里还会拿它与服务端行的实际
 * type 对一次（防「读的是 A、改的是 B」）。
 */
const internalAgentUpdateSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('report'),
      agent_id: agentIdField,
      title: titleField,
      enabled: z.boolean().optional(),
      model: modelField,
      prompt: promptField,
      schedule: z
        .object({
          rule: scheduleRuleSchema,
          /** 相位原点，本地日历日期（在 timezone 里解释）。 */
          anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          /** IANA 时区，必填 —— 空时区正是当年两个调度器分叉的根因。 */
          timezone: z.string().min(1).max(64)
        })
        .strict()
        .optional(),
      window_hours: z
        .number()
        .int()
        .min(1)
        .max(24 * 90)
        .optional(),
      trigger_mode: z.enum(['rolling_24h', 'natural_day']).optional(),
      body_full_priorities: z.array(z.string().min(1).max(32)).max(8).optional(),
      context_docs: docsField
    })
    .strict(),
  z
    .object({
      type: z.literal('search'),
      agent_id: agentIdField,
      title: titleField,
      enabled: z.boolean().optional(),
      model: modelField,
      prompt: promptField
    })
    .strict(),
  z
    .object({
      type: z.literal('preprocess'),
      agent_id: agentIdField,
      title: titleField,
      model: modelField,
      context_docs: docsField,
      context_source: z.enum(['standing_docs', 'notion_context']).nullable().optional(),
      mark_read_after_processing: z.boolean().optional(),
      /** null = 重置回跟随全局；[] = 显式不设兜底。 */
      fallback_models: z.array(z.string().min(1).max(128)).max(8).nullable().optional()
    })
    .strict(),
  z
    .object({
      type: z.literal('project_progress'),
      agent_id: agentIdField,
      title: titleField,
      enabled: z.boolean().optional(),
      /** 触发判据（sender/subject 正则）。深校验（ReDoS 上限等）在 Python 侧。 */
      email_filter: z
        .object({
          subject_pattern: z.string().max(256).optional(),
          sender_pattern: z.string().max(256).optional()
        })
        .strict()
        .optional()
    })
    .strict()
])
type InternalAgentUpdateInput = z.infer<typeof internalAgentUpdateSchema>

/** 本家族的工具名。导出供测试 + eval catalog 完整性闸（静态抽取每个 GATEWAY_*_TOOL_NAMES 数组）。 */
export const GATEWAY_INTERNAL_AGENT_TOOL_NAMES = [
  'internal_agent_list',
  'internal_agent_get',
  'internal_agent_update'
] as const

/** `report_agent` 表里的四类内建 type —— 即「非 custom」。**不是**手抄的枚举：Python 侧
 *  `src/api/routers/reports.py` 的 create 白名单是 report|search|preprocess(|custom)，
 *  project_progress 由 v31 seed 单例行引入。 */
export const INTERNAL_AGENT_TYPES = ['report', 'search', 'preprocess', 'project_progress'] as const
export type InternalAgentType = (typeof INTERNAL_AGENT_TYPES)[number]

export function isInternalAgentType(type: string): type is InternalAgentType {
  return (INTERNAL_AGENT_TYPES as readonly string[]).includes(type)
}

/** 🔴 preprocess 的启用态**不在这行里**。本工具有意不去猜 env 的值：读一条不可靠的 env 链、
 *  然后把猜测当事实报给模型，比明说「我读不到」更糟。 */
const PREPROCESS_ENABLED_NOTE =
  'The row-level `enabled` column is DEAD for this agent: the runtime never reads it, and the ' +
  'real switch is the env flag LLM_AGENT_ENABLED (surfaced in 设置 → AI). This tool does not ' +
  'read env, so the on/off state is deliberately not reported here — do not guess it, and do ' +
  'not offer to toggle it: direct the owner to 设置 → AI instead.'

/** report 的排程摘要。新形状（`kind:'schedule'`）复用 `triggerSummary` —— 两处的 `rule` 都是
 *  同一个 `ScheduleRuleWire`，所以这里是复用而不是第二份格式化器。老形状如实标注。 */
function scheduleSummary(schedule: ReportSchedule | null | undefined): string {
  if (!schedule) return 'no schedule'
  if (schedule.kind === 'schedule' && schedule.rule && schedule.timezone) {
    return triggerSummary({
      v: 1,
      kind: 'schedule',
      rule: schedule.rule,
      anchor: schedule.anchor ?? '',
      timezone: schedule.timezone
    })
  }
  const hours = schedule.hours?.length ? schedule.hours.join(',') : '?'
  return `${schedule.cadence} at ${hours} (legacy shape)`
}

/** 一行的排程/触发摘要：report 看 `schedule`，project_progress 看 `trigger`（email_filter），
 *  search / preprocess 结构上没有触发器（一个被动调用、一个每封邮件 hook）。 */
function activationSummary(agent: ReportAgentConfig): string {
  switch (agent.type) {
    case 'report':
      return scheduleSummary(agent.schedule)
    case 'project_progress':
      return triggerSummary(agent.trigger)
    case 'search':
      return 'on demand (invoked by ⌘K natural-language search)'
    case 'preprocess':
      return 'per incoming email (no schedule)'
    default:
      return 'unknown'
  }
}

/** 列表行。preprocess 的 `enabled` 报 null（见 PREPROCESS_ENABLED_NOTE），其余如实。 */
function listRow(agent: ReportAgentConfig): Record<string, unknown> {
  const isPreprocess = agent.type === 'preprocess'
  return {
    id: agent.id,
    type: agent.type,
    title: agent.title,
    description: agent.description ?? null,
    enabled: isPreprocess ? null : agent.enabled,
    ...(isPreprocess ? { enabled_note: PREPROCESS_ENABLED_NOTE } : {}),
    activation: activationSummary(agent)
  }
}

/** 单行的**有效**配置：per-type 投影，只含真有消费者的字段。 */
function effectiveConfig(agent: ReportAgentConfig): Record<string, unknown> {
  const base = {
    id: agent.id,
    type: agent.type,
    title: agent.title,
    description: agent.description ?? null,
    model: agent.model,
    updated_at: agent.updated_at
  }
  switch (agent.type) {
    case 'report':
      return {
        ...base,
        enabled: agent.enabled,
        prompt: agent.prompt,
        prompt_is_default: agent.prompt_is_default,
        // 🔴 只交出 rule/anchor/timezone。顶层 cadence/hours/weekday 是降级镜像，
        //    权威是 rule.freq —— 报出来会让模型以为那是可独立调整的旋钮。
        schedule:
          agent.schedule?.kind === 'schedule' && agent.schedule.rule
            ? {
                rule: agent.schedule.rule,
                anchor: agent.schedule.anchor ?? null,
                timezone: agent.schedule.timezone ?? null
              }
            : null,
        schedule_shape: agent.schedule?.kind === 'schedule' ? 'rule' : 'legacy',
        schedule_summary: scheduleSummary(agent.schedule),
        window_hours: agent.window_hours,
        trigger_mode: agent.trigger_mode,
        timezone: agent.timezone,
        body_full_priorities: agent.body_full_priorities,
        context_docs: agent.context_docs ?? null,
        cadence_note:
          'The report cadence (daily/weekly/monthly) is derived from schedule.rule.freq, which ' +
          'also decides the report KIND and its report id — changing freq changes what report ' +
          'this agent produces, not merely when it runs.'
      }
    case 'search':
      return {
        ...base,
        enabled: agent.enabled,
        prompt: agent.prompt,
        prompt_is_default: agent.prompt_is_default,
        tools: agent.tools_json ?? null,
        activation: activationSummary(agent)
      }
    case 'preprocess':
      return {
        ...base,
        enabled: null,
        enabled_note: PREPROCESS_ENABLED_NOTE,
        // prompt 有意缺席：该列运行时被忽略，人设改由 context_docs 承担。
        context_docs: agent.context_docs ?? null,
        context_source: agent.context_source ?? null,
        mark_read_after_processing: agent.mark_read_after_processing,
        fallback_models: agent.fallback_models ?? null,
        persona_note:
          'This agent has NO prompt of its own (the persona layer was removed in v1.1.0 and the ' +
          'column is ignored at runtime). Its identity comes from context_docs — the Standing ' +
          'Context documents injected into the classification prompt.',
        activation: activationSummary(agent)
      }
    case 'project_progress':
      return {
        ...base,
        enabled: agent.enabled,
        trigger: agent.trigger ?? null,
        trigger_summary: triggerSummary(agent.trigger),
        execution_note:
          'This one is a deterministic xlsx→Notion ETL, not an LLM loop: it has no prompt, and ' +
          'its Notion database id / BU filter live in env (not writable from chat). Its master ' +
          'switch is PROJECT_PROGRESS_SYNC_ENABLED.'
      }
    default:
      return base
  }
}

function invalidArg(message: string): never {
  throw new DomainError('E_INVALID_ARG', message)
}

/** 入参 → wire friendly patch。**逐字段组装**（不是把 input 摊开）—— 这样 `tool_policy` /
 *  `budget` / `avatar` 之类即使将来混进 schema 也进不了 wire body（同 custom_agent_update 纪律）。 */
function toConfigPatch(
  input: InternalAgentUpdateInput,
  current: ReportAgentConfig
): ReportConfigPatch {
  const patch: ReportConfigPatch = {}
  if (input.title !== undefined) patch.title = input.title
  switch (input.type) {
    case 'report':
      if (input.enabled !== undefined) patch.enabled = input.enabled
      if (input.model !== undefined) patch.model = input.model
      if (input.prompt !== undefined) patch.prompt = input.prompt
      if (input.schedule !== undefined) {
        // 老键先铺（保留后端可能存的未知键），再由 writeReportSchedule 覆盖权威字段 —— 与
        // 报告 Agent 配置页的保存路径逐字同款。🔴 cadence 的同步在 writeReportSchedule 里：它
        // 恒写 rule.freq，模型碰不到这个镜像，也就不可能把周报静默改成日报。
        patch.schedule = {
          ...(current.schedule ?? {}),
          ...writeReportSchedule({
            v: 1,
            kind: 'schedule',
            rule: input.schedule.rule as never,
            anchor: input.schedule.anchor,
            timezone: input.schedule.timezone
          })
        }
      }
      if (input.window_hours !== undefined) patch.window_hours = input.window_hours
      if (input.trigger_mode !== undefined) patch.trigger_mode = input.trigger_mode
      if (input.body_full_priorities !== undefined) {
        patch.body_full_priorities = input.body_full_priorities
      }
      if (input.context_docs !== undefined) patch.context_docs = input.context_docs
      return patch
    case 'search':
      if (input.enabled !== undefined) patch.enabled = input.enabled
      if (input.model !== undefined) patch.model = input.model
      if (input.prompt !== undefined) patch.prompt = input.prompt
      return patch
    case 'preprocess':
      // enabled / prompt 结构上不在这一支的 schema 里（两者都是死列）。
      if (input.model !== undefined) patch.model = input.model
      if (input.context_docs !== undefined) patch.context_docs = input.context_docs
      if (input.context_source !== undefined) patch.context_source = input.context_source
      if (input.mark_read_after_processing !== undefined) {
        patch.mark_read_after_processing = input.mark_read_after_processing
      }
      if (input.fallback_models !== undefined) patch.fallback_models = input.fallback_models
      return patch
    case 'project_progress':
      if (input.enabled !== undefined) patch.enabled = input.enabled
      if (input.email_filter !== undefined) {
        patch.trigger = { v: 1, kind: 'email_filter', ...input.email_filter }
      }
      return patch
  }
}

export function createInternalAgentTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard?: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    /** 08-05 WP-11 的 per-tool 档位图（manual run 专有；缺席 = pre-WP-11 的 ask 语义）。 */
    toolApprovalPrefs?: GatewayToolApprovalPrefs['tools']
    oneShot?: boolean
    contextMode?: AgentContextMode
  } = {}
): Record<string, Tool> {
  const internal_agent_list = auditedReadTool(
    {
      name: 'internal_agent_list',
      description:
        'List the BUILT-IN agents that ship with the app — the email digest reports, the ⌘K ' +
        'search agent, the AI email preprocessor, and the project-progress sync. Use this when ' +
        'the user asks "what agents do I have" / "what is running automatically". These are ' +
        'distinct from custom_agent_list, which lists agents the owner BUILT themselves (that ' +
        'list is empty until they create one) — to answer "all my agents" call BOTH. Each row ' +
        'carries id, type, title, enabled and how it activates. Read-only — no approval.',
      inputSchema: internalAgentListSchema,
      run: async (input, signal) => {
        const all = await domain.listReportAgents(signal)
        const items = all
          .filter((agent) => isInternalAgentType(agent.type))
          .slice(0, input.limit)
          .map(listRow)
        return { count: items.length, items }
      }
    },
    collector
  )

  const internal_agent_get = auditedReadTool(
    {
      name: 'internal_agent_get',
      description:
        'Fetch one built-in agent in full by its id (from internal_agent_list). Returns only the ' +
        'fields that actually take effect for that agent type — a report agent has a schedule ' +
        'and a prompt, the preprocessor has neither (its identity comes from context_docs, and ' +
        'its on/off lives in env), the project-progress sync is a deterministic ETL. Returns ' +
        'found:false if no built-in agent has that id (a custom agent id → use custom_agent_get).',
      inputSchema: internalAgentGetSchema,
      run: async (input, signal) => {
        const agent = await domain.getReportAgent(input.agent_id, signal)
        if (!agent || !isInternalAgentType(agent.type)) {
          return { found: false, agent_id: input.agent_id }
        }
        return { found: true, agent: effectiveConfig(agent) }
      }
    },
    collector
  )

  // internal_agent_update — EDIT-tier write。恒 ask（tool_prefs 里 configurable=false），
  // class capability_change ⇒ 只有 owner 全局 bypass 能免卡。无 editableFields ⇒ 整份提案被
  // 钉住（批准后不可在重放里被改成别的 agent 或别的值）。
  const internal_agent_update = guard
    ? auditedWriteTool(
        {
          name: 'internal_agent_update',
          description:
            'Change ONE built-in agent, after reading it with internal_agent_get and telling the ' +
            'user exactly what will differ. Partial — only the fields you pass change. `type` must ' +
            'match what internal_agent_get returned; each type accepts only the fields that ' +
            'actually take effect for it: report → title/enabled/model/prompt/schedule(rule, ' +
            'anchor, timezone)/window_hours/trigger_mode/body_full_priorities/kos_enrich/' +
            'context_docs; search → title/enabled/model/prompt; preprocess → title/model/' +
            'context_docs/context_source/mark_read_after_processing/fallback_models; ' +
            'project_progress → title/enabled/email_filter. ' +
            '🔴 The preprocessor has NO prompt and NO usable enabled here — its persona is ' +
            'context_docs, and its on/off is the env flag LLM_AGENT_ENABLED which only the owner ' +
            'can change in 设置 → AI; say so instead of attempting either. ' +
            'For a report, changing schedule.rule.freq changes the KIND of report produced (daily/' +
            'weekly/monthly decide its aggregation window and its report id), not just when it ' +
            'runs — call that out before proposing it. ' +
            'To edit an agent the owner built themselves use custom_agent_update instead. ' +
            'Edit tier — always asks; a bad schedule rule or regex is rejected server-side.',
          inputSchema: internalAgentUpdateSchema,
          risk: 'edit',
          a2uiEnabled: opts.a2uiEnabled,
          approvalMode: opts.approvalMode,
          toolApprovalPrefs: opts.toolApprovalPrefs,
          oneShot: opts.oneShot,
          contextMode: opts.contextMode,
          run: async (input: InternalAgentUpdateInput, { userEdited, signal }) => {
            // 🔴 fail-closed 的 merge base：读不到当前行就整单放弃。「读不到」既包括不存在，
            // 也包括后端瞬时故障 —— 后者若继续，patch 会落在一个我们没核对过 type 的行上。
            let current: ReportAgentConfig | null
            try {
              current = await domain.getReportAgent(input.agent_id, signal)
            } catch {
              invalidArg(
                `could not read ${input.agent_id}'s current config (backend temporarily ` +
                  'unavailable) — nothing was changed; retry'
              )
            }
            if (!current) {
              invalidArg(
                `no agent ${input.agent_id} — nothing was changed (check the id via internal_agent_list)`
              )
            }
            if (!isInternalAgentType(current.type)) {
              invalidArg(
                `${input.agent_id} is a ${current.type} agent, not a built-in one — use ` +
                  'custom_agent_update for agents the owner created; nothing was changed'
              )
            }
            // 读的是 A、改的是 B：把服务端事实当判据，不信模型对 type 的记忆。
            if (current.type !== input.type) {
              invalidArg(
                `${input.agent_id} is type '${current.type}', but the patch declares ` +
                  `'${input.type}' — re-read it with internal_agent_get; nothing was changed`
              )
            }
            const patch = toConfigPatch(input, current)
            if (Object.keys(patch).length === 0) {
              invalidArg('at least one field to change is required')
            }
            const updated = await domain.setReportAgentConfig(input.agent_id, patch, signal)
            // before/after 双双取自服务端（before 是改动前那一读，after 是写入返回值）——
            // 不回显模型自称的「原值」。
            return {
              updated: true,
              before: effectiveConfig(current),
              after: effectiveConfig(updated),
              user_edited: userEdited
            }
          }
        },
        collector,
        guard
      )
    : undefined

  return internal_agent_update
    ? { internal_agent_list, internal_agent_get, internal_agent_update }
    : { internal_agent_list, internal_agent_get }
}
