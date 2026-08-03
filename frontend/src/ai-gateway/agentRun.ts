// S4 W3 — headless custom-agent run on the embedded AI SDK Gateway (ADR-003 D2/D3/D6/D7).
//
// The fresh-spawn counterpart to approvalResume.ts's resume-drain: instead of restoring a stashed
// renderer-initiated run, this constructs a run FROM the pulled AgentRunSpec and drives the same
// prepareChatRun + streamText + tools + ApprovalGuard + makePersistOnFinish that /api/ai/chat uses.
// It is the ONLY path a cron/email-triggered agent executes on (路径 C); the Python run_tool_loop
// (path B, no approval gate) is frozen and never reached from here.
//
// 🔴 Pure-ish (gateway core discipline): depends only on chatRun (prepareChatRun / makePersistOnFinish
//    / makeIdGenerator / responseMessageAwaitsApproval), policy (contextMode normalize), config +
//    shared TYPES (erased). No node:http (the server handler feeds an already-pulled spec + a merged
//    AbortSignal), no electron / chat_db / keytar. The ai_chat.db session is pre-created by the
//    endpoint via cfg.createAgentSession (lifecycle-injected) and threaded in as sessionId.
//
// 🔴 NOT a new gateway tool surface: runHeadlessAgent is an ENDPOINT primitive (like
//    runHeadlessSearchAgent), never a registered tool — it must not enter GATEWAY_*_TOOL_NAMES /
//    skill_gating sets / tool_catalog.json (the completeness gate scans those). This wave adds ZERO
//    gateway tools.
//
// 🔴 The context mode is DERIVED from the spec's trigger.kind here in trusted code and passed to
//    prepareChatRun as its trustedContextMode parameter (never from a request body). The tool面 of a
//    headless run is therefore the MATRIX's product under the derived mode (applyContextModePolicy
//    strips every capability_change/exec/outbound tool outside manual_chat) — NOT the manual full set.
//    This module does NOT re-implement the matrix; it only picks a mode + intersects an owner
//    allow-list on top of whatever cfg.buildTools already filtered.

import { APICallError, type ToolSet } from 'ai'

import type { AiGatewayConfig } from './config'
import {
  makeIdGenerator,
  makePersistOnFinish,
  prepareChatRun,
  responseMessageAwaitsApproval
} from './chatRun'
import {
  classOfTool,
  normalizeContextMode,
  parseWebGrant,
  type AgentContextMode,
  type AgentRunContext
} from './tools/policy'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'
// Relative type-only import (erased) — same discipline as searchAgentRun.ts: the pure-Node harness
// (tsx) must be able to load this module without resolving vite aliases.
import type { AgentRunSpec, HeadlessAgentResult } from '../shared/api/types'

export const DEFAULT_AGENT_RUN_SECONDS = 1800
export const MAX_AGENT_RUN_SECONDS = 1800

/** Mirror the backend Budget clamp at the gateway boundary so stale or malformed specs cannot
 * silently restore the retired five-minute timeout or bypass the 30-minute ceiling. */
export function resolveAgentRunSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_AGENT_RUN_SECONDS
  return Math.max(1, Math.min(MAX_AGENT_RUN_SECONDS, Math.trunc(value)))
}

export interface RunHeadlessAgentOpts {
  jobId: number
  spec: AgentRunSpec
  /** Pre-created ai_chat.db session (origin='agent') the run persists into. null → the run streams
   *  but persists nothing (createAgentSession degraded gracefully). */
  sessionId: number | null
}

/** ADR-003 D2 — derive the run's trusted context mode from the pulled spec's trigger.kind:
 *  email_filter → untrusted_trigger, cron | schedule → cron_headless, anything else fail-closes to
 *  untrusted_trigger (normalizeContextMode(undefined), the strictest). The input is the SERVER-pulled
 *  spec, never a poke body. Exported for the derivation test.
 *
 *  🔴 `schedule`（07-24 结构化排程）与 `cron` 同族 —— 都是「到点就跑、输入里没有攻击者可控内容」，
 *  故同映射到 cron_headless。少了这一行会 fail-close 成 untrusted_trigger：安全方向没错，但
 *  白白套上「邮件正文不可信」那套收窄，且与 owner 在 cron_headless 下配的免卡规则对不上。
 *  **必须与 Python `src/api/routers/agent.py::_derive_rule_context_mode` 同表** —— 规则的
 *  context_mode 是它在创建时盖章的，两边不一致 = 规则永不命中。
 *
 *  `im`（阶段 0b 预置，harness-expansion epic grill Q10=A）→ 'im_chat'：阶段 2 飞书对话的第四
 *  场合。当前没有任何 spec 会带这个 kind（Python `parse_trigger` 尚不认识 'im'，行存不进库），
 *  本分支 dormant。 */
