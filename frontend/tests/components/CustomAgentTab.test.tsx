// @vitest-environment happy-dom
//
// S5 W2 — 完全自定义 Agent（type='custom'）Settings 转正。覆盖：
//   • AgentsTab 第四 type filter → custom 卡片渲染（title/trigger 摘要/run 徽标）
//   • NewAgentTile flag 门控：customAgentsEnabled=true → 可点新建；false → 禁用占位
//   • CustomAgentDrawer 新建：字段在场 + 两段式（createAgent type='custom' → setConfig 补 trigger）
//   • 浅校验：email_filter 谓词全空 / cron 非 5 段 → 前端拒 + 不发请求
//   • run 历史 8 状态穷举徽标 + paused_* 永不渲染为成功 + run-now 走 type:'custom'
//   • i18n zh/en agents.custom key 对齐
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
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture =
      vi.fn() as unknown as typeof Element.prototype.setPointerCapture
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture =
      vi.fn() as unknown as typeof Element.prototype.releasePointerCapture
  }
})

// useExitAnimation 强制 shouldRender=true。
vi.mock('@shared/hooks/useExitAnimation', () => ({
  useExitAnimation: () => ({ shouldRender: true, scopeRef: { current: null } })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  FALLBACK_MODELS: ['claude-opus-4-8', 'claude-fable-5'],
  useEnabledModels: () => ({
    models: ['claude-opus-4-8', 'claude-fable-5'],
    rawEnabled: ['claude-opus-4-8', 'claude-fable-5']
  }),
  useUpstreamModels: () => ({ models: [], isLoading: false, error: undefined, refresh: vi.fn() }),
  resolveApiBaseUrl: () => 'http://127.0.0.1:8200/api'
}))

const mockGetConfig = vi.fn()
const mockSetConfig = vi.fn()
const mockCreateAgent = vi.fn()
const mockDeleteAgent = vi.fn()
const mockRunNow = vi.fn()
const mockListRuns = vi.fn()
const mockToolOptions = vi.fn()
// S5 W5b — 自动化策略 section 的 chat api 面。
const mockListPolicyRules = vi.fn()
const mockCreatePolicyRule = vi.fn()
const mockSetRuleEnabled = vi.fn()
const mockDeleteRule = vi.fn()
const mockListEntrypoints = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      getConfig: mockGetConfig,
      setConfig: mockSetConfig,
      runNow: mockRunNow,
      delete: vi.fn(),
      createAgent: mockCreateAgent,
      deleteAgent: mockDeleteAgent,
      listRuns: mockListRuns,
      toolOptions: mockToolOptions
    },
    chat: {
      kosAvailable: vi.fn().mockResolvedValue(false),
      listPolicyRules: mockListPolicyRules,
      createPolicyRule: mockCreatePolicyRule,
      setPolicyRuleEnabled: mockSetRuleEnabled,
      deletePolicyRule: mockDeleteRule,
      listSkillEntrypoints: mockListEntrypoints
    }
  })
}))

import i18n from '@shared/i18n'
import { AgentsTab } from '../../src/shared/components/agents/AgentsTab'
import {
  CustomAgentDrawer,
  RunStateBadge
} from '../../src/shared/components/agents/CustomAgentDrawer'
import type { AgentRunState, ReportAgentConfig } from '@shared/api/types'
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

function mockFlag(enabled: boolean): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { customAgentsEnabled: enabled } })
  }) as unknown as typeof fetch
}

function makeCustomCfg(over: Partial<ReportAgentConfig> = {}): ReportAgentConfig {
  return {
    id: 'dms_helper',
    type: 'custom',
    enabled: true,
    title: 'DMS 审批助手',
    schedule: { cadence: 'daily', hours: [9] },
    window_hours: null,
    prompt: '处理 DMS 审批邮件',
    prompt_is_default: false,
    model: 'claude-opus-4-8',
    tools_json: null,
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: '',
    body_full_priorities: [],
    trigger: { v: 1, kind: 'email_filter', subject_pattern: 'DMS.*审批' },
    tool_policy: { v: 1, allowed_tools: ['email_search'] },
    budget: { v: 1, max_steps: 8, max_runs_per_day: 24, max_run_seconds: 300 },
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  mockListRuns.mockResolvedValue([])
  mockToolOptions.mockResolvedValue({
    tools: [
      { name: 'email_search', class: 'read' },
      { name: 'email_get', class: 'read' },
      { name: 'compose_reply', class: 'domain_write' }
    ],
    defaults: ['email_search', 'email_get']
  })
  mockListPolicyRules.mockResolvedValue([])
  mockListEntrypoints.mockResolvedValue([])
})

