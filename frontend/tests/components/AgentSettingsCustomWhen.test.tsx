// @vitest-environment happy-dom
//
// P4a agent-config lane — 自定义 Agent「什么时候动」三档（design §8.3）：
//   • trigger null 的行 → 默认落第一档「不定时 · 你找它才动」，排程编辑器整段收起、
//     页头「试运行一次」不出现（变异验证 ② 的落点：把收起条件改坏必红）。
//   • 第一档保存 → patch.trigger === null（🔴 'none' → null 的存储语义闸）。
//   • 切「按时间」→ 排程编辑器与「试运行一次」出现；保存 → 结构化 schedule trigger。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

// Radix Select 在 happy-dom 下缺这些 DOM 原语，逐个补上。
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = vi.fn(
      () => false
    ) as unknown as typeof Element.prototype.hasPointerCapture
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture =
      vi.fn() as unknown as typeof Element.prototype.setPointerCapture
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      vi.fn() as unknown as typeof Element.prototype.releasePointerCapture
  }
})

const { mockSave, mockRun, STABLE_TOOL_OPTIONS } = vi.hoisted(() => ({
  mockSave: vi.fn(),
  mockRun: vi.fn(),
  // 🔴 真 hook 承诺 defaults 是稳定单例（hooks.ts EMPTY_TOOL_OPTIONS 注释）：每渲染换新
  // 数组引用会让「defaults 初始化」effect 无限 setState。mock 必须遵守同一契约。
  STABLE_TOOL_OPTIONS: { tools: [], defaults: [] }
}))
mockSave.mockResolvedValue({})
mockRun.mockResolvedValue({})

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useCreateAgent: () => ({ create: vi.fn(), isCreating: false }),
  useDeleteAgent: () => ({ remove: vi.fn(), isDeleting: false }),
  useRunNow: () => ({ run: mockRun, isRunning: false }),
  useToolOptions: () => ({ options: STABLE_TOOL_OPTIONS, isLoading: false }),
  useOpennessFlags: () => ({}),
  useConnectorOptions: () => [],
  // v1 语义（trigger 单条）足够钉住三档 ↔ null 的映射；v2 envelope 的入库形状另有后端深校验。
  useTriggerV2Enabled: () => false,
  useCalendarTriggerEnabled: () => false,
  useAgentPluginsEnabled: () => false,
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useKosAvailable: () => false
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6'],
  resolveApiBaseUrl: () => 'http://127.0.0.1:0/api',
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

// 能力卡与自动化策略是独立测试面（customAgentCapabilities.test.ts 等），这里打桩免重。
vi.mock('../../src/shared/components/agents/custom-agent/CapabilityCards', () => ({
  CapabilityCards: () => null
}))
vi.mock('../../src/shared/components/agents/custom-agent/AutomationPolicySection', () => ({
  AutomationPolicySection: () => null
}))

import i18n from '@shared/i18n'
import { CustomAgentSettings } from '../../src/shared/components/agents/settings/CustomAgentSettings'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function makeCfg(over: Partial<ReportAgentConfig>): ReportAgentConfig {
  return {
    id: 'my_custom',
    type: 'custom',
    enabled: true,
    title: '盯 Figma 邮件',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: 24,
    prompt: 'watch',
    prompt_is_default: false,
    model: 'claude-sonnet-4-6',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    mark_read_after_processing: true,
    trigger: null,
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

afterEach(() => {
  cleanup()
  mockSave.mockClear()
})

describe('CustomAgentSettings「什么时候动」三档（变异 ②）', () => {
  test('trigger null → 默认第一档：编辑器收起 + 页头无「试运行一次」', () => {
    render(createElement(CustomAgentSettings, { cfg: makeCfg({}) }), { wrapper: makeQcWrapper() })
    expect(
      screen.getByRole('button', { name: '不定时 · 你找它才动' }).getAttribute('aria-pressed')
    ).toBe('true')
    expect(screen.getByTestId('when-manual-hint')).toBeTruthy()
    // 收起 = 排程编辑器整段不渲染（不是藏在 display:none 里）。
    expect(screen.queryByTestId('schedule-sentence')).toBeNull()
    expect(screen.queryByRole('button', { name: '试运行一次' })).toBeNull()
  })

  test('🔴 第一档保存 → patch.trigger === null（存储语义不动）', () => {
    render(createElement(CustomAgentSettings, { cfg: makeCfg({}) }), { wrapper: makeQcWrapper() })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1].trigger).toBeNull()
  })

  test('切「按时间」→ 排程编辑器与「试运行一次」出现；保存产出结构化 schedule trigger', () => {
    render(createElement(CustomAgentSettings, { cfg: makeCfg({}) }), { wrapper: makeQcWrapper() })
    fireEvent.click(screen.getByRole('button', { name: '按时间' }))
    expect(screen.getByTestId('schedule-sentence')).toBeTruthy()
    expect(screen.getByRole('button', { name: '试运行一次' })).toBeTruthy()
    expect(screen.queryByTestId('when-manual-hint')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1].trigger).toMatchObject({ v: 1, kind: 'schedule' })
  })

  test('既有 schedule 行 → 落「按时间」档且编辑器带出既有规则', () => {
    render(
      createElement(CustomAgentSettings, {
        cfg: makeCfg({
          trigger: {
            v: 1,
            kind: 'schedule',
            rule: {
              freq: 'weekly',
              interval: 1,
              weekdays: [1, 3],
              monthMode: 'date',
              monthDay: 1,
              ordinal: 1,
              weekday: 1,
              clamp: false,
              hour: 9,
              minute: 0
            },
            timezone: 'UTC',
            anchor: '2026-01-05'
          } as never
        })
      }),
      { wrapper: makeQcWrapper() }
    )
    expect(screen.getByRole('button', { name: '按时间' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('schedule-sentence')).toBeTruthy()
  })
})
