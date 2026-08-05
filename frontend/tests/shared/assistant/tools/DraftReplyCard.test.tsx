// @vitest-environment happy-dom
//
// chat-panel P4 Phase 04a — DraftReplyCard render + the edit → re-approve flow (the core of
// this phase). The card is rendered standalone with mocked ToolCallMessagePartProps (no Thread
// runtime needed). Asserts: the editable body, approve-without-edit (native respondToApproval,
// NO resolve POST), approve-WITH-edit (POST /api/ai/approval/resolve carrying the edited body,
// THEN respondToApproval), reject, and the done state.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { DraftReplyCard } from '@shared/assistant/tools/mail/DraftReplyCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'email_draft_reply',
    toolCallId: 'tc1',
    args: { internal_id: 7, body_markdown: 'proposed body' },
    argsText: '{}',
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-1' }, // pending: approved === undefined
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // resolveAiGatewayBaseUrl reads ?aiGatewayPort= from the URL — make it resolvable.
  window.history.replaceState({}, '', '/?aiGatewayPort=8765')
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ status: 'ok', approvalId: 'a', toolName: 'email_draft_reply' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('DraftReplyCard — pending (approval-requested)', () => {
  test('renders the proposed body in an editable textarea + approve/reject', () => {
    render(<DraftReplyCard {...mockProps({})} />)
    const textarea = screen.getByLabelText('reply draft body') as HTMLTextAreaElement
    expect(textarea.value).toBe('proposed body')
    expect(screen.getByText('创建草稿')).toBeTruthy()
    expect(screen.getByText('拒绝')).toBeTruthy()
  })

  test('approve WITHOUT editing → respondToApproval(true), NO resolve POST', async () => {
    const respondToApproval = vi.fn()
    render(<DraftReplyCard {...mockProps({ respondToApproval })} />)
    fireEvent.click(screen.getByText('创建草稿'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))
    expect(fetchMock).not.toHaveBeenCalled() // no edit → no side-channel re-approve
  })

  test('edit the body then approve → POST resolve with the edited body, THEN respondToApproval(true)', async () => {
    const respondToApproval = vi.fn()
    render(<DraftReplyCard {...mockProps({ respondToApproval })} />)
    const textarea = screen.getByLabelText('reply draft body')
    fireEvent.change(textarea, { target: { value: 'EDITED body by user' } })
    fireEvent.click(screen.getByText('创建草稿'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8765/api/ai/approval/resolve')
    const body = JSON.parse(init.body as string) as {
      toolCallId: string
      editedInput: { body_markdown: string }
    }
    expect(body.toolCallId).toBe('tc1')
    expect(body.editedInput.body_markdown).toBe('EDITED body by user')
    // The native approval is sent only AFTER the edit is recorded domain-side.
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))
  })

  test('a failed resolve POST surfaces the error and does NOT approve', async () => {
    const respondToApproval = vi.fn()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'E_APPROVAL_EXPIRED' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    render(<DraftReplyCard {...mockProps({ respondToApproval })} />)
    fireEvent.change(screen.getByLabelText('reply draft body'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('创建草稿'))
    await waitFor(() => expect(screen.getByText(/E_APPROVAL_EXPIRED/)).toBeTruthy())
    expect(respondToApproval).not.toHaveBeenCalled() // edit failed → never approved
  })

  test('reject → respondToApproval(false)', async () => {
    const respondToApproval = vi.fn()
    render(<DraftReplyCard {...mockProps({ respondToApproval })} />)
    fireEvent.click(screen.getByText('拒绝'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: false }))
  })
})

describe('DraftReplyCard — recipient overrides (add/remove people on reply-all)', () => {
  test('model-proposed to/cc prefill the fields; empty = server-derived placeholder', () => {
    render(
      <DraftReplyCard
        {...mockProps({
          args: {
            internal_id: 7,
            body_markdown: 'proposed body',
            to: ['a@x.com', 'b@x.com'],
            cc: ['c@x.com']
          }
        })}
      />
    )
    expect((screen.getByLabelText('收件人') as HTMLInputElement).value).toBe('a@x.com, b@x.com')
    expect((screen.getByLabelText('抄送') as HTMLInputElement).value).toBe('c@x.com')
    // 无 bcc 提议时不渲染密送字段 (低频, 少一行噪音)
    expect(screen.queryByLabelText('密送')).toBeNull()
  })

  test('edit recipients then approve → resolve POST carries to/cc/bcc lists', async () => {
    const respondToApproval = vi.fn()
    render(<DraftReplyCard {...mockProps({ respondToApproval })} />)
    fireEvent.change(screen.getByLabelText('收件人'), {
      target: { value: 'x@y.com; z@y.com' }
    })
    fireEvent.click(screen.getByText('创建草稿'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string) as {
      editedInput: { body_markdown: string; to: string[]; cc: string[]; bcc: string[] }
    }
    expect(body.editedInput.to).toEqual(['x@y.com', 'z@y.com'])
    expect(body.editedInput.cc).toEqual([])
    expect(body.editedInput.body_markdown).toBe('proposed body')
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))
  })
})

describe('DraftReplyCard — done (output-available)', () => {
  test('shows the draft id + mailbox + the edited-marker', () => {
    render(
      <DraftReplyCard
        {...mockProps({
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: true },
          result: {
            internal_id: 7,
            draft_id: 'reply_all_7',
            mailbox: 'Drafts',
            user_edited: true,
            final_body_markdown: 'final edited body'
          }
        })}
      />
    )
    expect(screen.getByText(/草稿已创建/)).toBeTruthy()
    expect(screen.getByText(/含你的修改/)).toBeTruthy()
    expect(screen.getByText(/Drafts/)).toBeTruthy()
    expect(screen.getByText(/reply_all_7/)).toBeTruthy()
  })
})
