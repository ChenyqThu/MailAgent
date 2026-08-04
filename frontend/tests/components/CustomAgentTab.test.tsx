// @vitest-environment happy-dom
//
// S5 W2 — 完全自定义 Agent（type='custom'）Settings 转正。覆盖：
//   • AgentsTab 第四 type filter → custom 卡片渲染（title/trigger 摘要/run 徽标）
//   • NewAgentTile flag 门控：customAgentsEnabled=true → 可点新建；false → 禁用占位
//   • CustomAgentDrawer 新建：字段在场 + 两段式（createAgent type='custom' → setConfig 补 trigger）
//   • 浅校验：email_filter 谓词全空 / cron 非 5 段 → 前端拒 + 不发请求
//   • run 历史 9 状态穷举徽标 + paused_*/skipped 永不渲染为成功 + run-now 走 type:'custom'
//   • i18n zh/en agents.custom key 对齐
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
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
  fetchChatConfigModelsProbe: async () => ({ enabledModels: [], providerRegistryEnabled: false }),
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
// S6 W3-3 — skill 挂载多选数据源（统一 registry 投影）。
const mockListSkills = vi.fn()
// MCP connector PR4 T3 — 第七「外部服务」卡的行数据源（GET /api/connector）。
const mockConnectorList = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    report: {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
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
      listSkillEntrypoints: mockListEntrypoints,
      listSkills: mockListSkills
    },
    connector: {
      list: mockConnectorList
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
    tool_policy: { v: 1, allowed_tools: ['email_list_filter'] },
    budget: { v: 1, max_steps: 8, max_runs_per_day: 24, max_run_seconds: 300 },
    updated_at: null,
    ...over
  } as ReportAgentConfig
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetConfig.mockResolvedValue([])
  mockListRuns.mockResolvedValue({ items: [], total: 0 })
  mockToolOptions.mockResolvedValue({
    tools: [
      { name: 'email_list_filter', class: 'read' },
      { name: 'email_get', class: 'read' },
      { name: 'compose_reply', class: 'domain_write' }
    ],
    defaults: ['email_list_filter', 'email_get']
  })
  mockListPolicyRules.mockResolvedValue([])
  mockListEntrypoints.mockResolvedValue([])
  mockListSkills.mockResolvedValue(SKILLS_FIXTURE)
  mockConnectorList.mockResolvedValue(CONNECTORS_FIXTURE)
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        customAgentsEnabled: true,
        webToolsEnabled: true,
        execToolsEnabled: true
      }
    })
  }) as unknown as typeof fetch
})

afterEach(cleanup)

// S6 W3-3 — skill registry 投影夹具（默认挂载集 email/search/report 命中；dms-approval 为额外可挂载项）。
const SKILLS_FIXTURE = [
  { name: 'email', title: 'Email', description: '', enabled: true, sourceType: 'builtin' },
  { name: 'search', title: 'Search', description: '', enabled: true, sourceType: 'builtin' },
  { name: 'report', title: 'Report', description: '', enabled: true, sourceType: 'builtin' },
  { name: 'dms-approval', title: 'DMS', description: '', enabled: true, sourceType: 'skill_pack' }
] as unknown as import('@shared/api/types').SkillSummary[]

// MCP connector PR4 T3 — connector.list 夹具（第七「外部服务」卡行集合；抽屉只消费
// connector_id / display_name / status 三字段）。
const CONNECTORS_FIXTURE = [
  { connector_id: 'notion', display_name: 'Notion', status: 'connected' }
] as unknown as import('@shared/api/types').ConnectorSummary[]

// afterEach 在首个用例前不会跑 —— 模块加载时也要有默认值（否则第一个渲染的 drawer 用例
// 会因 listPolicyRules 返回 undefined 而 query 报错）。
mockListRuns.mockResolvedValue([])
mockListPolicyRules.mockResolvedValue([])
mockListEntrypoints.mockResolvedValue([])
mockListSkills.mockResolvedValue(SKILLS_FIXTURE)
mockConnectorList.mockResolvedValue(CONNECTORS_FIXTURE)
mockToolOptions.mockResolvedValue({
  tools: [
    { name: 'email_list_filter', class: 'read' },
    { name: 'email_get', class: 'read' },
    { name: 'compose_reply', class: 'domain_write' }
  ],
  defaults: ['email_list_filter', 'email_get']
})

