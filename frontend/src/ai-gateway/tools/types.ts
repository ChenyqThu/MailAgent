// chat-panel P4 Phase 03a — AI SDK Gateway read-tool shared types + audit helper.
//
// The gateway read tools (email/kos/report) are AI SDK `tool()` definitions whose
// `execute` runs against the injected MailAgentDomainClient. This module owns the
// pieces every tool shares:
//   - the per-request audit collector captured by CLOSURE (each tool is built bound
//     to one `collector` array and pushes one entry per call). The gateway drains it
//     in onFinish and writes chat_tool_call keyed to the persisted assistant message
//     (matching the legacy harness's appendToolCall/updateToolCall audit, fields ≥
//     legacy). 🔴 We deliberately do NOT thread the collector through streamText
//     `experimental_context`: the AI SDK docs warn to treat that object as immutable
//     (it may be cloned/frozen per-call), which would silently drop audit entries.
//     A closure-captured array is robust regardless of SDK context semantics AND is
//     directly unit-testable (build tools with a collector → execute → assert it),
//     without driving a full streamText tool loop.
//   - the error normalizer (DomainError → typed {code,message}) + a thrown
//     ToolExecutionError the AI SDK renders as a tool-error part the model reads.
//
// 🔴 read tools NEVER set `needsApproval` (silent tier). Approval lands with write
//    tools in phase-03b/04b.

import { tool, type FlexibleSchema, type Tool } from 'ai'

import { DomainError, type DomainPolicyVerdict } from '../python/domainClient'
import { type ApprovalGuard, type ApprovalRecord, type ApprovalRisk } from '../security/approval'
// S2 W0 (ADR-001) — context-mode × tool-class policy: the auto-approve predicate consults the
// tool's policy CLASS (from the policy.ts single-source map) + the run's server-asserted context
// MODE, and a capability_change/exec/outbound tool hard-rejects at execute time outside a manual
// session (runtime double-insurance behind the registration-time filter in tools/index.ts).
import {
  ACCEPT_EDITS_AUTO_APPROVE_TOOLS,
  BYPASS_STILL_ASK,
  classOfTool,
  isToolClassAllowedInMode,
  mayAutoApprove,
  normalizeContextMode,
  type AgentContextMode,
  type AgentModeGrants,
  type GatewayToolClass
} from './policy'
// RELATIVE import (not the @shared alias) so the pure-Node poc harness (tsx, which doesn't
// resolve tsconfig paths at runtime) can load the gateway tools; vite/vitest/tsc resolve it
// identically. a2ui.ts is pure TS (types + zod, no react) — safe for the gateway core.
import { buildToolA2UIPayload } from '../../shared/assistant/tools/a2ui'

// v7 adaptation — auditedTool/auditedWriteTool/auditedSendTool are GENERIC over the tool input type I
// and hand tool() a FlexibleSchema<I> wrapper. v7's tool() infers INPUT from the CONCRETE inputSchema;
// a generic wrapper collapses that inference to `never`, so neither a bare tool(...) (→ never) nor an
// explicit tool<I>(...) (→ I must satisfy the RUNTIME_CONTEXT/Context constraint) type-checks. This
// thin helper keeps the generic wrappers + their execute/needsApproval bodies type-checked against I,
// casting ONLY at the tool() call boundary — behaviour is identical to a direct tool() call. The
// audited wrappers are the SSoT for I; every call site passes a concrete zod schema so I is sound.
function makeTool(def: unknown): Tool {
  return tool(def as never) as Tool
}

/** One finished tool call, ready to persist into chat_tool_call. The gateway
 *  collects these per request and the Electron wrapper writes them (appendToolCall
 *  + updateToolCall) keyed to the assistant message id. Read tools (03a) omit the
 *  approval fields → the writer defaults `confirmation_tier` to 'silent' with no
 *  approval columns; write tools (03b) carry the tier + approval audit. */
