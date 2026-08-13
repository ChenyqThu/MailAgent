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
//   - im_chat (stage 0b matrix row; asserted by POST /api/ai/im-chat since stage 2 PR-1 — the
//     飞书 IM venue, grill Q10=A + the 08-04 拍板): read/artifact/domain_write register (domain
//     writes 恒 HITL), connector reads/writes register like manual (owner 拍板「全开放」— writes
//     stay 恒 HITL because mayAutoApprove is manual-only), web registers ONLY under the
//     MAILAGENT_IM_WEB_ENABLED venue switch (Q19=A — a Settings/env switch, NEVER a grant);
//     capability_change / exec / outbound are hard-denied and per-agent grants are NOT consulted.
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
 *  and are already enforced here so S4 cannot forget them.
 *
 *  'im_chat' (stage 0b, harness-expansion epic — grill Q10=A): the FOURTH venue, the owner talking
 *  through an IM bridge (阶段 2 飞书对话). 盗号 ≠ 盗机 — a stolen IM account must never reach this
 *  machine's execution surface, so the row is STRICTER than manual_chat: reads free; domain writes
 *  恒 HITL (mayAutoApprove still requires manual_chat, and the bypass overlay is
 *  manual-gated at consumption); connector tools open like manual (08-04 拍板「全开放」; 08-05
 *  WP-10: write approval follows the per-tool tier — ask → Feishu card, auto → card-free, off →
 *  not registered); web gated by the MAILAGENT_IM_WEB_ENABLED venue switch
 *  (Q19=A — a Settings switch, NOT a grant; default off); exec / capability_change / outbound
 *  permanently denied, per-agent grants never consulted. Asserted in trusted code by
 *  POST /api/ai/im-chat (stage 2 PR-1, MAILAGENT_IM_FEISHU-gated).
 *
 *  'matter_followup' (Matters MVP P4, decisions D5; widened by the 0812 owner拍板): the FIFTH
 *  venue — a Matter follow-up run (观察 + 建议, never 执行). The boundary is BY CLASS, not by
 *  resource scope: every 'read' tool registers (the run's whole point is discovering NEW
 *  evidence, so it reads the full library), 'artifact' ONLY under the one propose NAME
 *  (MATTER_RUN_PROPOSE_TOOL — 0812 codex修复批: report_write shares the class and is a local
 *  write, whole-class admission was a hole), plus 'web' under the SPEC-authored read grant
 *  (run_spec.py writes grantWeb — the outbound-network-READ class; connector READS are class
 *  'read' and ride the grantConnectors read ceilings at registration). Every write-capable class
 *  — domain_write / connector_write / exec / capability_change / outbound — is denied, and 🔴 the
 *  exec grant + im venue switches are NOT consulted at all: binding a Matter to a
 *  strongly-granted Agent Profile (grant_exec / connector write ceilings) can never widen the
 *  face — the profile contributes model/persona only (D2), and the grants this row DOES read
 *  (web) are authored solely by the server-side spec assembler, never copied from a profile.
 *  The run's single output channel is the artifact-class `matter_update_propose`; every state
 *  change goes through the owner's review (matter_review_update in a manual/im session). The
 *  wrapCfgForAgentRun read-face exemption (agentRun.ts) is the SECOND, independent belt — this
 *  matrix row is the first. Asserted in trusted code by POST /api/ai/agent-run when the
 *  SERVER-assembled spec carries runKind==='matter_followup' (agentRun.ts deriveContextMode),
 *  never from a request body. */
export const AGENT_CONTEXT_MODES = [
  'manual_chat',
  'untrusted_trigger',
  'cron_headless',
  'im_chat',
  'matter_followup'
] as const
export type AgentContextMode = (typeof AGENT_CONTEXT_MODES)[number]

/** Fail-closed normalization: only the five known modes pass through; absent / unknown / any
 *  client-supplied junk → 'untrusted_trigger' (the strictest of the general-purpose modes). This
 *  is the ONLY way a mode enters the policy layer, so "forgot to pass the mode" always degrades
 *  toward safety. */
export function normalizeContextMode(value: unknown): AgentContextMode {
  return (AGENT_CONTEXT_MODES as readonly unknown[]).includes(value)
    ? (value as AgentContextMode)
    : 'untrusted_trigger'
}

