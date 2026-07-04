// S2 W0 (task 07-02-s2-exec-skill-install, ADR-001) — context-mode × tool-class policy matrix.
//
// Two orthogonal axes, both SERVER-asserted (never client input):
//   - AgentContextMode: run-level provenance — who initiated this run. Asserted by each trusted
//     entrypoint as an explicit prepareChatRun parameter (NEVER read from the request body);
//     absent/unknown normalizes fail-closed to 'untrusted_trigger' (the strictest mode), so a
//     future entrypoint that forgets to pass it can only be SAFER, never silently privileged.
//   - GatewayToolClass: what a tool can do (read / reversible domain write / capability change /
//     local exec / outbound). Independent of the approval `tier` (preview/edit/blocking), which
//     keeps owning the approval-card UX — class owns POLICY (ADR-001 D2: tier 管卡片, class 管策略).
//
// The matrix (ADR-001 D3):
//   - read + domain_write register in EVERY mode (domain writes stay HITL outside manual, because
//     mayAutoApprove requires manual_chat — see below).
//   - capability_change / exec / outbound are manual_chat-ONLY: outside a manual session they are
//     (a) not registered at all (applyContextModePolicy strips them from the ToolSet — the model
//     cannot see them), and (b) hard-rejected at execute time as a second line of defense
//     (types.ts) in case a future entrypoint misses the mode.
//   - auto-approve (approvalMode 'auto-reversible' skipping the card) is a privilege of
//     REVERSIBLE DOMAIN writes in an owner-driven manual session ONLY: mayAutoApprove ⇔
//     class==='domain_write' && mode==='manual_chat'. This closes the set_skill_enabled escape
//     (preview tier alone no longer skips the card — a capability change always asks).
//
// 🔴 GATEWAY_TOOL_CLASSES is the single source of truth for tool→class (types.ts resolves a
//    tool's class from here via classOfTool). A tool MISSING from the map fail-closes to 'exec'
//    (strictest: manual-only + never auto-approved), and the completeness test in policy.test.ts
//    forces every real gateway tool to be classified — a new tool without a class turns red, it
//    never silently registers loose.
//
// Pure functions + const data only (type-only `ai` import, fully erased) — directly unit-testable,
// and config.ts may type-import AgentContextMode without pulling the `ai` chunk (Phase 02
// invariant preserved).

import type { ToolSet } from 'ai'

/** Run-level provenance of a chat run (ADR-001 D1). Order of severity: manual_chat is the only
 *  human-in-front-of-screen mode; the other two exist for S4 (email-triggered / scheduled runs)
 *  and are already enforced here so S4 cannot forget them. */
export const AGENT_CONTEXT_MODES = ['manual_chat', 'untrusted_trigger', 'cron_headless'] as const
export type AgentContextMode = (typeof AGENT_CONTEXT_MODES)[number]

/** Fail-closed normalization: only the three known modes pass through; absent / unknown / any
 *  client-supplied junk → 'untrusted_trigger' (the strictest). This is the ONLY way a mode enters
 *  the policy layer, so "forgot to pass the mode" always degrades toward safety. */
export function normalizeContextMode(value: unknown): AgentContextMode {
  return (AGENT_CONTEXT_MODES as readonly unknown[]).includes(value)
    ? (value as AgentContextMode)
    : 'untrusted_trigger'
}

/** Policy class of a gateway tool (ADR-001 D2) — orthogonal to the approval tier. */
export const GATEWAY_TOOL_CLASS_VALUES = [
  'read',
  'domain_write',
  'capability_change',
  'exec',
  'outbound'
] as const
export type GatewayToolClass = (typeof GATEWAY_TOOL_CLASS_VALUES)[number]

/** tool name → policy class, per ADR-001 §4. Single source of truth: types.ts resolves each
 *  audited write/send tool's class from this map, and applyContextModePolicy filters the assembled
 *  ToolSet by it. Mirrored into tests/agent_eval/tool_catalog.json as `tool_class` (policy.test.ts
 *  asserts the two stay in sync). */
