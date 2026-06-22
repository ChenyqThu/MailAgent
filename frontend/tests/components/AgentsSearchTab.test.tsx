// @vitest-environment happy-dom
//
// F4b — agentic 搜索 = 特化 Custom Agent 的配置 UI。覆盖：
//   • AgentsTab 渲染「Search Agents」分组（filter type==='search'），report 区不受影响
//   • SearchConfigDrawer 编辑既有 → setConfig 带 tools/enabled/title/model/prompt
//   • SearchConfigDrawer 新建 → createAgent（id slug + type='search' + tools）
//   • SearchConfigDrawer 删除 → 两步确认后 deleteAgent
//   • 模型下拉 orphan 兜底（当前 model 不在启用列表 → 追加 + 「未启用」标注）
//   • 改名：chat.backend.customApi 已是 "Custom Agent"
// 用 useMailApi mock：让真实 hooks（useReportConfig / useCreateAgent / useDeleteAgent /
// useSetConfig）打到 mock 的 mailApi.report.*，验证整条数据链。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

// Radix Select needs DOM primitives happy-dom lacks to open its listbox.
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

// useExitAnimation 强制 shouldRender=true（覆盖退场期 cfg=null 路径，且 open=true 同样命中）。
vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

const mockEnabledModels = vi.fn(() => ({
  models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
}))
vi.mock('@shared/hooks/useLlmModels', () => ({
  FALLBACK_MODELS: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  useEnabledModels: () => mockEnabledModels(),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

// mailApi.report.* — 真实 hooks 经此打到这些 mock。getConfig 默认返一个 search + 一个 report。
const mockGetConfig = vi.fn()
const mockSetConfig = vi.fn()
const mockCreateAgent = vi.fn()
const mockDeleteAgent = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      getConfig: mockGetConfig,
      setConfig: mockSetConfig,
      runNow: vi.fn(),
      delete: vi.fn(),
      createAgent: mockCreateAgent,
      deleteAgent: mockDeleteAgent
    },
    chat: { kosAvailable: vi.fn().mockResolvedValue(false) }
  })
}))

import i18n from '@shared/i18n'
import { AgentsTab, SearchConfigDrawer } from '../../src/shared/components/agents/AgentsTab'
import type { ReportAgentConfig } from '@shared/api/types'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}
function renderUi(ui: React.ReactElement) {
  return render(ui, { wrapper: makeQcWrapper() })
}

function makeSearchCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id: 'email_search_agent',
    type: 'search',
    enabled: true,
    title: '邮件搜索助手',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: 'x',
    prompt_is_default: true,
    model: 'claude-opus-4-8',
    tools_json: ['email_search_fulltext'],
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

function getModelTrigger(): HTMLElement {
  const trigger = screen.getAllByRole('combobox').find((el) => el.tagName === 'BUTTON')
  if (!trigger) throw new Error('model select trigger not found')
  return trigger
}
function openModelSelect(): HTMLElement {
  const trigger = getModelTrigger()
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger)
  })
  return document.querySelector('[role="listbox"]') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockEnabledModels.mockReturnValue({
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
    rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
  })
})

describe('i18n 改名 Custom AI → Custom Agent', () => {
  test('chat.backend.customApi zh + en 均为 "Custom Agent"', () => {
    expect(zhCommon.chat.backend.customApi).toBe('Custom Agent')
    expect(enCommon.chat.backend.customApi).toBe('Custom Agent')
  })
  test('agents.search.* zh / en key 对齐', () => {
    const zhKeys = Object.keys(zhCommon.agents.search).sort()
    const enKeys = Object.keys(enCommon.agents.search).sort()
    expect(zhKeys).toEqual(enKeys)
  })
})

describe('AgentsTab — Search Agents 区', () => {
  test('渲染 type==="search" 的 agent 卡（report agent 不进搜索区）', async () => {
    mockGetConfig.mockResolvedValue([
      makeSearchCfg(),
      {
        ...makeSearchCfg({ id: 'daily', type: 'report', title: '日报' }),
        tools_json: null
      }
    ])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    // 搜索区标题 + 搜索 agent 卡名
    expect(await screen.findByText('搜索 Agent')).toBeTruthy()
    expect(await screen.findByText('邮件搜索助手')).toBeTruthy()
    // report agent 卡仍渲染（报告区不破坏）—— 「日报」可能在卡标题/cadence 多处出现，断在场即可
    expect(screen.getAllByText('日报').length).toBeGreaterThan(0)
    // 新建入口按产品要求退回 coming-soon（搜索 Agent 只用内置一个，编辑既有即可），
    // 改为不可点的「完全自定义 Agent · 待上线」占位 tile（NewAgentTile）—— 故「新建搜索
    // Agent」按钮不再渲染，占位 hint 在场。
    expect(screen.queryByText('新建搜索 Agent')).toBeNull()
    expect(screen.getByText(/完全自定义 Agent/)).toBeTruthy()
  })

  test('无 search agent 时显示空态提示', async () => {
    mockGetConfig.mockResolvedValue([])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    expect(await screen.findByText('暂无搜索 Agent，点上方新建。')).toBeTruthy()
  })
})