/** Policy class of a gateway tool (ADR-001 D2, 'web' split out of 'outbound' by ADR-004 rev3.1
 *  §3.1) — orthogonal to the approval tier.
 *
 *  'connector_write' (stage 1 PR2, harness-expansion epic — grill Q5=A原案; 08-05 WP-10 改判): the
 *  write/update tools of an MCP connector (`mcp__<connector>__<tool>`, runtime-registered — never
 *  in the static map below). manual_chat: registered; the approval shape follows the OWNER'S
 *  per-tool tier since 08-05 — 'ask' → the edit-tier card (the pre-08-05 恒 HITL behaviour),
 *  'auto' → card-free via the policyEvaluate seam (audit 'auto_tool_mode'), 'off' → not
 *  registered at all (WP-11's built-in per-tool registry never contains dynamic names —
 *  the CONNECTOR tier, not the built-in tier map, is how a connector write goes card-free). Outside
 *  manual (PR3): the per-connector grant key `connectors` lifts the row for
 *  untrusted_trigger/cron_headless when ANY granted ceiling is write-capable ('write'/'update');
 *  no grants → the fail-closed `return false`. im_chat (stage 2 PR-1, 08-04 拍板「connector 对
 *  im_chat 全开放」; 08-05 场地二: tiers apply like manual — ask 走飞书卡 / auto 免卡): grants
 *  are still never consulted (the venue is owner-present, not a granted headless run). Connector
 *  READ tools map to the existing 'read' (silent on the default 'auto' tier; an owner-demoted
 *  'ask' read registers approval-gated in owner-present venues); the load seam
 *  (shouldLoadConnectorTools) still keeps headless runs WITHOUT connector grants at zero fetches. */
