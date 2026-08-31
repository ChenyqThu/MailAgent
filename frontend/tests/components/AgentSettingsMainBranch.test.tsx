// @vitest-environment happy-dom
//
// P4a agent-config lane — AgentSettingsView 的主 Agent 分支闸（变异验证 ④ 的落点）：
// 主 Agent 不是 report_agent 的一行（r8 §B.1 唯一例外），保存必须走
// chat.setAssistantIdentity（agent_config profile），**绝不**发 PUT /api/report-agents
// （= useSetConfig().save）。把主分支改成走 report patch 通道 → 两条断言都红。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const { mockSave, mockSetIdentity, STABLE_TOOL_OPTIONS } = vi.hoisted(() => ({
  mockSave: vi.fn(),
  mockSetIdentity: vi.fn(),
  STABLE_TOOL_OPTIONS: { tools: [], defaults: [] }
}))
mockSave.mockResolvedValue({})
mockSetIdentity.mockResolvedValue({ name: '小助', avatar: null })

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useCreateAgent: () => ({ create: vi.fn(), isCreating: false }),
  useDeleteAgent: () => ({ remove: vi.fn(), isDeleting: false }),
  useRunNow: () => ({ run: vi.fn(), isRunning: false }),
  useKosAvailable: () => false,
  useToolOptions: () => ({ options: STABLE_TOOL_OPTIONS, isLoading: false }),
  useOpennessFlags: () => ({}),
  useConnectorOptions: () => [],
  useTriggerV2Enabled: () => false,
  useCalendarTriggerEnabled: () => false,
  useAgentPluginsEnabled: () => false,
  useProjectProgressRuns: () => ({ runs: [], isLoading: false })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { setAssistantIdentity: mockSetIdentity } })
}))

vi.mock('@shared/assistant/assistantIdentity', () => ({
  useAssistantIdentity: () => ({ name: '小助', avatar: null }),
  primeAssistantIdentity: vi.fn()
}))

// 身份文档编辑器是 设置 → AI 的同一个组件（自带数据依赖），这里打桩。
vi.mock('@shared/components/settings/CustomAiSection', () => ({
  StandingDocsSection: () => null
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6'],
  resolveApiBaseUrl: () => 'http://127.0.0.1:0/api',
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

import i18n from '@shared/i18n'
import { AgentSettingsView } from '../../src/shared/components/agents/settings/AgentSettingsView'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

afterEach(() => {
  cleanup()
  mockSave.mockClear()
  mockSetIdentity.mockClear()
})

describe('AgentSettingsView 主 Agent 分支（变异 ④）', () => {
  test('member={kind:main} → 渲染主 Agent 配置页（身份区在场，无启用开关）', () => {
    render(createElement(AgentSettingsView, { member: { kind: 'main' } }), {
      wrapper: makeQcWrapper()
    })
    // 名字回显当前生效名；主 Agent 没有「停用」这回事 → 页头无启用开关。
    expect(screen.getByDisplayValue('小助')).toBeTruthy()
    expect(screen.queryByRole('switch', { name: '启用' })).toBeNull()
  })

  test('🔴 保存走 chat.setAssistantIdentity，绝不发 report_agent patch', async () => {
    render(createElement(AgentSettingsView, { member: { kind: 'main' } }), {
      wrapper: makeQcWrapper()
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockSetIdentity).toHaveBeenCalledTimes(1))
    // 未编辑名字 → 保持服务端原值（不把默认字面量写死）。
    expect(mockSetIdentity.mock.calls[0][0]).toMatchObject({ name: '小助' })
    expect(mockSave).not.toHaveBeenCalled()
  })

  test('member={kind:agent} 查无此行 → 如实提示，不渲染任何表单', () => {
    render(
      createElement(AgentSettingsView, { member: { kind: 'agent', agentId: 'ghost_agent' } }),
      { wrapper: makeQcWrapper() }
    )
    expect(screen.getByText('没有找到这位成员的配置。')).toBeTruthy()
  })
})
