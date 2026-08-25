// chat-panel P4 Phase 03a — AI SDK Gateway tool registry assembly.
//
// buildGatewayTools() composes the read-tool set (email / kos / report) bound to one
// MailAgentDomainClient, ready to hand to streamText({ tools }). The Electron wrapper
// builds this once and injects it as AiGatewayConfig.tools.
//
// 🔴 Phase 03a is READ-ONLY: write tools (email_flag/archive/draft, sync_to_notion,
//    high-risk send) are NOT built here — they land in phase-03b behind
//    MAILAGENT_AI_SDK_WRITE_TOOLS + approval. The `writeToolsEnabled` gate is wired
//    now so 03b only adds the write set; flag-off it stays read-only.

import type { ToolSet } from 'ai'

import type { MailAgentDomainClient } from '../python/domainClient'
import type { ApprovalGuard } from '../security/approval'
import { createEmailReadTools } from './email'
import { createFollowupTools } from './followups'
import { createPlanTools } from './plan'
import { createKosReadTools } from './kos'
import { createReportTools } from './report'
import { createWriteTools } from './write'
import { createSendTools } from './send'
import { applySkillGating } from './skill_gating'
import { createSelfMountTools } from './self_mount'
import { createSessionTools } from './sessions'
import { createProfileTools } from './profile'
import { createWebTools } from './web'
import { createExecTools } from './exec'
import { createSkillSupplyTools } from './skill_supply'
import { createSkillCreatorTools } from './skill_creator'
import { createCustomAgentTools } from './agents'
import { createAgentCatalogTools } from './agent_catalog'
import { createInternalAgentTools } from './internal_agents'
import { createAgentCallTools } from './agent_call'
import { createCalendarReadTools, createCalendarWriteTools } from './calendar'
import {
  createContactProposeTools,
  createContactReadTools,
  createContactWriteTools
} from './contacts'
import { createMatterReadTools, createMatterRunTools, createMatterWriteTools } from './matters'
import { createNotionAgentTools } from './notion_agent'
import {
  admitDynamicTools,
  applyContextModePolicy,
  normalizeContextMode,
  type AgentContextMode,
  type AgentRunContext
} from './policy'
import type {
  GatewayApprovalMode,
  GatewayToolApprovalPrefs,
  GatewayToolAuditCollector
} from './types'
// D1 (connector dogfood batch) — catalog row shape (prompt-land canonical, skillCatalog 先例).
import type { ConnectorCatalogEntry } from '../prompts/stable_prompt'

