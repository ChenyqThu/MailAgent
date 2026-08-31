// @vitest-environment happy-dom
//
// P4a agent-config lane — 画像 / 治理配置页的 fire_hour 写回格式闸（变异验证 ① 的落点）：
// 「每日运行时刻」并进排程编辑器的只是 **UI**，写回必须仍是 trigger_json 字面字段
// {fire_hour, daily_limit, use_kos} / {fire_hour, use_kos}（profile_config.py 行内热读
// 这个形状）。把写回改成 schedule envelope（带 kind/rule 键）→ toEqual 严格比对必红。
// 🔴 整列覆写：只动时刻，daily_limit / use_kos 也必须原样一起写回。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(
      () => false
    ) as unknown as typeof Element.prototype.hasPointerCapture
  }
})

const { mockSave } = vi.hoisted(() => ({ mockSave: vi.fn() }))
mockSave.mockResolvedValue({})

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useKosAvailable: () => false,
  useRunNow: () => ({ run: vi.fn(), isRunning: false })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6'],
  resolveApiBaseUrl: () => 'http://127.0.0.1:0/api',
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

// 治理页的追加段 / 组织框架来自 contacts hooks —— 打桩成已就绪的空文档。
const { mockSavePrompt, mockSaveOrgFrame } = vi.hoisted(() => ({
  mockSavePrompt: vi.fn(),
  mockSaveOrgFrame: vi.fn()
}))
mockSavePrompt.mockResolvedValue(undefined)
mockSaveOrgFrame.mockResolvedValue(undefined)

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactAgentPrompt: () => ({
    data: { content: '', defaultContent: 'DEFAULT PROMPT' },
    isError: false,
    isPending: false
  }),
  useSaveContactAgentPrompt: () => ({ mutateAsync: mockSavePrompt, isPending: false }),
  useContactOrgFrame: () => ({ data: '', isError: false, isPending: false }),
  useSaveContactOrgFrame: () => ({ mutateAsync: mockSaveOrgFrame, isPending: false })
}))

import i18n from '@shared/i18n'
import { ContactProfileSettings } from '../../src/shared/components/agents/settings/ContactProfileSettings'
import { ContactGovernanceSettings } from '../../src/shared/components/agents/settings/ContactGovernanceSettings'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function makeCfg(over: Partial<ReportAgentConfig>): ReportAgentConfig {
  return {
    id: 'contact_profile_agent',
    type: 'contact_profile',
    enabled: true,
    title: '联系人画像',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: 24,
    prompt: '',
    prompt_is_default: true,
    model: '',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    mark_read_after_processing: true,
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

afterEach(() => {
  cleanup()
  mockSave.mockClear()
})

describe('ContactProfileSettings fire_hour 写回（变异 ①）', () => {
  test('改时刻保存 → patch.trigger 恒等于字面 {fire_hour, daily_limit, use_kos}，无 envelope 键', () => {
    render(
      createElement(ContactProfileSettings, {
        cfg: makeCfg({
          trigger: { fire_hour: 4, daily_limit: 50, use_kos: true } as never
        })
      }),
      { wrapper: makeQcWrapper() }
    )
    fireEvent.change(screen.getByLabelText('每日运行时刻'), { target: { value: '6' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledTimes(1)
    const [agentId, patch] = mockSave.mock.calls[0]
    expect(agentId).toBe('contact_profile_agent')
    // 🔴 toEqual 严格比对：写成 schedule envelope（多出 kind/rule/timezone 键）必红；
    // 只发 fire_hour 丢掉 daily_limit/use_kos（整列覆写被打破）也必红。
    expect(patch.trigger).toEqual({ fire_hour: 6, daily_limit: 50, use_kos: true })
  })

  test('未触碰排程 → patch 不带 trigger 键（不整列覆写别人的值）', () => {
    render(
      createElement(ContactProfileSettings, {
        cfg: makeCfg({ trigger: { fire_hour: 4, daily_limit: 50, use_kos: true } as never })
      }),
      { wrapper: makeQcWrapper() }
    )
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1]).not.toHaveProperty('trigger')
  })
})

describe('ContactGovernanceSettings fire_hour 写回（变异 ①，治理形状无 daily_limit）', () => {
  test('改时刻保存 → patch.trigger 恒等于字面 {fire_hour, use_kos}', () => {
    render(
      createElement(ContactGovernanceSettings, {
        cfg: makeCfg({
          id: 'contact_governance_agent',
          type: 'contact_governance',
          title: '通讯录治理',
          trigger: { fire_hour: 4, use_kos: false } as never
        })
      }),
      { wrapper: makeQcWrapper() }
    )
    fireEvent.change(screen.getByLabelText('每日运行时刻'), { target: { value: '22' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledTimes(1)
    const [agentId, patch] = mockSave.mock.calls[0]
    expect(agentId).toBe('contact_governance_agent')
    expect(patch.trigger).toEqual({ fire_hour: 22, use_kos: false })
  })
})