// afterEach 在首个用例前不会跑 —— 模块加载时也要有默认值（否则第一个渲染的 drawer 用例
// 会因 listPolicyRules 返回 undefined 而 query 报错）。
mockListRuns.mockResolvedValue([])
mockListPolicyRules.mockResolvedValue([])
mockListEntrypoints.mockResolvedValue([])
mockToolOptions.mockResolvedValue({
  tools: [
    { name: 'email_search', class: 'read' },
    { name: 'email_get', class: 'read' },
    { name: 'compose_reply', class: 'domain_write' }
  ],
  defaults: ['email_search', 'email_get']
})

describe('i18n — agents.custom key 对齐', () => {
  test('zh / en 顶层 key 一致', () => {
    const zhKeys = Object.keys(zhCommon.agents.custom).sort()
    const enKeys = Object.keys(enCommon.agents.custom).sort()
    expect(zhKeys).toEqual(enKeys)
  })
  test('zh / en runs.state 8 值域 key 一致', () => {
    const zhKeys = Object.keys(zhCommon.agents.custom.runs.state).sort()
    const enKeys = Object.keys(enCommon.agents.custom.runs.state).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBe(8)
  })
})

describe('AgentsTab — Custom Agent 区 + flag 门控', () => {
  test('flag on + custom 行 → 渲染 custom section + 卡片（trigger 摘要）', async () => {
    mockFlag(true)
    mockGetConfig.mockResolvedValue([makeCustomCfg()])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    // section 标题 + 卡片名
    expect(await screen.findByText('完全自定义 Agent')).toBeTruthy()
    expect(await screen.findByText('DMS 审批助手')).toBeTruthy()
    // trigger 摘要（email_filter → 邮件事件触发）
    expect(screen.getByText('邮件事件触发')).toBeTruthy()
    // flag on → 可点新建 tile（newTileTitle）
    expect(await screen.findByText('新建自定义 Agent')).toBeTruthy()
  })

  test('flag off + 无 custom 行 → 无 section，仅禁用占位 tile（字节级同现状文案）', async () => {
    mockFlag(false)
    mockGetConfig.mockResolvedValue([])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    // 禁用占位 hint 在场
    expect(await screen.findByText('完全自定义 Agent · 待上线')).toBeTruthy()
    // section header（精确 "完全自定义 Agent"）不渲染；可点新建 tile 不渲染
    expect(screen.queryByText('完全自定义 Agent')).toBeNull()
    expect(screen.queryByText('新建自定义 Agent')).toBeNull()
  })
})