export interface BuildGatewayToolsOpts {
  domain: MailAgentDomainClient
  /** kosConfig().timeDecayEnabled — gates kos_query recency rerank. */
  kosTimeDecayEnabled?: boolean
  /** MAILAGENT_PLAN_TOOL, read in Electron main only. Default ON because P0 fixes the bug where
   *  the prompt requires a tool that does not exist; default-off would preserve that bug. The
   *  flag is only an emergency rollback switch. Explicit false restores the pre-P0 ToolSet. */
  planToolsEnabled?: boolean
  /** MAILAGENT_AI_SDK_WRITE_TOOLS (phase-03b). When false (default) the registry is
   *  read-only. When true, the seven approval-gated write tools are added — but only
   *  if `approvalGuard` is also supplied (a write tool cannot exist without its guard). */
  writeToolsEnabled?: boolean
  /** The per-gateway ApprovalGuard the write tools bind to (id/hash/expiry domain guard).
   *  Required to build write tools; omitted → read-only even when writeToolsEnabled. */
  approvalGuard?: ApprovalGuard
  /** A2UI card stamping (phase-04a; always on since S3). When on, write tools stamp the A2UI render payload
   *  into their audit row (ui_payload_json). UI/audit only — does not change the model result
   *  (off → byte-identical to 03b). */
  a2uiEnabled?: boolean
  /** MAILAGENT_AI_SDK_SEND_TOOL (phase-04b). When true, the high-risk email_prepare_send tool is
   *  added — but only if writeToolsEnabled + approvalGuard + sendSigningSecret are also present
   *  (a send tool cannot exist without its guard + token secret). Off (default) → no send tool,
   *  byte-identical to 04a. */
  sendToolEnabled?: boolean
  /** HMAC secret for the send approval token (the per-session local API token, shared with the
   *  Python serve-api). Required to build the send tool; omitted → no send tool even if enabled. */
  sendSigningSecret?: string
  /** Auto-approval mode (body.approvalMode, default 'always'). 'auto-reversible' lets reversible
   *  preview-tier writes (flag/archive/pin/resync) execute without a card;
   *  edit-tier + the blocking send still ask. Threaded into the write tools' needsApproval.
   *  07-16 — may also carry the SERVER-injected owner-global 'bypass' overlay
   *  (prepareChatRun, manual_chat-gated); see types.ts GlobalApprovalMode. */
  approvalMode?: GatewayApprovalMode
  /** 08-05 WP-11 — the server-folded per-tool approval tiers + send whitelist of a MANUAL run
   *  (types.ts GatewayToolApprovalPrefs), resolved by prepareChatRun via
   *  cfg.resolveToolApprovalPrefs and passed ONLY for manual_chat runs. The tier map threads
   *  into every built-in write factory's needsApproval ladder; the send whitelist into
   *  createSendTools; an explicit owner 'deny' additionally strips the tool from the MANUAL
   *  ToolSet below (registration face — the model cannot see it). Absent (headless/im runs,
   *  resolver failure, tests) → every write keeps its ask semantics, byte-identical. */
  toolApprovalPrefs?: GatewayToolApprovalPrefs | null
  /** M4a (MAILAGENT_SKILL_SELF_MOUNT) — when true AND advertisedSkills is provided (non-null),
   *  drop the read tools of any email/search/report skill NOT in advertisedSkills (skill→tool
   *  gating, see skill_gating.ts). Off / advertisedSkills null → applySkillGating is NOT called →
   *  byte-identical to the cutover tool set. The gated set is read tools only; write/send
   *  (core) are never gated. (email_list_filter — the renamed former collision-exempt
   *  email_search — now gates with the email skill family like its siblings, PR-D.) */
  skillGatingEnabled?: boolean
  /** M4a — the advertised (enabled(override ?? default) && available) skill names from Python
   *  /chat/config.advertisedSkills. null/undefined = unknown (store/manifest hiccup) → fail OPEN
   *  (no gating; the gated set is harmless read tools, write/send keep flag+approval); [] = all
   *  skills disabled → gate every mapped skill tool. Only consulted when skillGatingEnabled. */
  advertisedSkills?: readonly string[] | null
  /** Part B (MAILAGENT_ISLAND_AGENT_ENABLED) — make the preview/edit write tools one-shot (execute
   *  consumes the approval) so an island-resumed approval and a renderer-resumed approval can never
   *  double-execute the same write. The blocking send has always consumed; this extends it to the
   *  other writes + self-mount writes. Off (default) → no consume, byte-identical to the pre-Part-B
   *  write path. */
  oneShotWrites?: boolean
  /** S1 R1 (MAILAGENT_OPENNESS_SESSION_TOOLS) — when true, the three chat-session read tools
   *  (chat_session_list / chat_session_search / chat_session_get) are added. Silent reads whose
   *  message content is CHAT_HISTORY-fenced (past sessions embed email bodies = second-order
   *  injection surface). Off (default) → not added → ToolSet byte-identical to the v1.2.0 set. */
  sessionToolsEnabled?: boolean
  sessionProvenanceEnabled?: boolean
  /** S1 R2 (MAILAGENT_OPENNESS_CONFIG_TOOLS) — when true AND approvalGuard is supplied, the four
   *  profile-config tools are added: agent_profile_read / agent_profile_history (silent reads;
   *  memory content comes back MEMORY-fenced) + agent_profile_restore / agent_memory_update
   *  (edit-tier writes, always ask — never auto-approved). Off (default) → not added → ToolSet
   *  byte-identical to the v1.2.0 set. */
  configToolsEnabled?: boolean
  /** S1 R3 (MAILAGENT_OPENNESS_WEB_TOOLS) — when true AND approvalGuard is supplied, the two web
   *  tools are added: web_fetch / web_search (both edit-tier writes — outbound network always asks,
   *  never auto-approved; returned content is WEB_CONTENT-fenced). Off (default) → not added →
   *  ToolSet byte-identical to the v1.2.0 set. */
  webToolsEnabled?: boolean
  /** Stage 2 PR-1 (grill Q19=A) — the im_chat web venue switch (MAILAGENT_IM_WEB_ENABLED, default
   *  off; 🔴 NOT a grant — it is a per-venue owner switch, deliberately outside AgentModeGrants).
   *  Consulted ONLY by the im_chat branch of the matrix: false → web tools are stripped from an
   *  im run's ToolSet (and their runtime modeDenied hard-rejects); true → they register in im_chat
   *  and stay 恒 HITL (mayAutoApprove is manual-only). Every other mode ignores it entirely, so a
   *  non-im assembly is byte-identical whatever this carries. */
  imWebEnabled?: boolean
  /** S2 W1 (MAILAGENT_OPENNESS_EXEC_TOOLS) — when true AND approvalGuard is supplied, the three exec
   *  tools are added: run_command / file_read / file_write (all edit-tier writes — local execution
   *  always asks unless a structured PolicyRule whitelist matches; never auto-approved). They are
   *  class 'exec' (manual_chat-only): applyContextModePolicy drops them outside a manual run. Off
   *  (default) → not added → ToolSet byte-identical to the v1.2.0 set. */
  execToolsEnabled?: boolean
  /** S2 W4 (MAILAGENT_OPENNESS_SKILL_INSTALL) — when true AND approvalGuard is supplied, the four
   *  skill-supply tools are added: skill_install / skill_install_confirm / skill_uninstall (all
   *  edit-tier writes + class capability_change — NEVER auto-approved, no whitelist hook, two HITL
   *  cards per install per ADR-002 §4) + skill_read (silent read, SKILL_DOC-fenced output). Off
   *  (default) → not added → ToolSet byte-identical to the v1.2.0 set. */
  skillInstallToolsEnabled?: boolean
  /** MAILAGENT_SKILL_CREATOR — six manual-only Skill draft tools. */
  skillCreatorToolsEnabled?: boolean
  /** S5 W3 (MAILAGENT_CUSTOM_AGENTS_ENABLED) — when true AND approvalGuard is supplied, the six
   *  custom-agent CRUD tools are added: custom_agent_list / custom_agent_get (silent reads) +
   *  custom_agent_create / custom_agent_update / custom_agent_delete / custom_agent_run_now
   *  (edit-tier writes + class capability_change — never auto-approved; the whole spec is pinned).
   *  The SAME flag gates the S4 headless kernel, so off (default) → not added → ToolSet byte-identical
   *  to the S4 set. */
  customAgentToolsEnabled?: boolean
  /** task 08-14 (MAILAGENT_INTERNAL_AGENT_TOOLS, default ON) — the BUILT-IN agent tool family:
   *  internal_agent_list / internal_agent_get (silent reads, class capability_change). It fixes
   *  "the main agent is blind to its own agents": custom_agent_list filters type==='custom', so a
   *  library with zero custom rows gets an empty list while five built-in agents really exist.
   *  Explicit false → not added → ToolSet byte-identical to the pre-08-14 set. */
  internalAgentToolsEnabled?: boolean
  customAgentCallEnabled?: boolean
  parentSessionId?: number | null
  findSessionByParentToolCall?: (parentSessionId: number, parentToolCallId: string) => number | null
  createAgentCallSession?: (input: {
    agentId: string
    title: string
    parentSessionId: number
    parentToolCallId: string
    invokedBy: 'user' | 'main_agent'
  }) => number
  setAgentSessionJobId?: (sessionId: number, jobId: number) => void
  /** calendar epic 4.1/4.2 (MAILAGENT_CALENDAR_AGENT_TOOLS) — when true AND approvalGuard is
   *  supplied, the five calendar tools are added: calendar_events_list / calendar_event_get
   *  (silent reads; event text comes back CALENDAR_EVENT-fenced) + calendar_event_reschedule /
   *  calendar_event_rsvp / calendar_event_delete (edit-tier writes, D4 恒 HITL — always ask, no
   *  whitelist/免卡 channel). Off → not added → ToolSet byte-identical to the pre-epic set. */
  calendarToolsEnabled?: boolean
  /** task 07-21 (MAILAGENT_NOTION_AGENT_TOOL) — when true AND approvalGuard is supplied, the
   *  notion_agent_chat tool is added: an edit-tier write (恒 HITL — external AI call to the
   *  notion-agent CLI, side effects on the Notion side, no whitelist/免卡 channel). Unlike the
   *  other tool families this one is SKILL-gated (skill_gating.GATEWAY_SKILL_TOOLS maps it to the
   *  notion_agent skill), so the Settings skill toggle (advertisedSkills) is the real on/off; the
   *  flag is the emergency kill-switch (explicit false → not added → byte-identical). */
  notionAgentToolsEnabled?: boolean
  /** S2 W0 (ADR-001 D1/D3) — the run's server-asserted context mode, threaded from
   *  prepareChatRun's trustedContextMode. Governs (a) the auto-approve predicate (a reversible
   *  domain write may only skip the card in manual_chat) and (b) the LAST assembly step
   *  (applyContextModePolicy): outside manual_chat every capability_change/exec/outbound tool is
   *  dropped from the ToolSet. 🔴 Fail-closed: absent/unknown → 'untrusted_trigger' (strictest).
   *  Every current entrypoint passes 'manual_chat', so production behaviour is byte-identical;
   *  tests must pass it explicitly. */
  contextMode?: AgentContextMode
  /** S5 W4 (ADR-004) — the per-agent run context of a headless custom-agent run, threaded from
   *  wrapCfgForAgentRun via cfg.buildTools' fourth parameter. Consumed three ways, all from this
   *  ONE object: (a) the write factory's headless-only policyEvaluate injection (agentId), (b) the
   *  exec factory's whitelist evaluate + audit annotation (agentId + modeGrants for the runtime
   *  modeDenied), (c) the LAST assembly step's matrix grants (applyContextModePolicy). Absent
   *  (every manual entrypoint) → assembly byte-identical to the pre-ADR-004 set. */
  agentRunContext?: AgentRunContext
  /** Stage 0b (harness-expansion epic) — DYNAMIC tools: runtime-discovered names (stage-1 MCP
   *  connector tools, `mcp__<connector>__<tool>`). Admitted AFTER both skill-gating passes (they
   *  belong to no GATEWAY_SKILL_TOOLS family — their business gating is the stage-1 seventh
   *  capability card) and BEFORE applyContextModePolicy (their runtime-registered class must be
   *  mode-filtered like any static tool). 🔴 Fail-closed: a dynamic tool with no
   *  registerRuntimeToolClass entry is NOT admitted (admitDynamicTools drops it), and a name
   *  colliding with an assembled static tool never clobbers it. Absent (every current caller) →
   *  assembly byte-identical. */
  dynamicTools?: ToolSet
  /** D1 (connector dogfood batch) — the run-scoped MCP connector catalog matching `dynamicTools`
   *  (lifecycle: connectorCatalogForRun over the manifest cache). Consumed ONLY by
   *  discover_skills' "External connectors" summary so the self-description tool stops being
   *  connector-blind. Absent / null → discover_skills output byte-identical. */
  connectorCatalog?: ConnectorCatalogEntry[] | null
}

