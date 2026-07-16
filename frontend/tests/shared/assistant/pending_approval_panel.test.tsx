// @vitest-environment happy-dom
//
// harness-chat lane A B3 (task 07-15, owner拍板「无灵动岛方案优先」) — the SHARED in-panel approval
// card's MANUAL-session face (the agent-run face is pinned by AgentRecordView.test.tsx through the
// InRecordApprovalPanel wrapper):
//   1. pending hit → actionable card with the manual body copy — and NO island-pointing copy
//      (the island is an optional overlay, never the instruction).
//   2. approve → postApprovalDecide({approvalId, decision}) + onDecided (reload/remount chain).
//   3. miss + showExpiredState=false (manual default) → renders NOTHING (no false expired notice).
//   4. miss + showExpiredState=true (record view's paused_* read state) → honest expired notice.
//   5. manual pending (agentId null) → web PIN affordance absent even for web_fetch.

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
import { PendingApprovalPanel } from '@shared/assistant/PendingApprovalPanel'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function withQuery(node: React.ReactElement): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const MANUAL_HIT: PendingApprovalInfo = {
  approvalId: 'ap_m1',
  toolName: 'email_prepare_send',
  inputPreview: 'email_prepare_send: → boss@example.com 「周报」',
  agentId: null,
  jobId: null,
  ageMs: 2 * 60 * 1000
}

describe('PendingApprovalPanel — manual session (agentName null)', () => {
  test('hit → actionable card with manual copy; island never mentioned', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    expect(await screen.findByText(MANUAL_HIT.inputPreview)).toBeTruthy()
    // manual body copy (chat.aiSdk.approvalBodyManual), tool interpolated
    expect(screen.getByText(/AI 请求执行 email_prepare_send/)).toBeTruthy()
    // 07-15 owner拍板 — the card must NOT point the user at the island
    const card = document.querySelector('[data-in-record-approval-card]')
    expect(card?.textContent ?? '').not.toContain('灵动岛')
  })

  test('approve → {approvalId, decision:approve} + onDecided fires', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    const onDecided = vi.fn()
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={onDecided} />)
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    await waitFor(() =>
      expect(mockPostDecide).toHaveBeenCalledWith({ approvalId: 'ap_m1', decision: 'approve' })
    )
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    // a manual approval never touches the web PIN channel
    expect(mockPostRememberWeb).not.toHaveBeenCalled()
  })

  test('miss + no expired signal → renders nothing (manual default)', async () => {
    mockFetchPending.mockResolvedValue(null)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await waitFor(() => expect(mockFetchPending).toHaveBeenCalled())
    expect(document.querySelector('[data-in-record-approval-card]')).toBeNull()
    expect(document.querySelector('[data-in-record-approval-expired]')).toBeNull()
  })

  test('miss + showExpiredState → honest expired notice (record-view face)', async () => {
    mockFetchPending.mockResolvedValue(null)
    withQuery(<PendingApprovalPanel sessionId={9} showExpiredState onDecided={vi.fn()} />)
    await waitFor(() =>
      expect(document.querySelector('[data-in-record-approval-expired]')).not.toBeNull()
    )
  })

  test('manual web_fetch (agentId null) → no "always allow domain" affordance', async () => {
    mockFetchPending.mockResolvedValue({
      ...MANUAL_HIT,
      approvalId: 'ap_w',
      toolName: 'web_fetch',
      inputPreview: 'web_fetch: https://example.com'
    })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await screen.findByText('web_fetch: https://example.com')
    expect(screen.queryByText(/总是允许/)).toBeNull()
  })
})