describe('CustomAgentDrawer — 新建（两段式）', () => {
  test('字段在场：title / prompt / trigger seg / budget', async () => {
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    expect(screen.getByPlaceholderText('如 DMS 审批助手')).toBeTruthy()
    expect(screen.getByPlaceholderText(/描述这个 Agent/)).toBeTruthy()
    // trigger seg 三态
    expect(screen.getByText('无（草稿）')).toBeTruthy()
    expect(screen.getByText('定时')).toBeTruthy()
    expect(screen.getByText('邮件事件')).toBeTruthy()
    // budget 标签
    expect(screen.getByText(/最大步数/)).toBeTruthy()
  })

  test('cron 触发 → createAgent(type=custom) 后 setConfig 带 trigger.kind=cron', async () => {
    mockCreateAgent.mockResolvedValue(makeCustomCfg())
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    const onClose = vi.fn()
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), {
      target: { value: '每日巡检' }
    })
    fireEvent.click(screen.getByText('定时')) // 选 cron（默认 cron = 0 9 * * 1-5，合法 5 段）
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1))
    expect(mockCreateAgent.mock.calls[0][0].type).toBe('custom')
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const patch = mockSetConfig.mock.calls[0][1]
    expect(patch.trigger.kind).toBe('cron')
    expect(patch.trigger.cron).toBe('0 9 * * 1-5')
    // tool_policy 恒发数组 + budget 三门
    expect(Array.isArray(patch.tool_policy.allowed_tools)).toBe(true)
    expect(patch.budget.max_steps).toBe(8)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('浅校验：email_filter 谓词全空 → 拒 + 不发请求', async () => {
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('邮件事件'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText(/邮件触发至少填一项/)).toBeTruthy()
    expect(mockCreateAgent).not.toHaveBeenCalled()
  })

  test('浅校验：cron 非 5 段 → 拒 + 不发请求', async () => {
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('定时'))
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), { target: { value: '0 9 * *' } })
    fireEvent.click(screen.getByText('创建'))
    // 精确匹配错误消息（「cron 必须是标准 5 段…」），避开 cron 提示文案（「标准 5 段 cron…」）。
    expect(await screen.findByText(/必须是标准 5 段/)).toBeTruthy()
    expect(mockCreateAgent).not.toHaveBeenCalled()
  })

  test('保存失败展示后端 detail（不做第二套深校验）', async () => {
    mockCreateAgent.mockResolvedValue(makeCustomCfg())
    const err = new Error('invalid cron expression')
    ;(err as { code?: string }).code = 'E_INVALID_ARG'
    mockSetConfig.mockRejectedValue(err)
    const onClose = vi.fn()
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('定时'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText(/E_INVALID_ARG: invalid cron expression/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('CustomAgentDrawer — P2 tool_policy 按需发送（NULL 行不被静默清空）', () => {
  test('NULL-policy 行仅改 prompt → patch 无 tool_policy 键（NULL 保持 NULL）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    const onClose = vi.fn()
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={onClose} />
    )
    fireEvent.change(screen.getByPlaceholderText(/描述这个 Agent/), {
      target: { value: '新任务描述' }
    })
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const patch = mockSetConfig.mock.calls[0][1]
    expect(patch.prompt).toBe('新任务描述')
    expect('tool_policy' in patch).toBe(false)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('NULL-policy 行勾掉一个工具 → patch 含显式集合', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />)
    // toolOptions 就位后 NULL 行默认勾选 = defaults（email_search / email_get）；勾掉 email_search
    const chip = await screen.findByRole('button', { name: 'email_search', pressed: true })
    fireEvent.click(chip)
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const patch = mockSetConfig.mock.calls[0][1]
    expect('tool_policy' in patch).toBe(true)
    expect(patch.tool_policy).toEqual({ v: 1, allowed_tools: ['email_get'] })
  })

  test('toolOptions 失败 → 工具区显示无法加载 + 编辑保存 patch 无 tool_policy', async () => {
    mockToolOptions.mockResolvedValue({ tools: [], defaults: [] })
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />)
    expect(await screen.findByText(/无法加载工具清单/)).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect('tool_policy' in mockSetConfig.mock.calls[0][1]).toBe(false)
  })

  test('显式行打开后勾选 = 行内集合（不被 defaults effect 覆盖，W5b 修 W2 潜伏 bug）', async () => {
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({ tool_policy: { v: 1, allowed_tools: ['compose_reply'] } })}
        open
        onClose={() => {}}
      />
    )
    // toolOptions 就位后：显式集合里的 compose_reply 选中，defaults 里的 email_search 未选中
    expect(await screen.findByRole('button', { name: /compose_reply/, pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'email_search', pressed: false })).toBeTruthy()
  })

  test('显式 allowed_tools 行未触碰工具区 → patch 无 tool_policy（不误清）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({ tool_policy: { v: 1, allowed_tools: ['email_search'] } })}
        open
        onClose={() => {}}
      />
    )
    // 仅改 enabled（不碰工具区）
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: '改名' } })
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect('tool_policy' in mockSetConfig.mock.calls[0][1]).toBe(false)
  })
})

