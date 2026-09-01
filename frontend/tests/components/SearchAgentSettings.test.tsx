// @vitest-environment happy-dom
//
// P4a agent-config lane — 搜索 Agent 配置页。承接 AgentsSearchTab.test 里随
// SearchConfigDrawer 退役的保存 / 删除 / 模型语义：
//   • 编辑既有行保存：patch 带 enabled / title / model / tools，prompt 默认态回传 null
//   • 头像未触碰不发 avatar 键（发了会把「按 id 稳定派生」物化成显式身份）
//   • 两步确认删除 → deleteAgent(cfg.id)，第一步不发请求
//   • 模型下拉 orphan 兜底：当前 model 不在启用列表 → 追加一项并标「（未启用）」
//   • 能力区是真实的多选工具 chip（渲染 SEARCH_TOOLS），不是「工具写死」一句话
//
// ⚠️ 旧文件里 `SearchConfigDrawer — 新建` 的 4 条、以及头像那组里依赖 create 两段式的
// 3 条**有意不迁**：本页没有新建分支（SearchAgentSettings.tsx 文件头写明是预存缺口，
// 旧卡片网格时期就已经没有调用点能进去）。造一个 create 用例只会测到产品里进不去的路径。
// 保存失败的报错语义仍然要测 —— 用编辑态的 setConfig 失败承接。
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

// Radix Select 开列表要几个 happy-dom 没有的 DOM 原语。
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

const { mockSave, mockRemove } = vi.hoisted(() => ({ mockSave: vi.fn(), mockRemove: vi.fn() }))

vi.mock('../../src/shared/components/agents/hooks', () => ({
  useSetConfig: () => ({ save: mockSave, isSaving: false }),
  useDeleteAgent: () => ({ remove: mockRemove, isDeleting: false }),
  useReportConfig: () => ({ agents: [], isLoading: false }),
  useKosAvailable: () => false,
  useRunNow: () => ({ run: vi.fn(), isRunning: false })
}))

const mockEnabledModels = vi.fn(() => ({
  models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
}))
vi.mock('@shared/hooks/useLlmModels', () => ({
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
  FALLBACK_MODELS: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
  resolveApiBaseUrl: () => 'http://127.0.0.1:0/api',
  useEnabledModels: () => mockEnabledModels(),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() })
}))

import i18n from '@shared/i18n'
import { SearchAgentSettings } from '../../src/shared/components/agents/settings/SearchAgentSettings'
import { DEFAULT_SEARCH_AGENT_PROMPT } from '@shared/assistant/searchAgentClient'
import type { ReportAgentConfig } from '@shared/api/types'
import zhCommon from '../../src/shared/i18n/locales/zh-CN/common.json'
import enCommon from '../../src/shared/i18n/locales/en-US/common.json'

await i18n.changeLanguage('zh-CN')

function makeQcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

function makeCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id: 'email_search_agent',
    type: 'search',
    enabled: true,
    title: '邮件搜索助手',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: '',
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

function renderSettings(over: Partial<ReportAgentConfig> = {}) {
  return render(createElement(SearchAgentSettings, { cfg: makeCfg(over) }), {
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
function openModelSelect(): HTMLElement {
  const trigger = screen.getByRole('combobox', { name: '模型' })
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    fireEvent.pointerUp(trigger)
  })
  return document.querySelector('[role="listbox"]') as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockSave.mockResolvedValue({})
  mockRemove.mockResolvedValue({ deleted: 'email_search_agent' })
  mockEnabledModels.mockReturnValue({
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5'],
    rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-fable-5', 'gpt-5.5']
  })
})

mockSave.mockResolvedValue({})
mockRemove.mockResolvedValue({ deleted: 'email_search_agent' })

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