export function deriveContextMode(spec: AgentRunSpec): AgentContextMode {
  const kind = spec.trigger?.kind
  if (kind === 'email_filter') return 'untrusted_trigger'
  if (kind === 'cron' || kind === 'schedule') return 'cron_headless'
  if (kind === 'im') return 'im_chat'
  return normalizeContextMode(undefined)
}

/** ADR-003 D6 — narrow an assembled ToolSet to the owner's per-agent allow-list. ONLY reduces
 *  (a name in `allowed` that isn't in `all` — e.g. a capability_change/exec/outbound tool the matrix
 *  already stripped under the non-manual mode — simply stays absent). allowed undefined → no
 *  narrowing (full set); allowed=[] → empty (owner explicitly selected zero tools). Exported for the
 *  intersection test. 🔴 The undefined=no-narrowing semantic is reserved for NON-agent callers.
 *  The agent-run path does NOT go through this function any more: wrapCfgForAgentRun applies its
 *  own filter (missing list → [] fail-closed per ADR-004 §5.1, and exec-class tools exempt from
 *  the intersection — their presence is the matrix's call alone, codex终审 P1). */
export function intersectAllowedTools(all: ToolSet, allowed?: string[]): ToolSet {
  if (!allowed) return all
  const keep = new Set(allowed)
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(all)) {
    if (keep.has(name)) out[name] = t
  }
  return out
}

/** ADR-004 §4.1 (+ rev3.1 D1 web) — construct the per-agent run context from the pulled spec.
 *  Grants are DISCRIMINATED typed values built here (`grantExec === true`; `parseWebGrant`
 *  collapsing anything but the exact 'gated'/'open' literals to 'off'), NEVER a passthrough of the
 *  spec's raw toolPolicy object — any other value/type ("yes", 1, {}, a junk key) yields the
 *  narrowest grant, so a future spec field can never silently flow into the matrix (codex P1-4).
 *  allowedTools missing / non-array → [] (fail-closed, §5.1). The shared AgentRunSpec TYPE
 *  (@shared/api/types) now spells all four toolPolicy keys, so this reads them directly — the
 *  structural cast that used to stand in for the stale type is gone. The runtime narrowing below
 *  is NOT redundant with those types: the spec is JSON off the wire, so it is re-derived from
 *  discriminated literals regardless of what the type claims. Exported for the
 *  discriminated-construction tests. */
export function agentRunContextFromSpec(spec: AgentRunSpec, jobId?: number): AgentRunContext {
  const toolPolicy = spec.toolPolicy
  const allowedRaw: unknown = toolPolicy?.allowedTools
  // S6 W3 (rev3.1 §5.1) — the mount list mirrors allowedTools' fail-closed shape: the Python
  // projection always emits the RESOLVED array (NULL → default mount set substituted server-side,
  // never re-derived here), so a spec missing/malforming it is a broken spec → [] (zero mounts),
  // NEVER null-passthrough into applySkillGating's fail-open manual semantic.
  const skillsRaw: unknown = toolPolicy?.skills
  return {
    agentId: spec.agentId,
    allowedTools: Array.isArray(allowedRaw)
      ? allowedRaw.filter((n): n is string => typeof n === 'string')
      : [],
    skills: Array.isArray(skillsRaw)
      ? skillsRaw.filter((n): n is string => typeof n === 'string')
      : [],
    modeGrants: { exec: toolPolicy?.grantExec === true, web: parseWebGrant(toolPolicy?.grantWeb) },
    // S6 W1 — carry the run's jobId so a paused approval freezes it into the stash for the
    // record-view pending projection. Conditional include: a caller that omits it (every existing
    // test + the shared type's cast callers) yields the pre-S6 object shape, byte-identical.
    ...(jobId != null ? { jobId } : {})
  }
}

