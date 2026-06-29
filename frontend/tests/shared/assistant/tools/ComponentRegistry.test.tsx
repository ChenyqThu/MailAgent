// @vitest-environment happy-dom
//
// chat-panel P4 Phase 04a — A2UI ComponentRegistry: tool→card resolution (hit / miss), the
// component allowlist, and the flag-gated assistant-ui part components (flag-off = generic
// fallback only, byte-identical to Phase 01; flag-on adds the rich cards as tools.by_name with
// ToolTraceCard still the fallback so a registry MISS never blocks the conversation).

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  componentRegistry,
  createComponentRegistry
} from '@shared/assistant/tools/ComponentRegistry'
import {
  assistantPartComponents,
  getAssistantPartComponents
} from '@shared/assistant/tools/registerToolUIs'
import { ToolTraceCard } from '@shared/assistant/tools/generic/ToolTraceCard'
import { MemoryApprovalCard } from '@shared/assistant/tools/generic/MemoryApprovalCard'

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

  test('memory_write / memory_delete resolve to the same MemoryApprovalCard instance', () => {
    const write = componentRegistry.resolve('memory_write')
    expect(write).toBeTypeOf('function')
    expect(write).toBe(MemoryApprovalCard)
    expect(componentRegistry.resolve('memory_delete')).toBe(MemoryApprovalCard)
  })

  test('byName covers the ten write/self-mount tools; components covers the seven card names', () => {
    expect(Object.keys(componentRegistry.byName).sort()).toEqual([
      'email_archive',
      'email_draft_reply',
      'email_flag',
      'email_pin',
      'email_prepare_send',
      'email_resync',
      'memory_delete',
      'memory_write',
      'set_skill_enabled',
      'update_system_md'
    ])
    expect(Object.keys(componentRegistry.components).sort()).toEqual([
      'ApprovalActionCard',
      'DraftReplyCard',
      'MemoryApprovalCard',
      'NotionSyncCard',
      'SendApprovalCard',
      'SkillToggleCard',
      'SystemDocApprovalCard'
    ])
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

describe('getAssistantPartComponents — flag gating', () => {
  test('flag-off (default) → byte-identical to Phase 01 (generic fallback only, no by_name)', () => {
    vi.stubEnv('MAILAGENT_A2UI_TOOL_CARDS', '')
    const parts = getAssistantPartComponents()
    expect(parts).toBe(assistantPartComponents)
    expect(parts.tools).toEqual({ Fallback: ToolTraceCard })
    expect('by_name' in parts.tools).toBe(false)
  })

  test('flag-on → adds the registry cards as tools.by_name, keeps ToolTraceCard fallback', () => {
    vi.stubEnv('MAILAGENT_A2UI_TOOL_CARDS', '1')
    const parts = getAssistantPartComponents()
    const tools = parts.tools as { by_name?: Record<string, unknown>; Fallback?: unknown }
    expect(tools.Fallback).toBe(ToolTraceCard) // registry miss still renders the generic card
    expect(tools.by_name).toBe(componentRegistry.byName)
    expect(Object.keys(tools.by_name ?? {})).toContain('email_draft_reply')
  })
})
