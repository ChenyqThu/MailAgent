// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
