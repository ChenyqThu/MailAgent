// @vitest-environment happy-dom
//
// task 08-27 P4d — 日历详情抽屉按源分形态（共用外壳）:
//   ① matter 形态四样字段全部从事项详情端点就地算 —— 🔴「下一步」必须走
//      `matterDerive.nextAction()` 从 items 派生，读 `matter.next_action`（清单端点才有的
//      投影）在详情端点上恒空，fixture 里放了一条**诱饵**来钉死这一点；
//   ② 投影两源不给编辑 / 删除 / RSVP，且面上要写清「它是投影，改要去源头」；
//   ③ 「上次跑的结果」是**可缺省块**：有数据才渲染，拿不到整段不出现（两向都测，
//      只测一向是恒绿装饰）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { AgendaEntry, CalendarEventOccurrence } from '../../src/shared/api/types'
import type { MatterDetailResponse } from '../../src/shared/api/types/matter'

const { matterGet, matterOpen, navSpy, reportState, configState, runsState } = vi.hoisted(() => ({
  matterGet: vi.fn(),
  matterOpen: vi.fn(),
  navSpy: vi.fn(),
  reportState: { report: null as unknown },
  configState: { agents: [] as unknown[] },
  runsState: { runs: [] as unknown[] }
}))

// t(key, defaultString?, vars?) —— 有默认串按默认串插值；没有默认串（复用团队页那批 key）
// 回落成 `key:值1|值2`，让断言看得见插进去的是什么。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (k: string, second?: unknown, third?: unknown) => {
      const dflt = typeof second === 'string' ? second : null
      const vars = (typeof second === 'object' && second !== null ? second : third) as
        | Record<string, unknown>
        | undefined
      if (dflt === null) {
        return vars ? `${k}:${Object.values(vars).join('|')}` : k
      }
      let s = dflt
      if (vars) for (const [key, v] of Object.entries(vars)) s = s.replaceAll(`{${key}}`, String(v))
      return s
    }
  })
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@shared/navigation/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/navigation/registry')>()
  return { ...actual, navigateToNavEntry: navSpy }
})

vi.mock('@shared/components/matters/navigation', () => ({
  useMatterNavigation: { getState: () => ({ open: matterOpen }) }
}))

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({ get: matterGet })
}))

vi.mock('@shared/components/agents/hooks', () => ({
  useReportConfig: () => ({ agents: configState.agents, isLoading: false }),
  useLatestReport: () => reportState.report,
  useAgentRuns: (agentId: string | null) => ({
    runs: agentId === null ? [] : runsState.runs,
    isLoading: false,
    refetch: vi.fn(),
    total: 0,
    hasMore: false,
    isLoadingMore: false,
    loadMore: vi.fn()
  })
}))

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', () => ({
  CALENDAR_EVENTS_KEY: ['calendar', 'events'],
  useCalendarEvent: () => ({ data: null, isLoading: false }),
  useCalendarNames: () => ({ data: [], isLoading: false })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    settings: { get: vi.fn().mockResolvedValue({ userEmail: 'me@example.test' }) },
    calendar: {
      eventRsvp: vi.fn(),
      eventDelete: vi.fn(),
      eventCreate: vi.fn(),
      eventUpdate: vi.fn(),
      eventSourceEmail: vi.fn().mockResolvedValue(null)
    },
    report: { list: vi.fn().mockResolvedValue({ items: [], total: 0 }) }
  })
}))

vi.mock('@shared/state/toast', () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

import { EventDetailDrawer } from '../../src/shared/components/calendar/EventDetailDrawer'
import { useAgendaDetail } from '../../src/shared/state/calendar-agenda-detail'
import { navEntry } from '../../src/shared/navigation/registry'

function matterEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
  return {
    id: 'matter:MAT-3',
    source: 'matter',
    hot: false,
    title: '合同交付截止',
    startIso: '2026-09-02T09:00:00+00:00',
    endIso: null,
    allDay: false,
    multiDay: false,
    matterId: 'MAT-3',
    ...over
  }
}

function agentEntry(over: Partial<AgendaEntry> = {}): AgendaEntry {
  return {
    id: 'agent:daily_email_digest:2026-09-02T01:00:00+00:00',
    source: 'agent',
    hot: false,
    title: '邮件日报',
    startIso: '2026-09-02T01:00:00+00:00',
    endIso: null,
    allDay: false,
    multiDay: false,
    agentId: 'daily_email_digest',
    ...over
  }
}