export interface GatewayToolAuditEntry {
  toolUseId: string
  toolName: string
  inputJson: string
  outputJson: string
  status: 'ok' | 'error'
  durationMs: number
  /** Phase 03b — 'preview' | 'edit' for write tools; omitted → 'silent' (read). */
  confirmationTier?: 'silent' | 'preview' | 'edit'
  /** Phase 03b — write-tool approval outcome: 'approved'/'edited' = a HUMAN passed the card and
   *  the write executed; 'rejected' = approval guard rejected (not executed). Omitted
   *  for read tools (no approval). S2 W1 adds 'auto_whitelist' — an exec tool executed
   *  without a card because a structured PolicyRule matched (whitelistRuleId carries which).
   *  07-16 (codex r1 P2-4) — card-skipped executions are audited DISTINCTLY, never as 'approved'
   *  ('approved'/'edited' now mean a real human decision, load-bearing for incident forensics):
   *  'auto_accept_edits' / 'auto_bypass' = the owner-global mode skipped the card;
   *  'auto_reversible' = the pre-existing reversible-preview skip (approvalMode 'auto-reversible',
   *  previously indistinguishably audited 'approved'). chat_tool_call.approval_status is free-form
   *  TEXT (v10, no CHECK) — the new values need no schema migration, mirroring 'auto_whitelist'. */
  approvalStatus?:
    | 'approved'
    | 'edited'
    | 'rejected'
    | 'auto_whitelist'
    | 'auto_accept_edits'
    | 'auto_bypass'
    | 'auto_reversible'
  /** S2 W1 — exec-tool whitelist audit (chat_tool_call.whitelist_rule_id): the PolicyRule id that
   *  auto-allowed this run without a card (approvalStatus='auto_whitelist'). null/omitted otherwise. */
  whitelistRuleId?: number | null
  /** Phase 03b — sha256 of the approved input (the domain guard binding). */
  approvalHash?: string
  /** Phase 03b — the user-edited input (edit-tier writes only); null otherwise. */
  userEditedInputJson?: string | null
  /** Phase 04a — the A2UI render payload (JSON) the rich card showed for this tool, stamped
   *  for audit into chat_tool_call.ui_payload_json. Only present when a2uiEnabled
   *  is on AND the tool has a registered card; null/omitted otherwise. NOT part of the
   *  model-visible tool result (UI/audit only — keeps 03b parity + no model noise). */
  uiPayloadJson?: string | null
  /** Phase 04b — outbound-send (email_prepare_send) only: the content hash that bound the
   *  approved payload to what was sent (chat_tool_call.content_hash). null/omitted otherwise. */
  contentHash?: string | null
  /** Phase 04b — outbound-send only: the one-shot idempotency key the send ledger keyed on
   *  (chat_tool_call.idempotency_key). null/omitted otherwise. */
  idempotencyKey?: string | null
}

/** A per-request audit collector — a plain array the gateway creates per /api/ai/chat
 *  request and binds into the tools (closure). Drained in onFinish. */
export type GatewayToolAuditCollector = GatewayToolAuditEntry[]

/** The owner-global chat approval mode (07-16 approval-mode switcher) — persisted in
 *  agent_config.db (owner_settings), switched ONLY through the owner UI (composer chip /
 *  serve-api verify_cf_access endpoint; no gateway tool can switch it), and hot-read by the
 *  gateway per run (cfg.resolveGlobalApprovalMode — any read failure fail-closes to 'manual').
 *   - 'manual'      (DEFAULT) — byte-identical current behaviour: the per-request
 *                   'always'|'auto-reversible' semantics apply unchanged.
 *   - 'acceptEdits' — ONLY the by-name allow-list (policy.ts ACCEPT_EDITS_AUTO_APPROVE_TOOLS)
 *                   auto-approves; anything unlisted — send included — keeps asking (fail-closed).
 *   - 'bypass'      — everything auto-approves, send/exec/skill-install included (owner 拍板:
 *                   无例外; Claude Code bypassPermissions semantics).
 *  Both overrides apply ONLY to manual_chat runs (injection gated in prepareChatRun AND
 *  re-checked at each consumption point) — headless custom-agent runs never see them. */
export type GlobalApprovalMode = 'manual' | 'acceptEdits' | 'bypass'

/** Auto-approval mode threaded from the request body (body.approvalMode) → buildGatewayTools →
 *  each write tool's needsApproval. Mirrors the renderer's @shared/lib/approvalMode.ApprovalMode
 *  (a string union — no shared import, so the gateway core stays harness-testable / @shared-free).
 *   - 'always'          (DEFAULT, absent body field) — every write tool asks (current behaviour).
 *   - 'auto-reversible'                              — reversible preview-tier writes execute
 *                                                     without a card; edit + blocking still ask.
 *   - 'acceptEdits' / 'bypass' (07-16) — the owner-global mode overlay, injected SERVER-SIDE by
 *     prepareChatRun (never from the body) and only for manual_chat runs; see GlobalApprovalMode.
 *  🔴 The high-risk blocking send (auditedSendTool) ignores everything except the explicit
 *     'bypass' literal, wired through its own narrowly-typed factory param (safety floor). */