describe('i18n — agents.custom key 对齐', () => {
  test('zh / en 顶层 key 一致', () => {
    const zhKeys = Object.keys(zhCommon.agents.custom).sort()
    const enKeys = Object.keys(enCommon.agents.custom).sort()
    expect(zhKeys).toEqual(enKeys)
  })
  test('zh / en runs.state 9 值域 key 一致', () => {
    const zhKeys = Object.keys(zhCommon.agents.custom.runs.state).sort()
    const enKeys = Object.keys(enCommon.agents.custom.runs.state).sort()
    expect(zhKeys).toEqual(enKeys)
    expect(zhKeys.length).toBe(9)
  })
  test('zh / en policy key 一致（含 W3-3 web / mounts / capability.web）', () => {
    const zhP = zhCommon.agents.custom.policy
    const enP = enCommon.agents.custom.policy
    expect(Object.keys(zhP).sort()).toEqual(Object.keys(enP).sort())
    expect(Object.keys(zhP.capability).sort()).toEqual(Object.keys(enP.capability).sort())
    expect(Object.keys(zhP.web).sort()).toEqual(Object.keys(enP.web).sort())
    expect(Object.keys(zhP.web.grant).sort()).toEqual(Object.keys(enP.web.grant).sort())
    expect(Object.keys(zhP.mounts).sort()).toEqual(Object.keys(enP.mounts).sort())
    // web 三档字面量（radix SelectItem 空串坑无关，此处为 seg —— 仍钉死 off/gated/open）
    expect(Object.keys(zhP.web.grant).sort()).toEqual(['gated', 'off', 'open'])
  })
})

