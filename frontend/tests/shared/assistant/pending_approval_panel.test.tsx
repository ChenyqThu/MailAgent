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

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { PendingApprovalInfo } from '@shared/assistant/approvalRecordClient'

const mockFetchPending = vi.fn<(sessionId: number) => Promise<PendingApprovalInfo | null>>()
const mockPostDecide = vi.fn()
const mockPostRememberWeb = vi.fn()
const mockPostResolveEdit = vi.fn()
vi.mock('@shared/assistant/approvalRecordClient', () => ({
  fetchPendingApproval: (sessionId: number) => mockFetchPending(sessionId),
  postApprovalDecide: (input: unknown) => mockPostDecide(input),
  postRememberWebPolicy: (approvalId: string) => mockPostRememberWeb(approvalId),
  postApprovalResolveEdit: (approvalId: string, editedInput: unknown) =>
    mockPostResolveEdit(approvalId, editedInput)
}))

// L4 批次2 — the panel now reads the built-in tool approval tiers (manual_chat only) and writes one
// on「记住」. Stub the api singleton so the fixtures decide what the catalog says.
const mockGetToolPrefs = vi.fn()
const mockSetToolPref = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { getToolPrefs: mockGetToolPrefs, setToolPref: mockSetToolPref } })
}))

import i18n from '@shared/i18n'
import { qk } from '@shared/lib/queryKeys'
import { PendingApprovalPanel } from '@shared/assistant/PendingApprovalPanel'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  // Default catalog: nothing configurable → no「记住」affordance unless a test says otherwise.
  mockGetToolPrefs.mockResolvedValue({ tools: [], sendWhitelist: [], acceptEditsPreset: [] })
  // vi.clearAllMocks() only clears CALLS, not implementations — reset the edit side-channel to a
  // happy default so one test's mockRejectedValue can't decide another test's outcome.
  mockPostResolveEdit.mockResolvedValue(undefined)
})