function occurrence(): CalendarEventOccurrence {
  return {
    id: 42,
    ical_uid: 'uid-proj-42',
    recurrence_id: null,
    sequence: 0,
    summary: '架构评审会',
    occurrence_start_iso: '2026-09-02T02:00:00+00:00',
    occurrence_end_iso: '2026-09-02T03:00:00+00:00',
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    organizer: 'boss@example.test',
    attendees: [],
    location: '',
    url: '',
    status: 'CONFIRMED',
    response_status: 'NEEDS-ACTION',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: null
  }
}

function matterDetail(over: Partial<MatterDetailResponse> = {}): MatterDetailResponse {
  return {
    matter: {
      id: 3,
      public_id: 'MAT-3',
      title: '与 Acme 的续约',
      background: '',
      goal: '',
      matter_type: null,
      tags: [],
      status: 'active',
      health: 'off_track',
      priority: 'p1',
      owner_id: '',
      source: 'manual',
      due_at: 1_756_800_000_000,
      waiting_context: null,
      next_attention_at: null,
      attention_reason: '对方法务两周没回',
      last_activity_at: null,
      latest_accepted_update_id: null,
      current_summary: null,
      summary_at: null,
      summary_by_kind: null,
      summary_by_id: null,
      version: 4,
      archived_at: null,
      archived_by_kind: null,
      archived_by_id: null,
      deleted_at: null,
      deleted_by_kind: null,
      deleted_by_id: null,
      purge_after: null,
      created_at: 1_756_000_000_000,
      updated_at: 1_756_700_000_000,
      // 🔴 诱饵：清单端点的投影。详情端点**不产出**这个字段，实现若图省事读它，
      // 下面「下一步」的断言会当场看到这句而不是 items 里那条。
      next_action: { kind: 'action', title: '清单投影的下一步', due_at: null }
    },
    items: [
      {
        id: 11,
        matter_id: 3,
        kind: 'action',
        title: '把终稿发给法务',
        description: null,
        position: 1,
        status: 'open',
        priority: null,
        owner_kind: null,
        owner_id: null,
        waiting_on_stakeholder_id: null,
        due_at: null,
        completed_at: null,
        checklist: [],
        source_resource_id: null,
        source_locator: null,
        created_at: 1,
        updated_at: 1,
        deleted_at: null
      },
      {
        id: 12,
        matter_id: 3,
        kind: 'blocker',
        title: '等对方法务确认赔偿条款',
        description: null,
        position: 2,
        status: 'open',
        priority: null,
        owner_kind: null,
        owner_id: null,
        waiting_on_stakeholder_id: null,
        due_at: null,
        completed_at: null,
        checklist: [],
        source_resource_id: null,
        source_locator: null,
        created_at: 1,
        updated_at: 1,
        deleted_at: null
      }
    ],
    progress: [
      {
        id: 5,
        matter_id: 3,
        kind: 'progress',
        title: '法务给了第二版意见',
        body: null,
        happened_at: Date.now() - 3_600_000,
        actor_kind: 'user',
        actor_id: null,
        source: 'manual',
        refs: [],
        version: 1,
        deleted_at: null,
        created_at: 1,
        updated_at: 1
      }
    ],
    timeline: [],
    ...over
  }
}

function renderDrawer(
  entry: AgendaEntry | null,
  occ: CalendarEventOccurrence | null = null,
  onClose: () => void = () => {}
): void {
  if (entry) useAgendaDetail.getState().open(entry)
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={qc}>
      <EventDetailDrawer occurrence={occ} onClose={onClose} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  // 🔴 默认值必须在 beforeEach 给: 只在 afterEach 铺的话第一个跑到的用例拿到的是
  // 没有实现的 mock（返回 undefined），react-query 直接抛「data cannot be undefined」。
  matterGet.mockReset().mockResolvedValue(matterDetail())
  matterOpen.mockReset()
  navSpy.mockReset()
  reportState.report = null
  configState.agents = []
  runsState.runs = []
})

afterEach(() => {
  cleanup()
  useAgendaDetail.getState().close()
})