describe('CustomAgentDrawer — run 历史', () => {
  test('run-now 按钮走 type:custom；paused_pending 显「等待审批」不显「已完成」', async () => {
    mockListRuns.mockResolvedValue([
      { jobId: 5, agentId: 'dms_helper', state: 'paused_pending', createdAt: 1_700_000_000 }
    ])
    mockRunNow.mockResolvedValue({ report_id: '9', status: 'generating', headline: '' })
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    // 徽标：等待审批（永不渲染为成功）
    expect(await screen.findByText('等待审批')).toBeTruthy()
    expect(screen.queryByText('已完成')).toBeNull()
    // pending 提示文案（岛 off 说明）—— 唯一子串定位，避免撞徽标文字
    expect(screen.getByText(/若未开启灵动岛/)).toBeTruthy()
    // run-now
    fireEvent.click(screen.getByText('立即运行'))
    await vi.waitFor(() => expect(mockRunNow).toHaveBeenCalledTimes(1))
    expect(mockRunNow.mock.calls[0][0]).toBe('dms_helper')
    expect(mockRunNow.mock.calls[0][1]).toEqual({ type: 'custom' })
  })
})

// ---------------------------------------------------------------------------
// S5 W5b — 自动化策略 section（ADR-004 D5/D6）
// ---------------------------------------------------------------------------

function makeRule(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    capability: 'domain_write',
    matcher: { v: 1, tool: 'email_flag' },
    contextMode: 'untrusted_trigger',
    agentId: 'dms_helper',
    enabled: true,
    note: null,
    createdAt: '2026-07-04T09:00:00Z',
    lastUsedAt: null,
    useCount: 3,
    dangerous: false,
    ...over
  }
}

