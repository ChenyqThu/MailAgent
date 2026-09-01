// @vitest-environment happy-dom
//
// P4a agent-config lane — 「AI 邮件预处理」配置页。承接 PreprocessConfigDrawer.test 随旧
// 抽屉退役的保存语义断言，核心是**双源写**：
//   • 启用开关 → env LLM_AGENT_ENABLED（+ 重启横幅）；模型 / fallback / 上下文源 / 头像
//     → report_agent 行 PATCH，全部 dirty 追踪，未触碰的字段一个都不发；
//   • 分类 prompt → .md 文件（只写 dirty 的那一份）；
//   • env 写失败必须**先失败先返回**，不能带着半截状态继续写行。
// 另钉一条形态：它跟着收信自动跑 → 没有「什么时候动」区（design §8.2）。
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

// 页面里有「查看处理统计」跳 /admin/llm —— 只消费 useNavigate 返回值，不需要真路由树。
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

const { mockSave, mockApplyEnvPatch, mockPromptRead, mockPromptWrite, mockToastError, STABLE_API } =
  vi.hoisted(() => {
    const read = vi.fn()
    const write = vi.fn()
    return {
      mockSave: vi.fn(),
      mockApplyEnvPatch: vi.fn(),
      mockPromptRead: read,
      mockPromptWrite: write,
      mockToastError: vi.fn(),
      // 🔴 稳定单例：分类 prompt 的加载 effect 依赖 `api.prompts`，每次渲染换新引用会让它
      // 无限重跑（永远停在 loading）。真 useMailApi 返回的是工厂单例，mock 必须遵守同一契约。
      STABLE_API: { prompts: { read, write } }
    }
  })

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6'],
  resolveApiBaseUrl: () => 'http://127.0.0.1:0/api',
  useEnabledModels: () => ({ models: ['claude-sonnet-4-6'], rawEnabled: ['claude-sonnet-4-6'] }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => STABLE_API }))

// applyEnvPatch 打桩（真 store 留着 —— 测试要用 setState 铺 env 快照）。
vi.mock('@shared/state/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@shared/state/env')>()),
  applyEnvPatch: mockApplyEnvPatch
}))

vi.mock('@shared/state/toast', () => ({
  toastError: mockToastError,
  toastSuccess: vi.fn()
}))

import i18n from '@shared/i18n'
import { PreprocessSettings } from '../../src/shared/components/agents/settings/PreprocessSettings'
import { useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'
import type { ReportAgentConfig } from '@shared/api/types'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

function setEnv(values: Record<string, string>): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: { path: '/tmp/.env', exists: true, values, managedKeys: [], secretKeys: [] }
    }
  })
}

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function makeCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
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
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    context_docs: ['soul'],
    context_source: 'standing_docs',
    mark_read_after_processing: true,
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

/** 两份分类 prompt 都读到了才算挂载完成（textarea 在 loading 态下不渲染）。 */
async function renderSettings(over: Partial<ReportAgentConfig> = {}) {
  const utils = render(createElement(PreprocessSettings, { cfg: makeCfg(over) }), {
    wrapper: makeQcWrapper()
  })
  await waitFor(() => expect(screen.getByText('/tmp/prompts/email_inbox.md')).toBeTruthy())
  return utils
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: '保存' }))
}

beforeEach(() => {
  mockSave.mockResolvedValue({})
  mockApplyEnvPatch.mockResolvedValue({
    ok: true,
    path: '/tmp/.env',
    changedKeys: ['LLM_AGENT_ENABLED'],
    restartRequired: true
  })
  mockPromptRead.mockImplementation(async (slot: 'inbox' | 'sent') => ({
    slot,
    path: `/tmp/prompts/email_${slot}.md`,
    exists: true,
    content: `${slot} prompt`
  }))
  mockPromptWrite.mockResolvedValue({ ok: true, info: {} })
  setEnv({ LLM_AGENT_ENABLED: 'false' })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
  useRestartStore.setState({ required: false, changedKeys: [] })
})

describe('双源写 — env 总闸 + 行 PATCH', () => {
  test('切启用开关 → 写 env LLM_AGENT_ENABLED + 挂重启横幅，行 PATCH 照发', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: '启用此 Agent' }))
    save()
    await waitFor(() => expect(mockApplyEnvPatch).toHaveBeenCalledTimes(1))
    expect(mockApplyEnvPatch).toHaveBeenCalledWith({ LLM_AGENT_ENABLED: 'true' })
    expect(useRestartStore.getState().changedKeys).toContain('LLM_AGENT_ENABLED')
    // 双源：env 写完还要写行（两处各管一半，少一处 = 保存只生效一半）。
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockSave.mock.calls[0][0]).toBe('email_preprocess_agent')
  })

  test('env 写失败 → 报错并**停在这里**，不继续写行', async () => {
    mockApplyEnvPatch.mockResolvedValue({
      ok: false,
      path: '/tmp/.env',
      error: { code: 'E_WRITE', message: 'disk full' }
    })
    await renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: '启用此 Agent' }))
    save()
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1))
    expect(mockToastError.mock.calls[0][1]).toContain('disk full')
    expect(mockSave).not.toHaveBeenCalled()
  })

  test('没碰 env 字段 → 一个 env 键都不写（保存不该顺手回写 .env）', async () => {
    await renderSettings()
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockApplyEnvPatch).not.toHaveBeenCalled()
  })
})