describe('EventDetailDrawer — matter 投影形态', () => {
  test('四样字段: 下一步走 items 派生 (不是清单投影) · 负责人 · 阻塞点 · 最近进展', async () => {
    renderDrawer(matterEntry())

    await waitFor(() => expect(screen.getByText(/把终稿发给法务/)).toBeTruthy())
    // 🔴 派生来源钉死: 读 matter.next_action 的实现会在这里露出诱饵
    expect(screen.queryByText(/清单投影的下一步/)).toBeNull()
    // 事项名 + 负责人未指定 + 阻塞条目 + off_track 的关注原因 + 最新一条进展
    expect(screen.getByText('与 Acme 的续约')).toBeTruthy()
    expect(screen.getByText('未指定')).toBeTruthy()
    expect(screen.getByText('等对方法务确认赔偿条款')).toBeTruthy()
    expect(screen.getByText('对方法务两周没回')).toBeTruthy()
    expect(screen.getByText('法务给了第二版意见')).toBeTruthy()
    // 事项详情按同一条 queryKey / include 取（与事项域共享缓存）
    expect(matterGet).toHaveBeenCalledWith('MAT-3', ['items', 'progress', 'timeline'])
  })

  test('行动项条目在头部点名是哪一条', async () => {
    renderDrawer(matterEntry({ id: 'matter-item:11', itemId: '11', title: '把终稿发给法务' }))
    await waitFor(() => expect(screen.getByText('行动项')).toBeTruthy())
    expect(screen.getAllByText('把终稿发给法务').length).toBeGreaterThan(0)
  })

  test('取不到详情 → 说清没取到 + 重试, 不留空壳', async () => {
    matterGet.mockRejectedValue(new Error('boom'))
    renderDrawer(matterEntry())
    await waitFor(() => expect(screen.getByText('没取到这件事的详情')).toBeTruthy())
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  test('「去事项」跳转 + 关抽屉清槽位', async () => {
    const onClose = vi.fn()
    renderDrawer(matterEntry(), null, onClose)
    await waitFor(() => expect(screen.getByRole('button', { name: /去事项/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /去事项/ }))
    expect(matterOpen).toHaveBeenCalledWith('MAT-3')
    expect(navSpy).toHaveBeenLastCalledWith(expect.anything(), navEntry('matters'))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(useAgendaDetail.getState().entry).toBeNull()
  })
})

describe('EventDetailDrawer — 投影不给编辑与删除', () => {
  // 🔴 同时有 occurrence（刚看过一场会）与投影时**投影在前**：mail 专属的编辑 / 删除 /
  // RSVP / 关联邮件一个都不许漏到投影形态上。少了这条前置，「没有编辑按钮」在
  // occurrence=null 的用例里是恒绿的（那时候本来就什么都不渲染）。
  test('matter 形态: 无编辑 / 删除 / RSVP, 有「它是投影」的说明', async () => {
    renderDrawer(matterEntry(), occurrence())
    await waitFor(() => expect(screen.getByText('事项投影')).toBeTruthy())
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.queryByRole('button', { name: '接受' })).toBeNull()
    expect(screen.queryByText('关联邮件')).toBeNull()
    expect(screen.getByText('这是事项的投影 —— 改时间或内容要去事项里改')).toBeTruthy()
  })

  test('occurrence 换了 (j/k 巡航 Enter) → 投影让位给邮件详情', async () => {
    useAgendaDetail.getState().open(matterEntry())
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } }
    })
    const { rerender } = render(
      <QueryClientProvider client={qc}>
        <EventDetailDrawer occurrence={occurrence()} onClose={() => {}} />
      </QueryClientProvider>
    )
    await waitFor(() => expect(screen.getByText('事项投影')).toBeTruthy())

    rerender(
      <QueryClientProvider client={qc}>
        <EventDetailDrawer
          occurrence={{ ...occurrence(), ical_uid: 'uid-proj-43', summary: '另一场会' }}
          onClose={() => {}}
        />
      </QueryClientProvider>
    )
    await waitFor(() => expect(useAgendaDetail.getState().entry).toBeNull())
    expect(screen.getByText('另一场会')).toBeTruthy()
  })

  test('agent 形态: 无编辑 / 删除, 有「它是投影」的说明', async () => {
    configState.agents = [reportAgent()]
    renderDrawer(agentEntry(), occurrence())
    await waitFor(() => expect(screen.getByText('Agent 排程')).toBeTruthy())
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(screen.getByText('这是排程的投影 —— 改时间要去 Agent 的设置里改')).toBeTruthy()
  })
})

function reportAgent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'daily_email_digest',
    type: 'report',
    enabled: true,
    title: '邮件日报',
    description: '每天早上把昨天的邮件收成一份日报',
    schedule: {
      cadence: 'daily',
      hours: [9],
      v: 1,
      kind: 'schedule',
      rule: { freq: 'daily', interval: 1, weekdays: [], monthMode: 'date', monthDay: 1 },
      timezone: 'Asia/Shanghai'
    },
    window_hours: 24,
    prompt: '',
    prompt_is_default: true,
    model: 'x',
    kos_enrich: false,
    trigger_mode: 'rolling_24h',
    timezone: 'Asia/Shanghai',
    body_full_priorities: [],
    mark_read_after_processing: true,
    trigger: null,
    updated_at: null,
    ...over
  }
}