/**
 * ADR-004 §4.4 — the SINGLE cfg wrapper for a per-agent tool face, shared by the fresh spawn
 * (runHeadlessAgent) and the island resume (approvalResume). Layers the owner's allowedTools
 * intersection on cfg.buildTools' OUTPUT (after create* → applySkillGating → applyContextModePolicy,
 * which received the SAME agentRunContext as its fourth parameter — matrix grants + whitelist
 * agentId all come from this one object), and records the context on the cfg so a pause freezes it
 * into the approval stash (maybeStashAndAnnounceApproval reads cfg.agentRunContext — the pause-time
 * server cfg is the authority, never a body).
 *
 * 🔴 This also fixes an S4 defect: before ADR-004 the allowedTools narrowing lived only in
 * runHeadlessAgent's local cfg2, so an island resume rebuilt the run from the BASE cfg and the
 * narrowing (and now the grants) was silently lost — resume drained on the full matrix floor,
 * violating ADR-003 D6's "only reduce" promise. With the stash freezing agentRunContext and both
 * paths rebuilding through this one function, pause→resume can never widen the tool face.
 */
export function wrapCfgForAgentRun(
  cfg: AiGatewayConfig,
  agentRunContext: AgentRunContext
): AiGatewayConfig {
  // Fail-closed normalization at the ONE funnel both paths share: an agent run never treats a
  // missing list as "no narrowing" (that semantic stays with non-agent callers of
  // intersectAllowedTools). skills mirrors it (S6 W3 §5.1: missing mount list → zero mounts,
  // never fail-open) — the normalized ctx is what the pause stash freezes, so a resume rebuilds
  // the exact same mount face.
  const ctx: AgentRunContext = {
    ...agentRunContext,
    allowedTools: agentRunContext.allowedTools ?? [],
    skills: agentRunContext.skills ?? []
  }
  const keep = new Set(ctx.allowedTools)
  return {
    ...cfg,
    agentRunContext: ctx,
    // ADR-004 §4.1 (codex终审 P1; rev3.1 §3.2 extends exec → exec ∪ web) — the intersection
    // domain is the NON-granted classes only. exec AND web tools are exempt: their presence is
    // decided SOLELY by the matrix (contextMode + grants) — allowed_tools is the defensive
    // narrowing for the read/domain_write face, while grant_exec/grant_web are the explicit
    // opt-ins for their classes; the control planes are orthogonal. Without the exemption a grant
    // is dead config: allowed_tools comes from the Settings tool picker /
    // DEFAULT_CUSTOM_AGENT_ALLOWED_TOOLS, whose vocabulary is read+domain_write only (the
    // tool-options endpoint offers no exec/web names), so the intersection would strip
    // run_command/web_fetch right after the matrix admitted them. Boundary: allowedTools=[] +
    // grant → the granted tools STILL register (and every call still crosses policy_rules /
    // first-run gate / grant-tier免卡 / HITL). An unclassified name fail-closes to 'exec' and
    // would share the exemption — harmless in practice: policy.test's completeness gate forces
    // every real tool to be classified, and the matrix already floors unclassified names whenever
    // there is no grant.
    buildTools: (collector, approvalMode, mode) => {
      const built = cfg.buildTools?.(collector, approvalMode, mode, ctx) ?? {}
      const out: ToolSet = {}
      for (const [name, t] of Object.entries(built)) {
        const cls = classOfTool(name)
        if (cls === 'exec' || cls === 'web' || keep.has(name)) out[name] = t
      }
      return out
    }
  }
}

/** Map a drain failure to a structured error code (mirrors searchAgentRun.normalizeLoopError):
 *  HTTP 429 → E_QUOTA, other upstream API errors → E_UPSTREAM, anything else → E_AGENT. */
function normalizeAgentError(err: unknown): { code: string; message: string } {
  if (APICallError.isInstance(err)) {
    return { code: err.statusCode === 429 ? 'E_QUOTA' : 'E_UPSTREAM', message: err.message }
  }
  return { code: 'E_AGENT', message: err instanceof Error ? err.message : String(err) }
}