/** L4 批次2 — the two-step deny: the first click opens the reason box, the confirm decides. */
async function denyWith(reason?: string): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: '拒绝' }))
  if (reason !== undefined) {
    fireEvent.change(screen.getByLabelText('拒绝理由（可选）'), { target: { value: reason } })
  }
  fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }))
}

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
  ageMs: 2 * 60 * 1000,
  destructive: false,
  input: { to: ['boss@example.com'], subject: '周报', body_markdown: '本周进展如下。' },
  // L4 批次2 — the base fixture stays approve/reject-only (editableFields empty) so the existing
  // pins keep measuring the unchanged path; the edit/remember tests opt in with their own fixtures.
  editableFields: [],
  contextMode: 'manual_chat'
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

  // P2-1 (codex r1) — judge the decide result BEFORE deactivating the card: a real failure keeps
  // the card alive with an inline error (the approval did NOT happen); only ok / not_found (handled
  // on another surface) invalidates + onDecided. The reject path rides the SAME async machine.
  test('approve failure (gateway error) → card STAYS, inline error, onDecided NOT called', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    mockPostDecide.mockResolvedValue({ ok: false, status: 'error', error: 'resume blew up' })
    const onDecided = vi.fn()
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={onDecided} />)
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostDecide).toHaveBeenCalled())
    // inline error surfaced through ApprovalActions' shared machine…
    expect(await screen.findByText(/resume blew up/)).toBeTruthy()
    // …the card is still live (NOT invalidated/remounted away) and the parent was never told "done".
    expect(document.querySelector('[data-in-record-approval-card]')).not.toBeNull()
    expect(onDecided).not.toHaveBeenCalled()
  })

  test('reject failure → same machine: inline error, card stays, no unhandled rejection', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    mockPostDecide.mockResolvedValue({ ok: false, status: 'error', error: 'gateway unreachable' })
    const onDecided = vi.fn()
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={onDecided} />)
    await denyWith()
    await waitFor(() =>
      expect(mockPostDecide).toHaveBeenCalledWith({ approvalId: 'ap_m1', decision: 'reject' })
    )
    expect(await screen.findByText(/gateway unreachable/)).toBeTruthy()
    expect(document.querySelector('[data-in-record-approval-card]')).not.toBeNull()
    expect(onDecided).not.toHaveBeenCalled()
  })

  test('not_found (already handled on another surface) → benign deactivation: onDecided fires, no error', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    mockPostDecide.mockResolvedValue({ ok: false, status: 'not_found' })
    const onDecided = vi.fn()
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={onDecided} />)
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(screen.queryByText(/操作失败|failed/i)).toBeNull()
  })

  // P1-2 — the decide-busy signal the parents use to disable their composer while the server-side
  // resume holds the session lease: true on click, false after the decide settles (either way).
  // codex r2 [E] — the signal carries the DECIDING session's id (captured at decide start) so the
  // parent (useApprovalDecideBusy) scopes the fence to that session only.
  test('onDecideBusyChange: (true, sessionId) while the decide POST is in flight, (false, sessionId) after', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    let resolveDecide!: (v: unknown) => void
    mockPostDecide.mockReturnValue(
      new Promise((r) => {
        resolveDecide = r
      })
    )
    const busyCalls: Array<[boolean, number | null]> = []
    withQuery(
      <PendingApprovalPanel
        sessionId={9}
        onDecided={vi.fn()}
        onDecideBusyChange={(b, sid) => busyCalls.push([b, sid])}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    await waitFor(() => expect(busyCalls).toEqual([[true, 9]]))
    resolveDecide({ ok: true, status: 'completed' })
    await waitFor(() =>
      expect(busyCalls).toEqual([
        [true, 9],
        [false, 9]
      ])
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

// ── L4 批次2 · response 维度（拒绝并给文字指导）──────────────────────────────────────────
describe('PendingApprovalPanel — reject with a reason', () => {
  test('the reason rides /decide (so the model reads execution-denied {reason})', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'rejected' })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await denyWith('先别发，等我确认过数字')
    await waitFor(() =>
      expect(mockPostDecide).toHaveBeenCalledWith({
        approvalId: 'ap_m1',
        decision: 'reject',
        reason: '先别发，等我确认过数字'
      })
    )
  })

  test('the first deny click only OPENS the box — no decision is sent', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }))
    expect(screen.getByLabelText('拒绝理由（可选）')).toBeTruthy()
    expect(mockPostDecide).not.toHaveBeenCalled()
  })

  test('返回 closes the box and discards the typed text (still nothing decided)', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }))
    fireEvent.change(screen.getByLabelText('拒绝理由（可选）'), { target: { value: '算了' } })
    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    expect(screen.queryByLabelText('拒绝理由（可选）')).toBeNull()
    expect(mockPostDecide).not.toHaveBeenCalled()
    // re-opening starts empty — the discarded draft must not resurface on the next attempt
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    expect((screen.getByLabelText('拒绝理由（可选）') as HTMLTextAreaElement).value).toBe('')
  })

  test('whitespace-only reason → the body carries NO reason key (byte-identical to a plain deny)', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'rejected' })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await denyWith('   ')
    await waitFor(() =>
      expect(mockPostDecide).toHaveBeenCalledWith({ approvalId: 'ap_m1', decision: 'reject' })
    )
  })
})

// ── L4 批次2 · edit 维度（改参数再执行）────────────────────────────────────────────────
const EDITABLE_HIT: PendingApprovalInfo = {
  ...MANUAL_HIT,
  approvalId: 'ap_edit',
  toolName: 'email_draft_reply',
  inputPreview: 'email_draft_reply · 回复张三',
  input: { internal_id: 5, body_markdown: '收到，我来跟进。', to: ['zhang@corp.test'] },
  // cc/bcc are registered editable but ABSENT from the proposal → no row (the generic editor can't
  // know their wire shape without a value).
  editableFields: ['body_markdown', 'to', 'cc', 'bcc']
}

