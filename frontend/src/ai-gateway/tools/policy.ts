// S2 W0 (task 07-02-s2-exec-skill-install, ADR-001) — context-mode × tool-class policy matrix.
//
// Two orthogonal axes, both SERVER-asserted (never client input):
//   - AgentContextMode: run-level provenance — who initiated this run. Asserted by each trusted
//     entrypoint as an explicit prepareChatRun parameter (NEVER read from the request body);
//     absent/unknown normalizes fail-closed to 'untrusted_trigger' (the strictest mode), so a
//     future entrypoint that forgets to pass it can only be SAFER, never silently privileged.
//   - GatewayToolClass: what a tool can do (read / reversible domain write / capability change /
//     local exec / outbound web read / outbound send). Independent of the approval `tier`
//     (preview/edit/blocking), which keeps owning the approval-card UX — class owns POLICY
//     (ADR-001 D2: tier 管卡片, class 管策略).
//
// The matrix (ADR-001 D3; exec row revised by ADR-004 D2, web row by ADR-004 rev3.1):
//   - read + domain_write register in EVERY mode (domain writes stay HITL outside manual, because
//     mayAutoApprove requires manual_chat — see below).
//   - capability_change / exec / web / outbound are manual_chat-ONLY by default: outside a manual
//     session they are (a) not registered at all (applyContextModePolicy strips them from the
//     ToolSet — the model cannot see them), and (b) hard-rejected at execute time as a second line
//     of defense (types.ts) in case a future entrypoint misses the mode. exec and web each have a
//     per-agent grant key that lifts ONLY their own row; capability_change and outbound (send)
//     have no key — permanently floored.
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

/** Policy class of a gateway tool (ADR-001 D2, 'web' split out of 'outbound' by ADR-004 rev3.1
 *  §3.1) — orthogonal to the approval tier. */
export const GATEWAY_TOOL_CLASS_VALUES = [
  'read',
  'domain_write',
  'capability_change',
  'exec',
  'web',
  'outbound'
] as const
export type GatewayToolClass = (typeof GATEWAY_TOOL_CLASS_VALUES)[number]

/** tool name → policy class, per ADR-001 §4. Single source of truth: types.ts resolves each
 *  audited write/send tool's class from this map, and applyContextModePolicy filters the assembled
 *  ToolSet by it. Mirrored into tests/agent_eval/tool_catalog.json as `tool_class` (policy.test.ts
 *  asserts the two stay in sync). */