export const GATEWAY_TOOL_CLASSES: Record<string, GatewayToolClass> = {
  // read — no side effects (silent tier; untrusted content in results is fenced at the tool).
  email_search: 'read',
  email_search_fulltext: 'read',
  email_get: 'read',
  email_body: 'read',
  email_list_thread: 'read',
  email_search_attachments: 'read',
  kos_query: 'read',
  report_list: 'read',
  report_get: 'read',
  chat_session_list: 'read',
  chat_session_search: 'read',
  chat_session_get: 'read',
  agent_profile_read: 'read',
  agent_profile_history: 'read',
  discover_skills: 'read',
  // domain_write — reversible in-domain writes (cheap to undo); the only class auto-approve may
  // ever relax, and only in manual_chat.
  email_flag: 'domain_write',
  email_archive: 'domain_write',
  email_pin: 'domain_write',
  email_resync: 'domain_write',
  email_draft_reply: 'domain_write',
  // capability_change — changes the agent's own capability/identity surface. NEVER auto-approved,
  // manual_chat-only, in every future mode permanently denied (ADR-001 §9 red line).
  set_skill_enabled: 'capability_change',
  update_system_md: 'capability_change',
  agent_profile_restore: 'capability_change',
  agent_memory_update: 'capability_change',
  // S2 W4 — the skill supply chain (install/uninstall) IS the capability surface. Two-step
  // install = two HITL cards; no whitelist hook exists for this class (unlike exec).
  skill_install: 'capability_change',
  skill_install_confirm: 'capability_change',
  skill_uninstall: 'capability_change',
  // S5 W3 — conversational custom-agent CRUD. Building/editing/running an agent that HOLDS tools is
  // a change to the assistant's own capability surface (ADR-004 P5): all six are capability_change,
  // so the matrix floor keeps them manual_chat-only (a headless run can never build/edit/run agents)
  // and they never auto-approve. list/get are silent reads but classed here so the WHOLE CRUD
  // surface (reads included) stays a manual-session capability face.
  custom_agent_list: 'capability_change',
  custom_agent_get: 'capability_change',
  custom_agent_create: 'capability_change',
  custom_agent_update: 'capability_change',
  custom_agent_delete: 'capability_change',
  custom_agent_run_now: 'capability_change',
  // S2 W4 — skill_read is a silent read (its third-party content is SKILL_DOC-fenced at the tool).
  skill_read: 'read',
  // outbound — data leaves the machine. manual_chat-only; web is edit-tier always-ask, send is
  // blocking always-ask (its needsApproval hard-returns true regardless of anything here).
  web_fetch: 'outbound',
  web_search: 'outbound',
  email_prepare_send: 'outbound',
  // exec — local command / filesystem (S2 W1). manual_chat-only; all three are edit-tier always-ask
  // (never auto-approved by approvalMode) UNLESS a structured PolicyRule whitelist the owner set
  // matches (needsApproval consults /api/agent/policy/evaluate — auto_allow skips the card,
  // ask/error fail-closed to the card).
  run_command: 'exec',
  file_read: 'exec',
  file_write: 'exec'
}

/** Resolve a tool's policy class. Missing/unknown name fail-closes to 'exec' (strictest class:
 *  manual-only registration + never auto-approved) — a new tool that forgot to classify itself
 *  degrades toward safety AND trips the completeness test. */
export function classOfTool(name: string): GatewayToolClass {
  return GATEWAY_TOOL_CLASSES[name] ?? 'exec'
}

/** Per-agent mode grants (ADR-004 §4.1 — the explicit revision of the ADR-001 §5 matrix's exec
 *  row). 🔴 The type has ONLY the `exec` key: capability_change and outbound have NO corresponding
 *  field — they are structurally un-grantable (not "don't pass true" but "nowhere to pass it"),
 *  fixing the red line at the type level. Constructed by the gateway from the strictly-parsed
 *  spec as a discriminated boolean ({ exec: spec.toolPolicy?.grantExec === true }) — NEVER a
 *  passthrough of a raw spec object (a future spec field must not silently flow into the matrix). */
