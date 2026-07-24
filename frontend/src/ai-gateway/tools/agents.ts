// S5 W3 (task 07-02-s5-custom-agent-productize) — conversational custom-agent CRUD tools: the
// assistant helps the owner build / edit / run a custom agent through chat. All six go through the
// SAME report-agent REST endpoints W1 opened for type='custom' (Python is the validation authority:
// validate_agent_config_patch deep-checks trigger/cron/ReDoS; run-now enqueues via the S4 run_queue).
//
// Two silent reads + four EDIT-TIER writes behind MAILAGENT_CUSTOM_AGENTS_ENABLED (default OFF —
// same flag as the S4 headless kernel; off → the ToolSet is byte-identical to S4):
//   - custom_agent_list    (silent, class capability_change) — list the owner's custom agents
//   - custom_agent_get     (silent, class capability_change) — one agent's full spec + recent runs
//   - custom_agent_create  (edit,   class capability_change) — propose a new custom agent
//   - custom_agent_update  (edit,   class capability_change) — propose changes to an agent
//   - custom_agent_delete  (edit,   class capability_change) — delete an agent
//   - custom_agent_run_now (edit,   class capability_change) — enqueue one immediate run
//
// 🔴 Why edit-tier + class capability_change (ADR-004 §7 D5 / P5): building or editing an agent that
//    holds tools IS a change to the assistant's own capability surface — the one class that NEVER
//    auto-approves, and (via applyContextModePolicy) outside a manual session neither registers nor
//    executes → headless runs can never build/edit/run agents. No editableFields → the approval card
//    is approve/reject only; the WHOLE spec is pinned (a raw-changed input of any tier →
//    E_APPROVAL_HASH_MISMATCH — an approved agent cannot be retargeted or its config swapped on replay).
//
// 🔴 Field ALLOWLIST (ADR-004 rev3.1 §7, owner Q4 — revises rev1 D5/Q7): the create/update schemas
//    are `.strict()` over title/prompt/model/enabled/trigger/allowed_tools/budget PLUS the grant
//    vocabulary grant_exec / grant_web / skills. The model may PROPOSE grants — the defense moved
//    from field-level deny to the always-human approval card, whose permission summary renders
//    exec / web-open red (update additionally diffs before/after against the SERVER's current row).
//    tool_policy / policy_rules still structurally cannot enter (wire body is assembled
//    field-by-field), and rule creation (the actual card-free whitelist) stays owner-only: a grant
//    only buys tool REGISTRATION — gated web / exec still need owner-built rules to skip cards.
//
// CORE (skill_gating.CORE_UNGATED_GATEWAY_TOOLS): the on/off authority is the flag, never skill gating.

import type { Tool } from 'ai'
import type { z } from 'zod'