describe('AgentsTab — Custom Agent 区 + flag 门控', () => {
  test('flag on + custom 行 → 渲染 custom section + 卡片（trigger 摘要）', async () => {
    mockFlag(true)
    mockGetConfig.mockResolvedValue([makeCustomCfg()])
    renderUi(<AgentsTab onOpenReports={() => {}} />)
    // section 标题 + 卡片名
    expect(await screen.findByText('完全自定义 Agent')).toBeTruthy()
    expect(await screen.findByRole('heading', { name: 'DMS 审批助手' })).toBeTruthy()
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
  test('字段在场：title / prompt / trigger seg / time budget', async () => {
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    expect(screen.getByPlaceholderText('如 DMS 审批助手')).toBeTruthy()
    expect(screen.getByPlaceholderText(/描述这个 Agent/)).toBeTruthy()
    // trigger seg 三态
    expect(screen.getByText('无（草稿）')).toBeTruthy()
    expect(screen.getByText('定时')).toBeTruthy()
    expect(screen.getByText('邮件事件')).toBeTruthy()
    // time remains the only hard runtime budget; the public step limit is removed.
    expect(screen.getByText(/单次运行秒数/)).toBeTruthy()
    expect(screen.queryByText(/最大步数/)).toBeNull()
  })

  // 07-24 排程统一：新建的定时触发从裸 cron 文本框换成共享 ScheduleBuilder，
  // wire 形状随之从 kind:'cron' 变成 kind:'schedule'（契约 §1）。
  test('定时触发 → createAgent(type=custom) 后 setConfig 带 trigger.kind=schedule', async () => {
    mockCreateAgent.mockResolvedValue(makeCustomCfg())
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    const onClose = vi.fn()
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), {
      target: { value: '每日巡检' }
    })
    // 选「定时」→ 构建器默认「每周 周一~周五 09:00」（与旧 cron 占位 0 9 * * 1-5 同义）
    fireEvent.click(screen.getByText('定时'))
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1))
    expect(mockCreateAgent.mock.calls[0][0].type).toBe('custom')
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const patch = mockSetConfig.mock.calls[0][1]
    expect(patch.trigger.kind).toBe('schedule')
    expect(patch.trigger.rule).toMatchObject({
      freq: 'weekly',
      interval: 1,
      hour: 9,
      minute: 0
    })
    expect(patch.trigger.rule.weekdays).toEqual([1, 2, 3, 4, 5])
    // 契约 §1：anchor（相位原点，本地日期）+ timezone（IANA，不允许为空）必须落库
    expect(patch.trigger.anchor).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(patch.trigger.timezone).toBeTruthy()
    // tool_policy 恒发数组 + budget 两门（无用户面 step 限制）
    expect(Array.isArray(patch.tool_policy.allowed_tools)).toBe(true)
    expect(patch.budget.max_steps).toBeUndefined()
    expect(patch.budget.max_run_seconds).toBe(1800)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('构建器全能力：改成「每月 最后一个周五 18:30」原样落 wire', async () => {
    mockCreateAgent.mockResolvedValue(makeCustomCfg())
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: '月结' } })
    fireEvent.click(screen.getByText('定时'))
    fireEvent.click(screen.getByRole('button', { name: '按月' }))
    fireEvent.click(screen.getByRole('button', { name: '按星期' }))
    fireEvent.change(screen.getByLabelText('第几个'), { target: { value: 'last' } })
    fireEvent.change(screen.getByLabelText('星期'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('小时'), { target: { value: '18' } })
    fireEvent.change(screen.getByLabelText('分钟'), { target: { value: '30' } })
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect(mockSetConfig.mock.calls[0][1].trigger.rule).toMatchObject({
      freq: 'monthly',
      monthMode: 'nth',
      ordinal: 'last',
      weekday: 5,
      hour: 18,
      minute: 30
    })
  })

  test('构建器全能力：interval 步进（每 3 周）', async () => {
    mockCreateAgent.mockResolvedValue(makeCustomCfg())
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: '巡检' } })
    fireEvent.click(screen.getByText('定时'))
    fireEvent.click(screen.getByRole('button', { name: '提高频率' }))
    fireEvent.click(screen.getByRole('button', { name: '提高频率' }))
    expect(screen.getByTestId('schedule-interval').textContent).toBe('3')
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect(mockSetConfig.mock.calls[0][1].trigger.rule.interval).toBe(3)
  })

  test('句子 + 「接下来 5 次运行」预览都在场（构建器核心价值）', () => {
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    fireEvent.click(screen.getByText('定时'))
    expect(screen.getByTestId('schedule-sentence').textContent).toContain('每周')
    expect(screen.getByTestId('schedule-preview').querySelectorAll('li')).toHaveLength(5)
  })

  test('浅校验：email_filter 谓词全空 → 拒 + 不发请求', async () => {
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('邮件事件'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText(/邮件触发至少填一项/)).toBeTruthy()
    expect(mockCreateAgent).not.toHaveBeenCalled()
  })

  // 裸 cron 文本框只剩老 `kind:'cron'` 行（legacy 态）才有 —— 新建走构建器，值模型受控、
  // 形状恒合法。故 5 段浅校验的入口改成「编辑一个老 cron 行」。
  test('浅校验：老 cron 行改成非 5 段 → 拒 + 不发请求', async () => {
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          trigger: { v: 1, kind: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC' }
        })}
        open
        onClose={() => {}}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('0 9 * * 1-5'), { target: { value: '0 9 * *' } })
    fireEvent.click(screen.getByText('保存'))
    // 精确匹配错误消息（「cron 必须是标准 5 段…」），避开 cron 提示文案（「标准 5 段 cron…」）。
    expect(await screen.findByText(/必须是标准 5 段/)).toBeTruthy()
    expect(mockSetConfig).not.toHaveBeenCalled()
  })

  // 契约 §4：老 cron 行**不自动映射**（`*/5 * * * *` 落在构建器值模型之外，静默转换会
  // 改掉用户的触发时刻）。停在 legacy 态原样保存，直到用户显式点升级。
  test('🔴 老 cron 行原样保留 kind:cron（不静默转成 schedule）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          trigger: { v: 1, kind: 'cron', cron: '*/5 * * * *', timezone: 'UTC' }
        })}
        open
        onClose={() => {}}
      />
    )
    expect((screen.getByPlaceholderText('0 9 * * 1-5') as HTMLInputElement).value).toBe(
      '*/5 * * * *'
    )
    // 构建器不渲染（没被自动升级）
    expect(screen.queryByTestId('schedule-preview')).toBeNull()
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect(mockSetConfig.mock.calls[0][1].trigger).toMatchObject({
      kind: 'cron',
      cron: '*/5 * * * *'
    })
  })

  test('老 cron 行显式升级 → 用 cron 当种子切到构建器，保存成 kind:schedule', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          trigger: { v: 1, kind: 'cron', cron: '30 7 * * 1-5', timezone: 'Asia/Shanghai' }
        })}
        open
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByText('改用排程构建器'))
    expect(screen.getByTestId('schedule-preview')).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const trigger = mockSetConfig.mock.calls[0][1].trigger
    expect(trigger.kind).toBe('schedule')
    // 种子来自原 cron：工作日 07:30，时区沿用原行
    expect(trigger.rule).toMatchObject({ freq: 'weekly', hour: 7, minute: 30 })
    expect(trigger.rule.weekdays).toEqual([1, 2, 3, 4, 5])
    expect(trigger.timezone).toBe('Asia/Shanghai')
  })

  test('编辑 kind:schedule 行 → 预填规则，不回落 cron 文本框', () => {
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          trigger: {
            v: 1,
            kind: 'schedule',
            rule: {
              freq: 'monthly',
              interval: 1,
              weekdays: [1],
              monthMode: 'date',
              monthDay: 20,
              ordinal: 1,
              weekday: 1,
              hour: 8,
              minute: 15,
              clamp: false
            },
            anchor: '2026-07-01',
            timezone: 'Asia/Shanghai'
          }
        })}
        open
        onClose={() => {}}
      />
    )
    expect(screen.queryByPlaceholderText('0 9 * * 1-5')).toBeNull()
    expect((screen.getByLabelText('每月几号') as HTMLSelectElement).value).toBe('20')
    expect((screen.getByLabelText('小时') as HTMLSelectElement).value).toBe('8')
    expect((screen.getByLabelText('分钟') as HTMLSelectElement).value).toBe('15')
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

  test('第二段失败后重试：不重复 createAgent（防 409），直接 setConfig 带全字段', async () => {
    // codex S5 复核 open P2：createAgent 成功 + setConfig 失败 → 原地重试曾重复 create 同 id 撞 409。
    mockCreateAgent.mockResolvedValue(makeCustomCfg())
    const err = new Error('invalid cron expression')
    ;(err as { code?: string }).code = 'E_INVALID_ARG'
    mockSetConfig.mockRejectedValueOnce(err).mockResolvedValueOnce(makeCustomCfg())
    const onClose = vi.fn()
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={onClose} />)
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: '巡检' } })
    fireEvent.click(screen.getByText('定时'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText(/E_INVALID_ARG/)).toBeTruthy()
    // 重试间隙用户改 title → 重试 patch 应带上（覆盖草稿行）
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), {
      target: { value: '巡检v2' }
    })
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(2))
    expect(mockCreateAgent).toHaveBeenCalledTimes(1)
    // 重试仍用首次 create 落库的 id（不因 title 变化重新 slugify）
    expect(mockSetConfig.mock.calls[1][0]).toBe(mockSetConfig.mock.calls[0][0])
    const retryPatch = mockSetConfig.mock.calls[1][1]
    expect(retryPatch.title).toBe('巡检v2')
    expect(retryPatch.trigger.kind).toBe('schedule')
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
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
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    // toolOptions 就位后 NULL 行默认勾选 = defaults（email_list_filter / email_get）；勾掉 email_list_filter
    const chip = await screen.findByRole('button', { name: 'email_list_filter', pressed: true })
    fireEvent.click(chip)
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const patch = mockSetConfig.mock.calls[0][1]
    expect('tool_policy' in patch).toBe(true)
    expect(patch.tool_policy).toEqual({ v: 1, allowed_tools: ['email_get'] })
  })

  // MCP connector PR4 T3 —— grant_connectors 进抽屉 state（第七「外部服务」卡）：打开预填、
  // 保存从 state 物化，PR3 的「照抄服务端行」carry-forward 临时块已删。这组测试钉「state
  // 往返」语义 —— 尤其 UI 三档折叠掉的存量 'write' 必须无损往返，绝不被无声升成 'update'。
  test('MCP connector：行里的 grant（含 write）只改别的能力保存 → 逐字节无损往返', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          tool_policy: {
            v: 1,
            allowed_tools: ['email_get'],
            grant_connectors: { notion: 'write' }
          }
        })}
        open
        onClose={() => {}}
      />
    )
    const chip = await screen.findByRole('button', { name: 'email_list_filter', pressed: false })
    fireEvent.click(chip)
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const tp = mockSetConfig.mock.calls[0][1].tool_policy
    // 🔴 'write'（UI 显示「可写」档）未触碰 → 原始值原样发出，不折叠成 'update'
    expect(tp.grant_connectors).toEqual({ notion: 'write' })
    expect([...tp.allowed_tools].sort()).toEqual(['email_get', 'email_list_filter'])
  })

  test('MCP connector：行里没有 grant 且未触碰第七卡 → 键不物化（PR3 前逐字节相同）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({ tool_policy: { v: 1, allowed_tools: ['email_get'] } })}
        open
        onClose={() => {}}
      />
    )
    const chip = await screen.findByRole('button', { name: 'email_list_filter', pressed: false })
    fireEvent.click(chip)
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect('grant_connectors' in mockSetConfig.mock.calls[0][1].tool_policy).toBe(false)
  })

  test('MCP connector：把仅有的 grant 关掉 → 发显式 {}（whole-map replace 清空）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          tool_policy: { v: 1, allowed_tools: ['email_get'], grant_connectors: { notion: 'read' } }
        })}
        open
        onClose={() => {}}
      />
    )
    // 第七卡 notion 行（label 来自 connector.list 的 display_name）：只读 → 关
    fireEvent.click(await screen.findByRole('button', { name: 'Notion: 关' }))
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const tp = mockSetConfig.mock.calls[0][1].tool_policy
    expect('grant_connectors' in tp).toBe(true)
    expect(tp.grant_connectors).toEqual({})
  })

  test('MCP connector：点「可写」→ canonical 写入 update（天花板档）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({ tool_policy: { v: 1, allowed_tools: ['email_get'] } })}
        open
        onClose={() => {}}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Notion: 可写' }))
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect(mockSetConfig.mock.calls[0][1].tool_policy.grant_connectors).toEqual({
      notion: 'update'
    })
  })

  test('toolOptions 失败 → 工具区显示无法加载 + 编辑保存 patch 无 tool_policy', async () => {
    mockToolOptions.mockResolvedValue({ tools: [], defaults: [] })
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
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
    // toolOptions 就位后：显式集合里的 compose_reply 选中，defaults 里的 email_list_filter 未选中
    expect(await screen.findByRole('button', { name: /compose_reply/, pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'email_list_filter', pressed: false })).toBeTruthy()
  })

  test('显式 allowed_tools 行未触碰工具区 → patch 无 tool_policy（不误清）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({ tool_policy: { v: 1, allowed_tools: ['email_list_filter'] } })}
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
    mockListRuns.mockResolvedValue({
      items: [
        { jobId: 5, agentId: 'dms_helper', state: 'paused_pending', createdAt: 1_700_000_000 }
      ],
      total: 1
    })
    mockRunNow.mockResolvedValue({ report_id: '9', status: 'generating', headline: '' })
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    // 徽标：等待审批（永不渲染为成功）
    expect(await screen.findByText('等待审批')).toBeTruthy()
    expect(screen.queryByText('已完成')).toBeNull()
    // pending 提示文案（S6 W2：可打开执行记录批准，或岛批准）—— 唯一子串定位，避免撞徽标文字
    expect(screen.getByText(/打开执行记录即可批准/)).toBeTruthy()
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
    expect(screen.getByText('/usr/bin/python3 /skills/dms-cli/approve.py <pattern>')).toBeTruthy()
    // dormant 恰出现一次（只有 cron_headless 那条失配）
    expect(screen.getAllByText(/休眠：触发类型已变更/)).toHaveLength(1)
  })

  // 🔴 07-24：schedule 与 cron 同族 → cron_headless。漏这条映射时该区会显示
  // 「未配置触发（规则将处于休眠）」并把所有免卡规则标成 dormant —— 排程型 agent 的
  // 自动化策略整片失真。
  test('schedule 触发 → 策略区按 cron_headless 呈现，cron_headless 规则不 dormant', async () => {
    mockListPolicyRules.mockResolvedValue([makeRule({ contextMode: 'cron_headless' })])
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          trigger: {
            v: 1,
            kind: 'schedule',
            rule: {
              freq: 'daily',
              interval: 1,
              weekdays: [1],
              monthMode: 'date',
              monthDay: 1,
              ordinal: 1,
              weekday: 1,
              hour: 9,
              minute: 0,
              clamp: false
            },
            anchor: '2026-07-24',
            timezone: 'America/Los_Angeles'
          }
        })}
        open
        onClose={() => {}}
      />
    )
    expect(await screen.findByText('email_flag')).toBeTruthy()
    expect(screen.queryByText(/休眠：触发类型已变更/)).toBeNull()
    expect(screen.queryByText(/未配置触发（规则将处于休眠）/)).toBeNull()
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
    expect(screen.getByText(/「DMS 审批助手」将在无人确认时自动执行 compose_reply/)).toBeTruthy()
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
    fireEvent.click(await screen.findByRole('button', { name: '文件与命令: 开启' }))
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
    fireEvent.click(await screen.findByRole('button', { name: '文件与命令: 开启' }))
    await screen.findByText(/确定开启/)
    // 「取消」出现两处（grant 确认块 + 抽屉 footer）—— 确认块的在 DOM 前（body 先于 footer）。
    fireEvent.click(screen.getAllByText('取消')[0])
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect('tool_policy' in mockSetConfig.mock.calls[0][1]).toBe(false)
  })

  test('run 行免卡 badge：autoWhitelistedWrites>0 渲染 ×N；null（账本不可达）不渲染', async () => {
    mockListRuns.mockResolvedValue({
      items: [
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
      ],
      total: 2
    })
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    expect(await screen.findByText('自动放行 ×2')).toBeTruthy()
    // null 行不渲染 badge（不渲染 ≠ 0 次）—— 全列表恰一个 badge
    expect(screen.getAllByText(/自动放行/)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// S6 W3-3 — grants 区（web 三档 + skill 挂载 + web 域名规则构造器）
// ---------------------------------------------------------------------------

describe('CustomAgentDrawer — web grant 三档（S6 W3-3）', () => {
  test('三档 seg 在场；选 gated → 保存 patch.tool_policy.grant_web=gated（NULL 行不物化 allowed_tools/skills）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    // 联网块 + 三档在场
    expect(await screen.findByText('Web')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Web: 域名门控' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Web: 全开放' })).toBeTruthy()
    // 默认 off → 无 web_search 外送警示
    expect(screen.queryByText(/web_search 免审批外送/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Web: 域名门控' }))
    // gated → 连带 web_search 外送警示在场（§6 残余面① UI 明示义务）
    expect(await screen.findByText(/web_search 免审批外送/)).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    // NULL 行只带 grant_web；allowed_tools / skills 缺省（默认集不物化）
    expect(mockSetConfig.mock.calls[0][1].tool_policy).toEqual({ v: 1, grant_web: 'gated' })
  })

  test('open 档：红样式全开放警示 + email_filter（untrusted_trigger）叠加最大暴露面警示', async () => {
    // cfg trigger = email_filter → 派生 untrusted_trigger → open 档叠加警示。
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Web: 全开放' }))
    expect(await screen.findByText(/可免审批抓取任意 URL/)).toBeTruthy()
    expect(screen.getByText(/最大暴露面组合/)).toBeTruthy()
  })

  test('cron 触发 agent 选 open → 无「最大暴露面」叠加警示（仅 untrusted_trigger 才叠加）', async () => {
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          tool_policy: null,
          trigger: { v: 1, kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' }
        })}
        open
        onClose={() => {}}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Web: 全开放' }))
    expect(await screen.findByText(/可免审批抓取任意 URL/)).toBeTruthy()
    expect(screen.queryByText(/最大暴露面组合/)).toBeNull()
  })

  test('只翻 grant_web 不抹掉其它 tool_policy 键（W3-2 教训：整体重建自 state）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({
          tool_policy: {
            v: 1,
            allowed_tools: ['email_list_filter'],
            grant_exec: true,
            skills: ['email']
          }
        })}
        open
        onClose={() => {}}
      />
    )
    // 等 registry/工具就位后翻 web 档
    fireEvent.click(await screen.findByRole('button', { name: 'Web: 域名门控' }))
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    // 所有键保留：allowed_tools（显式）+ grant_exec + skills（显式）+ 新的 grant_web
    expect(mockSetConfig.mock.calls[0][1].tool_policy).toEqual({
      v: 1,
      allowed_tools: ['email_list_filter'],
      grant_exec: true,
      grant_web: 'gated',
      skills: ['email']
    })
  })
})