export interface AgentModeGrants {
  exec?: boolean
}

/** The per-agent run context threaded through a headless custom-agent run (ADR-004 §3.1/§4.4):
 *  agentRun.ts constructs it from the pulled spec, buildTools/write/exec factories consume it, and
 *  the approval stash FREEZES it at pause time so an island resume rebuilds the exact same tool
 *  face (never wider). Manual entrypoints never construct one — absent everywhere means the
 *  pre-ADR-004 behaviour, byte-identical. */
export interface AgentRunContext {
  agentId: string
  /** The owner's per-agent allow-list, already normalized: an agent run ALWAYS carries an array
   *  (a malformed spec normalizes to [] — fail-closed, ADR-004 §5.1); undefined only survives in
   *  hand-built test contexts and wrapCfgForAgentRun re-normalizes it to []. */
  allowedTools?: string[]
  modeGrants?: AgentModeGrants
  /** S6 W1 — the async_jobs row id of this headless run, frozen into the run context so a paused
   *  approval carries it into the stash (maybeStashAndAnnounceApproval freezes the whole context).
   *  Read-only metadata for GET /api/ai/approval/pending's record-view projection; NEVER consulted
   *  by the matrix / intersection / whitelist. Absent on manual entrypoints (the pre-S6 shape,
   *  byte-identical), so pending → jobId:null for a non-agent approval. */
  jobId?: number
}

/** Registration-time matrix row (ADR-001 D3, exec row revised by ADR-004 D2): may a tool of this
 *  class exist in the ToolSet of a run in this mode? read/domain_write → every mode;
 *  capability_change/outbound → manual_chat only (permanently — no grant key exists for them);
 *  exec → manual_chat, OR a non-manual run whose per-agent grants carry exec===true (the owner's
 *  explicit opt-in, spec-derived). `grants` is only ever passed by the headless agent-run path;
 *  manual callers omit it (undefined = the pre-ADR-004 matrix, so a forgotten param is always
 *  SAFER, never wider). */
export function isToolClassAllowedInMode(
  toolClass: GatewayToolClass,
  mode: AgentContextMode,
  grants?: AgentModeGrants
): boolean {
  if (mode === 'manual_chat') return true
  if (toolClass === 'read' || toolClass === 'domain_write') return true
  if (toolClass === 'exec') return grants?.exec === true
  return false // capability_change + outbound: false under ANY grants (structurally un-grantable)
}

/** May approvalMode 'auto-reversible' skip the approval card for this tool? Only a reversible
 *  DOMAIN write in an owner-driven manual session (ADR-001 D3). The caller additionally requires
 *  tier==='preview' (unchanged UX vocabulary) — this predicate carries the class/mode half. */
export function mayAutoApprove(toolClass: GatewayToolClass, mode: AgentContextMode): boolean {
  return toolClass === 'domain_write' && mode === 'manual_chat'
}

/** Filter an assembled ToolSet by the context mode — the LAST step of buildGatewayTools, after
 *  every create* block AND applySkillGating (codex P2-2: no early return may let a class slip
 *  past). manual_chat is an identity pass-through (the same object, zero diff — S2 keeps every
 *  production run manual, so current behaviour is byte-identical); non-manual modes drop every
 *  capability_change/exec/outbound tool so the model structurally cannot see them — except an
 *  exec tool under an explicit per-agent grant (ADR-004 D2). Registration here and the runtime
 *  modeDenied double-insurance (types.ts) consume the SAME function with the SAME grants object
 *  (threaded from one agentRunContext) — there is no second decision point. */
export function applyContextModePolicy(
  tools: ToolSet,
  mode: AgentContextMode,
  grants?: AgentModeGrants
): ToolSet {
  if (mode === 'manual_chat') return tools
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    if (isToolClassAllowedInMode(classOfTool(name), mode, grants)) out[name] = t
  }
  return out
}