describe('保存 — 编辑既有行', () => {
  test('patch 含 enabled/title/model/tools；prompt 默认态 → null（保持「用默认」）', () => {
    renderSettings()
    fireEvent.change(screen.getByPlaceholderText('如 邮件搜索助手'), {
      target: { value: '我的搜索 Agent' }
    })
    save()
    expect(mockSave.mock.calls[0][0]).toBe('email_search_agent')
    const patch = lastPatch()
    expect(patch.title).toBe('我的搜索 Agent')
    expect(patch.enabled).toBe(true)
    expect(patch.model).toBe('claude-opus-4-8')
    expect(patch.tools).toEqual(['email_search_fulltext'])
    // 未改 + prompt_is_default → null；发文本会把内置默认物化成用户自定义，
    // 以后默认 prompt 升级这行再也跟不上。
    expect(patch.prompt).toBeNull()
  })

  test('回显的是内置默认 prompt；改过之后回传文本', () => {
    renderSettings()
    const ta = screen.getByPlaceholderText('搜索 Agent 的系统 prompt') as HTMLTextAreaElement
    expect(ta.value).toBe(DEFAULT_SEARCH_AGENT_PROMPT)
    fireEvent.change(ta, { target: { value: '只搜未读邮件' } })
    save()
    expect(lastPatch().prompt).toBe('只搜未读邮件')
  })

  test('行已自定义 + 未改 → 原样回传 cfg.prompt（不被 null 抹回默认）', () => {
    renderSettings({ prompt: '只搜未读邮件', prompt_is_default: false })
    save()
    expect(lastPatch().prompt).toBe('只搜未读邮件')
  })

  test('标题清空 → 回落 cfg.title（不把空串写进库）；关启用 → enabled=false', () => {
    renderSettings()
    fireEvent.change(screen.getByPlaceholderText('如 邮件搜索助手'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('switch', { name: '启用此 Agent' }))
    save()
    const patch = lastPatch()
    expect(patch.title).toBe('邮件搜索助手')
    expect(patch.enabled).toBe(false)
  })

  test('保存失败 → 就地报错，不静默吞掉', async () => {
    mockSave.mockRejectedValueOnce(new Error('boom'))
    renderSettings()
    save()
    expect(await screen.findByText(zhCommon.agents.search.errGeneric)).toBeTruthy()
  })
})

describe('身份 — 头像 dirty-gate', () => {
  test('未触碰头像 → patch 不带 avatar 键', () => {
    renderSettings()
    save()
    expect(lastPatch()).not.toHaveProperty('avatar')
  })

  test('展开「更换」→ 选形状 → patch 携带 avatar', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: '更换' }))
    fireEvent.click(within(screen.getByTestId('avatar-shape-grid')).getByLabelText('cloudee'))
    save()
    expect(lastPatch().avatar).toMatchObject({ type: 'bot', shape: 'cloudee' })
  })
})

describe('能碰什么 — 真实的多选工具', () => {
  test('SEARCH_TOOLS 渲染成可切的 chip；取消后 patch.tools 是空数组', () => {
    renderSettings()
    const chip = screen.getByRole('button', { name: '邮件全文搜索', pressed: true })
    fireEvent.click(chip)
    expect(screen.getByRole('button', { name: '邮件全文搜索' }).getAttribute('aria-pressed')).toBe(
      'false'
    )
    save()
    expect(lastPatch().tools).toEqual([])
  })

  test('老行 tools_json 为空 → 落 SEARCH_TOOLS 缺省（选中态 + 保存回传）', () => {
    renderSettings({ tools_json: null })
    expect(screen.getByRole('button', { name: '邮件全文搜索' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
    save()
    expect(lastPatch().tools).toEqual(['email_search_fulltext'])
  })
})

describe('删掉它 — 两步确认', () => {
  test('点删除只露确认，再点才 deleteAgent(id)', async () => {
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(mockRemove).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: '确认删除此搜索 Agent？' }))
    await vi.waitFor(() => expect(mockRemove).toHaveBeenCalledWith('email_search_agent'))
  })

  test('确认区可取消，取消后回到单个「删除」按钮', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '确认删除此搜索 Agent？' })).toBeNull()
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    expect(mockRemove).not.toHaveBeenCalled()
  })
})

describe('模型下拉 — orphan 兜底', () => {
  test('当前 model 不在启用列表 → trigger 显示它，下拉追加并标「未启用」', () => {
    mockEnabledModels.mockReturnValue({
      models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      rawEnabled: ['claude-sonnet-4-6', 'claude-opus-4-8']
    })
    renderSettings({ model: 'orphan-model-z' })
    expect(screen.getByRole('combobox', { name: '模型' }).textContent).toContain('orphan-model-z')
    const listbox = openModelSelect()
    expect(within(listbox).getByRole('option', { name: /orphan-model-z/ }).textContent).toMatch(
      /未启用/
    )
  })

  test('在启用列表里的模型不带「未启用」标注（证明上一条不是恒真）', () => {
    renderSettings()
    const listbox = openModelSelect()
    expect(
      within(listbox).getByRole('option', { name: /claude-opus-4-8/ }).textContent
    ).not.toMatch(/未启用/)
  })
})

describe('骨架 — 声明了才渲染', () => {
  test('五区固定序；没有「什么时候动」（⌘K 唤起，不定时跑）', () => {
    const { container } = renderSettings()
    const labels = Array.from(container.querySelectorAll('section')).map((el) =>
      el.getAttribute('aria-label')
    )
    expect(labels).toEqual(['身份', '指令', '模型', '能碰什么', '删掉它'])
  })
})
