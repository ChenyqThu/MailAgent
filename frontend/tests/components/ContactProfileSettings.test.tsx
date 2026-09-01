// @vitest-environment happy-dom
//
// P4a agent-config lane — 「联系人画像」配置页。承接 ContactProfileConfigDrawer.test 里
// 随旧抽屉退役、且 AgentSettingsContactSchedule.test 没覆盖到的那几族：
//   • 排程回填：读 trigger_json 的真实值；缺失 / 越界 / 类型不对时回落到与
//     profile_config.py dataclass 同值的缺省 4 / 50 / true（不把 25 点写进界面）。
//   • 🔴 三字段共用一个 scheduleDirty：碰上限或碰 KOS 开关同样触发整列覆写，
//     三个字段一起原样写回，少发一个会把它抹成缺省。
//   • 参考 KOS 四态回显（缺字段 / 整列缺失 / 存过 false / 野值）。
//   • 上限校验：0 = 永不处理，是死配置 → 就地拒绝，一个请求都不发。
//   • 提示词追加段的默认态回传。
//
// 「只改时刻 → 三字段一起发」与「没碰排程 → 不发 trigger」已由
// tests/components/AgentSettingsContactSchedule.test.tsx 钉住（那份是 fire_hour 写回格式
// 的专项闸），这里不重复。
// ⚠️ 旧文件「越界的时刻拒绝保存」**不迁**：时刻输入从 number input 换成了
// DailyHourSchedule 的 0–23 `<select>`，UI 已产不出越界值。
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

import i18n from '@shared/i18n'
import { ContactProfileSettings } from '../../src/shared/components/agents/settings/ContactProfileSettings'
import type { ReportAgentConfig } from '@shared/api/types'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function makeCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
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

function renderSettings(over: Partial<ReportAgentConfig> = {}) {
  return render(createElement(ContactProfileSettings, { cfg: makeCfg(over) }), {
    wrapper: makeQcWrapper()
  })
}
function hourSelect(): HTMLSelectElement {
  return screen.getByLabelText('每日运行时刻') as HTMLSelectElement
}
function capInput(): HTMLInputElement {
  return screen.getByLabelText('每轮人数上限') as HTMLInputElement
}
function kosSwitch(): HTMLElement {
  return screen.getByRole('switch', { name: '参考 KOS 资料' })
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
})

describe('排程回填 — 读真实值，坏值回落缺省', () => {
  test('回填读 trigger_json 的真实值，不是缺省 4 / 50', () => {
    renderSettings({ trigger: { fire_hour: 9, daily_limit: 7, use_kos: true } as never })
    expect(hourSelect().value).toBe('9')
    expect(capInput().value).toBe('7')
  })

  test('trigger 整个缺失（老行 / 未投影）→ 回落到与 profile_config.py 同值的 4 / 50', () => {
    renderSettings()
    expect(hourSelect().value).toBe('4')
    expect(capInput().value).toBe('50')
  })

  test('字段越界或类型不对 → 同样回落缺省（不把 25 点写进界面）', () => {
    renderSettings({ trigger: { fire_hour: 25, daily_limit: 0 } as never })
    expect(hourSelect().value).toBe('4')
    expect(capInput().value).toBe('50')
  })
})

describe('🔴 trigger_json 三字段共用 scheduleDirty', () => {
  test('只改上限 → 时刻与 KOS 原样一起写回', () => {
    renderSettings({ trigger: { fire_hour: 9, daily_limit: 50, use_kos: false } as never })
    fireEvent.change(capInput(), { target: { value: '12' } })
    save()
    expect(lastPatch().trigger).toEqual({ fire_hour: 9, daily_limit: 12, use_kos: false })
  })

  test('只关 KOS 开关 → 同列的时刻与上限原样一起写回', () => {
    renderSettings({ trigger: { fire_hour: 6, daily_limit: 30, use_kos: true } as never })
    fireEvent.click(kosSwitch())
    save()
    expect(mockSave.mock.calls[0][0]).toBe('contact_profile_agent')
    expect(lastPatch().trigger).toEqual({ fire_hour: 6, daily_limit: 30, use_kos: false })
  })
})

describe('参考 KOS — 缺字段默认开', () => {
  test('🔴 trigger 里没有 use_kos（老行）→ 开关显示「开」', () => {
    renderSettings({ trigger: { fire_hour: 4, daily_limit: 50 } as never })
    expect(kosSwitch().getAttribute('aria-checked')).toBe('true')
  })

  test('trigger 整个缺失（未投影）→ 同样显示「开」', () => {
    renderSettings()
    expect(kosSwitch().getAttribute('aria-checked')).toBe('true')
  })

  test('存过 false → 如实回显「关」（证明上面两条不是因为恒真）', () => {
    renderSettings({ trigger: { fire_hour: 4, daily_limit: 50, use_kos: false } as never })
    expect(kosSwitch().getAttribute('aria-checked')).toBe('false')
  })

  test('野值（不是 boolean）→ 回落到开，不把字符串当真值', () => {
    renderSettings({ trigger: { fire_hour: 4, daily_limit: 50, use_kos: 'no' } as never })
    expect(kosSwitch().getAttribute('aria-checked')).toBe('true')
  })
})

describe('上限校验', () => {
  test('上限为 0 → 就地拒绝（0 = 永不处理，是死配置），一个请求都不发', () => {
    renderSettings({ trigger: { fire_hour: 4, daily_limit: 50, use_kos: true } as never })
    fireEvent.change(capInput(), { target: { value: '0' } })
    save()
    expect(screen.getByText('每轮人数上限要是大于 0 的整数')).toBeTruthy()
    expect(mockSave).not.toHaveBeenCalled()
  })

  test('没碰排程时不校验（上限守卫只在整列覆写路径上）', () => {
    renderSettings({ trigger: { fire_hour: 4, daily_limit: 50, use_kos: true } as never })
    save()
    expect(mockSave).toHaveBeenCalledTimes(1)
    expect(mockSave.mock.calls[0][1]).not.toHaveProperty('trigger')
  })
})

describe('启用与提示词追加段', () => {
  test('关启用 → patch.enabled=false；未触碰提示词且行是默认 → patch 不带 prompt', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: '启用此 Agent' }))
    save()
    const patch = lastPatch()
    expect(patch.enabled).toBe(false)
    expect(patch).not.toHaveProperty('prompt')
  })

  test('改过提示词 → 带上追加段', () => {
    renderSettings()
    fireEvent.change(screen.getByPlaceholderText('例如：多留意对方在合同条款上的口径变化。'), {
      target: { value: '多留意口径变化' }
    })
    save()
    expect(lastPatch().prompt).toBe('多留意口径变化')
  })

  test('行已自定义 + 未改 → 原样回传（不被抹回默认）', () => {
    renderSettings({ prompt: '已有的追加段', prompt_is_default: false })
    save()
    expect(lastPatch().prompt).toBe('已有的追加段')
  })
})