// ---------------------------------------------------------------------------
// R3 (task 07-05) — 工具分组 + 额外能力区 + openness flag 接线
// ---------------------------------------------------------------------------

describe('CustomAgentDrawer — 工具分组（R3）', () => {
  test('分组渲染：已映射工具进家族组，未映射 compose_reply 落「其他」组（不静默丢）', async () => {
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    expect(await screen.findByText('邮件读取')).toBeTruthy()
    expect(screen.getByText('其他')).toBeTruthy()
    expect(screen.getByRole('button', { name: /compose_reply/ })).toBeTruthy()
  })

  test('组级清空：NULL 行默认勾选 defaults → 清空邮件读取组 → 保存 allowed_tools=[]', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    await screen.findByRole('button', { name: 'email_list_filter', pressed: true })
    // 每组一个「清空」——第一个 = 邮件读取组（defaults 两工具都在此组）
    fireEvent.click(screen.getAllByText('清空')[0])
    expect(screen.getByRole('button', { name: 'email_list_filter', pressed: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'email_get', pressed: false })).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect(mockSetConfig.mock.calls[0][1].tool_policy).toEqual({ v: 1, allowed_tools: [] })
  })

  test('组级全选：「其他」组全选 → compose_reply 加入选择（组内 chip 仍可单控）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    await screen.findByRole('button', { name: /compose_reply/, pressed: false })
    // 每组一个「全选」——第二个 = 其他组（compose_reply）
    fireEvent.click(screen.getAllByText('全选')[1])
    expect(screen.getByRole('button', { name: /compose_reply/, pressed: true })).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect(mockSetConfig.mock.calls[0][1].tool_policy).toEqual({
      v: 1,
      allowed_tools: ['email_list_filter', 'email_get', 'compose_reply']
    })
  })
})