export const GATEWAY_TOOL_CLASS_VALUES = [
  'read',
  'artifact',
  'domain_write',
  'capability_change',
  'exec',
  'web',
  'outbound',
  'connector_write'
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
  matter_find: 'read',
  matter_get: 'read',
  // 0813 轮 3 批 R — attention signals / run history / tag vocabulary. Class `read` is not a
  // convenience label here: it is what puts them inside a follow-up run's face (the
  // matter_followup row admits reads wholesale), which is the point — a run that cannot see its
  // own past conclusions re-derives them every round.
  matter_attention_list: 'read',
  matter_runs_list: 'read',
  matter_tags_list: 'read',
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
  // W6 — suggest_followups: a silent no-op the model calls at the end of a manual answer with
  // 2-3 next-question suggestions (renderer chips). Class 'read' (no side effects, never
  // approval-gated); registration is ADDITIONALLY venue-gated to manual_chat in
  // buildGatewayTools (interactive UI supply — the class matrix's "reads register everywhere"
  // does not apply to it; see the registration comment + policy.test.ts carve-out).
  suggest_followups: 'read',
  plan_update: 'read',
  skill_draft_create: 'capability_change',
  skill_draft_write_file: 'capability_change',
  skill_draft_read: 'capability_change',
  skill_draft_validate: 'capability_change',
  skill_draft_publish: 'capability_change',
  skill_draft_discard: 'capability_change',
  // artifact — local, deletable/replaceable output. It never leaves the machine and never needs
  // an approval card; unlike domain_write it is available silently in every context mode.
  report_write: 'artifact',
  // Matters MVP P4 (D6) — a Matter follow-up run's ONLY output channel: it writes a PENDING
  // proposal (matter_update row, review_status='pending'), never the Matter's own state. Same
  // artifact shape as report_write (silent, no guard, no card): the owner's later
  // matter_review_update is what commits anything, so the proposal itself is a local, reviewable,
  // discardable artifact. It is the ONE class the matter_followup row admits besides 'read', and
  // it only ever REGISTERS inside a matter-run context (tools/index.ts).
  matter_update_propose: 'artifact',
  chat_session_list: 'read',
  chat_session_search: 'read',
  chat_session_get: 'read',
  agent_catalog_list: 'read',
  agent_catalog_get: 'read',
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
  // prd 07-27 — the other two draft writes (create new/forward, edit an existing draft). Same risk
  // face as email_draft_reply: they only write the Drafts folder, nothing leaves the machine.
  email_draft_compose: 'domain_write',
  email_draft_update: 'domain_write',
  matter_create: 'domain_write',
  matter_update: 'domain_write',
  matter_item_mutate: 'domain_write',
  matter_resource_mutate: 'domain_write',
  matter_stakeholder_mutate: 'domain_write',
  matter_relation_mutate: 'domain_write',
  matter_add_note: 'domain_write',
  // Matters MVP P4 (D8) — the two REVIEW-side tools an owner-present session uses to drive the
  // follow-up loop: start/cancel a run, and accept/reject a pending proposal. Both are
  // in-domain and reversible-by-compensation (a cancel does not roll back what a run已 observed;
  // an accepted Update is corrected by a new Manual Update), hence domain_write rather than
  // capability_change — the follow-up Agent's own capability face is fixed by the matter_followup
  // matrix row, not by these calls. 🔴 matter_review_update carries the DYNAMIC approval
  // (policyEvaluate, matters.ts): non-manual venues 恒卡, manual reject免卡, manual accept touching
  // a `field` change asks.
  matter_run_control: 'domain_write',
  matter_review_update: 'domain_write',
  // 0813 轮 3 批 R — the disposal half of the two read surfaces above. domain_write on purpose:
  // it keeps them out of a follow-up run (the matrix row denies the class outright), so a run can
  // surface an attention signal or a resource suggestion but never quietly clear it.
  matter_attention_triage: 'domain_write',
  matter_suggestion_resolve: 'domain_write',
  // capability_change — changes the agent's own capability/identity surface. NEVER auto-approved
  // by the auto-reversible path, manual_chat-only, in every future mode permanently denied
  // (ADR-001 §9 red line).
  // 07-16 approval-mode 注记: the §9 red line describes the MANUAL default state; the owner-global
  // mode (agent_config.db, Settings/composer UI only — no gateway tool can switch it) is an
  // explicit owner-wide override applying ONLY in manual_chat.
  // 08-05 WP-11 注记: the by-name acceptEdits allow-list is retired — card-free execution in
  // manual is now decided by the owner's PER-TOOL approval tier (Python tool_prefs.py registry;
  // identity/memory/skill-toggle edits default 'ask' but are owner-configurable to 'auto';
  // skill_install/confirm + custom_agent create/update/delete stay non-configurable 恒 ask) and
  // by 'bypass' (auto-approves everything, D1=a). The headless "permanently denied outside
  // manual" half of the red line is untouched — prefs are never threaded into non-manual runs.
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
  custom_agent_call: 'capability_change',
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

// ---- Stage 0b (harness-expansion epic) — runtime tool-class registry for DYNAMIC tools --------
//
// Stage 1 introduces connector tools whose names are only known at runtime
// (`mcp__<connector>__<tool>`): the static GATEWAY_TOOL_CLASSES record is structurally blind to
// them (fail-close to 'exec' would strip them from every headless run) and the static catalog
// gates have zero coverage. 0b lands the MECHANISM only (stage 1 fills the contents): a dynamic
// source must REGISTER each tool's class here before assembly; admitDynamicTools() refuses any
// dynamic tool without a registration (fail-closed), and classOfTool() resolves registered names
// so the SAME matrix / runtime modeDenied / auto-approve predicates govern them. With zero
// registrations (today) every path below is byte-identical to the static behaviour.

const RUNTIME_TOOL_CLASSES = new Map<string, GatewayToolClass>()

/** Stage 2 PR-4 (task 08-01 messenger) — the DESTRUCTIVE bit of a runtime-registered tool, kept
 *  in a SIBLING map on purpose: it is a *presentation* fact (render a red warning), NOT a policy
 *  input. Nothing in the matrix / auto-approve predicates reads it, so widening the class map's
 *  value type (and every consumer of it) would have been the larger change.
 *
 *  Why it must live here at all: at approval-stash time (`chatRun.maybeStashAndAnnounceApproval`)
 *  the only tool fact in scope is the composed name — the connector manifest lives in the
 *  Electron lifecycle's TTL cache and is not reachable through `AiGatewayConfig`. The desktop
 *  McpApprovalCard sidesteps this by re-fetching `/api/connector/{id}/tools` from the renderer;
 *  an out-of-app surface (Feishu) has no such renderer, so the bit has to ride the stash. */
const RUNTIME_TOOL_DESTRUCTIVE = new Map<string, boolean>()

/** Register the policy class of a runtime-discovered (dynamic) tool. Fail-closed guards: a
 *  static GATEWAY_TOOL_CLASSES name can never be shadowed (the compile-time map stays the single
 *  source of truth for built-in tools), and only real GatewayToolClass literals are accepted
 *  (junk from a connector manifest must not mint a policy class).
 *
 *  `destructive` (optional, stage 2 PR-4) is presentation-only — see RUNTIME_TOOL_DESTRUCTIVE.
 *  Omitting it registers `false`, which is byte-identical to the pre-PR-4 behaviour. */
export function registerRuntimeToolClass(
  name: string,
  toolClass: GatewayToolClass,
  destructive?: boolean
): void {
  if (!name) throw new Error('registerRuntimeToolClass: empty tool name')
  if (GATEWAY_TOOL_CLASSES[name] !== undefined) {
    throw new Error(`registerRuntimeToolClass: '${name}' is a static gateway tool (unshadowable)`)
  }
  if (!(GATEWAY_TOOL_CLASS_VALUES as readonly string[]).includes(toolClass)) {
    throw new Error(`registerRuntimeToolClass: invalid tool class '${String(toolClass)}'`)
  }
  RUNTIME_TOOL_CLASSES.set(name, toolClass)
  RUNTIME_TOOL_DESTRUCTIVE.set(name, destructive === true)
}

/** Is this runtime-registered tool marked destructive by its MCP server? Unknown name → false
 *  (fail-quiet: an absent registration means "no warning", never a fabricated one). */
export function isRuntimeToolDestructive(name: string): boolean {
  return RUNTIME_TOOL_DESTRUCTIVE.get(name) === true
}

/** Is this name a runtime-registered dynamic tool? (assembly gate + tests) */
export function hasRuntimeToolClass(name: string): boolean {
  return RUNTIME_TOOL_CLASSES.has(name)
}

/** Test-only: clear the registry (module-level state would otherwise leak across tests). */
export function resetRuntimeToolClasses(): void {
  RUNTIME_TOOL_CLASSES.clear()
  RUNTIME_TOOL_DESTRUCTIVE.clear()
}

/** Stage-0b assembly gate: admit DYNAMIC tools into an assembled ToolSet. A dynamic tool with NO
 *  runtime classification is NOT admitted — without a class the matrix could only fail-close it
 *  to 'exec' (silently stripped headless, catalog gates blind), so the miss is made loud at the
 *  one seam stage 1 owns. A name colliding with an already-assembled tool never clobbers it
 *  (defense in depth on top of the registry's static-shadow rejection). `dynamic` absent/empty →
 *  the SAME base object (identity — every current caller, byte-identical). buildGatewayTools runs
 *  this BEFORE applyContextModePolicy so admitted tools are still mode-filtered by their
 *  registered class. */
export function admitDynamicTools(base: ToolSet, dynamic?: ToolSet): ToolSet {
  if (!dynamic) return base
  const entries = Object.entries(dynamic)
  if (entries.length === 0) return base
  const out: ToolSet = { ...base }
  for (const [name, t] of entries) {
    if (Object.prototype.hasOwnProperty.call(base, name)) continue
    if (!RUNTIME_TOOL_CLASSES.has(name)) continue
    out[name] = t
  }
  return out
}

/** Resolve a tool's policy class: runtime registry first (dynamic tools; can never shadow a
 *  static name — registerRuntimeToolClass rejects those), then the static map. Missing/unknown
 *  name fail-closes to 'exec' (strictest class: manual-only registration + never auto-approved)
 *  — a new tool that forgot to classify itself degrades toward safety AND trips the completeness
 *  test. */
export function classOfTool(name: string): GatewayToolClass {
  return RUNTIME_TOOL_CLASSES.get(name) ?? GATEWAY_TOOL_CLASSES[name] ?? 'exec'
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

/** Stage 1 PR3 (harness-expansion epic, grill Q2/Q3=B) — a per-connector crud CEILING of a
 *  headless custom-agent run. 🔴 The vocabulary is read < write < update and deliberately has NO
 *  'delete' member (grill Q3=B: the ceiling value-domain excludes delete; Python rejects it at
 *  store time, this type makes it unrepresentable gateway-side). */
export type ConnectorGrant = 'read' | 'write' | 'update'

/** The ceiling ORDER (PR3 contract: read=1 < write=2 < update=3). A connector tool registers in a
 *  headless run iff rank(crud_type) ≤ rank(ceiling); delete/unknown cruds never rank (they are
 *  skipped before ranking — Q16=A). Shared by the registration filter (connector.ts) so the order
 *  can never fork into two hand-copies. */
export const CONNECTOR_CRUD_RANK: Record<ConnectorGrant, 1 | 2 | 3> = {
  read: 1,
  write: 2,
  update: 3
}

/** Fail-closed parse of a spec's grantConnectors (`{connectorId: ceiling}`): only entries with a
 *  non-empty string key AND an exact 'read'/'write'/'update' literal value survive; every other
 *  entry (junk value, 'delete', empty key) is dropped PER-ENTRY, and an empty/absent/non-object
 *  result collapses to undefined (= no connector grants at all — the connector mirror of
 *  parseWebGrant, never a raw passthrough). */
export function parseConnectorGrants(raw: unknown): Record<string, ConnectorGrant> | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, ConnectorGrant> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key) continue
    if (value === 'read' || value === 'write' || value === 'update') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** PR3 — does this (possibly junk) connectors grant object carry ANY write-capable ceiling?
 *  Re-parses fail-closed (a hand-built / stash-frozen grants object may carry junk), so a
 *  'read'-only grant, 'delete'/junk values, empty keys and non-object shapes all yield false.
 *  This is the connector_write CLASS row's coarse gate — see isToolClassAllowedInMode. */
function hasConnectorWriteGrant(connectors: unknown): boolean {
  const parsed = parseConnectorGrants(connectors)
  if (!parsed) return false
  return Object.values(parsed).some((v) => v === 'write' || v === 'update')
}

/** Per-agent mode grants (ADR-004 §4.1, web key added by ADR-004 rev3.1 D1, connectors key added
 *  by stage 1 PR3 — the explicit revisions of the ADR-001 §5 matrix's exec/web/connector rows).
 *  🔴 The type has ONLY the `exec`, `web` and `connectors` keys: capability_change and outbound
 *  (send) have NO corresponding field — they are structurally un-grantable (not "don't pass true"
 *  but "nowhere to pass it"), fixing the red line at the type level. Constructed by the gateway
 *  from the strictly-parsed spec as discriminated typed values ({ exec: spec.toolPolicy?.grantExec
 *  === true, web: parseWebGrant(spec.toolPolicy?.grantWeb) }, plus `connectors` ONLY when
 *  parseConnectorGrants yields a non-empty record — an absent key means "no connector grants",
 *  keeping every pre-PR3 grants object byte-identical) — NEVER a passthrough of a raw spec object
 *  (a future spec field must not silently flow into the matrix). */
export interface AgentModeGrants {
  exec?: boolean
  web?: WebGrant
  /** PR3 — per-connector crud ceilings ({connectorId: 'read'|'write'|'update'}), spec-derived via
   *  parseConnectorGrants (fail-closed per-entry; 'delete' unrepresentable). Consumed by (a) the
   *  connector_write matrix row below (coarse class gate) and (b) createConnectorTools'
   *  registration filter (the per-connector / per-tool precision). */
  connectors?: Record<string, ConnectorGrant>
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
  /** Matters MVP P4 (D5/D7) — the Matter this run follows up, built by agentRunContextFromSpec
   *  from the SERVER-assembled spec's `matter` key (never a body). Present ONLY for a
   *  matter_followup run; every manual/im/cron context omits it, so every pre-P4 assembly is
   *  byte-identical. Two consumers, both in tools/index.ts: (a) it SCOPES the email read tools to
   *  this Matter's resource set (the headless counterpart of the manual matterScopeFilter), and
   *  (b) it is the registration condition + the server-stamped identity of
   *  `matter_update_propose` (the model never passes matter_id / run_id — they are not in the
   *  schema at all). NOT a policy input: the matrix row keys on the MODE, so a mis-threaded
   *  matterRun can never widen a tool face. */
  matterRun?: {
    matterId: number
    publicId: string
    runId: number
  }
  /** 0812 dogfood — the owner-configured web tier of THIS follow-up run, resolved ONCE by
   *  runHeadlessAgent (owner_settings `matter_run_web_face` via the lifecycle's TTL-cached hot
   *  read) and consumed ONLY by wrapCfgForAgentRun's matter belt (matterRunAdmitsWeb). It rides
   *  the run context — rather than being re-read at wrap time — for the same reason the grants
   *  do: the approval stash FREEZES this object, so an island resume rebuilds the exact same
   *  face and a mid-run setting change can never widen a paused run.
   *  🔴 NOT a policy input (the matrix row keys on the MODE alone) and NOT set by
   *  agentRunContextFromSpec: absent means "use MATTER_RUN_WEB_FACE_DEFAULT", so every context
   *  built without a resolver (tests, manual entrypoints, non-matter runs) stays byte-identical. */
  matterWebFace?: MatterRunWebFace
}

/** 0812 dogfood — the three tiers of a Matter follow-up run's web tool face. Declared as a
 *  RUNTIME array (type derived from it) rather than a bare literal union so the two narrowing
 *  sites — agentRun's resolver funnel and the lifecycle's wire read — share ONE vocabulary
 *  instead of each hand-copying the three literals. The belt that interprets a tier lives in
 *  agentRun.ts (matterRunAdmitsWeb); the Python value domain that persists it is
 *  `MATTER_RUN_WEB_FACES` in src/api/routers/agent.py — that ONE cross-language copy is what
 *  tests/config/test_matter_web_face_parity.py pins. */
export const MATTER_RUN_WEB_FACES = ['keep', 'search_only', 'off'] as const
export type MatterRunWebFace = (typeof MATTER_RUN_WEB_FACES)[number]

/** Narrow an untrusted value (an owner-setting wire string, an injected resolver's return) to a
 *  tier; anything else → null and the CALLER picks the fallback. Mirrors parseWebGrant's
 *  discipline — one narrowing funnel, never a literal chain per call site — but deliberately
 *  returns null instead of collapsing to a tier: unlike a grant, the safe fallback here is the
 *  DEFAULT ('keep'), and that decision belongs at the call site where the 🔴 fail-safe rationale
 *  is written, not buried in a parser. */
export function parseMatterRunWebFace(value: unknown): MatterRunWebFace | null {
  return (MATTER_RUN_WEB_FACES as readonly unknown[]).includes(value)
    ? (value as MatterRunWebFace)
    : null
}

/** Stage 2 PR-1 (grill Q19=A) — VENUE-level switches of the im_chat row. 🔴 NOT grants: the
 *  AgentModeGrants axis is the owner's per-AGENT headless authorization; these are per-VENUE
 *  owner switches (env/Settings), threaded from the lifecycle as trusted data. Only the im_chat
 *  branch ever reads them — every other mode ignores the object entirely, so passing it to a
 *  non-im run is behavior-inert. `imWebEnabled` mirrors MAILAGENT_IM_WEB_ENABLED (default off):
 *  false → web tools are not even registered in an im run; true → registered AND 恒 HITL
 *  (mayAutoApprove stays manual-only — the switch never relaxes approval). */
export interface ImVenueSwitches {
  imWebEnabled?: boolean
}

/** 0812 codex修复批 — the ONE artifact NAME the matter_followup row admits. The row used to admit
 *  the WHOLE artifact class, which silently covered report_write (a LOCAL WRITE: tools/report.ts
 *  persists/replaces Reports data) — a follow-up run's only artifact channel is the proposal
 *  tool, so the admission is BY NAME now. Defined here (not imported from tools/matters.ts)
 *  because policy.ts is the class layer's zero-dependency root — importing the tool module would
 *  cycle through types.ts. */
export const MATTER_RUN_PROPOSE_TOOL = 'matter_update_propose'

/** Registration-time matrix row (ADR-001 D3, exec row revised by ADR-004 D2, web row added by
 *  ADR-004 rev3.1 D2, im_chat row added by stage 0b — grill Q10=A — and opened by stage 2 PR-1
 *  — the 08-04 拍板): may a tool of this class exist in the ToolSet of a run in this mode?
 *  read/domain_write/artifact → every mode; capability_change/outbound → manual_chat only (permanently —
 *  no grant key exists for them); exec → manual_chat, OR a non-manual run whose per-agent grants
 *  carry exec===true; web → manual_chat, OR a non-manual run whose grants carry web∈{gated,open}
 *  (the owner's explicit opt-in, spec-derived — any other value incl. junk is 'off'), OR an
 *  im_chat run under the MAILAGENT_IM_WEB_ENABLED venue switch (Q19=A — `venue`, never a grant);
 *  connector_write (PR3) → manual_chat, OR a non-manual run whose grants carry a connectors record
 *  with ANY write-capable ceiling (coarse class gate — per-connector precision lives at
 *  registration, see the row comment below), OR im_chat (stage 2 PR-1: connector 全开放 —
 *  registered + 恒 HITL, grants not consulted). `grants` is
 *  only ever passed by the headless agent-run path; manual callers omit it (undefined = the
 *  pre-ADR-004 matrix, so a forgotten param is always SAFER, never wider).
 *  im_chat stays a hard floor for exec/capability_change/outbound: grants are deliberately NOT
 *  consulted in this mode (AgentModeGrants is the per-agent HEADLESS axis; the IM web opt-in is
 *  the separate `venue` switch), so a mis-threaded grants object can never widen an im run. */
export function isToolClassAllowedInMode(
  toolClass: GatewayToolClass,
  mode: AgentContextMode,
  grants?: AgentModeGrants,
  venue?: ImVenueSwitches,
  /** 0812 codex修复批 — ONLY the matter_followup row reads it (artifact admission is BY NAME
   *  there, see MATTER_RUN_PROPOSE_TOOL); every other mode ignores it, so an omitted argument
   *  (types.ts's runtime modeDenied belt, every existing caller/test) is byte-identical outside
   *  matter runs and FAIL-CLOSED inside them (no name → no artifact). */
  toolName?: string
): boolean {
  if (mode === 'manual_chat') return true
  // Matters MVP P4 (D5) — 🔴 this row MUST stay ABOVE the generic read/domain_write/artifact line
  // below: that line admits domain writes in every non-manual mode, so a matter_followup branch
  // placed after it could no longer deny them. A follow-up run observes and PROPOSES; the classes
  // it may hold are 'read' + 'artifact' — and 'artifact' ONLY under the one propose NAME (0812
  // codex修复批: the class also contains report_write, a LOCAL WRITE — whole-class admission was
  // the hole that let an allowedTools list pull it into an unattended run) — + since the 0812
  // owner拍板 (「全部只读工具，一个写工具都不给」) 'web' under the spec-authored read grant (the
  // same gated/open literals as the generic headless row; run_spec.py is the only author of that
  // grant, a profile's grants are never copied into a matter spec). Everything write-capable
  // (domain_write / connector_write / exec / capability_change / outbound) returns false BEFORE
  // the grant ladder below — grant_exec can never lift exec here, and venue switches are never
  // consulted (connector READS are class 'read', already admitted; connector WRITES stay denied
  // even under a tampered write/update ceiling).
  if (mode === 'matter_followup') {
    if (toolClass === 'read') return true
    if (toolClass === 'artifact') return toolName === MATTER_RUN_PROPOSE_TOOL
    if (toolClass === 'web') return grants?.web === 'gated' || grants?.web === 'open'
    return false
  }
  if (toolClass === 'read' || toolClass === 'domain_write' || toolClass === 'artifact') return true
  // Stage 2 PR-1 (08-04 拍板) — im_chat: connector tools fully open (write approval follows the
  // 08-05 per-tool tier: ask → Feishu card, auto → card-free — decided at the connector factory,
  // not here); web only under the venue switch (Q19=A — exact `=== true`, never
  // a grant); exec / capability_change / outbound 直接不给. Grants can lift NOTHING in this mode.
  if (mode === 'im_chat') {
    if (toolClass === 'connector_write') return true
    if (toolClass === 'web') return venue?.imWebEnabled === true
    return false
  }
  if (toolClass === 'exec') return grants?.exec === true
  if (toolClass === 'web') return grants?.web === 'gated' || grants?.web === 'open'
  // connector_write (stage 1 PR3, grill Q2): lifted when the per-agent connector grants carry ANY
  // write-capable ceiling ('write'/'update'; re-parsed fail-closed — junk/'read'-only/empty deny).
  // 🔴 This row is deliberately a COARSE class-level gate: it cannot see WHICH connector a tool
  // belongs to (class is per-tool-class, not per-tool). The per-connector / per-tool precision is
  // guaranteed at REGISTRATION (createConnectorTools only ever builds tools whose connector is in
  // the grants AND whose crud rank ≤ that connector's ceiling), so a ToolSet reaching this row can
  // only contain grant-covered connector writes — the row exists so applyContextModePolicy doesn't
  // strip them wholesale. A leaked/forged connector write outside that construction still hits the
  // registration whitelist server-side (Python rejects unsynced/undisclosed names).
  if (toolClass === 'connector_write') return hasConnectorWriteGrant(grants?.connectors)
  // capability_change + outbound: false under ANY grants (structurally un-grantable).
  return false
}

/** May approvalMode 'auto-reversible' skip the approval card for this tool? Only a reversible
 *  DOMAIN write in an owner-driven manual session (ADR-001 D3). The caller additionally requires
 *  tier==='preview' (unchanged UX vocabulary) — this predicate carries the class/mode half. */
export function mayAutoApprove(toolClass: GatewayToolClass, mode: AgentContextMode): boolean {
  return toolClass === 'domain_write' && mode === 'manual_chat'
}

// ── 08-05 WP-11 (owner 拍板) — the acceptEdits sets + the bypass carve-out are RETIRED ─────────
//
// 07-16's ACCEPT_EDITS_AUTO_APPROVE_TOOLS / ACCEPT_EDITS_ASK_TOOLS / BYPASS_STILL_ASK used to
// live here as code constants. The 08-05 per-tool approval-tier system replaced all three:
//   - Every built-in write tool now carries an owner-configurable tier (ask|auto|deny) whose
//     canonical registry + factory defaults live in Python `src/agent_config/tool_prefs.py`
//     (agent_config.db `tool_approval_pref` overrides; served via GET /api/agent/tool-prefs).
//     The gateway consumes the SERVER-folded map (GatewayToolApprovalPrefs, types.ts) — TS holds
//     NO copy of the registry (跨语言手抄纪律: the wire is the mirror, not a hand-copy).
//   - The 'acceptEdits' GLOBAL MODE is retired (GlobalApprovalMode is 'manual'|'bypass' now);
//     its member list survives as the data-level「编辑放行」preset (tool_prefs.py
//     ACCEPT_EDITS_PRESET → POST /api/agent/tool-prefs/preset batch-sets explicit 'auto').
//   - BYPASS_STILL_ASK is EMPTIED AND RETIRED (D1=a: bypass = 字面「无例外」, it outranks a
//     per-tool 'ask'). notion_agent_chat's carve-out rationale (外呼-不可撤回, codex HIGH-1)
//     did not disappear — it demoted from a code floor to that tool's factory-default 'ask'
//     tier + a danger_auto red confirm when the owner sets it to 'auto' (D2=a).
// The completeness gate moved with the data: tests/config/test_tool_prefs_catalog_parity.py
// pins registry ↔ tool_catalog.json `default_approval` (a new write tool without an explicit
// tier decision turns red there, replacing approval_mode.test.ts's two-set partition gate).

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
  grants?: AgentModeGrants,
  /** Stage 2 PR-1 — the im_chat venue switches (Q19 web opt-in). Only consulted by the im_chat
   *  branch; omitted everywhere else → byte-identical to the pre-PR-1 filter. */
  venue?: ImVenueSwitches
): ToolSet {
  if (mode === 'manual_chat') return tools
  const out: ToolSet = {}
  for (const [name, t] of Object.entries(tools)) {
    // 0812 codex修复批 — the NAME rides along so the matter_followup row can admit artifact
    // by name (MATTER_RUN_PROPOSE_TOOL); every other mode ignores the argument.
    if (isToolClassAllowedInMode(classOfTool(name), mode, grants, venue, name)) out[name] = t
  }
  return out
}