export type GatewayApprovalMode = 'always' | 'auto-reversible' | 'acceptEdits' | 'bypass'

/** True for an abort/cancel error — let it propagate untouched so the AI SDK
 *  treats the run as aborted (not as a tool error). */
function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'AbortError' || /abort/i.test(e.message))
}

/** Normalize a thrown tool error into a stable {code,message}. DomainError carries
 *  the serve-api envelope code; a duck-typed `.code` (e.g. KOS E_KOS_*) is honored;
 *  anything else is E_INTERNAL so the model can read it and self-correct. */
export function normalizeToolError(e: unknown): { code: string; message: string } {
  if (e instanceof DomainError) return { code: e.code, message: e.message }
  const code = (e as { code?: unknown }).code
  if (e instanceof Error && typeof code === 'string') return { code, message: e.message }
  return { code: 'E_INTERNAL', message: e instanceof Error ? e.message : String(e) }
}

/** A thrown tool error the AI SDK turns into a tool-error part. Carries the
 *  structured `code` so audit + parity tests can read it. */
export class ToolExecutionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'ToolExecutionError'
    this.code = code
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return '"[unserializable]"'
  }
}

/**
 * Build a silent-tier AI SDK read tool with built-in audit, bound to one `collector`
 * (closure). `run` does the domain call + parity massage and returns the model-facing
 * output. The wrapper:
 *   - times the call, pushes an `ok` audit entry (input+output) into `collector`;
 *   - on failure pushes an `error` entry (code+message) and throws a
 *     ToolExecutionError → tool-error part (model self-corrects);
 *   - lets abort propagate untouched (the aborted turn isn't persisted anyway).
 * read tools never request approval — there is no `needsApproval` here by design.
 */
export function auditedReadTool<I>(
  opts: {
    name: string
    description: string
    inputSchema: FlexibleSchema<I>
    run: (input: I, signal: AbortSignal | undefined) => Promise<unknown>
  },
  collector: GatewayToolAuditCollector
): Tool {
  return makeTool({
    description: opts.description,
    inputSchema: opts.inputSchema,
    execute: async (input: I, { toolCallId, abortSignal }) => {
      const start = Date.now()
      try {
        const output = await opts.run(input, abortSignal)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson(output),
          status: 'ok',
          durationMs: Date.now() - start
        })
        return output
      } catch (e) {
        if (isAbortError(e)) throw e
        const { code, message } = normalizeToolError(e)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start
        })
        throw new ToolExecutionError(code, message)
      }
    }
  })
}

/**
 * Build an approval-gated AI SDK write tool with built-in audit, bound to one
 * `collector` (closure) + one `guard` (the per-gateway ApprovalGuard). Phase 03b.
 *
 * HITL two-call flow (architecture §5.3 / §13.4):
 *   - `needsApproval` always returns true (write tools are never silent). As a
 *     side-effect it REGISTERS the approval record (keyed by toolCallId, keep-first)
 *     on the FIRST streamText run, when ai@6 decides the tool needs approval. The run
 *     then ends with a `tool-approval-request` part (no execute).
 *   - `execute` runs on the SECOND run only — after the user approved. It then runs the
 *     MailAgent domain guard (`guard.verify`: record exists, not expired, input matches
 *     for preview / edit permits change) — the AUTHORITATIVE write gate — runs the domain
 *     write via `run`, and pushes a write-audit entry (tier + approval_status +
 *     approval_hash + user_edited) into `collector`. (ai@6's signed-approval layer,
 *     streamText `experimental_toolApprovalSecret`, is intentionally NOT used: the native
 *     assistant-ui replay drops the request signature — see chatRun.ts.)
 *
 * A guard rejection (not-found / expired / preview hash mismatch) audits an
 * `approvalStatus:'rejected'` error entry and throws a ToolExecutionError → the write
 * never executes ("no silent write"; "no execution without a valid approval").
 */