describe('CustomAgentDrawer — 六能力卡（W5）', () => {
  test('默认视图显示六张卡、知识默认关闭，并保留高级原子工具入口', async () => {
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    for (const title of ['邮件', '日历', '知识与会话', '报告', 'Web', '文件与命令']) {
      expect(await screen.findByRole('heading', { name: title })).toBeTruthy()
    }
    expect(screen.getByRole('button', { name: '知识与会话: 关闭', pressed: true })).toBeTruthy()
    expect(screen.getByText('高级：逐工具微调')).toBeTruthy()
  })

  test('起草/日历写/报告产出映射完整，日历写永久 HITL 提示在场', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    const emailDraft = await screen.findByRole('button', { name: '邮件: 起草' })
    await vi.waitFor(() => expect(emailDraft.hasAttribute('disabled')).toBe(false))
    fireEvent.click(emailDraft)
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: '邮件: 起草' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: '日历: 写入' }))
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: '日历: 写入' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: '报告: 产出' }))
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: '报告: 产出' }).getAttribute('aria-pressed')).toBe(
        'true'
      )
    )
    expect(await screen.findByText(/日历写操作永久需要人工审批/)).toBeTruthy()
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const tools = mockSetConfig.mock.calls[0][1].tool_policy.allowed_tools as string[]
    expect(tools).toEqual(
      expect.arrayContaining([
        'email_draft_reply',
        'email_draft_compose',
        'email_draft_update',
        'calendar_event_reschedule',
        'calendar_event_rsvp',
        'calendar_event_delete',
        'report_write'
      ])
    )
  })
})