/** Names of the read tools exposed by the gateway (for tests / observability). */
export const GATEWAY_READ_TOOL_NAMES = [
  'email_list_filter',
  'email_search_fulltext',
  'email_get',
  'email_body',
  'email_list_thread',
  'email_search_attachments',
  'email_thread_attachments',
  'email_attachment_text',
  'kos_query',
  // issue #57 — extra KOS read tools (all silent reads, registered alongside kos_query; like it
  // they are registered unconditionally — kosConfigured gates the prompt guidance block, and an
  // unconfigured call surfaces E_KOS_NOT_CONFIGURED as a tool error).
  'kos_search',
  'kos_get_page',
  'kos_find_experts',
  'kos_list_pages',
  'kos_get_backlinks',
  'report_list',
  'report_get'
] as const

/** Tools present in the default manual gateway assembly. `report_write` and `plan_update` are
 * local, silent artifacts, so they are available without the approval-gated domain write families.
 * `suggest_followups` (W6) is the flag-free interactive follow-up supply — part of every MANUAL
 * assembly (the one venue-gated member: it does not register outside manual_chat, and every
 * consumer of this const asserts a manual assembly). */
export const GATEWAY_DEFAULT_TOOL_NAMES = [
  ...GATEWAY_READ_TOOL_NAMES,
  'report_write',
  'plan_update',
  'suggest_followups'
] as const

