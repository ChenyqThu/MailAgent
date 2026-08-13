// chat-panel P4 Phase 04a — A2UI ComponentRegistry.
//
// The registry maps a tool/component name → its rich React card (protocol-contracts §3). It is
// the security-boundary allowlist for generative tool UI: a tool name with a registered card
// renders that card; ANY other tool falls through to the generic ToolTraceCard (registry miss
// NEVER blocks the conversation). `createComponentRegistry` is generic so the same shape can be
// reused/extended; `componentRegistry` is the concrete Phase 04a instance (Draft / Notion /
// generic-approval cards). `registerToolUIs` (registerToolUIs.tsx) feeds `byName` into the
// assistant-ui `tools.by_name` slot (rich cards always mounted since S3).

import type { ToolCallMessagePartComponent } from '@assistant-ui/react'

import { A2UI_COMPONENTS } from './a2ui'
import { DraftReplyCard } from './mail/DraftReplyCard'
import { DraftComposeCard } from './mail/DraftComposeCard'
import { SendApprovalCard } from './mail/SendApprovalCard'
import { NotionSyncCard } from './notion/NotionSyncCard'
import { ApprovalActionCard } from './generic/ApprovalActionCard'
import { SystemDocApprovalCard } from './generic/SystemDocApprovalCard'
import { SkillToggleCard } from './generic/SkillToggleCard'
import { ExecApprovalCard } from './generic/ExecApprovalCard'
import { SkillInstallCard } from './generic/SkillInstallCard'
import { SkillInstallConfirmCard } from './generic/SkillInstallConfirmCard'
import { SkillUninstallCard } from './generic/SkillUninstallCard'
import { SkillPublishCard } from './generic/SkillPublishCard'
import { CustomAgentApprovalCard } from './generic/CustomAgentApprovalCard'
import { CustomAgentCallCard } from './generic/CustomAgentCallCard'
import { SimpleApprovalCard } from './generic/SimpleApprovalCard'
import { CalendarApprovalCard } from './calendar/CalendarApprovalCard'
import { MatterWriteCard } from './matters/MatterWriteCard'

/** One registration: an A2UI component (by name) + the tool names that render through it. */
export interface ToolUIRegistration {
  /** The A2UI component name (matches buildToolA2UIPayload's `component`). */
  component: string
  /** Tool names whose tool-call parts render through `render`. */
  toolNames: readonly string[]
  render: ToolCallMessagePartComponent
}

export interface ComponentRegistry {
  /** A2UI component name → component (the GenerativeUI-style allowlist, protocol §3). */
  components: Record<string, ToolCallMessagePartComponent>
  /** tool name → component (fed into assistant-ui's `tools.by_name`). */
  byName: Record<string, ToolCallMessagePartComponent>
  /** Resolve a tool name to its registered card, or undefined → caller uses the generic
   *  fallback. A registry miss must never throw / block. */
  resolve(toolName: string): ToolCallMessagePartComponent | undefined
}

/** Build a ComponentRegistry from a list of registrations. Later registrations win on a
 *  duplicate tool name (last-write); a component name may be referenced by several tools. */
export function createComponentRegistry(
  registrations: readonly ToolUIRegistration[]
): ComponentRegistry {
  const components: Record<string, ToolCallMessagePartComponent> = {}
  const byName: Record<string, ToolCallMessagePartComponent> = {}
  for (const reg of registrations) {
    components[reg.component] = reg.render
    for (const toolName of reg.toolNames) byName[toolName] = reg.render
  }
  return {
    components,
    byName,
    resolve: (toolName: string) => byName[toolName]
  }
}

