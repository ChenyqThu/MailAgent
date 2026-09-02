// @vitest-environment happy-dom
//
// g3 lane U — 群详情面在狼人杀预设下的 family 用量与地板占位。
//
//   F1 preset + familySessionIds [M,W,S] → 三个群各查一次 metrics，turn / cost **相加**
//      （不是平均：跨群平均没有意义），上限文案用 WEREWOLF_SESSION_TURN_CAP；
//   F2 任一群 sessionCostUsd 为 null → 整体显示「未知」（把未知当 0 会读成一个偏低的确定数）；
//   F3 非 preset → 只查本群（不发 family 三查）、没有「本局合计」行；
//   F4 数值项占位：preset 时 chainCap 的占位是 WEREWOLF_CHAIN_CAP（数值不落库，输入框留空时
//      要显示的是调度器实际会用的那个数）。
//
// 🔴 判据常量全部 import 自 groupFloors，测试里零裸数字。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const mockGetGroupConfig = vi.fn()
const mockGetGroupMetrics = vi.fn()
const mockGetGroupTurns = vi.fn()
vi.mock('@shared/api/groupSettings', () => ({
  getGroupConfig: (...args: unknown[]) => mockGetGroupConfig(...args),
  setGroupConfig: vi.fn(),
  getGroupMetrics: (...args: unknown[]) => mockGetGroupMetrics(...args),
  getGroupTurns: (...args: unknown[]) => mockGetGroupTurns(...args),
  patchGroupMembers: vi.fn(),
  getLabs: vi.fn(),
  setLabs: vi.fn()
}))

vi.mock('@shared/api/http_client', () => ({ request: vi.fn() }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    chat: {
      listMessages: vi.fn().mockResolvedValue([]),
      updateSessionTitle: vi.fn(),
      deleteSession: vi.fn()
    }
  })
}))

vi.mock('@shared/hooks/useLlmModels', () => ({
  useEnabledModels: () => ({ models: ['claude-opus-4-8'], rawEnabled: ['claude-opus-4-8'] }),
  fetchChatConfigModelsProbe: vi.fn().mockResolvedValue({
    enabledModels: ['claude-opus-4-8'],
    providerRegistryEnabled: false,
    kosConsumerEnabled: false,
    kosConfigured: false
  })
}))

vi.mock('../../src/shared/components/agents/AgentAvatar', () => ({
  AgentAvatar: (props: { agentId: string }) => <span data-avatar={props.agentId} />
}))

import i18n from '@shared/i18n'
import type { ChatSession, ReportAgentConfig } from '@shared/api/types'
import type { GroupConfig, GroupMetrics } from '@shared/chat_model'
import { GroupDetailsPane } from '../../src/shared/components/agents/groups/GroupDetailsPane'
import type { GroupMemberMeta } from '../../src/shared/components/agents/groups/members'
import { WEREWOLF_CHAIN_CAP, WEREWOLF_SESSION_TURN_CAP } from '../../src/ai-gateway/groupFloors'

await i18n.changeLanguage('zh-CN')

const FAMILY = [901, 902, 903]

const SESSION: ChatSession = {
  id: 901,
  email_id: null,
  anchor_type: 'general',
  anchor_id: null,
  backend_kind: 'ai-sdk',
  backend_model: null,
  backend_agent_page_id: null,
  title: '狼人杀 #1',
  archived: false,
  created_at: 1,
  updated_at: 1,
  origin: 'group',
  members_json: '["judge","p1"]'
}

const MEMBER_META = new Map<string, GroupMemberMeta>([
  ['judge', { title: '法官' }],
  ['p1', { title: '玩家甲' }]
])

const CANDIDATES = [
  { id: 'judge', type: 'custom', enabled: true, title: '法官' }
] as ReportAgentConfig[]

function metrics(over: Partial<GroupMetrics> = {}): GroupMetrics {
  return {
    silentRunRate: null,
    turnsPerHumanMessage: null,
    last1h: { turns: 0, tokens: 0, costUsd: null },
    last24h: { turns: 0, tokens: 0, costUsd: null },
    lastStopReason: null,
    sessionTurns: 0,
    sessionTokens: 0,
    sessionCostUsd: null,
    ...over
  }
}

function renderPane(config: GroupConfig, familySessionIds = FAMILY): void {
  mockGetGroupConfig.mockResolvedValue({
    modes: {},
    config,
    members: ['judge', 'p1'],
    judgeScopeStale: false
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <GroupDetailsPane
        sessionId={901}
        session={SESSION}
        memberIds={['judge', 'p1']}
        familySessionIds={familySessionIds}
        memberMeta={MEMBER_META}
        candidates={CANDIDATES}
        labsOn
        onClose={vi.fn()}
        onRenamed={vi.fn()}
        onDeleted={vi.fn()}
        onMembersChanged={vi.fn()}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  mockGetGroupTurns.mockResolvedValue({ turns: [], hasMore: false })
  mockGetGroupMetrics.mockImplementation(async (sessionId: number) =>
    metrics({
      sessionTurns: sessionId === 901 ? 10 : sessionId === 902 ? 4 : 1,
      sessionTokens: 1000,
      sessionCostUsd: 0.5
    })
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('狼人杀 family 用量', () => {
  test('F1 三群各查一次并相加，上限用 WEREWOLF_SESSION_TURN_CAP', async () => {
    renderPane({ v: 1, preset: 'werewolf' })
    await waitFor(() => expect(screen.getByText('本局合计（含子群）')).toBeTruthy())
    await waitFor(() =>
      expect(new Set(mockGetGroupMetrics.mock.calls.map((c) => c[0]))).toEqual(new Set(FAMILY))
    )
    const cell = document.querySelector('[data-family-usage] .font-mono')
    await waitFor(() => expect(cell?.textContent).toContain(`15 / ${WEREWOLF_SESSION_TURN_CAP}`))
    expect(cell?.textContent).toContain('$1.50')
  })

  test('F2 任一群 cost 未知 → 整体未知', async () => {
    mockGetGroupMetrics.mockImplementation(async (sessionId: number) =>
      metrics({ sessionTurns: 1, sessionCostUsd: sessionId === 903 ? null : 0.5 })
    )
    renderPane({ v: 1, preset: 'werewolf' })
    await waitFor(() => expect(screen.getByText('本局合计（含子群）')).toBeTruthy())
    const cell = document.querySelector('[data-family-usage] .font-mono')
    await waitFor(() => expect(cell?.textContent).toContain(i18n.t('groupChat.metrics.unknown')))
    expect(cell?.textContent).not.toContain('$')
  })

  test('F3 非 preset → 不发 family 三查、无「本局合计」行', async () => {
    renderPane({ v: 1 })
    await waitFor(() => expect(mockGetGroupMetrics).toHaveBeenCalled())
    expect(screen.queryByText('本局合计（含子群）')).toBeNull()
    // 只有本群那一条 useQuery，没有 family 的三条。
    expect(new Set(mockGetGroupMetrics.mock.calls.map((c) => c[0]))).toEqual(new Set([901]))
  })

  test('F4 preset 时 chainCap 占位 = WEREWOLF_CHAIN_CAP', async () => {
    renderPane({ v: 1, preset: 'werewolf' })
    const input = (await screen.findByLabelText('一条链最多唤醒')) as HTMLInputElement
    // 群设置到达前占位仍是出厂默认，等 preset 读回来才切 —— 等的是终态。
    await waitFor(() => expect(input.placeholder).toBe(String(WEREWOLF_CHAIN_CAP)))
  })
})