describe('EventDetailDrawer — agent 投影形态', () => {
  test('这次要跑什么 + 触发规则 (排程句子)', async () => {
    configState.agents = [reportAgent()]
    renderDrawer(agentEntry())
    await waitFor(() => expect(screen.getByText('这次要跑什么')).toBeTruthy())
    expect(screen.getByText('每天早上把昨天的邮件收成一份日报')).toBeTruthy()
    expect(screen.getByText('触发规则')).toBeTruthy()
    // trigger 恒 null 的报告型 → 回落排程句子（key 复用团队页卡片那条）
    expect(screen.getByText(/agents\.custom\.card\.triggerSchedule/)).toBeTruthy()
  })

  test('v2 envelope: 每条触发一行, 单独停用的那条标出来', async () => {
    configState.agents = [
      reportAgent({
        id: 'custom-1',
        type: 'custom',
        trigger: {
          v: 2,
          triggers: [
            {
              kind: 'schedule',
              enabled: true,
              rule: { freq: 'daily', interval: 1 },
              anchor: '2026-09-01',
              timezone: 'Asia/Shanghai'
            },
            { kind: 'email_filter', enabled: false, subject_pattern: '发票' }
          ]
        }
      })
    ]
    renderDrawer(agentEntry({ agentId: 'custom-1' }))
    await waitFor(() => expect(screen.getByText('触发规则')).toBeTruthy())
    expect(screen.getByText(/agents\.custom\.card\.triggerSchedule/)).toBeTruthy()
    expect(screen.getByText(/agents\.custom\.card\.triggerEmail.*已停用/)).toBeTruthy()
  })

  test('配置没取到 → 说清楚, 不渲染触发规则区', async () => {
    configState.agents = []
    renderDrawer(agentEntry())
    await waitFor(() => expect(screen.getByText('这个 Agent 的配置没取到')).toBeTruthy())
    expect(screen.queryByText('触发规则')).toBeNull()
  })
})

describe('EventDetailDrawer — 「上次跑的结果」是可缺省块', () => {
  test('自定义 agent 有 run → 渲染状态与摘要', async () => {
    configState.agents = [reportAgent({ id: 'custom-1', type: 'custom' })]
    runsState.runs = [
      {
        jobId: 9,
        agentId: 'custom-1',
        state: 'completed',
        outcome: 'completed',
        summary: '扫了 34 封, 标了 6 封要回',
        createdAt: 1_756_700_000_000,
        finishedAt: 1_756_700_060_000,
        durationSeconds: 61
      }
    ]
    renderDrawer(agentEntry({ agentId: 'custom-1' }))
    await waitFor(() => expect(screen.getByText('上次跑的结果')).toBeTruthy())
    expect(screen.getByText('扫了 34 封, 标了 6 封要回')).toBeTruthy()
  })

  test('自定义 agent 没有 run → 整段不渲染 (不写「暂无记录」)', async () => {
    configState.agents = [reportAgent({ id: 'custom-1', type: 'custom' })]
    runsState.runs = []
    renderDrawer(agentEntry({ agentId: 'custom-1' }))
    await waitFor(() => expect(screen.getByText('触发规则')).toBeTruthy())
    expect(screen.queryByText('上次跑的结果')).toBeNull()
  })

  test('报告型: 有最近一篇 → 渲染状态与标题行; 没有 → 整段不渲染', async () => {
    configState.agents = [reportAgent()]
    reportState.report = {
      id: 'r-1',
      agent_id: 'daily_email_digest',
      cadence: 'daily',
      report_date: '2026-09-01',
      window_start: '',
      window_end: '',
      status: 'ready',
      counts: { total: 12 },
      headline: '昨天 12 封, 3 封等你回',
      model: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      error: null,
      created_at: null,
      generated_at: 1_756_700_000_000
    }
    renderDrawer(agentEntry())
    await waitFor(() => expect(screen.getByText('上次跑的结果')).toBeTruthy())
    expect(screen.getByText('昨天 12 封, 3 封等你回')).toBeTruthy()
    expect(screen.getByText(/已生成/)).toBeTruthy()

    cleanup()
    useAgendaDetail.getState().close()
    reportState.report = null
    renderDrawer(agentEntry())
    await waitFor(() => expect(screen.getByText('触发规则')).toBeTruthy())
    expect(screen.queryByText('上次跑的结果')).toBeNull()
  })

  test('「去 Agent」跳团队域', async () => {
    configState.agents = [reportAgent()]
    renderDrawer(agentEntry())
    await waitFor(() => expect(screen.getByRole('button', { name: /去 Agent/ })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /去 Agent/ }))
    expect(navSpy).toHaveBeenLastCalledWith(expect.anything(), navEntry('agents'))
    expect(useAgendaDetail.getState().entry).toBeNull()
  })
})