/** The concrete Phase 04a registry: the rich cards over the write tools. */
export const componentRegistry: ComponentRegistry = createComponentRegistry([
  {
    component: A2UI_COMPONENTS.DraftReplyCard,
    toolNames: ['email_draft_reply'],
    render: DraftReplyCard
  },
  // prd 07-27 — new/forward + edit-existing draft approval card. Shows the SUBJECT (which the
  // reply card has no field for) and, for an update, a before→after diff whose "before" the card
  // fetches from serve-api. email_draft_reply deliberately keeps DraftReplyCard.
  {
    component: A2UI_COMPONENTS.DraftComposeCard,
    toolNames: ['email_draft_compose', 'email_draft_update'],
    render: DraftComposeCard
  },
  {
    component: A2UI_COMPONENTS.NotionSyncCard,
    toolNames: ['email_resync'],
    render: NotionSyncCard
  },
  {
    component: A2UI_COMPONENTS.ApprovalActionCard,
    toolNames: ['email_flag', 'email_archive', 'email_pin'],
    render: ApprovalActionCard
  },
  {
    component: A2UI_COMPONENTS.SendApprovalCard,
    toolNames: ['email_prepare_send'],
    render: SendApprovalCard
  },
  // M4b/M4c — self-mount approval cards (behind MAILAGENT_SKILL_SELF_MOUNT; discover_skills is a
  // silent read → no card → generic ToolTraceCard).
  {
    component: A2UI_COMPONENTS.SystemDocApprovalCard,
    toolNames: ['update_system_md'],
    render: SystemDocApprovalCard
  },
  {
    component: A2UI_COMPONENTS.SkillToggleCard,
    toolNames: ['set_skill_enabled'],
    render: SkillToggleCard
  },
  // S2 W1 — local exec approval cards (behind MAILAGENT_OPENNESS_EXEC_TOOLS + A2UI). The card shows
  // the exact argv/path + a "总是允许" affordance (creates a structured whitelist rule).
  {
    component: A2UI_COMPONENTS.ExecApprovalCard,
    toolNames: ['run_command', 'file_read', 'file_write'],
    render: ExecApprovalCard
  },
  // S2 W4 — skill-supply approval cards (behind MAILAGENT_OPENNESS_SKILL_INSTALL + A2UI;
  // skill_read is a silent read → no card). The confirm card renders SERVER quarantine facts.
  {
    component: A2UI_COMPONENTS.SkillInstallCard,
    toolNames: ['skill_install'],
    render: SkillInstallCard
  },
  {
    component: A2UI_COMPONENTS.SkillInstallConfirmCard,
    toolNames: ['skill_install_confirm'],
    render: SkillInstallConfirmCard
  },
  {
    component: A2UI_COMPONENTS.SkillUninstallCard,
    toolNames: ['skill_uninstall'],
    render: SkillUninstallCard
  },
  {
    component: A2UI_COMPONENTS.SkillPublishCard,
    toolNames: ['skill_draft_publish'],
    render: SkillPublishCard
  },
  // S6 W3-2 — custom-agent CRUD approval card (behind MAILAGENT_CUSTOM_AGENTS_ENABLED). The
  // permission summary + server-fact before/after diff card; delete/run_now stay on the generic
  // shell (identity-only inputs), list/get are silent reads → no card.
  {
    component: A2UI_COMPONENTS.CustomAgentApprovalCard,
    toolNames: ['custom_agent_create', 'custom_agent_update'],
    render: CustomAgentApprovalCard
  },
  {
    component: A2UI_COMPONENTS.CustomAgentCallCard,
    toolNames: ['custom_agent_call'],
    render: CustomAgentCallCard
  },
  // 1.5.0 dogfood (task 07-07) — identity-only edit-tier approval card for the four tools that were
  // missing a rich card and so fell through to the buttonless ToolTraceCard (approval-paused shown
  // as a永久 spinner, island-only approve). Registering them here gives islandless approve/reject
  // (respondToApproval → 通道 A resume). Behind their own gateway flags (WEB_TOOLS / CUSTOM_AGENTS);
  // a registration for a tool the gateway never emits is inert (the card only ever renders for a
  // live tool part).
  {
    component: A2UI_COMPONENTS.SimpleApprovalCard,
    toolNames: [
      'web_fetch',
      'web_search',
      'custom_agent_delete',
      'custom_agent_run_now',
      // task 07-21 — notion_agent_chat: identity-only edit-tier approval previewing the prompt.
      'notion_agent_chat',
      // 阶段 0.5-① G9 — the same 1.5.0 bug, two tools that were missed: agent_profile_restore /
      // agent_memory_update are edit-tier writes (tools/profile.ts makeWrite risk:'edit') with NO
      // registered card, so an approval-paused part fell through to the buttonless ToolTraceCard
      // (permanent spinner, island-only approve = deadlock without the island). Both are
      // identity-only (no editableFields on the gateway side either), so the pinned-value shell
      // is exactly right.
      'agent_profile_restore',
      'agent_memory_update'
    ],
    render: SimpleApprovalCard
  },
  // calendar epic 4.2 — the calendar write approval card (behind MAILAGENT_CALENDAR_AGENT_TOOLS).
  // Reschedule renders a server-fact before→after time diff; rsvp/delete carry the irrevocable
  // warnings. Registered here so islandless approval has real approve/reject buttons (v1.5.0 教训).
  {
    component: A2UI_COMPONENTS.CalendarApprovalCard,
    toolNames: ['calendar_event_reschedule', 'calendar_event_rsvp', 'calendar_event_delete'],
    render: CalendarApprovalCard
  },
  // Matters MVP P3 — the matter write tools (behind MAILAGENT_MATTERS_ENABLED; a registration for
  // a tool the gateway never emits is inert). One card, two jobs: an approval-paused part gets
  // real approve/reject buttons (matter_resource_mutate can force a card at any time, and per-tool
  // prefs let an owner set any of them to `ask` — without this they hit the buttonless
  // ToolTraceCard spinner, the v1.5.0 deadlock), and a COMPLETED part renders the write receipt +
  // undo — but only inside the Matter Chat panel (MatterChatSurfaceContext); everywhere else it
  // falls through to ToolTraceCard byte-identically.
  //
  // 🔴 This list must stay equal to GATEWAY_MATTER_WRITE_TOOL_NAMES (ai-gateway/tools/matters.ts),
  // the gateway's own definition of the write family — pinned by ComponentRegistry.test.tsx. It
  // drifted once: P4's matter_run_control / matter_review_update were added there (and to
  // WRITE_LABELLED_TOOLS + both locales) but not here, so the card never mounted for them and
  // matter_review_update — which tool_prefs.py ships `ask` with configurable=False, a floor an
  // owner cannot lower — paused onto the buttonless ToolTraceCard. That was the v1.5.0 / 阶段
  // 0.5-① G9 bug a third time; the gate exists so there is no fourth.
  {
    component: A2UI_COMPONENTS.MatterWriteCard,
    toolNames: [
      'matter_create',
      'matter_update',
      'matter_item_mutate',
      'matter_resource_mutate',
      'matter_stakeholder_mutate',
      'matter_relation_mutate',
      'matter_add_note',
      // P4 (D8) — the review-side pair.
      'matter_run_control',
      'matter_review_update',
      // 0813 轮 3 批 R — the two disposal writes.
      'matter_attention_triage',
      'matter_suggestion_resolve'
    ],
    render: MatterWriteCard
  }
])
