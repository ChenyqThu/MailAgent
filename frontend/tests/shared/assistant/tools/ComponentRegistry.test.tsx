// @vitest-environment happy-dom
//
// chat-panel P4 Phase 04a / S3 — A2UI ComponentRegistry: tool→card resolution (hit / miss),
// the component allowlist, and the assistant-ui part components (S3: the A2UI flag was GA'd —
// rich cards are always mounted as tools.by_name with ToolTraceCard still the fallback so a
// registry MISS never blocks the conversation).

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  componentRegistry,
  createComponentRegistry
} from '@shared/assistant/tools/ComponentRegistry'
import {
  assistantPartComponents,
  getAssistantPartComponents
} from '@shared/assistant/tools/registerToolUIs'
import { PLAN_UPDATE_TOOL_NAME } from '@shared/assistant/plan'
import { PlanCard } from '@shared/assistant/tools/generic/PlanCard'
import { ToolTraceCard } from '@shared/assistant/tools/generic/ToolTraceCard'
import { McpToolFallback } from '@shared/assistant/tools/generic/McpApprovalCard'
import { SuggestFollowupsHiddenPart } from '@shared/assistant/components/FollowupSuggestions'
import { SUGGEST_FOLLOWUPS_TOOL_NAME } from '@shared/assistant/followups'
import { GATEWAY_MATTER_WRITE_TOOL_NAMES } from '../../../../src/ai-gateway/tools/matters'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('componentRegistry — resolution', () => {
  test('registered write tools resolve to a card (hit)', () => {
    expect(componentRegistry.resolve('email_draft_reply')).toBeTypeOf('function')
    expect(componentRegistry.resolve('email_resync')).toBeTypeOf('function')
    expect(componentRegistry.resolve('email_flag')).toBeTypeOf('function')
    expect(componentRegistry.resolve('email_archive')).toBeTypeOf('function')
    expect(componentRegistry.resolve('email_pin')).toBeTypeOf('function')
  })

  test('unregistered / read tools resolve to undefined (miss → generic fallback)', () => {
    expect(componentRegistry.resolve('email_search')).toBeUndefined()
    expect(componentRegistry.resolve('kos_query')).toBeUndefined()
    expect(componentRegistry.resolve('totally_unknown')).toBeUndefined()
  })

  test('memory_write / memory_delete retired (M5b) → undefined (no card)', () => {
    expect(componentRegistry.resolve('memory_write')).toBeUndefined()
    expect(componentRegistry.resolve('memory_delete')).toBeUndefined()
  })

  test('web_fetch/web_search/custom_agent_delete/custom_agent_run_now resolve to the SimpleApprovalCard (islandless approve, task 07-07)', () => {
    const webFetch = componentRegistry.resolve('web_fetch')
    expect(webFetch).toBeTypeOf('function')
    // all four share one component instance (they are one registration).
    expect(componentRegistry.resolve('web_search')).toBe(webFetch)
    expect(componentRegistry.resolve('custom_agent_delete')).toBe(webFetch)
    expect(componentRegistry.resolve('custom_agent_run_now')).toBe(webFetch)
    // 阶段 0.5-① G9 — the two profile writes join the same shell (same bug, missed in 07-07).
    expect(componentRegistry.resolve('agent_profile_restore')).toBe(webFetch)
    expect(componentRegistry.resolve('agent_memory_update')).toBe(webFetch)
    // and it is NOT the buttonless generic fallback.
    expect(webFetch).not.toBe(ToolTraceCard)
  })

  test('byName covers the write/self-mount/exec/skill-supply/custom-agent/simple-approval/calendar tools; components covers the card names', () => {
    expect(Object.keys(componentRegistry.byName).sort()).toEqual([
      // 阶段 0.5-① G9 — the two edit-tier profile writes that used to fall through to the
      // buttonless ToolTraceCard (approval-paused = permanent spinner, island-only approve).
      'agent_memory_update',
      'agent_profile_restore',
      'calendar_event_delete',
      'calendar_event_reschedule',
      'calendar_event_rsvp',
      'custom_agent_call',
      'custom_agent_create',
      'custom_agent_delete',
      'custom_agent_run_now',
      'custom_agent_update',
      'email_archive',
      'email_draft_compose',
      'email_draft_reply',
      'email_draft_update',
      'email_flag',
      'email_pin',
      'email_prepare_send',
      'email_resync',
      'file_read',
      'file_write',
      // Matters MVP P3 + P4 — the 9 matter write tools share MatterWriteCard (approval → real
      // approve/reject; completed → the write receipt, but only inside the Matter Chat panel).
      'matter_add_note',
      'matter_create',
      'matter_item_mutate',
      'matter_relation_mutate',
      'matter_resource_mutate',
      'matter_review_update',
      'matter_run_control',
      'matter_stakeholder_mutate',
      'matter_update',
      'notion_agent_chat',
      'run_command',
      'set_skill_enabled',
      'skill_draft_publish',
      'skill_install',
      'skill_install_confirm',
      'skill_uninstall',
      'update_system_md',
      'web_fetch',
      'web_search'
    ])
    expect(Object.keys(componentRegistry.components).sort()).toEqual([
      'ApprovalActionCard',
      'CalendarApprovalCard',
      'CustomAgentApprovalCard',
      'CustomAgentCallCard',
      'DraftComposeCard',
      'DraftReplyCard',
      'ExecApprovalCard',
      'MatterWriteCard',
      'NotionSyncCard',
      'SendApprovalCard',
      'SimpleApprovalCard',
      'SkillInstallCard',
      'SkillInstallConfirmCard',
      'SkillPublishCard',
      'SkillToggleCard',
      'SkillUninstallCard',
      'SystemDocApprovalCard'
    ])
  })

  // 🔴 Anti-regression gate for the bug this file's matter list carried from P4 to 2026-08-12:
  // matter_run_control / matter_review_update existed in the gateway's write family but were never
  // registered here, so their approval-paused parts fell onto the BUTTONLESS ToolTraceCard —
  // permanent spinner, island-only approve. Third occurrence of the v1.5.0 / 阶段 0.5-① G9 class.
  //
  // The judge is GATEWAY_MATTER_WRITE_TOOL_NAMES — the gateway's OWN definition of the family —
  // deliberately not MatterWriteCard's WRITE_LABELLED_TOOLS and not a hardcoded count: the card's
  // set is itself a mirror, so a tenth tool that misses BOTH mirrors would keep a set-based gate
  // green, which is exactly the shape that produced this bug. Adding a write tool to the gateway
  // now turns this red until it has a card.
  test('every gateway matter write tool resolves to the one MatterWriteCard instance', () => {
    expect(GATEWAY_MATTER_WRITE_TOOL_NAMES.length).toBeGreaterThan(0)
    const card = componentRegistry.resolve(GATEWAY_MATTER_WRITE_TOOL_NAMES[0])
    expect(card).toBeTypeOf('function')
    expect(card).not.toBe(ToolTraceCard)
    for (const name of GATEWAY_MATTER_WRITE_TOOL_NAMES) {
      expect(componentRegistry.resolve(name), `${name} has no registered card`).toBe(card)
    }
  })

  test('the three calendar write tools share one component instance (CalendarApprovalCard)', () => {
    const resched = componentRegistry.resolve('calendar_event_reschedule')
    expect(resched).toBeTypeOf('function')
    expect(componentRegistry.resolve('calendar_event_rsvp')).toBe(resched)
    expect(componentRegistry.resolve('calendar_event_delete')).toBe(resched)
    expect(resched).not.toBe(ToolTraceCard)
  })

  test('the three flag/archive/pin tools share one component instance (ApprovalActionCard)', () => {
    const flag = componentRegistry.resolve('email_flag')
    expect(componentRegistry.resolve('email_archive')).toBe(flag)
    expect(componentRegistry.resolve('email_pin')).toBe(flag)
  })
})