describe('CustomAgentDrawer — 额外能力区 + openness flag 接线（R3）', () => {
  test('webToolsEnabled=false → 三档禁用 + 提示；execPolicyEnabled=false → exec 提示 + 开关失效', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { webToolsEnabled: false, execPolicyEnabled: false } })
    }) as unknown as typeof fetch
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    expect(await screen.findByText(/联网功能未开启/)).toBeTruthy()
    expect(screen.getByText(/命令执行功能未开启/)).toBeTruthy()
    // 三档按钮带 disabled；点击不生效（无 web_search 外送警示）
    const gated = screen.getByRole('button', { name: 'Web: 域名门控' }) as HTMLButtonElement
    expect(gated.disabled).toBe(true)
    fireEvent.click(gated)
    expect(screen.queryByText(/web_search 免审批外送/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '文件与命令: 开启' }))
    expect(screen.queryByText(/确定开启/)).toBeNull()
    // clearAllMocks 只清调用记录不清 mockResolvedValue 实现 —— 显式恢复空 fetch，
    // 防 flag-off 响应残留污染后续用例（useOpennessFlags 会读到 stale false → 误禁用）。
    global.fetch = vi.fn() as unknown as typeof fetch
  })

  test('旧后端无字段（undefined）→ 按现状渲染不禁用（可切档）', async () => {
    // afterEach clearAllMocks 后 global.fetch 空实现 → useOpennessFlags 捕获异常回 {}。
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Web: 域名门控' }))
    expect(await screen.findByText(/web_search 免审批外送/)).toBeTruthy()
  })

  test('create 模式渲染额外能力区；授 gated → 二段 setConfig tool_policy 带 grant_web', async () => {
    mockCreateAgent.mockResolvedValue(makeCustomCfg())
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    const onClose = vi.fn()
    renderUi(<CustomAgentDrawer cfg={null} open create onClose={onClose} />)
    expect(await screen.findByText('能力与权限')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('如 DMS 审批助手'), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('定时'))
    fireEvent.click(screen.getByRole('button', { name: 'Web: 域名门控' }))
    fireEvent.click(screen.getByText('创建'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    const patch = mockSetConfig.mock.calls[0][1]
    expect(patch.tool_policy.grant_web).toBe('gated')
    // 新建仍恒发显式集合（安全方向不变）
    expect(Array.isArray(patch.tool_policy.allowed_tools)).toBe(true)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('CustomAgentDrawer — skill 挂载（S6 W3-3）', () => {
  test('NULL skills 行 → 默认挂载集 email/search/report 预选（defaultTag 在场）；未触碰不写 skills 键', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    // 默认挂载集标签 + email/search/report 预选、dms-approval 未选
    expect(await screen.findByText(/默认挂载集/)).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'email', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'search', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'report', pressed: true })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'dms-approval', pressed: false })).toBeTruthy()
    // 未触碰挂载区，仅改 prompt → patch 无 tool_policy（NULL 保持 NULL，默认挂载集不物化）
    fireEvent.change(screen.getByPlaceholderText(/描述这个 Agent/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    expect('tool_policy' in mockSetConfig.mock.calls[0][1]).toBe(false)
  })

  test('挂载一个 skill → 保存带显式 skills 列表（含默认集 + 新增）', async () => {
    mockSetConfig.mockResolvedValue(makeCustomCfg())
    renderUi(
      <CustomAgentDrawer cfg={makeCustomCfg({ tool_policy: null })} open onClose={() => {}} />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'dms-approval', pressed: false }))
    fireEvent.click(screen.getByText('保存'))
    await vi.waitFor(() => expect(mockSetConfig).toHaveBeenCalledTimes(1))
    // 触碰挂载 → 显式列表（defaults email/search/report + dms-approval）；allowed_tools 缺省（NULL 不物化）
    expect(mockSetConfig.mock.calls[0][1].tool_policy).toEqual({
      v: 1,
      skills: ['email', 'search', 'report', 'dms-approval']
    })
  })

  test('显式挂载行（含卸载后仍挂载的未知名）→ chip 仍可见（strict-effect）', async () => {
    renderUi(
      <CustomAgentDrawer
        cfg={makeCustomCfg({ tool_policy: { v: 1, skills: ['email', 'ghost-skill'] } })}
        open
        onClose={() => {}}
      />
    )
    // registry 无 ghost-skill，但显式挂载 → union 仍渲染为选中 chip（可解绑）
    expect(await screen.findByRole('button', { name: 'ghost-skill', pressed: true })).toBeTruthy()
    // 默认标签不显（显式行）
    expect(screen.queryByText(/默认挂载集/)).toBeNull()
  })
})