describe('PendingApprovalPanel — edit parameters', () => {
  test('rows cover the registered ∩ proposed fields only; identity fields never appear', async () => {
    mockFetchPending.mockResolvedValue(EDITABLE_HIT)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑参数' }))
    expect(screen.getByLabelText('body_markdown')).toBeTruthy()
    expect(screen.getByLabelText('to')).toBeTruthy()
    expect(screen.queryByLabelText('cc')).toBeNull()
    expect(screen.queryByLabelText('bcc')).toBeNull()
    expect(screen.queryByLabelText('internal_id')).toBeNull()
  })

  test('approve after an edit → /resolve FIRST (changed fields only), then /decide', async () => {
    mockFetchPending.mockResolvedValue(EDITABLE_HIT)
    mockPostResolveEdit.mockResolvedValue(undefined)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    const order: string[] = []
    mockPostResolveEdit.mockImplementation(async () => {
      order.push('resolve')
    })
    mockPostDecide.mockImplementation(async () => {
      order.push('decide')
      return { ok: true, status: 'completed' }
    })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑参数' }))
    fireEvent.change(screen.getByLabelText('body_markdown'), {
      target: { value: '收到，明天给你结论。' }
    })
    fireEvent.change(screen.getByLabelText('to'), {
      target: { value: 'zhang@corp.test, li@corp.test' }
    })
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostDecide).toHaveBeenCalled())
    expect(mockPostResolveEdit).toHaveBeenCalledWith('ap_edit', {
      body_markdown: '收到，明天给你结论。',
      // a list row splits on newlines AND commas, trims, drops empties
      to: ['zhang@corp.test', 'li@corp.test']
    })
    // 🔴 /decide claims the stash — an overlay posted after it would be silently dropped
    expect(order).toEqual(['resolve', 'decide'])
  })

  test('opened but unchanged → no /resolve at all (the approve stays byte-identical)', async () => {
    mockFetchPending.mockResolvedValue(EDITABLE_HIT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑参数' }))
    // TOUCHED but identical (typed and reverted, or a stray focus/blur) — the overlay is keyed on the
    // VALUE, not on "did this field ever receive an event", so this must still post nothing.
    fireEvent.change(screen.getByLabelText('body_markdown'), { target: { value: '改了一下' } })
    fireEvent.change(screen.getByLabelText('body_markdown'), {
      target: { value: '收到，我来跟进。' }
    })
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostDecide).toHaveBeenCalled())
    expect(mockPostResolveEdit).not.toHaveBeenCalled()
  })

  test('a /resolve failure ABORTS the approve: no /decide, card stays, typed code inline', async () => {
    mockFetchPending.mockResolvedValue(EDITABLE_HIT)
    mockPostResolveEdit.mockRejectedValue(new Error('E_APPROVAL_NOT_EDITABLE'))
    const onDecided = vi.fn()
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={onDecided} />)
    fireEvent.click(await screen.findByRole('button', { name: '编辑参数' }))
    fireEvent.change(screen.getByLabelText('body_markdown'), { target: { value: '改一下' } })
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    expect(await screen.findByText(/E_APPROVAL_NOT_EDITABLE/)).toBeTruthy()
    // approving the MODEL's version behind the owner's back is the failure mode this pins away
    expect(mockPostDecide).not.toHaveBeenCalled()
    expect(document.querySelector('[data-in-record-approval-card]')).not.toBeNull()
    expect(onDecided).not.toHaveBeenCalled()
  })

  test('🔴 a re-pause (new approvalId) discards the previous approval’s draft edit and reason', async () => {
    // The panel is NOT remounted between approvals — the probe just returns a different payload.
    // Without the per-approval scratch reset, the text typed for approval A would be diffed against
    // B's proposal and posted as an edit of B.
    mockFetchPending.mockResolvedValue(EDITABLE_HIT)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    const ui = (refreshKey: number): React.ReactElement => (
      <QueryClientProvider client={qc}>
        <PendingApprovalPanel sessionId={9} refreshKey={refreshKey} onDecided={vi.fn()} />
      </QueryClientProvider>
    )
    const { rerender } = render(ui(0))
    fireEvent.click(await screen.findByRole('button', { name: '编辑参数' }))
    fireEvent.change(screen.getByLabelText('body_markdown'), { target: { value: 'A 的改动' } })
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    fireEvent.change(screen.getByLabelText('拒绝理由（可选）'), { target: { value: 'A 的理由' } })

    // approval B arrives (refreshKey is folded into the query key → a fresh probe)
    mockFetchPending.mockResolvedValue({
      ...EDITABLE_HIT,
      approvalId: 'ap_edit_b',
      inputPreview: 'email_draft_reply · 回复李四',
      input: { internal_id: 6, body_markdown: 'B 的原文', to: ['li@corp.test'] }
    })
    rerender(ui(1))
    await screen.findByText('email_draft_reply · 回复李四')
    expect(screen.queryByLabelText('拒绝理由（可选）')).toBeNull() // the reason draft is gone
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostDecide).toHaveBeenCalled())
    expect(mockPostResolveEdit).not.toHaveBeenCalled()
    expect(mockPostDecide).toHaveBeenCalledWith({ approvalId: 'ap_edit_b', decision: 'approve' })
  })

  test('no editable fields → no editor entry point', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await screen.findByText(MANUAL_HIT.inputPreview)
    expect(screen.queryByRole('button', { name: '编辑参数' })).toBeNull()
  })
})

