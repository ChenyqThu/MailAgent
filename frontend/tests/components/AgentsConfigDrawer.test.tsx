// @vitest-environment happy-dom
//
// Bug2 回归 — 报告 Agent 配置 drawer 的调度控件：
//   • weekly  → 出现 weekday 单选（周一~周日），不出现「每月几日」
//   • monthly → 出现「每月几日」下拉（1~28 日）+ 1–28 限制 hint，不出现 weekday
//   • daily   → 两者都不出现（只时点）
// 断言用 getByRole('option') 精确匹配 <select> 选项，避免误中 aggWeekly 说明文字里
// 的「周一~周日」。注意：jsdom/happy-dom 不渲染真实 CSS 布局 —— 视觉（flexWrap /
// select 宽度）需打包后人工确认，这里只锁渲染逻辑。
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: vi.fn().mockResolvedValue({}), isSaving: false }),
  useKosAvailable: () => false,
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useReportList: () => ({ reports: [], isLoading: false }),
  useRunNow: () => ({ run: vi.fn(), isRunning: false })
}))

// useExitAnimation 强制 shouldRender=true：覆盖「退场动画播放中、父组件已把 cfg 置 null」
// 这一真实渲染路径（regression: 此时若 header 读 cfg.title 会空指针崩）。open=true 的
// 既有用例同样 shouldRender=true，不受影响。
vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

// ConfigDrawer 调用 useEnabledModels()（useQuery）→ 需要 QueryClientProvider。
// 这里 mock 整个模块：测试 schedule 控件逻辑不依赖真实模型列表，且避免 jsdom
// 环境缺 serve-api 时 fetch 失败干扰。
const mockEnabledModels = vi.fn(() => ({
  models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  FALLBACK_MODELS: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  useEnabledModels: () => mockEnabledModels(),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

import i18n from '@shared/i18n'
import { ConfigDrawer } from '../../src/shared/components/agents/AgentsTab'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function renderDrawer(ui: React.ReactElement) {
  return render(ui, { wrapper: makeQcWrapper() })
}

function makeCfg(over: Partial<ReportAgentConfig>): ReportAgentConfig {
  return {
    id: 'daily',
    type: 'daily',
    enabled: true,
    title: '日报',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: 24,
    prompt: 'x',
    prompt_is_default: true,
    model: 'claude-opus-4-8',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

afterEach(cleanup)

describe('ConfigDrawer schedule controls (Bug2)', () => {
  test('weekly：出现 weekday 单选（周一~周日），无「每月几日」', () => {
    renderDrawer(
      <ConfigDrawer
        cfg={makeCfg({
          id: 'weekly',
          type: 'weekly',
          schedule: { cadence: 'weekly', hours: [9], weekday: 2 }
        })}
        open
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('option', { name: '周一' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '周三' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '周日' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: '1 日' })).toBeNull()
  })

  test('monthly：出现每月几日下拉（1~28 日）+ hint，无 weekday', () => {
    renderDrawer(
      <ConfigDrawer
        cfg={makeCfg({
          id: 'monthly',
          type: 'monthly',
          schedule: { cadence: 'monthly', hours: [9], day_of_month: 15 }
        })}
        open
        onClose={() => {}}
      />
    )
    expect(screen.getByRole('option', { name: '1 日' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '15 日' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '28 日' })).toBeTruthy()
    expect(screen.getByText(/每月都能触发/)).toBeTruthy()
    expect(screen.queryByRole('option', { name: '周一' })).toBeNull()
  })

  test('daily：weekday / 每月几日 均不出现', () => {
    renderDrawer(<ConfigDrawer cfg={makeCfg({})} open onClose={() => {}} />)
    expect(screen.queryByRole('option', { name: '周一' })).toBeNull()
    expect(screen.queryByRole('option', { name: '1 日' })).toBeNull()
  })

  test('退场期 cfg=null 不崩（regression：header title 改用 state，不读 cfg.title）', () => {
    // shouldRender 被 mock 成恒 true，模拟退场动画播放中、父组件已把 cfg 置 null。
    // 修复前 header 读 cfg.title → null.title 空指针崩；修复后读 title state（中性默认）→ 安全。
    expect(() =>
      renderDrawer(<ConfigDrawer cfg={null} open={false} onClose={() => {}} />)
    ).not.toThrow()
  })
})

describe('ConfigDrawer model list (Phase 4 — dynamic models)', () => {
  // Reset the mock to the default after each test so the persistent
  // mockReturnValue from one test doesn't bleed into the next.
  afterEach(() => {
    mockEnabledModels.mockReset()
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
      rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
    })
  })

  test('渲染启用列表中的所有模型选项', () => {
    mockEnabledModels.mockReturnValue({
      models: ['m1', 'm2'],
      rawEnabled: ['m1', 'm2']
    })
    renderDrawer(<ConfigDrawer cfg={makeCfg({ model: 'm1' })} open onClose={() => {}} />)
    expect(screen.getByText('m1')).toBeTruthy()
    expect(screen.getByText('m2')).toBeTruthy()
  })

  test('启用列表为空时 fallback 到四默认模型', () => {
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
      rawEnabled: []
    })
    renderDrawer(
      <ConfigDrawer cfg={makeCfg({ model: 'claude-sonnet-4-6' })} open onClose={() => {}} />
    )
    expect(screen.getByText('claude-sonnet-4-6')).toBeTruthy()
    expect(screen.getByText('claude-opus-4-8')).toBeTruthy()
    expect(screen.getByText('claude-fable-5')).toBeTruthy()
    expect(screen.getByText('gpt-5.5')).toBeTruthy()
  })

  test('当前模型不在启用列表时追加并显示「（未启用）」', () => {
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8']
    })
    renderDrawer(
      <ConfigDrawer cfg={makeCfg({ model: 'orphan-model-x' })} open onClose={() => {}} />
    )
    expect(screen.getByText('orphan-model-x')).toBeTruthy()
    expect(screen.getByText(/未启用/)).toBeTruthy()
  })
})