describe('CustomAgentDrawer — web 域名规则构造器（S6 W3-3）', () => {
  test('web capability → 输入 origin → 两步确认 → createPolicyRule({capability:web, matcher:{v:1,origin}})', async () => {
    mockCreatePolicyRule.mockResolvedValue(makeRule({ id: 9, capability: 'web' }))
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('新建规则'))
    // 切到 web capability（seg 第三项）
    fireEvent.click(screen.getByText('放行联网域名'))
    fireEvent.change(screen.getByPlaceholderText(/域名或完整 URL/), {
      target: { value: 'https://api.vendor.com/v1?q=1' }
    })
    fireEvent.click(screen.getByText('创建'))
    // 红样式影响面确认在场，未确认前不发请求
    expect(await screen.findByText('高危：免审批自动执行')).toBeTruthy()
    expect(mockCreatePolicyRule).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('我已了解，创建规则'))
    await vi.waitFor(() => expect(mockCreatePolicyRule).toHaveBeenCalledTimes(1))
    // 提交原文（服务端 _normalize_origin 归一入库，TS 不自归一）
    expect(mockCreatePolicyRule.mock.calls[0][0]).toEqual({
      capability: 'web',
      matcher: { v: 1, origin: 'https://api.vendor.com/v1?q=1' },
      agentId: 'dms_helper'
    })
  })

  test('web 浅校验：origin 空 → 拒 + 不发请求', async () => {
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('新建规则'))
    fireEvent.click(screen.getByText('放行联网域名'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText(/请填写要放行的域名或完整 URL/)).toBeTruthy()
    expect(mockCreatePolicyRule).not.toHaveBeenCalled()
  })

  test('web 建规后端 400 透出（非法 origin / userinfo）', async () => {
    const err = new Error('origin must be http(s)://host[:port]')
    ;(err as { code?: string }).code = 'E_INVALID_ARG'
    mockCreatePolicyRule.mockRejectedValue(err)
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    fireEvent.click(await screen.findByText('新建规则'))
    fireEvent.click(screen.getByText('放行联网域名'))
    fireEvent.change(screen.getByPlaceholderText(/域名或完整 URL/), {
      target: { value: 'ftp://x.com' }
    })
    fireEvent.click(screen.getByText('创建'))
    fireEvent.click(await screen.findByText('我已了解，创建规则'))
    expect(await screen.findByText(/E_INVALID_ARG: origin must be/)).toBeTruthy()
  })

  test('规则列表渲染 web 规则（归一 origin 直接展示）', async () => {
    mockListPolicyRules.mockResolvedValue([
      makeRule({
        id: 3,
        capability: 'web',
        matcher: { v: 1, origin: 'https://api.vendor.com:443' }
      })
    ])
    renderUi(<CustomAgentDrawer cfg={makeCustomCfg()} open onClose={() => {}} />)
    expect(await screen.findByText('https://api.vendor.com:443')).toBeTruthy()
  })
})

describe('RunStateBadge — 9 状态穷举渲染', () => {
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