describe('SearchConfigDrawer — 编辑既有', () => {
  test('保存走 setConfig，patch 含 enabled/title/model/prompt/tools', async () => {
    mockSetConfig.mockResolvedValue(makeSearchCfg())
    const onClose = vi.fn()
    renderUi(<SearchConfigDrawer cfg={makeSearchCfg()} open onClose={onClose} />)
    // 改名
    const titleInput = screen.getByPlaceholderText('如 邮件搜索助手') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: '我的搜索 Agent' } })
    // 保存
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const [id, patch] = mockSetConfig.mock.calls[0]
    expect(id).toBe('email_search_agent')
    expect(patch.title).toBe('我的搜索 Agent')
    expect(patch.enabled).toBe(true)
    expect(patch.model).toBe('claude-opus-4-8')
    expect(patch.tools).toEqual(['email_search_fulltext'])
    // prompt 未改 + 默认态 → null（用内置默认）
    expect(patch.prompt).toBeNull()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('改 prompt 后 patch.prompt 带文本', async () => {
    mockSetConfig.mockResolvedValue(makeSearchCfg())
    renderUi(<SearchConfigDrawer cfg={makeSearchCfg()} open onClose={() => {}} />)
    const ta = screen.getByPlaceholderText('搜索 Agent 的系统 prompt') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: '只搜未读邮件' } })
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalled())
    expect(mockSetConfig.mock.calls[0][1].prompt).toBe('只搜未读邮件')
  })

  test('取消 tool chip → patch.tools 为空数组', async () => {
    mockSetConfig.mockResolvedValue(makeSearchCfg())
    renderUi(<SearchConfigDrawer cfg={makeSearchCfg()} open onClose={() => {}} />)
    // tool chip（aria-pressed）切掉
    const chip = screen.getByRole('button', { name: '邮件全文搜索', pressed: true })
    fireEvent.click(chip)
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalled())
    expect(mockSetConfig.mock.calls[0][1].tools).toEqual([])
  })
})

describe('SearchConfigDrawer — 新建', () => {
  test('保存走 createAgent，id 为 title slug + type="search" + tools', async () => {
    mockCreateAgent.mockResolvedValue(makeSearchCfg())
    const onClose = vi.fn()
    renderUi(<SearchConfigDrawer cfg={null} open create onClose={onClose} />)
    const titleInput = screen.getByPlaceholderText('如 邮件搜索助手') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: 'My Search Bot' } })
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1))
    const input = mockCreateAgent.mock.calls[0][0]
    expect(input.id).toBe('my_search_bot')
    expect(input.type).toBe('search')
    expect(input.title).toBe('My Search Bot')
    expect(input.enabled).toBe(true)
    expect(input.tools).toEqual(['email_search_fulltext'])
    // 新建空 prompt → null
    expect(input.prompt).toBeNull()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('id 冲突（E_INVALID_ARG）→ 显示友好提示，不关闭', async () => {
    // 真实 Electron 错误形状：码在 err.code，message 是人话不含码串。
    const err = new Error("report_agent 'dup' already exists")
    ;(err as { code?: string }).code = 'E_INVALID_ARG'
    mockCreateAgent.mockRejectedValue(err)
    const onClose = vi.fn()
    renderUi(<SearchConfigDrawer cfg={null} open create onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('如 邮件搜索助手'), { target: { value: 'dup' } })
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText('该 id 已存在，请换一个名称。')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  test('全中文 title → slug 保留中文（非 timestamp fallback）', async () => {
    mockCreateAgent.mockResolvedValue(makeSearchCfg())
    renderUi(<SearchConfigDrawer cfg={null} open create onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('如 邮件搜索助手'), {
      target: { value: '邮件搜索助手' }
    })
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1))
    const input = mockCreateAgent.mock.calls[0][0]
    expect(input.id).toBe('邮件搜索助手')
    expect(input.id).not.toMatch(/^(agent|search)_/)
  })

  test('新建态不显示删除按钮', () => {
    renderUi(<SearchConfigDrawer cfg={null} open create onClose={() => {}} />)
    expect(screen.queryByText('删除')).toBeNull()
  })
})

describe('SearchConfigDrawer — 删除（两步确认）', () => {
  test('点删除 → 确认 → deleteAgent(id)', async () => {
    mockDeleteAgent.mockResolvedValue({ deleted: 'email_search_agent' })
    const onClose = vi.fn()
    renderUi(<SearchConfigDrawer cfg={makeSearchCfg()} open onClose={onClose} />)
    // 第一步：露出确认
    fireEvent.click(screen.getByText('删除'))
    // 第二步：确认文案出现
    const confirmBtn = await screen.findByText('确认删除此搜索 Agent？')
    expect(mockDeleteAgent).not.toHaveBeenCalled()
    fireEvent.click(confirmBtn)
    await vi.waitFor(() => expect(mockDeleteAgent).toHaveBeenCalledWith('email_search_agent'))
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('SearchConfigDrawer — 模型下拉 orphan 兜底', () => {
  test('当前 model 不在启用列表 → trigger 显示 + 下拉追加「未启用」', () => {
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8']
    })
    renderUi(
      <SearchConfigDrawer
        cfg={makeSearchCfg({ model: 'orphan-model-z' })}
        open
        onClose={() => {}}
      />
    )
    expect(getModelTrigger().textContent).toContain('orphan-model-z')
    const listbox = openModelSelect()
    const orphan = within(listbox).getByRole('option', { name: /orphan-model-z/ })
    expect(orphan.textContent).toMatch(/未启用/)
  })
})