describe('createComponentRegistry — generic builder', () => {
  test('empty registrations → empty maps, resolve always undefined', () => {
    const r = createComponentRegistry([])
    expect(r.byName).toEqual({})
    expect(r.components).toEqual({})
    expect(r.resolve('anything')).toBeUndefined()
  })

  test('a registration maps every listed tool name to its render', () => {
    const Dummy = (): null => null
    const r = createComponentRegistry([{ component: 'X', toolNames: ['a', 'b'], render: Dummy }])
    expect(r.resolve('a')).toBe(Dummy)
    expect(r.resolve('b')).toBe(Dummy)
    expect(r.components.X).toBe(Dummy)
    expect(r.resolve('c')).toBeUndefined()
  })
})

describe('getAssistantPartComponents — S3 always-on rich cards', () => {
  test('returns the registry cards as tools.by_name; the fallback is the MCP-aware router', () => {
    const parts = getAssistantPartComponents()
    expect(parts).toBe(assistantPartComponents)
    const tools = parts.tools as { by_name?: Record<string, unknown>; Fallback?: unknown }
    // Stage 1 PR2 — the Fallback slot is McpToolFallback: it routes an mcp__* connector part in
    // an approval phase to McpApprovalCard and EVERYTHING else to ToolTraceCard (registry miss
    // still never blocks — pinned in McpApprovalCard.test.tsx).
    expect(tools.Fallback).toBe(McpToolFallback)
    expect(tools.Fallback).not.toBe(ToolTraceCard)
    // W6 — by_name 不再是 componentRegistry.byName 本体：registerToolUIs 在它之上 overlay 了一个
    // 零渲染的 suggest_followups part UI（chip 行由 thread 层渲染，工具本身不出卡）。身份断言换成
    // 结构断言，钉住真正要保的两件事：registry 每一条都原样在里面，且 overlay 只有这一条。
    const byName = tools.by_name ?? {}
    for (const [name, render] of Object.entries(componentRegistry.byName)) {
      expect(byName[name]).toBe(render)
    }
    expect(byName[SUGGEST_FOLLOWUPS_TOOL_NAME]).toBe(SuggestFollowupsHiddenPart)
    expect(byName[PLAN_UPDATE_TOOL_NAME]).toBe(PlanCard)
    expect(Object.keys(byName)).toHaveLength(Object.keys(componentRegistry.byName).length + 2)
    expect(Object.keys(tools.by_name ?? {})).toContain('email_draft_reply')
    // dynamic connector names are structurally NOT in by_name (runtime-only) — the router is
    // the only surface that can card them.
    expect(Object.keys(tools.by_name ?? {}).some((n) => n.startsWith('mcp__'))).toBe(false)
  })
})