// ── L4 批次2 · remember 维度（写 owner tool_approval_pref）───────────────────────────────
const PREFS = {
  tools: [
    {
      toolName: 'calendar_event_reschedule',
      group: 'calendar',
      defaultTier: 'ask' as const,
      tier: null,
      effectiveTier: 'ask' as const,
      configurable: true,
      dangerAuto: false
    },
    {
      toolName: 'email_prepare_send',
      group: 'outbound',
      defaultTier: 'ask' as const,
      tier: null,
      effectiveTier: 'ask' as const,
      // 结构性不可配（唯一免卡形状是收件人白名单）
      configurable: false,
      dangerAuto: false
    },
    {
      toolName: 'file_write',
      group: 'exec',
      defaultTier: 'ask' as const,
      tier: null,
      effectiveTier: 'ask' as const,
      configurable: true,
      dangerAuto: false
    }
  ],
  sendWhitelist: [],
  acceptEditsPreset: []
}
const CALENDAR_HIT: PendingApprovalInfo = {
  ...MANUAL_HIT,
  approvalId: 'ap_cal',
  toolName: 'calendar_event_reschedule',
  inputPreview: 'calendar_event_reschedule · 周会 → 周四 15:00',
  input: { uid: 'evt-1', new_start: '2026-08-27T15:00:00' },
  editableFields: []
}

