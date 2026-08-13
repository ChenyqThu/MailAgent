// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const mockSave = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false })
}))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'] })
}))
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    prompts: {
      read: vi.fn().mockResolvedValue({ content: '', path: '' }),
      write: vi.fn().mockResolvedValue({ ok: true })
    }
  })
}))
vi.mock('@shared/state/env', () => ({
  applyEnvPatch: vi.fn(),
  useEnvStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ state: { status: 'ready', snapshot: { values: { LLM_AGENT_ENABLED: 'true' } } } }),
    { getState: () => ({ state: { status: 'ready', snapshot: { values: {} } } }) }
  )
}))
vi.mock('@shared/state/restart', () => ({
  useRestartStore: () => vi.fn()
}))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))
vi.mock('@shared/components/settings/CustomAiSection', () => ({
  StandingDocsSection: () => null
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn()
}))

import i18n from '@shared/i18n'
import type { ReportAgentConfig } from '@shared/api/types'
import { PreprocessConfigDrawer } from '../../src/shared/components/agents/drawers/PreprocessConfigDrawer'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

function makeCfg(): ReportAgentConfig {
  return {
    id: 'email_preprocess_agent',
    type: 'preprocess',
    enabled: true,
    title: 'AI 邮件预处理',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: '',
    prompt_is_default: true,
    model: '',
    tools_json: [],
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    context_docs: ['soul', 'user'],
    fallback_models: null,
    mark_read_after_processing: true,
    context_source: 'standing_docs',
    updated_at: null
  }
}

function renderDrawer(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <PreprocessConfigDrawer cfg={makeCfg()} open onClose={() => {}} />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('PreprocessConfigDrawer mark-read toggle', () => {
  test('默认开启，关闭保存后写入行级 false', async () => {
    renderDrawer()
    const markReadToggle = screen.getByRole('switch', {
      name: '预处理完成后自动标已读'
    })
    expect(markReadToggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(markReadToggle)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith(
        'email_preprocess_agent',
        expect.objectContaining({ mark_read_after_processing: false })
      )
    })
  })

  test('中英文文案 key 齐全', () => {
    expect(zhCommon.agents.preprocess.markReadAfterProcessing).toBe('预处理完成后自动标已读')
    expect(enCommon.agents.preprocess.markReadAfterProcessing).toBe(
      'Mark as read after preprocessing'
    )
  })
})

describe('PreprocessConfigDrawer 参考上下文源（task 07-22 行存储）', () => {
  test('切换到 Notion 上下文页 → 保存走行 PATCH context_source，不写 env（无重启）', async () => {
    const { applyEnvPatch } = await import('@shared/state/env')
    renderDrawer()
    // 切到 notion_context radio（行级，非 env）。
    fireEvent.click(screen.getByRole('button', { name: 'Notion 上下文页' }))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith(
        'email_preprocess_agent',
        expect.objectContaining({ context_source: 'notion_context' })
      )
    })
    // 参考上下文源不再写 env → 无 env patch（用户未改 enable / page id）→ 不触发重启横幅。
    expect(applyEnvPatch).not.toHaveBeenCalled()
  })

  test('未触碰源 → 保存 patch 不含 context_source（dirty-gate，行权威不被 stale 覆写）', async () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    const patch = mockSave.mock.calls[0][1] as Record<string, unknown>
    expect(patch).not.toHaveProperty('context_source')
  })

  test('中英文文案 key 齐全（源提示注明保存即生效）', () => {
    expect(zhCommon.agents.preprocess.contextSourceHint).toContain('保存即生效')
    expect(enCommon.agents.preprocess.contextSourceHint).toContain('no restart')
  })
})

// 0804 dogfood 3d —— 预设单例行也有头像入口（名称仍不可编辑，patch 只带 avatar）。
describe('PreprocessConfigDrawer 头像身份（0804 dogfood 3d）', () => {
  test('默认折叠；展开选形状后保存 → patch 携带 avatar', async () => {
    renderDrawer()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('kirby'))
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(mockSave).toHaveBeenCalledWith(
        'email_preprocess_agent',
        expect.objectContaining({ avatar: expect.objectContaining({ type: 'bot', shape: 'kirby' }) })
      )
    })
  })

  test('未触碰头像 → 保存 patch 不含 avatar（dirty-gate，NULL 行保持 NULL）', async () => {
    renderDrawer()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(mockSave.mock.calls[0][1] as Record<string, unknown>).not.toHaveProperty('avatar')
  })
})