export function auditedWriteTool<I>(
  opts: {
    name: string
    description: string
    inputSchema: FlexibleSchema<I>
    // preview/edit only — the high-risk 'blocking' send tool uses auditedSendTool (below), whose
    // audit tier maps to 'edit'. This keeps confirmationTier within the chat_tool_call CHECK set.
    risk: Exclude<ApprovalRisk, 'blocking'>
    /** Phase 04a — top-level input fields the user may edit on the rich card (edit-tier
     *  only, e.g. ['body_markdown']). Registered onto the approval so applyEdit can overlay
     *  only these (identity fields pinned). Omitted → not editable. */
    editableFields?: readonly string[]
    /** Phase 04a — stamp the A2UI render payload into the audit row (ui_payload_json) when
     *  a2uiEnabled is on (always since S3). UI/audit only — never enters the model result. */
    a2uiEnabled?: boolean
    /** Auto-approval mode (body.approvalMode, default 'always'). When 'auto-reversible' a
     *  preview-tier (reversible) write skips the approval card and executes in the SAME call;
     *  edit-tier still asks. The approval record is registered regardless (execute's verify +
     *  the audit need it), so the only change is whether needsApproval returns true.
     *  S2 W0 (ADR-001 D3): auto-reversible additionally requires class==='domain_write' AND
     *  contextMode==='manual_chat' — a preview-tier capability change (set_skill_enabled) always
     *  asks now.
     *  07-16 — may also carry the SERVER-injected owner-global modes (never from a body):
     *  'acceptEdits' skips the card ONLY for writes in ACCEPT_EDITS_AUTO_APPROVE_TOOLS
     *  (fail-closed allow-list — an unlisted tool asks); 'bypass' skips it for every write. Both
     *  require contextMode==='manual_chat' at this consumption point too (defense in depth behind
     *  the prepareChatRun injection gate). */
    approvalMode?: GatewayApprovalMode
    /** S2 W0 (ADR-001 D2) — TEST-ONLY override of the tool's policy class. Production ALWAYS resolves
     *  the class from the policy.ts single-source map by name (a name missing there fail-closes to
     *  'exec': manual-only + never auto-approved). Named `testOnlyToolClass` so a real tool can never
     *  quietly claim a class different from its map entry — only a unit test drives the matrix with
     *  a synthetic class. */
    testOnlyToolClass?: GatewayToolClass
    /** S2 W0 (ADR-001 D1) — the run's server-asserted context mode, threaded from
     *  prepareChatRun's trustedContextMode via buildGatewayTools. Absent/unknown fail-closes to
     *  'untrusted_trigger': the write never auto-approves, and a capability_change/exec/outbound
     *  tool hard-rejects at execute (runtime double-insurance — registration-time filtering
     *  should have kept it out of the ToolSet already). */
    contextMode?: AgentContextMode
    /** S5 W4 (ADR-004 D2) — the per-agent mode grants of a headless agent run, threaded by the
     *  exec factory from the SAME agentRunContext that registration (applyContextModePolicy)
     *  consumed, so the runtime modeDenied double-insurance below evaluates the SAME
     *  isToolClassAllowedInMode(class, mode, grants) — one function, one grants object, no second
     *  decision point. Absent (every manual caller + every non-exec factory) → the pre-ADR-004
     *  matrix, byte-identical. */
    modeGrants?: AgentModeGrants
    /** Part B (harness 上岛) — one-shot execution claim. When true, execute calls guard.consume()
     *  right after verify so an approval executes AT MOST ONCE across BOTH resume paths (island
     *  /api/ai/approval/decide and renderer /api/ai/chat): whichever lands first consumes, the second
     *  throws E_APPROVAL_USED → the write never runs twice. Enabled by the lifecycle only when
     *  MAILAGENT_ISLAND_AGENT_ENABLED is on (a paused approval can be resumed from two places); off
     *  (default) → no consume, byte-identical to the pre-Part-B write path (the send tool has always
     *  consumed regardless — this extends the same one-shot to preview/edit writes). */
    oneShot?: boolean
    /** S2 W1 (ADR-001 D4) — exec-tool structured whitelist hook (run_command / file_read /
     *  file_write only). When present, needsApproval consults it — with the run's server-asserted
     *  contextMode captured by the exec factory, NEVER a body value — BEFORE showing a card:
     *  'auto_allow' → skip the card (execute records approval_status='auto_whitelist' +
     *  whitelist_rule_id); 'ask' / timeout / any error → the card (fail-closed). It runs INSTEAD of
     *  the approvalMode auto-reversible path (exec tools are edit-tier + class exec, which that path
     *  never relaxes anyway). Absent (every non-exec tool) → the existing behaviour, byte-identical. */
    policyEvaluate?: (input: I) => Promise<DomainPolicyVerdict>
    run: (
      input: I,
      ctx: { userEdited: boolean; signal: AbortSignal | undefined }
    ) => Promise<unknown>
  },
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard
): Tool {
  /** Build the optional A2UI audit payload (UI/audit only — NOT the model result). */
  const a2uiJson = (args: unknown, result: unknown, userEdited: boolean): string | undefined => {
    if (!opts.a2uiEnabled) return undefined
    const payload = buildToolA2UIPayload(opts.name, { args, result, userEdited, risk: opts.risk })
    return payload ? safeJson(payload) : undefined
  }

  // S2 W0 (ADR-001 D2/D3) — resolve the policy class (single source: policy.ts map; explicit only
  // in tests) + the run's context mode (fail-closed: absent/unknown → 'untrusted_trigger'). A
  // capability_change/exec/outbound tool outside manual_chat is modeDenied: registration-time
  // filtering (applyContextModePolicy) already keeps it out of the ToolSet, and this is the
  // runtime double-insurance for an entrypoint that missed the mode.
  const toolClass = opts.testOnlyToolClass ?? classOfTool(opts.name)
  const contextMode = normalizeContextMode(opts.contextMode)
  const modeDenied = !isToolClassAllowedInMode(toolClass, contextMode, opts.modeGrants)

  // S2 W1 — when a structured whitelist rule auto-allows an exec run (needsApproval returns false),
  // stash the matched rule id keyed by toolCallId so execute (same call, right after) can record
  // approval_status='auto_whitelist' + whitelist_rule_id. Presence of a key = "this call was
  // whitelist-skipped", so execute overrides the default 'approved' audit. Cleared on read.
  const whitelistRuleIdByCall = new Map<string, number | null>()

  // 07-16 (codex r1 P2-4) — same idiom for the card-skip paths of needsApproval: stash WHY the
  // card was skipped so execute audits a distinct approval_status ('auto_accept_edits' /
  // 'auto_bypass' / 'auto_reversible') instead of the human-decision 'approved'. Cleared on read.
  const autoSkipByCall = new Map<string, 'auto_accept_edits' | 'auto_bypass' | 'auto_reversible'>()

  return makeTool({
    description: opts.description,
    inputSchema: opts.inputSchema,
    // First run: register the approval record (keep-first) ALWAYS — execute's guard.verify +
    // the audit need it whether or not a card is shown. Then decide if a card is required:
    //   - 'auto-reversible' + preview-tier (reversible) + class domain_write + mode manual_chat →
    //     return false → ai@6 runs execute in the SAME call (no card). guard.verify still passes
    //     (record was registered; preview hash matches the unchanged input) and the audit records
    //     approval_status='approved'. Tier keeps the card UX; class+mode carry the policy
    //     (ADR-001 D3) — a preview-tier capability change (set_skill_enabled) always asks now.
    //   - everything else (default 'always', or any edit-tier write) → return true → the two-call
    //     HITL flow (approval card) as before. The model never sees a non-reversible write run
    //     without the user approving it.
    // (input/execute params are left unannotated so tool() infers INPUT=I from inputSchema alone —
    // an explicit `: I` on these contravariant param sites breaks tool()'s overload inference.)
    needsApproval: (input, { toolCallId }) => {
      // modeDenied → no approval card at all: this tool can never execute in this context mode,
      // so pausing the run on a card would be misleading. Return false and let execute
      // hard-reject (tool-error the model can read).
      if (modeDenied) return false
      guard.register(toolCallId, opts.name, opts.risk, input, opts.editableFields)
      // 07-16 approval-mode switcher — the owner-global overrides, BEFORE the policyEvaluate
      // branch (so 'bypass' releases exec without a whitelist round-trip, and 'acceptEdits'
      // releases file_read/file_write while run_command — in the by-name retain set — still
      // falls through to the whitelist-or-card path). Both are double-gated on manual_chat:
      // prepareChatRun only injects them for manual runs, and this consumption-side re-check
      // (mayAutoApprove precedent) keeps a mis-threaded headless run fail-closed. The approval
      // record above is registered regardless — execute's guard.verify + the audit need it, so
      // the authoritative write-gate chain (verify/consume/audit) is intact on every skip.
      if (contextMode === 'manual_chat') {
        // 07-21 (codex HIGH-1) — bypass is otherwise 无例外, but BYPASS_STILL_ASK (currently only
        // notion_agent_chat) stays 恒 HITL even here: an external-AI call whose Notion-side writes
        // can't be undone from this machine is the same「安全地板」floored elsewhere (exec/skill
        // install). Skipping the bypass branch falls through to the unchanged ask paths → return
        // true (edit tier, no policyEvaluate) → the card is shown.
        if (opts.approvalMode === 'bypass' && !BYPASS_STILL_ASK.has(opts.name)) {
          autoSkipByCall.set(toolCallId, 'auto_bypass')
          return false
        }
        // codex r1 P1-3 — fail-closed ALLOW-list (inverted from the original deny-list): only a
        // tool explicitly named in ACCEPT_EDITS_AUTO_APPROVE_TOOLS skips the card; any unlisted
        // (including future/unclassified) write falls through to the unchanged ask paths below.
        if (opts.approvalMode === 'acceptEdits' && ACCEPT_EDITS_AUTO_APPROVE_TOOLS.has(opts.name)) {
          autoSkipByCall.set(toolCallId, 'auto_accept_edits')
          return false
        }
      }
      // S2 W1 — exec tools consult the structured whitelist instead of the approvalMode path. A
      // matching rule (auto_allow) skips the card (stash the rule id for execute's audit); any
      // other verdict OR an error → the card (fail-closed). Returns a Promise (ai@6 awaits it).
      if (opts.policyEvaluate) {
        return opts
          .policyEvaluate(input)
          .then((verdict) => {
            if (verdict.decision === 'auto_allow') {
              whitelistRuleIdByCall.set(toolCallId, verdict.rule_id)
              return false
            }
            return true
          })
          .catch(() => true)
      }
      if (
        opts.approvalMode === 'auto-reversible' &&
        opts.risk === 'preview' &&
        mayAutoApprove(toolClass, contextMode)
      ) {
        autoSkipByCall.set(toolCallId, 'auto_reversible')
        return false
      }
      return true
    },
    execute: async (input, { toolCallId, abortSignal }) => {
      const start = Date.now()
      // S2 W0 runtime double-insurance (ADR-001 D3): a capability_change/exec/outbound tool must
      // never run outside a manual session — hard-reject before any guard/domain interaction.
      if (modeDenied) {
        const code = 'E_CONTEXT_MODE_DENIED'
        const message = `${opts.name} (${toolClass}) is not available in a ${contextMode} run`
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start,
          confirmationTier: opts.risk,
          approvalStatus: 'rejected'
        })
        throw new ToolExecutionError(code, message)
      }
      // Domain guard (second run): expiry + (preview) input-binding + (edit) UI-edit override,
      // layered on ai@6's signature. Rejection → audit 'rejected' + tool-error, write never runs.
      let userEdited = false
      let approvalHash: string | undefined
      let effectiveInput: unknown = input
      try {
        const v = guard.verify(toolCallId, input)
        userEdited = v.userEdited
        approvalHash = v.record.inputHash
        // Phase 04a — execute the EFFECTIVE input (the applyEdit override when the user edited
        // the card, else the verified input). The ai@6 history input stays `input` (signature
        // intact); the domain decides what actually runs.
        effectiveInput = v.effectiveInput
        // Part B — one-shot claim so the same approval never double-executes across the island
        // /decide resume and the renderer /api/ai/chat resume. Fires E_APPROVAL_USED on the second
        // (caught below → audited 'rejected', no write). Off (default) → skipped, byte-identical.
        if (opts.oneShot) guard.consume(toolCallId)
      } catch (e) {
        const { code, message } = normalizeToolError(e)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start,
          confirmationTier: opts.risk,
          approvalStatus: 'rejected'
        })
        throw new ToolExecutionError(code, message)
      }
      // S2 W1 — an exec run the whitelist auto-allowed (needsApproval skipped the card) audits as
      // 'auto_whitelist' + the matched rule id, distinct from the human-approved 'approved'/'edited'.
      // 07-16 (codex r1 P2-4) — likewise a mode/auto-reversible skip audits its stashed reason;
      // 'approved'/'edited' are reserved for a real human card decision.
      const wasWhitelisted = whitelistRuleIdByCall.has(toolCallId)
      const whitelistRuleId = wasWhitelisted
        ? (whitelistRuleIdByCall.get(toolCallId) ?? null)
        : null
      whitelistRuleIdByCall.delete(toolCallId)
      const autoSkip = autoSkipByCall.get(toolCallId)
      autoSkipByCall.delete(toolCallId)
      const approvalStatus = wasWhitelisted
        ? 'auto_whitelist'
        : (autoSkip ?? (userEdited ? 'edited' : 'approved'))
      // userEditedInputJson records the EXECUTED (effective) input when edited; input_json
      // stays the model-proposed (history) input — matching the legacy audit shape.
      const userEditedJson = userEdited ? safeJson(effectiveInput) : null
      try {
        const output = await opts.run(effectiveInput as I, { userEdited, signal: abortSignal })
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson(output),
          status: 'ok',
          durationMs: Date.now() - start,
          confirmationTier: opts.risk,
          approvalStatus,
          approvalHash,
          userEditedInputJson: userEditedJson,
          ...(wasWhitelisted ? { whitelistRuleId } : {}),
          uiPayloadJson: a2uiJson(effectiveInput, output, userEdited)
        })
        return output
      } catch (e) {
        if (isAbortError(e)) throw e
        const { code, message } = normalizeToolError(e)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start,
          confirmationTier: opts.risk,
          approvalStatus,
          approvalHash,
          userEditedInputJson: userEditedJson,
          ...(wasWhitelisted ? { whitelistRuleId } : {})
        })
        throw new ToolExecutionError(code, message)
      }
    }
  })
}