export const GATEWAY_TOOL_CLASSES: Record<string, GatewayToolClass> = {
  // read — no side effects (silent tier; untrusted content in results is fenced at the tool).
  email_list_filter: 'read',
  email_search_fulltext: 'read',
  email_get: 'read',
  email_body: 'read',
  email_list_thread: 'read',
  email_search_attachments: 'read',
  // attachment-awareness reads (thread attachment metadata + one attachment's extracted text —
  // the text is UNTRUSTED_ATTACHMENT_TEXT-fenced at the tool).
  email_thread_attachments: 'read',
  email_attachment_text: 'read',
  kos_query: 'read',
  // issue #57 — extra KOS read tools (keyword search / page read / expert lookup / page
  // listing / backlinks). All silent reads, same class as kos_query.
  kos_search: 'read',
  kos_get_page: 'read',
  kos_find_experts: 'read',
  kos_list_pages: 'read',
  kos_get_backlinks: 'read',
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
  // 07-16 approval-mode 注记: the §9 red line describes the MANUAL default state. The owner-global
  // approval mode (agent_config.db, Settings/composer UI only — no gateway tool can switch it) is
  // an explicit owner-wide override: 'acceptEdits' auto-approves ONLY the by-name allow-list
  // ACCEPT_EDITS_AUTO_APPROVE_TOOLS below (identity/memory/skill-toggle edits are in it; the
  // skill supply chain + custom_agent CRUD are NOT — they stay HITL, fail-closed for anything
  // unlisted); 'bypass' auto-approves everything. Both apply ONLY in manual_chat (injection +
  // consumption gated) — the headless "permanently denied outside manual" half of the red line is
  // untouched.
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
  // calendar epic 4.1 — calendar reads (event text is CALENDAR_EVENT-fenced at the tool).
  calendar_events_list: 'read',
  calendar_event_get: 'read',
  // calendar epic 4.2 — calendar writes: in-domain CalDAV/iTIP mutations of the owner's own
  // calendar. domain_write keeps them REGISTERED in headless runs where the always-ask edit tier
  // stashes → paused_handoff (the D4 headless semantics); they can never auto-approve because all
  // three are edit-tier (mayAutoApprove additionally requires preview) AND their factory wires no
  // policyEvaluate — no whitelist/免卡 channel exists (恒 HITL). The RSVP's outbound iTIP REPLY is
  // recipient-pinned server-side (organizer from the event row; the model has no recipient field),
  // which is why it is not class 'outbound' (that row would unregister it headless and remove the
  // paused_handoff path entirely).
  calendar_event_reschedule: 'domain_write',
  calendar_event_rsvp: 'domain_write',
  calendar_event_delete: 'domain_write',
  // web — outbound network reads (S6 W3, ADR-004 rev3.1 §3.1: migrated OUT of 'outbound' so the
  // per-agent `web` grant maps 1:1 to a class without ever admitting send). Both edit-tier
  // always-ask in manual; in a headless agent run they register only under grant_web∈{gated,open}
  // and the免卡 shape is per-tier (gated fetch = origin whitelist policyEvaluate; open fetch +
  // web_search = grant-level local verdict).
  web_fetch: 'web',
  web_search: 'web',
  // outbound — data irreversibly leaves the machine toward a chosen recipient (send). manual_chat
  // -only; send is blocking always-ask (its needsApproval hard-returns true regardless of anything
  // here) and has NO grants key — structurally un-grantable, same level as capability_change.
  email_prepare_send: 'outbound',
  // notion_agent_chat (task 07-21) — delegates the request (prompt, possibly carrying workspace
  // data) to an EXTERNAL AI (the notion-agent CLI) whose side effects land on the Notion side. It
  // is edit-tier always-ask in manual_chat (恒 HITL — the factory wires no policyEvaluate, so no
  // whitelist/免卡 channel exists). Class 'outbound' — data egresses the machine and there is NO
  // grants key, so a headless custom-agent run never gets it (放宽留给后续 grant 体系); that is the
  // MVP-safe default (mirrors the send row's un-grantable stance, not a recipient send).
  notion_agent_chat: 'outbound',
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

/** Per-agent web grant tier (ADR-004 rev3.1 D1/D2): 'off' = not registered headless (default),
 *  'gated' = registered + per-agent origin-whitelist免卡 for web_fetch (web_search grant-level),
 *  'open' = registered + grant-level免卡 for any URL. A three-state enum (not two booleans) so the
 *  illegal state "full access while web is off" is unrepresentable. */
export type WebGrant = 'off' | 'gated' | 'open'

/** Fail-closed parse of a spec's grantWeb: ONLY the exact literals 'gated'/'open' pass; anything
 *  else (true / 1 / 'yes' / junk / absent) collapses to 'off' — the web mirror of the
 *  `grantExec === true` discrimination, never a raw passthrough. */
export function parseWebGrant(raw: unknown): WebGrant {
  return raw === 'gated' || raw === 'open' ? raw : 'off'
}

/** Per-agent mode grants (ADR-004 §4.1, web key added by ADR-004 rev3.1 D1 — the explicit
 *  revisions of the ADR-001 §5 matrix's exec/web rows). 🔴 The type has ONLY the `exec` and `web`
 *  keys: capability_change and outbound (send) have NO corresponding field — they are structurally
 *  un-grantable (not "don't pass true" but "nowhere to pass it"), fixing the red line at the type
 *  level. Constructed by the gateway from the strictly-parsed spec as discriminated typed values
 *  ({ exec: spec.toolPolicy?.grantExec === true, web: parseWebGrant(spec.toolPolicy?.grantWeb) },
 *  exec a boolean, web a three-state literal) — NEVER a passthrough of a raw spec object (a future
 *  spec field must not silently flow into the matrix). */
export interface AgentModeGrants {
  exec?: boolean
  web?: WebGrant
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
  /** S6 W3 (ADR-004 rev3.1 §5.1/D3) — the owner's per-agent skill MOUNT list, spec-projected
   *  (the Python side substitutes the default mount set for NULL, so a real spec always carries
   *  the resolved array; missing/malformed → [] fail-closed, mirroring allowedTools). Consumed by
   *  buildGatewayTools as a SECOND applySkillGating pass (mounted ∩ advertised — pure reduction,
   *  independent of the M4a flag and of the advertisedSkills null fail-open, which are manual
   *  business-state semantics). Never widens: CORE_UNGATED / collision-exempt floors stay. */
  skills?: string[]
  modeGrants?: AgentModeGrants
  /** S6 W1 — the async_jobs row id of this headless run, frozen into the run context so a paused
   *  approval carries it into the stash (maybeStashAndAnnounceApproval freezes the whole context).
   *  Read-only metadata for GET /api/ai/approval/pending's record-view projection; NEVER consulted
   *  by the matrix / intersection / whitelist. Absent on manual entrypoints (the pre-S6 shape,
   *  byte-identical), so pending → jobId:null for a non-agent approval. */
  jobId?: number
}

/** Registration-time matrix row (ADR-001 D3, exec row revised by ADR-004 D2, web row added by
 *  ADR-004 rev3.1 D2): may a tool of this class exist in the ToolSet of a run in this mode?
 *  read/domain_write → every mode; capability_change/outbound → manual_chat only (permanently —
 *  no grant key exists for them); exec → manual_chat, OR a non-manual run whose per-agent grants
 *  carry exec===true; web → manual_chat, OR a non-manual run whose grants carry web∈{gated,open}
 *  (the owner's explicit opt-in, spec-derived — any other value incl. junk is 'off'). `grants` is
 *  only ever passed by the headless agent-run path; manual callers omit it (undefined = the
 *  pre-ADR-004 matrix, so a forgotten param is always SAFER, never wider). */
export function isToolClassAllowedInMode(
  toolClass: GatewayToolClass,
  mode: AgentContextMode,
  grants?: AgentModeGrants
): boolean {
  if (mode === 'manual_chat') return true
  if (toolClass === 'read' || toolClass === 'domain_write') return true
  if (toolClass === 'exec') return grants?.exec === true
  if (toolClass === 'web') return grants?.web === 'gated' || grants?.web === 'open'
  return false // capability_change + outbound: false under ANY grants (structurally un-grantable)
}

/** May approvalMode 'auto-reversible' skip the approval card for this tool? Only a reversible
 *  DOMAIN write in an owner-driven manual session (ADR-001 D3). The caller additionally requires
 *  tier==='preview' (unchanged UX vocabulary) — this predicate carries the class/mode half. */
export function mayAutoApprove(toolClass: GatewayToolClass, mode: AgentContextMode): boolean {
  return toolClass === 'domain_write' && mode === 'manual_chat'
}

/** 07-16 approval-mode switcher (codex r1 P1-3: inverted from a deny-list to this allow-list) —
 *  the by-name AUTO-APPROVE set of the owner-global 'acceptEdits' mode (owner 拍板 2026-07-16).
 *  🔴 FAIL-CLOSED: this is the ONLY set the runtime consults — under acceptEdits a write tool
 *  auto-approves IFF its name is listed here; anything else (including every FUTURE write tool
 *  that forgets to declare itself) keeps its current approval semantics (card, or the exec
 *  structured-whitelist path). A new destructive/outbound/supply-chain tool can therefore never
 *  slip into card-free execution by omission — the failure mode of the original deny-list.
 *
 *  🔴 A by-NAME set, not a (tier,class) predicate, because the boundary is not expressible in
 *  those axes: the calendar three writes share email_draft_reply's exact (edit, domain_write)
 *  signature yet stay HITL (ACCEPT_EDITS_ASK_TOOLS below), and file_read/file_write auto-approve
 *  while their class-sibling run_command stays whitelist-or-card (Claude Code acceptEdits
 *  semantics: file edits yes, commands no).
 *
 *  Membership = owner 拍板「编辑/联网放行」: reversible email domain writes + draft, the agent's
 *  own identity/memory/skill-toggle edits (capability_change「编辑放行」, ADR-001 §9 mode 注记),
 *  web fetch/search, and file read/write. Everything else asks — see ACCEPT_EDITS_ASK_TOOLS for
 *  the explicit rationale per retained tool. */
export const ACCEPT_EDITS_AUTO_APPROVE_TOOLS: ReadonlySet<string> = new Set([
  'email_flag',
  'email_archive',
  'email_pin',
  'email_resync',
  'email_draft_reply',
  'update_system_md',
  'set_skill_enabled',
  'agent_profile_restore',
  'agent_memory_update',
  'web_fetch',
  'web_search',
  'file_read',
  'file_write'
])

/** The explicit KEEP-ASKING declarations of 'acceptEdits' — documentation + completeness
 *  accounting ONLY (the runtime never consults this set: an unlisted tool already asks because
 *  the allow-list above is fail-closed). Together with ACCEPT_EDITS_AUTO_APPROVE_TOOLS this must
 *  PARTITION the write-tool universe: the approval_mode.test.ts completeness gate walks every
 *  `write:true` tool in tests/agent_eval/tool_catalog.json and turns red unless it sits in
 *  exactly one of the two sets — so a new write tool forces a deliberate acceptEdits decision.
 *
 *  - calendar reschedule/rsvp/delete: irreversible-outbound/destructive (D4 拍板 恒 HITL).
 *  - run_command: whitelist-or-card stays (owner 拍板: exec 非白名单恒 HITL; a structured
 *    PolicyRule hit still skips the card as before).
 *  - skill_install/confirm/uninstall: the supply chain is capability_change with two HITL cards
 *    per install (ADR-002) — acceptEdits keeps all three (uninstall rides with its family);
 *    only 'bypass' (owner 拍板: 无例外) releases them.
 *  - custom_agent create/update/delete/run_now (07-16 check 改判): the ADR-004 rev3.1 §7 field
 *    allowlist lets the model PROPOSE grants (grant_web 'open' / grant_exec / skills / cron)
 *    precisely because "the defense moved … to the always-human approval card" (agents.ts header).
 *    Auto-approving create/update would let injected chat content mint a cron agent with
 *    grant_web:'open' — whose headless web_fetch is card-free by grant (web.ts) — i.e. a
 *    persistent, zero-card exfil backdoor. That defeats the card the grant vocabulary leans on,
 *    so all four stay HITL under acceptEdits; only 'bypass' releases them.
 *  - email_prepare_send: listed for accounting only — the send tool never consults either set;
 *    auditedSendTool's needsApproval only ever relaxes under the explicit 'bypass' literal
 *    (types.ts bypassMode param).
 *  - notion_agent_chat (task 07-21): an EXTERNAL AI call whose side effects land on the Notion side
 *    and cannot be undone from here — 恒 HITL (D4-style), so it keeps asking under acceptEdits. Unlike
 *    every other row here it is ALSO in BYPASS_STILL_ASK (codex HIGH-1 carve-out), so unlike the rest
 *    'bypass' does NOT release it either — it stays 恒 HITL under every mode. */
export const ACCEPT_EDITS_ASK_TOOLS: ReadonlySet<string> = new Set([
  'calendar_event_reschedule',
  'calendar_event_rsvp',
  'calendar_event_delete',
  'run_command',
  'skill_install',
  'skill_install_confirm',
  'skill_uninstall',
  'custom_agent_create',
  'custom_agent_update',
  'custom_agent_delete',
  'custom_agent_run_now',
  'email_prepare_send',
  'notion_agent_chat'
])

/** 07-21 (codex HIGH-1) — the bypass carve-out: the ONE set of write tools that KEEP asking even
 *  under the owner-global 'bypass' mode. 'bypass' is otherwise 无例外 (owner 拍板 2026-07-16:
 *  everything auto-approves, send/exec/skill-install included) — but that verdict was made for
 *  actions on THIS machine's own domain (reversible email writes, local exec, the send whose
 *  double-guard still runs). notion_agent_chat is categorically different: it hands the prompt
 *  (possibly carrying workspace data) to an EXTERNAL AI (the notion-agent CLI) whose side effects
 *  land on the Notion side and cannot be undone from here. That外呼-不可撤回 shape is the same
 *  「安全地板」the repo floors elsewhere (exec 无白名单命中恒 HITL、skill 安装恒 HITL), so bypass
 *  does NOT remove its card either — it stays 恒 HITL under every mode. Minimal by design (只含
 *  notion_agent_chat); a broader loosening waits for the future per-agent grant 体系. */
export const BYPASS_STILL_ASK: ReadonlySet<string> = new Set(['notion_agent_chat'])

/** Filter an assembled ToolSet by the context mode — the LAST step of buildGatewayTools, after
 *  every create* block AND applySkillGating (codex P2-2: no early return may let a class slip
 *  past). manual_chat is an identity pass-through (the same object, zero diff — S2 keeps every
 *  production run manual, so current behaviour is byte-identical); non-manual modes drop every
 *  capability_change/exec/web/outbound tool so the model structurally cannot see them — except an
 *  exec/web tool under an explicit per-agent grant (ADR-004 D2 / rev3.1). Registration here and the runtime
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
