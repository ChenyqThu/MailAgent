// chat-panel P4 Phase 04a — A2UI ComponentRegistry.
//
// The registry maps a tool/component name → its rich React card (protocol-contracts §3). It is
// the security-boundary allowlist for generative tool UI: a tool name with a registered card
// renders that card; ANY other tool falls through to the generic ToolTraceCard (registry miss
// NEVER blocks the conversation). `createComponentRegistry` is generic so the same shape can be
// reused/extended; `componentRegistry` is the concrete Phase 04a instance (Draft / Notion /
// generic-approval cards). `registerToolUIs` (registerToolUIs.tsx) feeds `byName` into the
// assistant-ui `tools.by_name` slot, gated by MAILAGENT_A2UI_TOOL_CARDS.

import type { ToolCallMessagePartComponent } from '@assistant-ui/react'

import { A2UI_COMPONENTS } from './a2ui'
import { DraftReplyCard } from './mail/DraftReplyCard'
import { SendApprovalCard } from './mail/SendApprovalCard'
import { NotionSyncCard } from './notion/NotionSyncCard'
import { ApprovalActionCard } from './generic/ApprovalActionCard'

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

/** The concrete Phase 04a registry: the three rich cards over the five write tools. */
export const componentRegistry: ComponentRegistry = createComponentRegistry([
  {
    component: A2UI_COMPONENTS.DraftReplyCard,
    toolNames: ['email_draft_reply'],
    render: DraftReplyCard
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
  }
])