/**
 * Build the high-risk OUTBOUND-SEND tool (email_prepare_send) — Phase 04b. Like auditedWriteTool
 * but for the one tool that performs a real, irreversible SMTP send, so it adds the two extra
 * guards of the "double guard" (architecture §13.10.3 / phase-04 §6):
 *   - idempotency (gateway scope): after the approval is verified, `guard.consume()` reserves the
 *     blocking approval for its ONE allowed execution — a replayed approval-response throws
 *     E_APPROVAL_USED and never sends twice (the Python send ledger is the cross-process half).
 *   - content hash: `run` computes the content hash over the EFFECTIVE (post-edit) outbound
 *     payload + signs the approval token, sends to Python (which re-verifies both), and returns
 *     it for audit. The card edit rides the 04a resolve side-channel, so the hash is naturally
 *     recomputed over the edited payload (the ai@6 history input is unchanged → signature valid).
 *
 * 🔴 Risk vocabulary: the approval is registered at risk 'blocking' (idempotency + editable send
 *    fields), but the AUDIT confirmation_tier is written as 'edit' — the eval tool_catalog +
 *    chat_tool_call CHECK only allow silent/preview/edit, and email_prepare_send's catalog tier
 *    is 'edit'. 'blocking' is the gateway/A2UI-risk vocabulary only.
 */
