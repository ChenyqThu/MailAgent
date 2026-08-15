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
// 把死键当有效配置呈现，会让模型（进而让 owner）以为改得动某个其实纹丝不动的东西 —— 审批卡
// 照弹、行为零变化。所以它们在这里既不返回、也（PR2 起）不可写。
//
// class capability_change（同 custom_agent_*）：改内建 agent 的排程 / 模型 / prompt 是对助手
// 自身能力面的改动，故 manual-only，headless run 结构性拿不到。

import type { Tool } from 'ai'
import { z } from 'zod'

import type { MailAgentDomainClient } from '../python/domainClient'
import { triggerSummary } from './agents'
import { auditedReadTool, type GatewayToolAuditCollector } from './types'
import type { ReportAgentConfig, ReportSchedule } from '@shared/api/types'

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

/** 本家族的工具名。导出供测试 + eval catalog 完整性闸（静态抽取每个 GATEWAY_*_TOOL_NAMES 数组）。 */
export const GATEWAY_INTERNAL_AGENT_TOOL_NAMES = [
  'internal_agent_list',
  'internal_agent_get'
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
        kos_enrich: agent.kos_enrich,
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

export function createInternalAgentTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = []
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

  return { internal_agent_list, internal_agent_get }
}