/** Clip the accumulated assistant text to a one-line summary (mirrors approvalResume.clipSummary). */
function clipSummary(text: string, max = 180): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max)}…` : one
}

/** Resolve the finished run's step count (StreamTextResult.steps is a Promise). Best-effort → 0. */
async function resolveSteps(result: { steps?: unknown }): Promise<number> {
  try {
    const steps = await Promise.resolve(result.steps as Promise<unknown[]> | unknown[])
    return Array.isArray(steps) ? steps.length : 0
  } catch {
    return 0
  }
}

/**
 * Run one headless custom-agent turn: build a synthetic body from the spec, wrap cfg with the
 * per-agent tool narrowing, prepareChatRun under the DERIVED context mode, then
 * drain the stream server-side (driving the tool loop → execute → guard.verify/consume → write →
 * makePersistOnFinish). Never throws — every failure normalizes into { ok:false, outcome:'error' }.
 *
 * On a paused approval, makePersistOnFinish's既有 pause path runs UNCHANGED: it persists the redacted
 * turn and (only when cfg.islandAgentEnabled) stashes + announces an island card. Island off → the
 * turn just停在 the redacted pause; the outcome is 'paused_handoff' either way (the worker records
 * approval_state='pending', which the read side treats as "not a success").
 */
export async function runHeadlessAgent(
  cfg: AiGatewayConfig,
  opts: RunHeadlessAgentOpts,
  abortSignal: AbortSignal
): Promise<HeadlessAgentResult> {
  const { spec, sessionId } = opts
  const contextMode = deriveContextMode(spec)

  // Synthetic body: the owner-configured taskPrompt + the server-fenced emailEnvelope (already an
  // UNTRUSTED_EMAIL_BODY block from W2). The code-owned repeated-failure discipline is injected by
  // prepareChatRun into the trusted system channel when it sees this headless cfg's agentRunContext;
  // no spec/body string participates in that trusted section. Physically ONE user message — the
  // envelope carries its own fence, so concatenate it verbatim WITHOUT re-wrapping. A stable message
  // id (derived from jobId) lets persistTurn's eager-write dedup behave.
  const taskPrompt = spec.prompt?.taskPrompt ?? ''
  const envelope = spec.prompt?.emailEnvelope ?? ''
  const userText = envelope ? `${taskPrompt}\n\n${envelope}` : taskPrompt
  const body: Record<string, unknown> = {
    messages: [
      { id: `agent-user-${opts.jobId}`, role: 'user', parts: [{ type: 'text', text: userText }] }
    ],
    sessionId
  }
  if (spec.model) body.model = spec.model

  // cfg' wrapper (ADR-003 D6/D7 + ADR-004 §4.4). The allowedTools intersection is layered on
  // cfg.buildTools' OUTPUT — i.e. AFTER the full assembly chain (create* → applySkillGating →
  // applyContextModePolicy, which consumes the same agentRunContext for matrix grants + the
  // whitelist agentId). So a headless run's tool面 is: (the matrix's product under the derived
  // mode, incl. the per-agent exec grant) ∩ allowedTools. There is no body/prompt control surface.
  // wrapCfgForAgentRun is the SHARED wrapper the island resume also rebuilds through, so a
  // pause→resume chain keeps the exact same tool face. Both fresh and resumed drains use chatRun's
  // internal 10k termination sentinel; the worker's run-seconds abort remains the actual budget.
  const agentRunContext = agentRunContextFromSpec(spec, opts.jobId)
  const cfg2 = wrapCfgForAgentRun(cfg, agentRunContext)

  const prepared = await prepareChatRun(body, cfg2, abortSignal, contextMode)
  if (!prepared.ok) {
    return {
      ok: false,
      outcome: 'error',
      sessionId,
      steps: 0,
      error: { code: prepared.body.error, message: prepared.body.hint }
    }
  }
  const run = prepared.run

  // Drain the stream server-side (no client to pipe to) — mirrors approvalResume. basePersist
  // (makePersistOnFinish) owns persistence AND the island stash/announce on a pause (islandAgentEnabled
  // -gated, UNCHANGED — we do NOT introduce "stash even when island off"). We only OBSERVE the finished
  // message: whether it paused at an approval gate, was aborted, or carried a swallowed error chunk.
  const budgetTimeError = (steps: number): HeadlessAgentResult => ({
    ok: false,
    outcome: 'error',
    sessionId,
    steps,
    error: { code: 'E_BUDGET_TIME', message: 'run aborted (budget deadline or client cancel)' }
  })
  const basePersist = makePersistOnFinish(cfg2, run)
  let paused = false
  let aborted = false
  let streamError: unknown = null
  let errorText: string | null = null
  let assistantText = ''
  try {
    const stream = run.result.toUIMessageStream({
      originalMessages: run.rawMessages,
      generateMessageId: makeIdGenerator(),
      sendReasoning: false,
      // Without onError ai@7 masks the error chunk's errorText to a generic "An error occurred."
      // (same gotcha handleChat works around). Keep the FIRST error object (the propagation chain
      // re-reports the same failure wrapped in a plain Error) so the outcome below carries a
      // structured code (429 → E_QUOTA) + the real message, and log it — the worker only stores the
      // code, so this log line is the forensic trail.
      onError: (error: unknown) => {
        if (streamError == null) streamError = error
        console.error('[ai-gateway] agent-run stream error', error)
        return error instanceof Error ? error.message : String(error)
      },
      onFinish: async (args) => {
        aborted = args.isAborted === true
        if (!aborted) {
          paused = responseMessageAwaitsApproval(args.responseMessage as MailAgentUIMessage)
        }
        await basePersist(args)
      }
    })
    for await (const chunk of stream) {
      const c = chunk as { type?: string; delta?: unknown; text?: unknown; errorText?: unknown }
      if (c.type === 'text-delta') {
        assistantText +=
          typeof c.delta === 'string' ? c.delta : typeof c.text === 'string' ? c.text : ''
      } else if (c.type === 'error') {
        // streamText surfaces a non-abort upstream error as an error chunk (it does NOT always throw
        // from the drain). Capture it so an errored run never reports 'completed'.
        errorText = typeof c.errorText === 'string' ? c.errorText : 'stream error'
      }
    }
  } catch (err) {
    // A thrown drain failure. A budget/timeout abort OR a client (worker) disconnect surface as
    // `aborted` → E_BUDGET_TIME (ADR-003 D7); otherwise a structured upstream code.
    if (abortSignal.aborted) return budgetTimeError(await resolveSteps(run.result))
    const { code, message } = normalizeAgentError(err)
    return {
      ok: false,
      outcome: 'error',
      sessionId,
      steps: await resolveSteps(run.result),
      error: { code, message }
    }
  }

  const steps = await resolveSteps(run.result)
  // Abort (budget deadline / client cancel) is often SWALLOWED by streamText (marks isAborted, doesn't
  // throw). Detect it here so an aborted run is never mislabeled 'completed'. The endpoint's
  // AbortSignal.timeout(maxRunSeconds) fires before the worker's http timeout (+margin), so an abort
  // here is dominantly budget exhaustion.
  if (abortSignal.aborted || aborted) return budgetTimeError(steps)
  if (streamError != null || errorText) {
    // Prefer the original error object (captured in onError) over the chunk's errorText so the code
    // stays structured (E_QUOTA / E_UPSTREAM) instead of collapsing everything into E_AGENT.
    const { code, message } =
      streamError != null
        ? normalizeAgentError(streamError)
        : { code: 'E_AGENT', message: errorText as string }
    return { ok: false, outcome: 'error', sessionId, steps, error: { code, message } }
  }
  if (paused) {
    // paused_handoff — the turn stopped at an approval gate. NOT a success: the worker stamps
    // result_json.approval_state='pending' (island on → a card awaits; island off → it's effectively
    // void). The read side must never render this as "completed".
    return {
      ok: true,
      outcome: 'paused_handoff',
      sessionId,
      steps,
      summary: clipSummary(assistantText)
    }
  }
  const usage = await Promise.resolve(run.result.usage).catch(() => undefined)
  return {
    ok: true,
    outcome: 'completed',
    sessionId,
    steps,
    summary: clipSummary(assistantText) || undefined,
    usage
  }
}