export function auditedSendTool<I>(
  opts: {
    name: string
    description: string
    inputSchema: FlexibleSchema<I>
    /** Top-level send fields the user may edit on the SendApprovalCard (identity fields like
     *  internal_id are pinned). e.g. ['to','cc','bcc','subject','body_markdown']. */
    editableFields: readonly string[]
    a2uiEnabled?: boolean
    /** S2 W0 (ADR-001 D1/D3) — the run's server-asserted context mode. The send is class
     *  'outbound' (manual_chat-only): outside a manual session execute hard-rejects (runtime
     *  double-insurance; registration-time filtering should have dropped the tool already).
     *  needsApproval stays a hard `true` regardless — there is deliberately still no path to
     *  auto-approve a send. Absent/unknown fail-closes to 'untrusted_trigger'. */
    contextMode?: AgentContextMode
    /** 07-16 approval-mode switcher — the ONE deliberate breach of the "no path to auto-approve
     *  a send" contract above, and it is as narrow as the type system allows: the param accepts
     *  ONLY the literal 'bypass' (owner 拍板 2026-07-16: bypass = 无例外全放行, Claude Code
     *  bypassPermissions semantics). It can structurally never be wired to 'always' /
     *  'auto-reversible' / 'acceptEdits' — those modes keep the hard-true floor. Set by
     *  createSendTools from the SERVER-resolved global mode (prepareChatRun, manual_chat-gated),
     *  never from a request body; needsApproval additionally re-checks manual_chat. The guard
     *  chain (register → verify → one-shot consume → content hash + Python send ledger) runs
     *  unchanged on the skip — bypass removes the card, never the double guard. */
    bypassMode?: 'bypass'
    /** Compute the content hash, sign the token, perform the real send via the domain client, and
     *  return the model-facing output + the content hash for audit. Receives the verified
     *  approval record (its idempotencyKey + expiry feed the signed token). */
    run: (
      input: I,
      ctx: { userEdited: boolean; signal: AbortSignal | undefined; record: ApprovalRecord }
    ) => Promise<{ output: unknown; contentHash: string }>
  },
  collector: GatewayToolAuditCollector,
  guard: ApprovalGuard
): Tool {
  const RISK: ApprovalRisk = 'blocking'
  // blocking maps DOWN to 'edit' for chat_tool_call.confirmation_tier (CHECK) + the eval catalog.
  const AUDIT_TIER = 'edit' as const

  const a2uiJson = (args: unknown, result: unknown, userEdited: boolean): string | undefined => {
    if (!opts.a2uiEnabled) return undefined
    const payload = buildToolA2UIPayload(opts.name, { args, result, userEdited, risk: 'blocking' })
    return payload ? safeJson(payload) : undefined
  }

  // S2 W0 (ADR-001 D3) — the send is class 'outbound' (manual_chat-only). Runtime
  // double-insurance mirrors auditedWriteTool; needsApproval below stays a hard true.
  const contextMode = normalizeContextMode(opts.contextMode)
  const modeDenied = !isToolClassAllowedInMode('outbound', contextMode)

  // 07-16 (codex r1 P2-4) — calls whose card was skipped by the owner-global bypass mode, so
  // execute audits approval_status='auto_bypass' (never the human-decision 'approved').
  const bypassSkippedCalls = new Set<string>()

  return makeTool({
    description: opts.description,
    inputSchema: opts.inputSchema,
    // 🔴 The high-risk outbound send ALWAYS asks — it hard-returns true regardless of approvalMode
    // ('auto-reversible' relaxes only reversible preview writes, never an irreversible send). This is
    // the safety floor; auditedSendTool intentionally takes no approvalMode param so it can never be
    // wired to skip approval. 07-16 — the single exception is the owner-global 'bypass' mode via the
    // narrowly-typed bypassMode param (see its doc above): manual_chat-only, register/verify/consume
    // and the Python-side double guard all still run — only the card is skipped.
    needsApproval: (input, { toolCallId }) => {
      guard.register(toolCallId, opts.name, RISK, input, opts.editableFields)
      if (opts.bypassMode === 'bypass' && contextMode === 'manual_chat') {
        bypassSkippedCalls.add(toolCallId)
        return false
      }
      return true
    },
    execute: async (input, { toolCallId, abortSignal }) => {
      const start = Date.now()
      // S2 W0 runtime double-insurance (ADR-001 D3): no send ever runs outside a manual session,
      // even if a future entrypoint misses the mode and the card was shown + approved.
      if (modeDenied) {
        const code = 'E_CONTEXT_MODE_DENIED'
        const message = `${opts.name} (outbound) is not available in a ${contextMode} run`
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start,
          confirmationTier: AUDIT_TIER,
          approvalStatus: 'rejected'
        })
        throw new ToolExecutionError(code, message)
      }
      let userEdited = false
      let record: ApprovalRecord
      let effectiveInput: unknown = input
      try {
        const v = guard.verify(toolCallId, input)
        userEdited = v.userEdited
        record = v.record
        effectiveInput = v.effectiveInput
        // Reserve the one allowed execution (gateway-scope idempotency) BEFORE the send. A
        // replayed approval-response → E_APPROVAL_USED → the email is never sent twice.
        guard.consume(toolCallId)
      } catch (e) {
        const { code, message } = normalizeToolError(e)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start,
          confirmationTier: AUDIT_TIER,
          approvalStatus: 'rejected'
        })
        throw new ToolExecutionError(code, message)
      }
      const approvalStatus = bypassSkippedCalls.delete(toolCallId)
        ? 'auto_bypass'
        : userEdited
          ? 'edited'
          : 'approved'
      const userEditedJson = userEdited ? safeJson(effectiveInput) : null
      try {
        const { output, contentHash } = await opts.run(effectiveInput as I, {
          userEdited,
          signal: abortSignal,
          record
        })
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson(output),
          status: 'ok',
          durationMs: Date.now() - start,
          confirmationTier: AUDIT_TIER,
          approvalStatus,
          approvalHash: record.inputHash,
          userEditedInputJson: userEditedJson,
          contentHash,
          idempotencyKey: record.idempotencyKey ?? null,
          uiPayloadJson: a2uiJson(effectiveInput, output, userEdited)
        })
        return output
      } catch (e) {
        if (isAbortError(e)) throw e
        const { code, message } = normalizeToolError(e)
        collector.push({
          toolUseId: toolCallId,
          toolName: opts.name,
          inputJson: safeJson(input),
          outputJson: safeJson({ error: code, message }),
          status: 'error',
          durationMs: Date.now() - start,
          confirmationTier: AUDIT_TIER,
          approvalStatus,
          approvalHash: record.inputHash,
          userEditedInputJson: userEditedJson,
          idempotencyKey: record.idempotencyKey ?? null
        })
        throw new ToolExecutionError(code, message)
      }
    }
  })
}