describe('PendingApprovalPanel — remember this kind of action', () => {
  test('manual + configurable + ask → affordance shown; ticking writes tier=auto BEFORE /decide', async () => {
    mockFetchPending.mockResolvedValue(CALENDAR_HIT)
    mockGetToolPrefs.mockResolvedValue(PREFS)
    const order: string[] = []
    mockSetToolPref.mockImplementation(async () => {
      order.push('pref')
      return PREFS
    })
    mockPostDecide.mockImplementation(async () => {
      order.push('decide')
      return { ok: true, status: 'completed' }
    })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    fireEvent.click(await screen.findByText('记住：以后不再询问这类操作'))
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostDecide).toHaveBeenCalled())
    expect(mockSetToolPref).toHaveBeenCalledWith('calendar_event_reschedule', 'auto')
    expect(order).toEqual(['pref', 'decide'])
  })

  test('unticked → nothing is written (remember is always a user action)', async () => {
    mockFetchPending.mockResolvedValue(CALENDAR_HIT)
    mockGetToolPrefs.mockResolvedValue(PREFS)
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: '批准' }))
    await waitFor(() => expect(mockPostDecide).toHaveBeenCalled())
    expect(mockSetToolPref).not.toHaveBeenCalled()
  })

  test('a failed tier write does NOT block the approval the owner already made', async () => {
    mockFetchPending.mockResolvedValue(CALENDAR_HIT)
    mockGetToolPrefs.mockResolvedValue(PREFS)
    mockSetToolPref.mockRejectedValue(new Error('serve-api down'))
    mockPostDecide.mockResolvedValue({ ok: true, status: 'completed' })
    const onDecided = vi.fn()
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={onDecided} />)
    fireEvent.click(await screen.findByText('记住：以后不再询问这类操作'))
    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    await waitFor(() => expect(onDecided).toHaveBeenCalled())
    expect(mockPostDecide).toHaveBeenCalledWith({ approvalId: 'ap_cal', decision: 'approve' })
  })

  test('🔴 headless pause (contextMode ≠ manual_chat) → hidden: the ladder never reads the tier there', async () => {
    mockFetchPending.mockResolvedValue({
      ...CALENDAR_HIT,
      agentId: 'dms',
      jobId: 7,
      contextMode: 'cron_headless'
    })
    mockGetToolPrefs.mockResolvedValue(PREFS)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await screen.findByText(CALENDAR_HIT.inputPreview)
    expect(screen.queryByText('记住：以后不再询问这类操作')).toBeNull()
    // …and the catalog is not even fetched for a mode that cannot consume it
    expect(mockGetToolPrefs).not.toHaveBeenCalled()
  })

  test('🔴 headless + the catalog ALREADY cached → still hidden (the mode gate, not the fetch gate)', async () => {
    // The realistic version of the case above: the owner opened Settings earlier, so
    // qk.toolApprovalPrefs is warm and a disabled query still hands its cached data to the render.
    // Only the contextMode check in canRememberTool keeps the affordance off here.
    mockFetchPending.mockResolvedValue({
      ...CALENDAR_HIT,
      agentId: 'dms',
      jobId: 7,
      contextMode: 'cron_headless'
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    qc.setQueryData(qk.toolApprovalPrefs(), PREFS)
    render(
      <QueryClientProvider client={qc}>
        <PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />
      </QueryClientProvider>
    )
    await screen.findByText(CALENDAR_HIT.inputPreview)
    expect(screen.queryByText('记住：以后不再询问这类操作')).toBeNull()
  })

  test('structurally fixed-ask tool (send) → hidden', async () => {
    mockFetchPending.mockResolvedValue(MANUAL_HIT) // email_prepare_send, configurable:false
    mockGetToolPrefs.mockResolvedValue(PREFS)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await screen.findByText(MANUAL_HIT.inputPreview)
    await waitFor(() => expect(mockGetToolPrefs).toHaveBeenCalled())
    expect(screen.queryByText('记住：以后不再询问这类操作')).toBeNull()
  })

  test('exec/web tools keep their finer policy_rules affordance — no second checkbox', async () => {
    mockFetchPending.mockResolvedValue({
      ...CALENDAR_HIT,
      approvalId: 'ap_fw',
      toolName: 'file_write',
      inputPreview: 'file_write · /tmp/x.md'
    })
    mockGetToolPrefs.mockResolvedValue(PREFS)
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await screen.findByText('file_write · /tmp/x.md')
    await waitFor(() => expect(mockGetToolPrefs).toHaveBeenCalled())
    expect(screen.queryByText('记住：以后不再询问这类操作')).toBeNull()
  })

  test('already auto (nothing left to remember) → hidden', async () => {
    mockFetchPending.mockResolvedValue(CALENDAR_HIT)
    mockGetToolPrefs.mockResolvedValue({
      ...PREFS,
      tools: [{ ...PREFS.tools[0], tier: 'auto' as const, effectiveTier: 'auto' as const }]
    })
    withQuery(<PendingApprovalPanel sessionId={9} onDecided={vi.fn()} />)
    await screen.findByText(CALENDAR_HIT.inputPreview)
    await waitFor(() => expect(mockGetToolPrefs).toHaveBeenCalled())
    expect(screen.queryByText('记住：以后不再询问这类操作')).toBeNull()
  })
})