import { DomainError, type MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import {
  auditedReadTool,
  auditedWriteTool,
  type GatewayApprovalMode,
  type GatewayToolAuditCollector
} from './types'
import type { AgentContextMode } from './policy'
import type {
  CustomAgentToolPolicy,
  CustomAgentTrigger,
  ReportAgentConfig,
  ReportConfigPatch,
  ReportAgentCreateInput
} from '@shared/api/types'
import {
  customAgentCreateSchema,
  customAgentDeleteSchema,
  customAgentGetSchema,
  customAgentListSchema,
  customAgentRunNowSchema,
  customAgentUpdateSchema,
  type CustomAgentCreateInput,
  type CustomAgentTriggerInput,
  type CustomAgentUpdateInput
} from './schemas'

/** Names of the custom-agent CRUD tools the gateway exposes when MAILAGENT_CUSTOM_AGENTS_ENABLED is
 *  on. Exported for tests + the eval catalog completeness gate (which statically extracts every
 *  GATEWAY_*_TOOL_NAMES array). */
export const GATEWAY_CUSTOM_AGENT_TOOL_NAMES = [
  'custom_agent_list',
  'custom_agent_get',
  'custom_agent_create',
  'custom_agent_update',
  'custom_agent_delete',
  'custom_agent_run_now'
] as const

function invalidArg(message: string): never {
  throw new DomainError('E_INVALID_ARG', message)
}

/** Wire updated_at is epoch ms (store `_now()` int); tolerate a string passthrough. */
function isoOrNull(v: number | null | undefined): string | null {
  if (v == null) return null
  return typeof v === 'number' ? new Date(v).toISOString() : v
}

/** A compact human-readable summary of a custom-agent trigger (for the list/get output). */
function triggerSummary(trigger: CustomAgentTrigger | null | undefined): string {
  if (!trigger) return 'disabled (no trigger)'
  if (trigger.kind === 'cron') {
    return `cron ${trigger.cron}${trigger.timezone ? ` (${trigger.timezone})` : ''}`
  }
  // 07-24 结构化排程规则（与 kind:'cron' 并存）。摘要保持一行、可预测。
  if (trigger.kind === 'schedule') {
    const r = trigger.rule
    const at = `${String(r.hour).padStart(2, '0')}:${String(r.minute).padStart(2, '0')}`
    const parts = [`schedule ${r.freq}`]
    if (r.interval > 1) parts.push(`every ${r.interval}`)
    if (r.freq === 'weekly') parts.push(`byday=[${r.weekdays.join(',')}]`)
    if (r.freq === 'monthly') {
      parts.push(
        r.monthMode === 'date'
          ? `day=${r.monthDay}${r.clamp ? ' (clamped)' : ''}`
          : `nth=${r.ordinal} weekday=${r.weekday}`
      )
    }
    parts.push(`at ${at} (${trigger.timezone})`)
    return parts.join(' ')
  }
  const preds: string[] = []
  if (trigger.subject_pattern) preds.push(`subject~/${trigger.subject_pattern}/`)
  if (trigger.sender_pattern) preds.push(`sender~/${trigger.sender_pattern}/`)
  if (trigger.folders && trigger.folders.length > 0)
    preds.push(`folders=[${trigger.folders.join(',')}]`)
  return `email_filter ${preds.join(' ') || '(no predicates)'}`
}

/** Project one ReportAgentConfig into the model-facing spec summary (custom-agent fields only).
 *  Grants/skills are projected read-side too (rev3.1 §7) so an update proposal starts from the
 *  agent's REAL current permissions — the approval card's before-diff is still server-fetched. */
function specSummary(agent: ReportAgentConfig): Record<string, unknown> {
  return {
    id: agent.id,
    type: agent.type,
    title: agent.title,
    enabled: agent.enabled,
    model: agent.model,
    prompt: agent.prompt,
    prompt_is_default: agent.prompt_is_default,
    trigger: agent.trigger ?? null,
    trigger_summary: triggerSummary(agent.trigger),
    allowed_tools: agent.tool_policy?.allowed_tools ?? null,
    grant_exec: agent.tool_policy?.grant_exec === true,
    grant_web: agent.tool_policy?.grant_web ?? 'off',
    skills: agent.tool_policy?.skills ?? null,
    budget: agent.budget ?? null,
    updated_at: isoOrNull(agent.updated_at)
  }
}

/** The friendly-input shape create/update share (the ALLOWLISTED fields, rev3.1 §7). */
interface ConfigPatchInput {
  title?: string
  prompt?: string | null
  model?: string
  enabled?: boolean
  trigger?: CustomAgentTriggerInput | null
  allowed_tools?: string[]
  budget?: { max_steps?: number; max_runs_per_day?: number; max_run_seconds?: number } | null
  grant_exec?: boolean
  grant_web?: 'off' | 'gated' | 'open'
  skills?: string[]
}

/** True when the input touches any tool_policy sub-field (they live in ONE server-side JSON blob,
 *  so update must merge the untouched ones — see the merge base in custom_agent_update). */
function touchesToolPolicy(input: ConfigPatchInput): boolean {
  return (
    input.allowed_tools !== undefined ||
    input.grant_exec !== undefined ||
    input.grant_web !== undefined ||
    input.skills !== undefined
  )
}

/** Assemble the friendly REST patch body from the ALLOWLISTED tool input (create/update share this).
 *  allowed_tools/grant_exec/grant_web/skills → tool_policy {v:1, ...}; trigger/budget gain the `v:1`
 *  version bit the backend schemas carry (the model omits it). Raw tool_policy / policy fields
 *  CANNOT appear — the source object has no such field (structural allowlist, `.strict()` schema).
 *  `currentToolPolicy` (update only) is the SERVER row's policy: tool_policy_json is one blob, so a
 *  partial grants patch carries the untouched sub-fields forward instead of wiping them. Only the
 *  four known sub-fields are carried (never a verbatim blob passthrough). */
function toConfigPatch(
  input: ConfigPatchInput,
  currentToolPolicy?: CustomAgentToolPolicy | null
): ReportConfigPatch {
  const patch: ReportConfigPatch = {}
  if (input.title !== undefined) patch.title = input.title
  if (input.prompt !== undefined) patch.prompt = input.prompt
  if (input.model !== undefined) patch.model = input.model
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.trigger !== undefined) {
    patch.trigger = input.trigger === null ? null : { ...input.trigger, v: 1 }
  }
  if (touchesToolPolicy(input)) {
    const tp: CustomAgentToolPolicy = { v: 1 }
    const cur = currentToolPolicy ?? undefined
    if (cur?.allowed_tools !== undefined) tp.allowed_tools = cur.allowed_tools
    if (cur?.grant_exec !== undefined) tp.grant_exec = cur.grant_exec
    if (cur?.grant_web !== undefined) tp.grant_web = cur.grant_web
    if (cur?.skills !== undefined) tp.skills = cur.skills
    if (input.allowed_tools !== undefined) tp.allowed_tools = input.allowed_tools
    if (input.grant_exec !== undefined) tp.grant_exec = input.grant_exec
    if (input.grant_web !== undefined) tp.grant_web = input.grant_web
    if (input.skills !== undefined) tp.skills = input.skills
    patch.tool_policy = tp
  }
  if (input.budget !== undefined) {
    patch.budget = input.budget === null ? null : { ...input.budget, v: 1 }
  }
  return patch
}

