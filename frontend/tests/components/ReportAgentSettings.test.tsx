// @vitest-environment happy-dom
//
// P4a agent-config lane — 报告 Agent（日/周/月同引擎）配置页。承接 AgentsConfigDrawer.test
// 里随旧抽屉退役的保存语义断言：
//   • prompt 默认态回传（未改 + prompt_is_default → null，保持「用默认」）
//   • 头像未触碰不发 avatar 键
//   • cadence 被 lockFreq 锁死（cadence 在报告侧是**内容种类**，被排程编辑改掉 = 周报
//     静默退化成日报）
//   • 空时区写实成宿主机 IANA（留空会让 natural_day 边界退化成 UTC）
//   • 非 daily 不带 trigger_mode / body_full_priorities / timezone
// 骨架层再钉一条：SectionMap 没声明的区整段不渲染（报告不可删 → 无「删掉它」）。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

const { mockSave, mockRun } = vi.hoisted(() => ({ mockSave: vi.fn(), mockRun: vi.fn() }))
mockSave.mockResolvedValue({})
mockRun.mockResolvedValue({})

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useRunNow: () => ({ run: mockRun, isRunning: false }),
  useKosAvailable: () => false,
  useReportConfig: () => ({ agents: [], isLoading: false })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6'],
  resolveApiBaseUrl: () => 'http://127.0.0.1:0/api',
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

import i18n from '@shared/i18n'
import { ReportAgentSettings } from '../../src/shared/components/agents/settings/ReportAgentSettings'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function makeCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id: 'daily_email_digest',
    type: 'report',
    enabled: true,
    title: '邮件日报',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: 24,
    prompt: '',
    prompt_is_default: true,
    model: 'claude-sonnet-4-6',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    context_docs: [],
    mark_read_after_processing: true,
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

function renderSettings(over: Partial<ReportAgentConfig> = {}) {
  return render(createElement(ReportAgentSettings, { cfg: makeCfg(over) }), {
    wrapper: makeQcWrapper()
  })
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
}
function lastPatch(): Record<string, unknown> {
  expect(mockSave).toHaveBeenCalledTimes(1)
  return mockSave.mock.calls[0][1] as Record<string, unknown>
}

afterEach(() => {
  cleanup()
  mockSave.mockClear()
  mockRun.mockClear()
})

describe('保存语义 — prompt 默认态与头像 dirty', () => {
  test('未改 prompt + prompt_is_default → patch.prompt === null，且不带 avatar 键', () => {
    renderSettings()
    save()
    const patch = lastPatch()
    expect(mockSave.mock.calls[0][0]).toBe('daily_email_digest')
    expect(patch.prompt).toBeNull()
    // 头像未触碰 → 不发 avatar（发了会把「按 id 稳定派生」物化成显式身份）。
    expect(patch).not.toHaveProperty('avatar')
  })

  test('未改 prompt 但行已自定义 → 原样回传 cfg.prompt（不被 null 抹回默认）', () => {
    renderSettings({ prompt: '按项目分组写', prompt_is_default: false })
    save()
    expect(lastPatch().prompt).toBe('按项目分组写')
  })

  test('改过 prompt → 回传文本', () => {
    renderSettings()
    fireEvent.change(
      screen.getByPlaceholderText(
        '留空 = 用内置默认幕僚 persona（按日 / 周 / 月自动套用）；在此输入可完全覆写'
      ),
      { target: { value: '只写待我拍板的' } }
    )
    save()
    expect(lastPatch().prompt).toBe('只写待我拍板的')
  })

  // 承接 AgentsConfigDrawer.test 的 avatar 正路径（上面那条只钉住 dirty-gate 的否定面，
  // 光有否定面时把 `if (avatarDirty)` 整段删掉两条都还是绿的）。
  test('头像编辑器默认折叠；展开选形状 → patch 携带 avatar', () => {
    renderSettings()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('cloudee'))
    save()
    expect(lastPatch().avatar).toMatchObject({ type: 'bot', shape: 'cloudee' })
  })
})

describe('排程 — cadence 锁死 + 空时区写实', () => {
  test('周报：频率段不渲染（lockFreq），改时刻后 cadence 仍是 weekly', () => {
    renderSettings({ schedule: { cadence: 'weekly', hours: [9], weekday: 0 } as never })
    // 锁死 = 频率那一行整段不渲染（不是渲染成 disabled）。
    expect(screen.queryByRole('group', { name: '重复' })).toBeNull()
    fireEvent.change(screen.getByLabelText('小时'), { target: { value: '7' } })
    save()
    const schedule = lastPatch().schedule as Record<string, unknown>
    expect(schedule.cadence).toBe('weekly')
    expect(schedule.hours).toEqual([7])
    expect((schedule.rule as { freq: string; hour: number }).freq).toBe('weekly')
    expect((schedule.rule as { freq: string; hour: number }).hour).toBe(7)
  })

  test('周报：不带 daily 专属三字段（触发口径 / 带正文优先级 / 时区）', () => {
    renderSettings({ schedule: { cadence: 'weekly', hours: [9], weekday: 0 } as never })
    save()
    const patch = lastPatch()
    expect(patch).not.toHaveProperty('trigger_mode')
    expect(patch).not.toHaveProperty('body_full_priorities')
    expect(patch).not.toHaveProperty('timezone')
    // 周月报走层级聚合 → 「它自己的设置」区是只读的数据来源卡，不是优先级 chip。
    expect(screen.getByText('周报自动综合过去 7 天已生成的日报；缺失的天会标注。')).toBeTruthy()
  })

  test('日报 + 自然日：空 cfg.timezone 写实成宿主机 IANA（不留空）', () => {
    renderSettings({ timezone: '' })
    fireEvent.click(screen.getByRole('button', { name: '自然日（昨天）' }))
    save()
    const patch = lastPatch()
    expect(patch.trigger_mode).toBe('natural_day')
    // 独立算一遍宿主机时区：留空（''）或退化成 'UTC' 都会红。
    expect(patch.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(patch.timezone).not.toBe('')
  })

  test('日报 + 回溯 24h：时区不写（这个口径下时区没有意义）', () => {
    renderSettings({ timezone: '' })
    save()
    expect(lastPatch().timezone).toBe('')
  })
})

describe('指令区 — 行级身份文档勾选', () => {
  test('勾选文档 → patch.context_docs 带上它；再点一次取消', () => {
    renderSettings({ context_docs: [] })
    fireEvent.click(screen.getByRole('button', { name: '灵魂 / soul' }))
    fireEvent.click(screen.getByRole('button', { name: '用户偏好 / user' }))
    save()
    expect(lastPatch().context_docs).toEqual(['soul', 'user'])
  })

  test('已勾的行回显为选中态（aria-pressed）', () => {
    renderSettings({ context_docs: ['rules'] })
    expect(screen.getByRole('button', { name: '规则 / rules' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    expect(screen.getByRole('button', { name: '灵魂 / soul' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
  })
})

describe('骨架 — 声明了才渲染', () => {
  test('分区按固定顺序渲染；报告没有「删掉它」区', () => {
    const { container } = renderSettings()
    const labels = Array.from(container.querySelectorAll('section')).map((el) =>
      el.getAttribute('aria-label')
    )
    expect(labels).toEqual(['身份', '指令', '模型', '什么时候动', '能碰什么', '它自己的设置'])
  })

  test('页头「试运行一次」打到这一行的 id', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: '试运行一次' }))
    expect(mockRun).toHaveBeenCalledWith('daily_email_digest')
  })
})
