// @vitest-environment happy-dom
//
// S6 W2 — custom-agent 执行记录视图的两个可测子件：
//   - AgentRunRecordBanner（纯 props）：agent 名 + run 状态徽标 + 触发时间 + P4「记录视图」说明。
//   - InRecordApprovalPanel（live 查 pending）：命中 → decide 审批卡（批准走 {approvalId,decision}
//     形状）；miss 且 run 处 paused 态 → 诚实失效态；miss 且非 paused → 不渲染。
// composer 禁用由 AgentThread readOnly 承载（AgentThread 单测已覆盖 !readOnly && <AgentComposer/>），
// 此处只测记录视图专属件。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { PendingApprovalInfo } from '@shared/assistant/approvalRecordClient'

const mockFetchPending = vi.fn<(sessionId: number) => Promise<PendingApprovalInfo | null>>()
const mockPostDecide = vi.fn()
const mockPostRememberWeb = vi.fn()
vi.mock('@shared/assistant/approvalRecordClient', () => ({
  fetchPendingApproval: (sessionId: number) => mockFetchPending(sessionId),
  postApprovalDecide: (input: unknown) => mockPostDecide(input),
  postRememberWebPolicy: (approvalId: string) => mockPostRememberWeb(approvalId)
}))

import i18n from '@shared/i18n'
import {
  AgentRunRecordBanner,
  InRecordApprovalPanel
} from '@shared/components/agents/AgentRecordView'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function withQuery(node: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const HIT: PendingApprovalInfo = {
  approvalId: 'ap_1',
  toolName: 'email_draft_reply',
  inputPreview: 'email_draft_reply · 给张三回复',
  agentId: 'dms',
  jobId: 7,
  ageMs: 3 * 60 * 1000,
  // L4 批次2 — the headless record face: destructive off, nothing editable offered here, and the
  // FROZEN cron_headless mode (which is what keeps the「记住」affordance off — tool_approval_pref
  // is a manual_chat-only ladder rung).
  destructive: false,
  input: { internal_id: 5, body_markdown: '好的，我来跟进。' },
  editableFields: [],
  contextMode: 'cron_headless'
}

describe('AgentRunRecordBanner', () => {
  test('renders agent name + run-state badge + trigger time + the P4 record-mode explanation', () => {
    render(
      <AgentRunRecordBanner
        agentName="每日摘要"
        runState="paused_pending"
        triggeredAt={Date.now() - 5 * 60 * 1000}
      />
    )
    expect(screen.getByText('每日摘要')).toBeTruthy()
    // RunStateBadge 复用：paused_pending → 「等待审批」
    expect(screen.getByText('等待审批')).toBeTruthy()
    // 触发时间（i18n key 存在 → 非原始 key）
    expect(screen.getByText(/触发于/)).toBeTruthy()
    // P4 read-mostly 说明
    expect(screen.getByText(/仅审批可交互/)).toBeTruthy()
  })

  test('no run state / no trigger time → renders name + banner text without a badge', () => {
    render(<AgentRunRecordBanner agentName="Agent A" runState={null} triggeredAt={null} />)
    expect(screen.getByText('Agent A')).toBeTruthy()
    expect(screen.getByText(/仅审批可交互/)).toBeTruthy()
    // 无 state → 不渲染任何 9 值域状态标签
    expect(screen.queryByText('等待审批')).toBeNull()
  })
})

describe('InRecordApprovalPanel — pending hit (decide card)', () => {
  test('renders the decide card (tool + input preview + agent) and drives {approvalId, decision}', async () => {
    mockFetchPending.mockResolvedValue(HIT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    const onDecided = vi.fn()
    withQuery(
      <InRecordApprovalPanel
        sessionId={55}
        runState="paused_pending"
        agentName="每日摘要"
        onDecided={onDecided}
      />
    )
    // card 出现（含工具输入预览）
    expect(await screen.findByText('email_draft_reply · 给张三回复')).toBeTruthy()
    expect(screen.getByText('待审批')).toBeTruthy()

    // 批准 → postApprovalDecide 收到 {approvalId, decision:'approve'}（无 resumeToken/toolCallId）
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() =>
      expect(mockPostDecide).toHaveBeenCalledWith({ approvalId: 'ap_1', decision: 'approve' })
    )
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
  })
})

// S6 W3-3 — the in-record web_fetch "总是允许该域名" PIN affordance (agent-run-only).
const HIT_WEB_AGENT: PendingApprovalInfo = {
  approvalId: 'ap_web',
  toolName: 'web_fetch',
  inputPreview: 'web_fetch · https://api.vendor.com/v1',
  agentId: 'dms',
  jobId: 7,
  ageMs: 60 * 1000,
  destructive: false,
  input: { url: 'https://api.vendor.com/v1' },
  editableFields: ['url'],
  contextMode: 'cron_headless'
}
const HIT_WEB_MANUAL: PendingApprovalInfo = { ...HIT_WEB_AGENT, approvalId: 'ap_m', agentId: null }

describe('InRecordApprovalPanel — web PIN affordance (S6 W3-3, agent-run-only)', () => {
  test('agent-run web_fetch → affordance shown; tick + approve → remember BEFORE decide', async () => {
    mockFetchPending.mockResolvedValue(HIT_WEB_AGENT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    mockPostRememberWeb.mockResolvedValue(true)
    withQuery(
      <InRecordApprovalPanel
        sessionId={9}
        runState="paused_pending"
        agentName="供应商监控"
        onDecided={vi.fn()}
      />
    )
    const box = await screen.findByText(/总是允许该 Agent 访问此域名/)
    expect(box).toBeTruthy()
    // tick + approve
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostRememberWeb).toHaveBeenCalledWith('ap_web'))
    await waitFor(() =>
      expect(mockPostDecide).toHaveBeenCalledWith({ approvalId: 'ap_web', decision: 'approve' })
    )
    // remember fired before decide (peek is read-only; decide consumes the stash)
    expect(mockPostRememberWeb.mock.invocationCallOrder[0]).toBeLessThan(
      mockPostDecide.mock.invocationCallOrder[0]
    )
  })

  test('agent-run web_fetch, approve WITHOUT ticking → no remember call', async () => {
    mockFetchPending.mockResolvedValue(HIT_WEB_AGENT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    withQuery(
      <InRecordApprovalPanel
        sessionId={9}
        runState="paused_pending"
        agentName="供应商监控"
        onDecided={vi.fn()}
      />
    )
    await screen.findByText(/总是允许该 Agent 访问此域名/)
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostDecide).toHaveBeenCalled())
    expect(mockPostRememberWeb).not.toHaveBeenCalled()
  })

  test('MANUAL web_fetch (agentId null) → NO affordance (dead-config boundary)', async () => {
    // 🔴 the load-bearing negative: a manual web_fetch never runs policyEvaluate, so a per-agent web
    // rule built here would be a dead, misleading config — the affordance must be absent.
    mockFetchPending.mockResolvedValue(HIT_WEB_MANUAL)
    withQuery(
      <InRecordApprovalPanel
        sessionId={9}
        runState="paused_pending"
        agentName="手动会话"
        onDecided={vi.fn()}
      />
    )
    // card renders, but no PIN affordance
    expect(await screen.findByText('web_fetch · https://api.vendor.com/v1')).toBeTruthy()
    expect(screen.queryByText(/总是允许该 Agent 访问此域名/)).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  test('agent-run NON-web_fetch (email_draft_reply) → NO affordance (web_fetch only)', async () => {
    mockFetchPending.mockResolvedValue(HIT) // toolName email_draft_reply, agentId dms
    withQuery(
      <InRecordApprovalPanel
        sessionId={9}
        runState="paused_pending"
        agentName="每日摘要"
        onDecided={vi.fn()}
      />
    )
    await screen.findByText('email_draft_reply · 给张三回复')
    expect(screen.queryByText(/总是允许该 Agent 访问此域名/)).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})

describe('InRecordApprovalPanel — pending miss', () => {
  test('miss + run paused_pending → honest expired notice (not a card)', async () => {
    mockFetchPending.mockResolvedValue(null)
    withQuery(
      <InRecordApprovalPanel
        sessionId={55}
        runState="paused_pending"
        agentName="每日摘要"
        onDecided={vi.fn()}
      />
    )
    expect(await screen.findByText(/审批已失效/)).toBeTruthy()
    // 不是可决策卡
    expect(screen.queryByRole('button', { name: '批准' })).toBeNull()
  })

  test('miss + run completed → renders nothing (no false expired notice on a done run)', async () => {
    mockFetchPending.mockResolvedValue(null)
    const { container } = withQuery(
      <InRecordApprovalPanel
        sessionId={55}
        runState="completed"
        agentName="每日摘要"
        onDecided={vi.fn()}
      />
    )
    // 等 query settle 后仍无失效提示 / 无卡
    await waitFor(() => expect(mockFetchPending).toHaveBeenCalled())
    expect(screen.queryByText(/审批已失效/)).toBeNull()
    expect(container.querySelector('[data-in-record-approval-card]')).toBeNull()
    expect(container.querySelector('[data-in-record-approval-expired]')).toBeNull()
  })

  test('sessionId null → never probes, renders nothing', async () => {
    withQuery(
      <InRecordApprovalPanel
        sessionId={null}
        runState="paused_pending"
        agentName="每日摘要"
        onDecided={vi.fn()}
      />
    )
    // enabled:false → 不发请求
    await new Promise((r) => setTimeout(r, 0))
    expect(mockFetchPending).not.toHaveBeenCalled()
  })
})