describe('CustomAgentDrawer — 自动化策略（S5 W5b）', () => {
  test('规则列表：matcher 摘要 + 命中计数 + dormant 提示（contextMode 失配才显）', async () => {
    mockListPolicyRules.mockResolvedValue([
      makeRule(),
      makeRule({
        id: 2,
        capability: 'exec',
        contextMode: 'cron_headless', // cfg trigger=email_filter → untrusted_trigger → 失配
        matcher: {
          v: 1,
          argv0_realpath: '/usr/bin/python3',
          argv_template: [
            { pin: '/skills/dms-cli/approve.py' },
            { arg: { kind: 'pattern', regex: '^REQ-[0-9]+$' } }
          ]
        },
        useCount: 0
      })
    ])
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    expect(await screen.findByText('email_flag')).toBeTruthy()
    expect(screen.getByText('命中 3 次')).toBeTruthy()
    expect(mockListPolicyRules).toHaveBeenCalledWith({ agentId: 'dms_helper' })
    // exec matcher 摘要：argv0 + entry pin + 受约束位 <pattern>
    expect(
      screen.getByText('/usr/bin/python3 /skills/dms-cli/approve.py <pattern>')
    ).toBeTruthy()
    // dormant 恰出现一次（只有 cron_headless 那条失配）
    expect(screen.getAllByText(/休眠：触发类型已变更/)).toHaveLength(1)
  })

  test('domain_write 建规：两步确认（红样式影响面声明）→ createPolicyRule payload', async () => {
    mockCreatePolicyRule.mockResolvedValue(makeRule({ id: 9 }))
    // 可选写工具 = domain_write 工具 ∩ allowed_tools = [compose_reply]（唯一 → 打开表单预选）
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({ tool_policy: { v: 1, allowed_tools: ['compose_reply'] } })}
        open
        onClose={() => {}}
      />
    )
    // 先等 toolOptions 就位（工具区 chip 渲染）——「新建规则」的唯一写工具预选依赖它。
    await screen.findByRole('button', { name: /compose_reply/ })
    fireEvent.click(screen.getByText('新建规则'))
    fireEvent.click(screen.getByText('创建'))
    // 红样式影响面确认在场，未确认前不发请求
    expect(await screen.findByText('高危：免审批自动执行')).toBeTruthy()
    // 影响面声明：agent 名 + 动作 + 语境都在声明句里
    expect(
      screen.getByText(/「DMS 审批助手」将在无人确认时自动执行 compose_reply/)
    ).toBeTruthy()
    expect(mockCreatePolicyRule).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('我已了解，创建规则'))
    await vi.waitFor(() => expect(mockCreatePolicyRule).toHaveBeenCalledTimes(1))
    expect(mockCreatePolicyRule.mock.calls[0][0]).toEqual({
      capability: 'domain_write',
      matcher: { v: 1, tool: 'compose_reply' },
      agentId: 'dms_helper'
    })
  })

  test('domain_write 建规浅校验：多选项未选 → 拒 + 不发请求', async () => {
    mockToolOptions.mockResolvedValue({
      tools: [
        { name: 'email_flag', class: 'domain_write' },
        { name: 'compose_reply', class: 'domain_write' }
      ],
      defaults: []
    })
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          tool_policy: { v: 1, allowed_tools: ['email_flag', 'compose_reply'] }
        })}
        open
        onClose={() => {}}
      />
    )
    fireEvent.click(await screen.findByText('新建规则'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText('请选择要放行的写工具。')).toBeTruthy()
    expect(mockCreatePolicyRule).not.toHaveBeenCalled()
  })

  test('grant_exec：确认后翻开关，保存并入 tool_policy 且 NULL 行不物化 allowed_tools', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    expect(await screen.findByText(/grant_exec/)).toBeTruthy()
    // grant 开关 = 最后一个 switch（enabled 开关之后、无规则行）
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[switches.length - 1])
    // 确认对话在场，未确认前开关不翻（保存也不带 tool_policy）
    expect(await screen.findByText(/确定开启/)).toBeTruthy()
    fireEvent.click(screen.getByText('确认开启'))
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const patch = mockSetConfig.mock.calls[0][1]
    // 触碰 grant = 触碰 tool_policy；NULL 行只带 grant_exec，allowed_tools 缺省（默认安全集不物化）
    expect(patch.tool_policy).toEqual({ v: 1, grant_exec: true })
  })

  test('grant_exec 取消确认 → 开关不翻，保存不带 tool_policy', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    await screen.findByText(/grant_exec/)
    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[switches.length - 1])
    await screen.findByText(/确定开启/)
    // 「取消」出现两处（grant 确认块 + 抽屉 footer）—— 确认块的在 DOM 前（body 先于 footer）。
    fireEvent.click(screen.getAllByText('取消')[0])
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect('tool_policy' in mockSetConfig.mock.calls[0][1]).toBe(false)
  })

  test('run 行免卡 badge：autoWhitelistedWrites>0 渲染 ×N；null（账本不可达）不渲染', async () => {
    mockListRuns.mockResolvedValue([
      {
        jobId: 1,
        agentId: 'dms_helper',
        state: 'completed',
        createdAt: 1_700_000_000,
        autoWhitelistedWrites: 2
      },
      {
        jobId: 2,
        agentId: 'dms_helper',
        state: 'completed',
        createdAt: 1_700_000_100,
        autoWhitelistedWrites: null
      }
    ])
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    expect(await screen.findByText('自动放行 ×2')).toBeTruthy()
    // null 行不渲染 badge（不渲染 ≠ 0 次）—— 全列表恰一个 badge
    expect(screen.getAllByText(/自动放行/)).toHaveLength(1)
  })
})

describe('RunStateBadge — 8 状态穷举渲染', () => {
  const cases: Array<[AgentRunState, string]> = [
    ['queued', '排队中'],
    ['running', '运行中'],
    ['completed', '已完成'],
    ['paused_pending', '等待审批'],
    ['paused_expired', '审批过期（未执行）'],
    ['paused_approved', '审批通过（已执行）'],
    ['paused_rejected', '审批拒绝（未执行）'],
    ['failed', '失败']
  ]
  test.each(cases)('state=%s → 徽标 "%s"', (state, label) => {
    renderUi(<RunStateBadge state={state} />)
    expect(screen.getByText(label)).toBeTruthy()
  })
})
