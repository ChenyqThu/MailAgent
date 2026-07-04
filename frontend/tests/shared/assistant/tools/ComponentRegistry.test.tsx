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
import { ToolTraceCard } from '@shared/assistant/tools/generic/ToolTraceCard'

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

  test('byName covers the write/self-mount/exec/skill-supply/custom-agent tools; components covers the card names', () => {
    expect(Object.keys(componentRegistry.byName).sort()).toEqual([
      'custom_agent_create',
      'custom_agent_update',
      'email_archive',
      'email_draft_reply',
      'email_flag',
      'email_pin',
      'email_prepare_send',
      'email_resync',
      'file_read',
      'file_write',
      'run_command',
      'set_skill_enabled',
      'skill_install',
      'skill_install_confirm',
      'skill_uninstall',
      'update_system_md'
    ])
    expect(Object.keys(componentRegistry.components).sort()).toEqual([
      'ApprovalActionCard',
      'CustomAgentApprovalCard',
      'DraftReplyCard',
      'ExecApprovalCard',
      'NotionSyncCard',
      'SendApprovalCard',
      'SkillInstallCard',
      'SkillInstallConfirmCard',
      'SkillToggleCard',
      'SkillUninstallCard',
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

describe('getAssistantPartComponents — S3 always-on rich cards', () => {
  test('returns the registry cards as tools.by_name, keeps ToolTraceCard fallback', () => {
    const parts = getAssistantPartComponents()
    expect(parts).toBe(assistantPartComponents)
    const tools = parts.tools as { by_name?: Record<string, unknown>; Fallback?: unknown }
    expect(tools.Fallback).toBe(ToolTraceCard) // registry miss still renders the generic card
    expect(tools.by_name).toBe(componentRegistry.byName)
    expect(Object.keys(tools.by_name ?? {})).toContain('email_draft_reply')
  })
})