/**
 * Build the S5 W3 custom-agent CRUD tools bound to the injected domain client + audit collector +
 * approval guard. list/get are silent reads; create/update/delete/run_now are edit-tier writes
 * (class capability_change — a card under Manual/auto-reversible AND the owner-global acceptEdits
 * mode [none is an ACCEPT_EDITS_AUTO_APPROVE_TOOLS member]; only the owner-global bypass mode
 * skips it; never registered outside manual_chat). Validation is Python-authoritative.
 */
export function createCustomAgentTools(
  domain: MailAgentDomainClient,
  collector: GatewayToolAuditCollector = [],
  guard: ApprovalGuard,
  opts: {
    a2uiEnabled?: boolean
    approvalMode?: GatewayApprovalMode
    oneShot?: boolean
    contextMode?: AgentContextMode
  } = {}
): Record<string, Tool> {
  const makeWrite = <I>(toolOpts: {
    name: string
    description: string
    inputSchema: z.ZodType<I>
    // edit tier only — a per-tool literal (validate_catalog.py reads it as the source tier). class
    // capability_change (policy.ts) additionally means the approvalMode auto-reversible path can never
    // apply. 07-16 — approvalMode is now threaded, but ONLY 'bypass' (owner 拍板: 无例外) ever skips
    // the CRUD cards: none of the four writes is in the fail-closed ACCEPT_EDITS_AUTO_APPROVE_TOOLS
    // allow-list (policy.ts; see ACCEPT_EDITS_ASK_TOOLS) because the rev3.1 §7 grant vocabulary above
    // leans on the always-human card — auto-approving create/update under acceptEdits would let
    // injected content mint a cron agent with grant_web:'open' (card-free headless exfil).
    // 'always'/'auto-reversible' behaviour is byte-identical. No editableFields → the WHOLE spec is
    // pinned (approve/reject only, cannot be retargeted on replay).
    risk: 'edit'
    run: (
      input: I,
      ctx: { userEdited: boolean; signal: AbortSignal | undefined }
    ) => Promise<unknown>
  }): Tool =>
    auditedWriteTool(
      {
        ...toolOpts,
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        oneShot: opts.oneShot,
        contextMode: opts.contextMode
      },
      collector,
      guard
    )

  // custom_agent_list — SILENT read. Lists the owner's custom agents (type='custom' filtered here;
  // report/search/preprocess agents are managed elsewhere). Read-only → no approval.
  const custom_agent_list = auditedReadTool(
    {
      name: 'custom_agent_list',
      description:
        'List the custom agents the owner has configured — each with its id, title, whether it is ' +
        'enabled, and a short trigger summary (cron schedule or email filter, or "disabled" when it ' +
        'has no trigger yet). Use when the user asks "what agents do I have" / "list my custom ' +
        'agents", then call custom_agent_get with an id to see one in full. Read-only — no approval.',
      inputSchema: customAgentListSchema,
      run: async (input, signal) => {
        const all = await domain.listReportAgents(signal)
        const items = all
          .filter((a) => a.type === 'custom')
          .slice(0, input.limit)
          .map((a) => ({
            id: a.id,
            title: a.title,
            enabled: a.enabled,
            trigger_summary: triggerSummary(a.trigger)
          }))
        return { count: items.length, items }
      }
    },
    collector
  )

  // custom_agent_get — SILENT read. One custom agent's full spec + its recent runs (the run history
  // state is derived server-side — this tool never re-derives it). Read-only → no approval.
  const custom_agent_get = auditedReadTool(
    {
      name: 'custom_agent_get',
      description:
        'Fetch one custom agent in full by its id (from custom_agent_list): title, prompt, model, ' +
        'enabled, its trigger (cron / email_filter), the tools it may use (allowed_tools), its ' +
        'budget, plus its most recent runs (each with an authoritative state — queued / running / ' +
        'completed / paused_pending / paused_expired / paused_approved / paused_rejected / failed; ' +
        'a paused run is NOT a completed run). Use after custom_agent_list when the user wants the ' +
        'details of a specific agent. Returns found:false if no custom agent has that id. Read-only.',
      inputSchema: customAgentGetSchema,
      run: async (input, signal) => {
        const agent = await domain.getReportAgent(input.agent_id, signal)
        if (!agent || agent.type !== 'custom') {
          return { found: false, agent_id: input.agent_id }
        }
        // Recent runs are advisory: if the run-history endpoint hiccups, still return the spec.
        let runs: unknown[] = []
        if (input.runs_limit > 0) {
          try {
            const rows = await domain.listAgentRuns(input.agent_id, input.runs_limit, signal)
            runs = rows.map((r) => ({
              job_id: r.jobId,
              state: r.state,
              outcome: r.outcome ?? null,
              approval_state: r.approvalState ?? null,
              session_id: r.sessionId ?? null,
              created_at: r.createdAt,
              finished_at: r.finishedAt ?? null,
              error: r.error ?? null
            }))
          } catch {
            /* run history is advisory; the spec is the primary result */
          }
        }
        return { found: true, ...specSummary(agent), recent_runs: runs }
      }
    },
    collector
  )

  // custom_agent_create — EDIT-tier write. Propose a NEW custom agent. Asks in every mode except
  // owner-global bypass (the whole spec is shown on the card); deep validation (trigger/cron/ReDoS)
  // is server-side.
  const custom_agent_create = makeWrite({
    name: 'custom_agent_create',
    description:
      'Propose creating a NEW custom agent. Provide an id (unique, no spaces), a title, the prompt ' +
      'that steers it, optionally a model, whether it is enabled, a trigger (either {kind:"cron", ' +
      'cron:"<5-field cron>", timezone?} for a schedule OR {kind:"email_filter", subject_pattern?, ' +
      'sender_pattern?, folders?} to fire on matching mail — omit for a disabled draft), the list of ' +
      'tools it may use (allowed_tools), a budget ({max_steps?, max_runs_per_day?, ' +
      'max_run_seconds?}), and optionally the permissions it needs: grant_exec (local command ' +
      'execution), grant_web ("off" | "gated" domain-whitelist | "open" any URL — high risk), and ' +
      'skills (the skill sets mounted for it). The user reviews the full spec on a confirmation ' +
      'card whose permission summary highlights exec / open-web in red; nothing is created without ' +
      'approval. Grants only register tools — card-free whitelist RULES remain an owner-only ' +
      'Settings action you cannot perform. A bad cron / regex is rejected by a server-side ' +
      'validator. Edit tier — always asks under the Manual/auto-reversible and acceptEdits ' +
      'modes; only the owner-set global bypass permission mode can auto-execute it.',
    inputSchema: customAgentCreateSchema,
    risk: 'edit',
    run: async (input: CustomAgentCreateInput, { userEdited, signal }) => {
      if (input.id.trim().length === 0) invalidArg('id required (non-empty)')
      const body: ReportAgentCreateInput & ReportConfigPatch = {
        id: input.id,
        type: 'custom',
        ...toConfigPatch(input)
      }
      const agent = await domain.createReportAgent(body, signal)
      return { created: true, ...specSummary(agent), user_edited: userEdited }
    }
  })

  // custom_agent_update — EDIT-tier write. Propose changes to an existing custom agent (partial
  // patch). Asks in every mode except owner-global bypass; the approval card diffs grant/skill
  // changes against the SERVER's current row (never the model's claim of "before").
  const custom_agent_update = makeWrite({
    name: 'custom_agent_update',
    description:
      'Propose changes to an EXISTING custom agent (partial — only the fields you pass change). ' +
      'agent_id identifies it (from custom_agent_list). You may change title, prompt, model, ' +
      'enabled, trigger, allowed_tools, budget, or its permissions (grant_exec / grant_web / ' +
      'skills) — same shapes as custom_agent_create. Pass trigger:null to disable the agent ' +
      '(clear its trigger). A permission change is shown to the user as a before/after diff read ' +
      'from the server (escalations highlighted red); card-free whitelist RULES remain owner-only. ' +
      'The user reviews and approves the change; a bad cron / regex is rejected server-side. ' +
      'Edit tier — always asks under the Manual/auto-reversible and acceptEdits modes; only the ' +
      'owner-set global bypass permission mode can auto-execute it.',
    inputSchema: customAgentUpdateSchema,
    risk: 'edit',
    run: async (input: CustomAgentUpdateInput, { userEdited, signal }) => {
      if (input.agent_id.trim().length === 0) invalidArg('agent_id required (non-empty)')
      // tool_policy_json is ONE server-side blob: a patch touching any of its sub-fields must
      // merge the current row's untouched ones (re-read at execute time, post-approval) — else
      // `{grant_web:'open'}` alone would silently wipe allowed_tools/grant_exec/skills.
      // 🔴 fail-closed: a merge-base read failure (missing row OR a transient backend error)
      // ABORTS the update — proceeding with an empty base would reset the untouched sub-fields
      // to the WIDER defaults (owner-narrowed allowed_tools / explicit skills:[] fall back to
      // the default sets) and execute something other than the before→after the owner approved.
      let currentToolPolicy: CustomAgentToolPolicy | null = null
      if (touchesToolPolicy(input)) {
        let current: ReportAgentConfig | null
        try {
          current = await domain.getReportAgent(input.agent_id, signal)
        } catch {
          // transient backend error (getReportAgent already maps E_NOT_FOUND to null)
          invalidArg(
            `could not read agent ${input.agent_id}'s current config to merge the tool_policy ` +
              'patch (backend temporarily unavailable) — nothing was changed; retry'
          )
        }
        if (!current || current.type !== 'custom') {
          invalidArg(
            `no custom agent ${input.agent_id} — the tool_policy patch has no merge base; ` +
              'nothing was changed (check the agent id via custom_agent_list)'
          )
        }
        currentToolPolicy = current.tool_policy ?? null
      }
      const patch = toConfigPatch(input, currentToolPolicy)
      if (Object.keys(patch).length === 0) invalidArg('at least one field to change is required')
      const agent = await domain.setReportAgentConfig(input.agent_id, patch, signal)
      return { updated: true, ...specSummary(agent), user_edited: userEdited }
    }
  })

  // custom_agent_delete — EDIT-tier write. Delete a custom agent. identity (agent_id) pinned → an
  // approved delete cannot be retargeted on replay.
  const custom_agent_delete = makeWrite({
    name: 'custom_agent_delete',
    description:
      'Propose DELETING a custom agent by its id (from custom_agent_list). The user approves or ' +
      'rejects; nothing is deleted without approval. The agent_id is pinned on the card — an ' +
      'approved delete cannot be retargeted to a different agent. Edit tier — always asks under ' +
      'the Manual/auto-reversible and acceptEdits modes; only the owner-set global bypass ' +
      'permission mode can auto-execute it.',
    inputSchema: customAgentDeleteSchema,
    risk: 'edit',
    run: async (input, { userEdited, signal }) => {
      if (input.agent_id.trim().length === 0) invalidArg('agent_id required (non-empty)')
      const res = await domain.deleteReportAgent(input.agent_id, signal)
      return { deleted: res.deleted, user_edited: userEdited }
    }
  })

  // custom_agent_run_now — EDIT-tier write. Enqueue ONE immediate run of a custom agent (S4 enqueue
  // → AgentRunWorker → gateway headless drain). Returns the job id. Conservatively edit-tier +
  // capability_change: it starts an autonomous tool-holding run (ADR-004 P5).
  const custom_agent_run_now = makeWrite({
    name: 'custom_agent_run_now',
    description:
      'Propose running a custom agent ONCE right now (a manual trigger, in addition to its cron / ' +
      'email schedule). agent_id identifies it. The user approves; on approval the run is enqueued ' +
      'and executes headless in the background (returns a job id — check custom_agent_get for its ' +
      "result). Subject to the agent's daily run budget. Edit tier — always asks under the " +
      'Manual/auto-reversible and acceptEdits modes; only the owner-set global bypass ' +
      'permission mode can auto-execute it.',
    inputSchema: customAgentRunNowSchema,
    risk: 'edit',
    run: async (input, { userEdited, signal }) => {
      if (input.agent_id.trim().length === 0) invalidArg('agent_id required (non-empty)')
      const res = await domain.runReportAgentNow(input.agent_id, signal)
      return {
        enqueued: true,
        job_id: res.jobId,
        agent_id: res.agentId,
        was_created: res.wasCreated,
        user_edited: userEdited
      }
    }
  })

  return {
    custom_agent_list,
    custom_agent_get,
    custom_agent_create,
    custom_agent_update,
    custom_agent_delete,
    custom_agent_run_now
  }
}
