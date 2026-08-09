// @vitest-environment happy-dom

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReportAgentConfig } from '@shared/api/types'
import type { ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import i18n from '@shared/i18n'
import { buildAgentMentionItems, parseComposerMentionIds } from '@shared/components/agents/agentMention'

const hookState = vi.hoisted(() => ({
  agents: [] as ReportAgentConfig[],
  customAgentsEnabled: true,
  customAgentCallEnabled: true
}))

vi.mock('@shared/components/agents/hooks', () => ({
  useReportConfig: () => ({ agents: hookState.agents, isLoading: false }),
  useCustomAgentsEnabled: () => hookState.customAgentsEnabled,
  useCustomAgentCallEnabled: () => hookState.customAgentCallEnabled
}))

import { useAgentMentionAdapter } from '@shared/components/agents/useAgentMentionAdapter'

function makeAgent(overrides: Partial<ReportAgentConfig>): ReportAgentConfig {
  return {
    id: 'custom-default-12345678',
    type: 'custom',
    enabled: true,
    title: 'Default Agent',
    description: null,
    schedule: { kind: 'manual' },
    window_hours: null,
    prompt: '',
    prompt_is_default: false,
    model: '',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    ...overrides
  } as ReportAgentConfig
}

function controls(overrides: Partial<ChatComposerControls> = {}): ChatComposerControls {
  return {
    model: null,
    availableModels: [],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    agentMentions: [],
    onAddAgentMention: vi.fn(),
    onRemoveAgentMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn(),
    ...overrides
  }
}

beforeAll(async () => {
  await i18n.changeLanguage('en-US')
})

beforeEach(() => {
  hookState.agents = []
  hookState.customAgentsEnabled = true
  hookState.customAgentCallEnabled = true
})

describe('agent mention adapter filtering', () => {
  test('keeps only enabled custom agents and maps the directive identity', () => {
    const items = buildAgentMentionItems([
      makeAgent({ id: 'custom-enabled-12345678', title: 'Enabled' }),
      makeAgent({ id: 'custom-disabled-12345678', title: 'Disabled', enabled: false }),
      makeAgent({ id: 'report-daily', title: 'Report', type: 'report' })
    ])
    expect(items.map((item) => item.id)).toEqual(['agent-custom-enabled-12345678'])
    expect(items[0]).toMatchObject({ type: 'agent', label: 'Enabled' })
  })

  test('hook exposes only eligible agents and records the selected config', () => {
    const selected = vi.fn()
    hookState.agents = [
      makeAgent({ id: 'custom-enabled-12345678', title: 'Enabled' }),
      makeAgent({ id: 'custom-disabled-12345678', enabled: false }),
      makeAgent({ id: 'report-daily', type: 'report' })
    ]
    const { result } = renderHook(() =>
      useAgentMentionAdapter(controls({ onAddAgentMention: selected }))
    )
    const items = result.current.adapter.categoryItems('agent')
    expect(items.map((item) => item.id)).toEqual(['agent-custom-enabled-12345678'])
    result.current.onInserted(items[0]!)
    expect(selected).toHaveBeenCalledWith(hookState.agents[0])
  })

  test('hook hides the Agent category when custom_agent_call is off', () => {
    hookState.agents = [makeAgent({})]
    hookState.customAgentCallEnabled = false
    const { result } = renderHook(() => useAgentMentionAdapter(controls()))
    expect(result.current.adapter.categories()).toEqual([])
  })
})

describe('agent mention chip reconciliation parser', () => {
  test('tracks numeric email ids and string custom-agent ids independently', () => {
    const ids = parseComposerMentionIds(
      ':email[Subject]{name=email-42} and :agent[Ops]{name=agent-custom-ops-a1b2c3d4}'
    )
    expect([...ids.emailIds]).toEqual([42])
    expect([...ids.agentIds]).toEqual(['custom-ops-a1b2c3d4'])
  })
})
