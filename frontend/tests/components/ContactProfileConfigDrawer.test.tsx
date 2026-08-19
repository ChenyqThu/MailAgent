// @vitest-environment happy-dom
//
// WP6 —— 联系人画像配置抽屉。重点锁**排程的 round-trip**：
// `{fire_hour, daily_limit}` 存在 trigger_json 里，读回来要回填到同两个输入框。
// 这条闸的由来：`wire.resolve_agent` 起初不投影 contact_profile 的 trigger（`_projects_trigger`
// 只含 custom / project_progress），于是「存得进读不回」—— 抽屉保存 6 点，重开又显示 4 点，
// 真值却是 6。后端补投影后由这条测试守住，别再退回去。
// 另外锁：trigger_json 是**整列覆写**，所以两个字段必须一起发；未触碰排程时不发 trigger。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const mockSave = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false })
}))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] })
}))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))
vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

import i18n from '@shared/i18n'
import type { ReportAgentConfig } from '@shared/api/types'
import { ContactProfileConfigDrawer } from '../../src/shared/components/agents/drawers/ContactProfileConfigDrawer'

await i18n.changeLanguage('zh-CN')

function makeCfg(overrides: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id: 'contact_profile_agent',
    type: 'contact_profile',
    enabled: false,
    title: '联系人画像',
    schedule: { cadence: 'daily', hours: [4] },
    window_hours: null,
    prompt: '',
    prompt_is_default: true,
    model: '',
    tools_json: [],
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    mark_read_after_processing: true,
    trigger: { fire_hour: 4, daily_limit: 50 },
    updated_at: null,
    ...overrides
  } as ReportAgentConfig
}

function renderDrawer(cfg: ReportAgentConfig | null, masterEnabled = true): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ContactProfileConfigDrawer cfg={cfg} open masterEnabled={masterEnabled} onClose={() => {}} />
    </QueryClientProvider>
  )
}

function hourInput(): HTMLInputElement {
  return screen.getByLabelText('每日运行时刻（0–23 点）') as HTMLInputElement
}
function capInput(): HTMLInputElement {
  return screen.getByLabelText('每轮人数上限') as HTMLInputElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContactProfileConfigDrawer · 排程 round-trip', () => {
  // 🔴 存得进读不回的回归闸：非缺省值必须回填出来，而不是显示 4/50。
  test('回填读 trigger_json 的真实值，不是缺省 4/50', () => {
    renderDrawer(makeCfg({ trigger: { fire_hour: 6, daily_limit: 120 } as never }))

    expect(hourInput().value).toBe('6')
    expect(capInput().value).toBe('120')
  })

  test('trigger 缺失（老行 / 未投影）时回落到与 profile_config.py 同值的缺省 4 / 50', () => {
    renderDrawer(makeCfg({ trigger: null }))

    expect(hourInput().value).toBe('4')
    expect(capInput().value).toBe('50')
  })

  test('trigger 里字段缺失或越界时同样回落缺省（不把 25 点写进界面）', () => {
    renderDrawer(makeCfg({ trigger: { fire_hour: 25 } as never }))

    expect(hourInput().value).toBe('4')
    expect(capInput().value).toBe('50')
  })

  // 🔴 trigger_json 是整列覆写不是 merge：只改时刻也必须把上限一起发，否则上限被抹回缺省。
  test('只改时刻，保存时两个字段一起发', async () => {
    renderDrawer(makeCfg({ trigger: { fire_hour: 6, daily_limit: 120 } as never }))

    fireEvent.change(hourInput(), { target: { value: '9' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0]![0]).toBe('contact_profile_agent')
    expect(mockSave.mock.calls[0]![1].trigger).toEqual({ fire_hour: 9, daily_limit: 120 })
  })

  test('没碰排程时 patch 不带 trigger（PATCH 缺席 = 不动列）', async () => {
    renderDrawer(makeCfg({ trigger: { fire_hour: 6, daily_limit: 120 } as never }))

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0]![1]).not.toHaveProperty('trigger')
  })

  test('越界的时刻拒绝保存并给出反馈', async () => {
    renderDrawer(makeCfg())

    fireEvent.change(hourInput(), { target: { value: '24' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(screen.getByText(/每日运行时刻要是 0 到 23 之间的整数/)).toBeTruthy())
    expect(mockSave).not.toHaveBeenCalled()
  })

  test('上限为 0 时拒绝保存（0 = 永不处理，是死配置）', async () => {
    renderDrawer(makeCfg())

    fireEvent.change(capInput(), { target: { value: '0' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(screen.getByText(/每轮人数上限要是大于 0 的整数/)).toBeTruthy())
    expect(mockSave).not.toHaveBeenCalled()
  })
})

describe('ContactProfileConfigDrawer · 启用与总闸', () => {
  test('总闸未开时给出「去 Labs 开」的说明，但启用开关照常可存', async () => {
    renderDrawer(makeCfg(), false)

    expect(screen.getByText(/MAILAGENT_CONTACT_PROFILE_ENABLED/)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: '启用画像 Agent' }))
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0]![1].enabled).toBe(true)
  })

  test('总闸已开时说明换成 on 的那句', () => {
    renderDrawer(makeCfg(), true)

    expect(screen.getByText(/总开关已开/)).toBeTruthy()
  })

  // prompt_is_default 的行不该把「后端回填的默认」当成自定义存回去。
  test('未触碰提示词且行是默认时，patch 不带 prompt', async () => {
    renderDrawer(makeCfg({ prompt: '（后端回填的报告默认）', prompt_is_default: true }))

    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0]![1]).not.toHaveProperty('prompt')
  })

  test('改过提示词就带上追加段', async () => {
    renderDrawer(makeCfg())

    fireEvent.change(screen.getByPlaceholderText(/多留意对方在合同条款上的口径变化/), {
      target: { value: '多留意排期口径' }
    })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0]![1].prompt).toBe('多留意排期口径')
  })
})