describe('行 PATCH — dirty 追踪与恒发字段', () => {
  test('未触碰 → 只发文档勾选 + 标已读；model / fallback / 上下文源 / 头像都不发', async () => {
    await renderSettings()
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    const patch = mockSave.mock.calls[0][1] as Record<string, unknown>
    expect(Object.keys(patch).sort()).toEqual(['context_docs', 'mark_read_after_processing'])
    expect(patch.context_docs).toEqual(['soul'])
    expect(patch.mark_read_after_processing).toBe(true)
  })

  // 承接 PreprocessConfigDrawer.test 的 avatar 正路径（上面那条只钉住 dirty-gate 的否定面，
  // 光有否定面时把 `...(avatarDirty ? { avatar } : {})` 整段删掉两条都还是绿的）。
  test('展开「更换」→ 选形状 → 行 PATCH 携带 avatar（名称仍不可编辑）', async () => {
    await renderSettings()
    expect(screen.queryByTestId('avatar-shape-grid')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('cloudee'))
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    const patch = mockSave.mock.calls[0][1] as Record<string, unknown>
    expect(patch.avatar).toMatchObject({ type: 'bot', shape: 'cloudee' })
    // 单例行不可改名 → 身份区没有名称输入框，只有只读展示。
    expect(screen.queryByDisplayValue('AI 邮件预处理')).toBeNull()
  })

  test('关掉「预处理完成后自动标已读」→ 行 PATCH 带 false', async () => {
    await renderSettings()
    fireEvent.click(screen.getByRole('switch', { name: '预处理完成后自动标已读' }))
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect((mockSave.mock.calls[0][1] as Record<string, unknown>).mark_read_after_processing).toBe(
      false
    )
  })

  test('切参考上下文源 → 发 context_source，并露出 Notion 上下文页 ID 输入', async () => {
    await renderSettings()
    expect(screen.queryByPlaceholderText('Notion 页面 ID（LLM_CONTEXT_PAGE_ID）')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notion 上下文页' }))
    expect(screen.getByPlaceholderText('Notion 页面 ID（LLM_CONTEXT_PAGE_ID）')).toBeTruthy()
    // 文档勾选此时不生效 —— 面上要说清，不能让人以为勾了就注入。
    expect(
      screen.getByText(
        '当前参考上下文源为「Notion 上下文页」，身份文档不会注入分类提示（此处勾选暂不生效）。'
      )
    ).toBeTruthy()
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect((mockSave.mock.calls[0][1] as Record<string, unknown>).context_source).toBe(
      'notion_context'
    )
  })

  test('行值缺失时按 LLM_CONTEXT_PAGE_ID 有无推导生效源（同后端 _resolve_context_source）', async () => {
    setEnv({ LLM_AGENT_ENABLED: 'false', LLM_CONTEXT_PAGE_ID: 'abc123' })
    await renderSettings({ context_source: null })
    expect(
      screen.getByRole('button', { name: 'Notion 上下文页' }).getAttribute('aria-pressed')
    ).toBe('true')
  })
})

describe('分类 prompt — 只写 dirty 的那一份', () => {
  test('改收件箱那份 → 只写 inbox，不碰 sent', async () => {
    await renderSettings()
    fireEvent.change(screen.getByDisplayValue('inbox prompt'), {
      target: { value: '收件箱新规则' }
    })
    save()
    await waitFor(() => expect(mockPromptWrite).toHaveBeenCalledTimes(1))
    expect(mockPromptWrite).toHaveBeenCalledWith('inbox', '收件箱新规则')
  })

  test('一份都没改 → 不写文件', async () => {
    await renderSettings()
    save()
    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    expect(mockPromptWrite).not.toHaveBeenCalled()
  })
})

// 承接 PreprocessConfigDrawer.test 的两条文案闸（与渲染无关，随页面一起搬过来）。
describe('i18n — agents.preprocess 中英文案', () => {
  test('标已读开关中英都在', () => {
    expect(zhCommon.agents.preprocess.markReadAfterProcessing).toBe('预处理完成后自动标已读')
    expect(enCommon.agents.preprocess.markReadAfterProcessing).toBe(
      'Mark as read after preprocessing'
    )
  })

  test('参考上下文源的提示注明「保存即生效」（不写 env → 不需重启）', () => {
    expect(zhCommon.agents.preprocess.contextSourceHint).toContain('保存即生效')
    expect(enCommon.agents.preprocess.contextSourceHint).toContain('no restart')
  })
})

describe('形态 — 跟着收信跑，没有「什么时候动」', () => {
  test('分区只有五个，无排程区', async () => {
    const { container } = await renderSettings()
    const labels = Array.from(container.querySelectorAll('section')).map((el) =>
      el.getAttribute('aria-label')
    )
    expect(labels).toEqual(['身份', '指令', '模型', '能碰什么', '它自己的设置'])
  })
})