/** Exact pre-P0 manual default surface, used to pin the emergency flag-off rollback shape. */
export const GATEWAY_PLAN_TOOL_OFF_NAMES = [
  ...GATEWAY_READ_TOOL_NAMES,
  'report_write',
  'suggest_followups'
] as const

/** Compose the gateway tool set. 03a → read tools only. The optional `collector` is
 *  the per-request audit sink each tool's execute pushes into (closure-bound); the
 *  gateway (server.ts) creates one per /api/ai/chat request and drains it in onFinish. */
export function buildGatewayTools(
  opts: BuildGatewayToolsOpts,
  collector: GatewayToolAuditCollector = []
): ToolSet {
  // S2 W0 — the run's context mode, fail-closed (absent/unknown → 'untrusted_trigger'). Threaded
  // into every write/send factory (auto-approve predicate + runtime double-insurance) and applied
  // as the LAST assembly step below (registration-time filter).
  const contextMode = normalizeContextMode(opts.contextMode)
  // 08-05 WP-11 — per-tool approval tiers are a MANUAL-run concept: even if a caller threads the
  // prefs into a non-manual assembly they are dropped HERE (structural gate on top of types.ts'
  // consumption-side manual re-check) — headless stays grants-only, im stays matrix-only.
  const toolPrefs = contextMode === 'manual_chat' ? (opts.toolApprovalPrefs ?? null) : null
  const prefTiers = toolPrefs?.tools
  // P4 (D5) → 0812 owner拍板 — NO caller narrows the email reads to a Matter any more, in EITHER
  // venue: a follow-up run's whole point is discovering NEW evidence (the old anchor-derived
  // matterScopeFilter/matterGetScope locked it inside what was already linked — structurally
  // unable to see a new mail), and the manual panel's「本事项 / 全库」toggle was removed with the
  // same call (事项对话 reads the full library). The anchor (matterRun) now feeds ONLY the propose
  // tool's identity below, so both tool-side scoping options are gone rather than left null.
  const matterRun = opts.agentRunContext?.matterRun
  const tools: ToolSet = {
    ...createEmailReadTools(opts.domain, collector),
    ...createKosReadTools(opts.domain, collector, { timeDecayEnabled: opts.kosTimeDecayEnabled }),
    ...createReportTools(opts.domain, collector, opts.agentRunContext?.agentId)
  }
  if (opts.planToolsEnabled !== false) {
    Object.assign(tools, createPlanTools(collector))
  }
  // W6 — suggest_followups is interactive UI supply: registered ONLY in an owner-facing manual
  // chat (no flag — it is part of the manual default set). NOT registered headless/im/search:
  // follow-up chips have no meaning without a composer, and its hasToolCall stop condition
  // (prepareChatRun) must never be able to end an unattended run early. This is a VENUE gate on
  // top of its 'read' class — the one read tool with a registration-time mode condition (the
  // class matrix alone would register reads everywhere; policy.test.ts documents the carve-out).
  if (contextMode === 'manual_chat') {
    Object.assign(tools, createFollowupTools(collector))
  }
  // S1 R1 — chat-session read tools behind MAILAGENT_OPENNESS_SESSION_TOOLS (default off →
  // not added, byte-identical to the v1.2.0 set). Silent reads with CHAT_HISTORY-fenced output;
  // CORE_UNGATED (no skill ownership — the flag is the on/off authority) so applySkillGating
  // below never drops them.
  if (opts.sessionToolsEnabled) {
    Object.assign(
      tools,
      createSessionTools(opts.domain, collector, {
        provenanceEnabled: opts.sessionProvenanceEnabled,
        currentAgentId: opts.agentRunContext?.agentId,
        allowAllHistory: opts.agentRunContext?.allowedTools?.includes('chat_session_list') === true
      })
    )
  }
  if (
    opts.sessionProvenanceEnabled &&
    opts.agentRunContext &&
    opts.agentRunContext.allowedTools?.includes('chat_session_list')
  ) {
    Object.assign(tools, createAgentCatalogTools(opts.domain, collector))
  }
  // phase-03b — write tools only when the flag is on AND a guard is supplied. Off (or no
  // guard) → read-only, byte-identical to 03a. Approval is enforced two ways: ai@6's
  // needsApproval/signature (set at streamText) + the guard bound here (id/hash/expiry).
  if (opts.writeToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createWriteTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode,
        // S5 W4 (ADR-004 D1) — headless agent run only: the factory injects the per-agent
        // domain_write whitelist evaluate. Manual runs never carry a context → undefined →
        // the factory's policyEvaluate stays absent, byte-identical.
        agentRunContext: opts.agentRunContext
      })
    )
    // phase-04b — the high-risk send tool layers on top of the write tools (it needs the same
    // approval guard) and only when MAILAGENT_AI_SDK_SEND_TOOL is on AND a signing secret is
    // present. Off → no send tool, byte-identical to 04a.
    if (opts.sendToolEnabled && opts.sendSigningSecret) {
      Object.assign(
        tools,
        createSendTools(opts.domain, collector, opts.approvalGuard, {
          signingSecret: opts.sendSigningSecret,
          a2uiEnabled: opts.a2uiEnabled,
          contextMode,
          // 07-16 approval-mode switcher — only the exact 'bypass' literal relaxes the send card
          // (the factory narrows it into auditedSendTool's bypassMode); every other mode keeps
          // the hard always-ask floor byte-identical.
          approvalMode: opts.approvalMode,
          // 08-05 WP-11 (D2=a) — the send's ONE structured card-free shape: the owner's
          // recipient whitelist (manual only; empty/absent = the send 恒 ask). The send tool
          // deliberately gets NO per-tool tier map — a bare 'auto' is unrepresentable for it.
          sendRecipientWhitelist: toolPrefs?.sendRecipientWhitelist
        })
      )
    }
  }
  // M4 (M4b/M4c) — self-mount tools (update_system_md / discover_skills / set_skill_enabled) behind
  // MAILAGENT_SKILL_SELF_MOUNT (skillGatingEnabled). The two writes (update_system_md edit-tier,
  // set_skill_enabled preview-tier) bind the approval guard; discover_skills is a silent read. They
  // are CORE (no skill ownership) so applySkillGating below never drops them. flag-off → not added →
  // byte-identical to the cutover set.
  if (opts.skillGatingEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createSelfMountTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode,
        // D1 — run-scoped connector catalog for discover_skills' External connectors summary.
        connectorCatalog: opts.connectorCatalog
      })
    )
  }
  // S1 R2 — profile-config tools behind MAILAGENT_OPENNESS_CONFIG_TOOLS. Mixed set (2 silent
  // reads + 2 edit-tier writes) → all-or-nothing on flag + guard (self-mount 先例: a write tool
  // cannot exist without its guard, and registering only the reads would advertise a half
  // capability). CORE (no skill ownership) so applySkillGating below never drops them.
  // flag-off (default) → not added → byte-identical to the v1.2.0 set.
  if (opts.configToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createProfileTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  // S1 R3 — web tools behind MAILAGENT_OPENNESS_WEB_TOOLS. Both edit-tier writes → need the
  // approval guard (all-or-nothing on flag + guard, same as the profile-config block). CORE (no
  // skill ownership) so applySkillGating below never drops them. flag-off (default) → not added →
  // byte-identical to the v1.2.0 set.
  if (opts.webToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createWebTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode,
        // S6 W3 (ADR-004 rev3.1 D2) — headless agent run only: the factory wires the grant-tier
        // 免卡 paths (gated origin-whitelist evaluate / open+search grant verdict) + the runtime
        // modeDenied grants. Manual runs never carry a context → undefined → byte-identical.
        agentRunContext: opts.agentRunContext,
        // Stage 2 PR-1 — the im web venue switch (Q19=A); only the im_chat matrix branch reads it.
        imWebEnabled: opts.imWebEnabled
      })
    )
  }
  // S2 W1 — exec tools behind MAILAGENT_OPENNESS_EXEC_TOOLS. All three edit-tier writes → need the
  // approval guard (all-or-nothing on flag + guard, same as the web block). CORE (no skill ownership)
  // so applySkillGating below never drops them; class 'exec' so applyContextModePolicy (LAST step)
  // drops them outside a manual run. flag-off (default) → not added → byte-identical to the v1.2.0 set.
  if (opts.execToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createExecTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode,
        // S5 W4 (ADR-004 D2) — per-agent grants + agentId for a headless run: the SAME grants
        // applyContextModePolicy consumes below reach the tools' runtime modeDenied, and the
        // whitelist evaluate + /exec/* audit annotation carry agentId/contextMode.
        agentRunContext: opts.agentRunContext
      })
    )
  }
  // S2 W4 — skill-supply tools behind MAILAGENT_OPENNESS_SKILL_INSTALL. Mixed set (3 edit-tier
  // capability_change writes + 1 silent read) → all-or-nothing on flag + guard (profile-config
  // 先例: registering only the read would advertise a half capability). CORE (no skill ownership)
  // so applySkillGating below never drops them; class capability_change so applyContextModePolicy
  // (LAST step) drops the writes outside a manual run. flag-off (default) → not added →
  // byte-identical to the v1.2.0 set.
  if (opts.skillInstallToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createSkillSupplyTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  if (opts.skillCreatorToolsEnabled && opts.approvalGuard && contextMode === 'manual_chat') {
    Object.assign(
      tools,
      createSkillCreatorTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  // S5 W3 — custom-agent CRUD tools behind MAILAGENT_CUSTOM_AGENTS_ENABLED. Mixed set (2 silent
  // reads + 4 edit-tier capability_change writes) → all-or-nothing on flag + guard (skill-supply
  // 先例: registering only the reads would advertise a half capability). CORE (no skill ownership)
  // so applySkillGating below never drops them; class capability_change so applyContextModePolicy
  // (LAST step) drops the ENTIRE surface outside a manual run (a headless run can never build/edit/run
  // agents). flag-off (default) → not added → byte-identical to the S4 set.
  if (opts.customAgentToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createCustomAgentTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  // task 08-14 — 内建 agent 面（MAILAGENT_INTERNAL_AGENT_TOOLS，默认开）。混合集（2 silent read
  // + 1 edit-tier capability_change write）→ flag + guard 上 all-or-nothing（custom_agent_* 先例：
  // 只注册读面等于广告半个能力）。class capability_change ⇒ applyContextModePolicy（最后一步）在
  // 非 manual run 里把整面剔除，无需额外场地门。显式 false → 不注册 → 字节级回 08-14 前。
  if (opts.internalAgentToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createInternalAgentTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  if (
    contextMode === 'manual_chat' &&
    opts.customAgentCallEnabled &&
    opts.customAgentToolsEnabled &&
    opts.approvalGuard &&
    opts.parentSessionId != null &&
    opts.findSessionByParentToolCall &&
    opts.createAgentCallSession &&
    opts.setAgentSessionJobId
  ) {
    Object.assign(
      tools,
      createAgentCallTools(opts.domain, collector, opts.approvalGuard, {
        contextMode,
        approvalMode: opts.approvalMode,
        toolApprovalPrefs: prefTiers,
        parentSessionId: opts.parentSessionId,
        findSessionByParentToolCall: opts.findSessionByParentToolCall,
        createAgentSession: opts.createAgentCallSession,
        setAgentSessionJobId: opts.setAgentSessionJobId
      })
    )
  }
  // calendar epic 4.1/4.2 — calendar tools behind MAILAGENT_CALENDAR_AGENT_TOOLS. Mixed set
  // (2 silent reads + 3 edit-tier writes) → all-or-nothing on flag + guard (profile-config 先例:
  // a write tool cannot exist without its guard, and registering only the reads would advertise a
  // half capability). CORE (no skill ownership) so applySkillGating below never drops them; class
  // domain_write (policy.ts) so a headless run keeps them registered and the always-ask edit tier
  // stashes → paused_handoff. NO agentRunContext is threaded — the factory wires no policyEvaluate,
  // so no per-agent whitelist can ever免卡 a calendar write (D4 恒 HITL). flag-off → not added →
  // byte-identical to the pre-epic set.
  if (opts.calendarToolsEnabled && opts.approvalGuard) {
    Object.assign(tools, createCalendarReadTools(opts.domain, collector))
    Object.assign(
      tools,
      createCalendarWriteTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  // Matters MVP P3 (D6) + P4 (D8) + 0813 批 R — core Matter family. Mixed set (silent reads +
  // edit-tier writes) requires the guard. CORE_UNGATED (no skill ownership) so applySkillGating
  // never drops them; class
  // read/domain_write (policy.ts), so the LAST assembly step keeps the writes in owner-present and
  // headless venues alike — and strips EVERY write inside a matter_followup run (D5). No
  // agentRunContext is threaded into the write factory: no per-agent whitelist may 免卡 a Matter
  // write, and matter_review_update's own policyEvaluate is a SERVER-fact seam, not a grant.
  if (opts.approvalGuard) {
    Object.assign(tools, createMatterReadTools(opts.domain, collector))
    Object.assign(
      tools,
      createMatterWriteTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
    // P4 (D6) — matter_update_propose exists ONLY inside a follow-up run: its identity (which
    // Matter, which run) comes from the server-assembled anchor, so outside that context there is
    // nothing for it to address. Guard-free by design (class artifact, silent — report_write
    // 先例): it writes a PENDING proposal the owner still has to review.
    if (matterRun) {
      Object.assign(tools, createMatterRunTools(opts.domain, collector, matterRun))
    }
  }
  // Contact Directory WP7 — core contact family. Mixed set (3 silent reads + 3 silent artifact
  // proposals + 3 domain_write) requires the guard. CORE_UNGATED (no skill ownership) so neither
  // applySkillGating
  // pass drops them; class read/artifact/domain_write (policy.ts), so the LAST assembly step keeps
  // the reads + proposals inside a contact_governance run and strips EVERY write there. 🔴 No
  // agentRunContext is threaded into the write factory: no per-agent whitelist may 免卡 a
  // directory write (calendar 先例 — the factory wires no policyEvaluate at all).
  if (opts.approvalGuard) {
    Object.assign(tools, createContactReadTools(opts.domain, collector))
    Object.assign(tools, createContactProposeTools(opts.domain, collector))
    Object.assign(
      tools,
      createContactWriteTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  // task 07-21 — notion-agent tool behind MAILAGENT_NOTION_AGENT_TOOL. One edit-tier write (恒 HITL,
  // class 'outbound') → needs the approval guard (all-or-nothing on flag + guard). Registered here
  // BEFORE the skill-gating passes because — unlike the CORE_UNGATED web/calendar families — it is
  // SKILL-gated (mapped to the notion_agent skill in GATEWAY_SKILL_TOOLS), so applySkillGating below
  // drops it unless the notion_agent skill is advertised (Settings toggle). flag-off → not added →
  // byte-identical.
  if (opts.notionAgentToolsEnabled && opts.approvalGuard) {
    Object.assign(
      tools,
      createNotionAgentTools(opts.domain, collector, opts.approvalGuard, {
        a2uiEnabled: opts.a2uiEnabled,
        approvalMode: opts.approvalMode,
        // 08-05 WP-11 — the per-tool tier map (manual only; null-collapsed above).
        toolApprovalPrefs: prefTiers,
        oneShot: opts.oneShotWrites,
        contextMode
      })
    )
  }
  // M4a — skill→tool gating after the full set is assembled, behind MAILAGENT_SKILL_SELF_MOUNT.
  // flag-off OR advertisedSkills null (Python hiccup → fail-open) → not called → byte-identical to the
  // cutover set. advertisedSkills=[] (all disabled) → gates every mapped skill read tool. The gated set
  // is read-only; write/send (core) are never dropped. (email_list_filter now gates with the
  // email skill family — the collision-exempt特例 retired with the PR-D rename.)
  const gated =
    opts.skillGatingEnabled && opts.advertisedSkills != null
      ? applySkillGating(tools, opts.advertisedSkills)
      : tools
  // S6 W3 (ADR-004 rev3.1 §5.1/D3) — per-agent skill MOUNT gating, headless agent runs only
  // (agentRunContext present). A SECOND applySkillGating pass stacked on the M4a business-state
  // gate above → the surviving skill tools are (mounted ∩ advertised): mounting can never revive a
  // globally-disabled skill. Deliberately independent of skillGatingEnabled AND of the
  // advertisedSkills null fail-open — those are manual business-state semantics; the mount list is
  // the owner's per-agent authorization, so it ALWAYS applies and a missing list is [] (zero
  // mounts, fail-closed), never a null passthrough into the fail-open branch. Pure reduction over
  // GATEWAY_SKILL_TOOLS only — CORE_UNGATED / collision-exempt floors are untouched (the mount
  // list is not a second switch for them). Manual entrypoints never carry a context → not called
  // → byte-identical.
  const mounted = opts.agentRunContext
    ? applySkillGating(gated, opts.agentRunContext.skills ?? [])
    : gated
  // task 08-25 — Matters MVP P6-A 的 `matter_suggest_related_resources` 曾在这里、两道
  // skill-gating 之后单独注册（manual-only 的供给工具）。整条关键词命中式的资料推荐随
  // owner 0825 拍板退役，于是这个注册点也没了 —— 现在两道 gating 之后只剩 dynamic tools。
  // Stage 0b — dynamic tools (none exist yet; stage 1 fills the input): admitted only with a
  // runtime class registration (fail-closed — an unregistered dynamic tool never enters the
  // ToolSet), after both skill-gating passes (no skill family) and BEFORE the context-mode
  // policy below so an admitted tool is mode-filtered by its registered class like any static
  // tool. Absent/empty input → identity pass-through (the same `mounted` object, byte-identical).
  const withDynamic = admitDynamicTools(mounted, opts.dynamicTools)
  // S2 W0 — context-mode policy LAST, after every create* block AND both skill-gating passes
  // (ADR-001 D3 / codex P2-2: no assembly path may leave a tool unfiltered). manual_chat (every
  // current production run) is an identity pass-through → byte-identical; non-manual modes drop
  // every capability_change/exec/outbound tool so the model structurally cannot see them — except
  // exec under an explicit per-agent grant (ADR-004 D2; the same grants object the exec tools'
  // runtime modeDenied consumed above, from the one agentRunContext), and web in im_chat under the
  // stage-2 PR-1 venue switch (the same imWebEnabled the web tools' runtime modeDenied consumed).
  const filtered = applyContextModePolicy(
    withDynamic,
    contextMode,
    opts.agentRunContext?.modeGrants,
    opts.imWebEnabled === true ? { imWebEnabled: true } : undefined
  )
  // 08-05 WP-11 — owner per-tool 'deny' strips the tool from the MANUAL ToolSet (the model
  // cannot see it — mirrors connector 'off'). Only EXPLICIT owner overrides can deny (factory
  // defaults are ask|auto), only manual_chat (prefTiers is null otherwise — headless/im matrices
  // untouched), and only built-in names (the prefs registry never contains mcp__* tools). The
  // types.ts prefDenied hard-reject is the runtime belt behind this registration-face filter.
  if (prefTiers) {
    const denied = Object.entries(prefTiers)
      .filter(([, p]) => p.source === 'owner' && p.tier === 'deny')
      .map(([name]) => name)
    if (denied.some((name) => name in filtered)) {
      const out: ToolSet = { ...filtered }
      for (const name of denied) delete out[name]
      return out
    }
  }
  return filtered
}
