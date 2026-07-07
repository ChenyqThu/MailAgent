// @vitest-environment happy-dom
//
// chat-panel P4 Phase 04b — SendApprovalCard render + the high-risk send approval flow. Rendered
// standalone with mocked ToolCallMessagePartProps. Asserts: the editable To/CC/BCC/Subject/Body
// fields, the external-recipient + sensitive-term warnings, approve-without-edit (native
// respondToApproval, NO resolve POST), approve-WITH-edit (POST /api/ai/approval/resolve carrying
// the edited send fields, THEN respondToApproval), reject, and the sent (done) state.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { SendApprovalCard } from '@shared/assistant/tools/mail/SendApprovalCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'email_prepare_send',
    toolCallId: 'tc1',
    args: {
      to: ['colleague@example-corp.test'],
      subject: '报价确认结论',
      body_markdown: '单价 1280、交期 4 周。',
      internal_id: 51240
    },
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
  window.history.replaceState({}, '', '/?aiGatewayPort=8765')
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ status: 'ok', approvalId: 'a', toolName: 'email_prepare_send' }),
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

describe('SendApprovalCard — pending (approval-requested)', () => {
  test('renders editable To/Subject/Body + 允许发送/取消 + expiry countdown', () => {
    render(<SendApprovalCard {...mockProps({})} />)
    expect((screen.getByLabelText('收件人') as HTMLInputElement).value).toBe(
      'colleague@example-corp.test'
    )
    expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('报价确认结论')
    expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toContain('单价 1280')
    expect(screen.getByText('允许发送')).toBeTruthy()
    expect(screen.getByText('取消')).toBeTruthy()
    expect(screen.getByText(/审批有效期/)).toBeTruthy()
  })

  test('external / personal recipient → warning shown', () => {
    render(
      <SendApprovalCard
        {...mockProps({ args: { to: ['someone@gmail.com'], subject: 's', body_markdown: 'b' } })}
      />
    )
    expect(screen.getByText(/外部 \/ 个人邮箱收件人/)).toBeTruthy()
  })

  test('sensitive term in the body → warning shown', () => {
    render(
      <SendApprovalCard
        {...mockProps({
          args: { to: ['a@example-corp.test'], subject: 's', body_markdown: '附上登录密码' }
        })}
      />
    )
    expect(screen.getByText(/正文含敏感词/)).toBeTruthy()
  })

  test('approve WITHOUT editing → respondToApproval(true), NO resolve POST', async () => {
    const respondToApproval = vi.fn()
    render(<SendApprovalCard {...mockProps({ respondToApproval })} />)
    fireEvent.click(screen.getByText('允许发送'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('edit a field then approve → POST resolve with edited send fields, THEN respondToApproval(true)', async () => {
    const respondToApproval = vi.fn()
    render(<SendApprovalCard {...mockProps({ respondToApproval })} />)
    fireEvent.change(screen.getByLabelText('抄送'), {
      target: { value: 'manager@example-corp.test' }
    })
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: '最终正文' } })
    fireEvent.click(screen.getByText('允许发送'))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8765/api/ai/approval/resolve')
    const body = JSON.parse(init.body as string) as {
      toolCallId: string
      editedInput: { cc: string[]; body_markdown: string }
    }
    expect(body.toolCallId).toBe('tc1')
    expect(body.editedInput.cc).toEqual(['manager@example-corp.test'])
    expect(body.editedInput.body_markdown).toBe('最终正文')
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))
  })

  test('a failed resolve POST surfaces the error and does NOT approve (email not sent)', async () => {
    const respondToApproval = vi.fn()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'E_APPROVAL_EXPIRED' }), {
        status: 410,
        headers: { 'Content-Type': 'application/json' }
      })
    )
    render(<SendApprovalCard {...mockProps({ respondToApproval })} />)
    fireEvent.change(screen.getByLabelText('正文'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('允许发送'))
    await waitFor(() => expect(screen.getByText(/E_APPROVAL_EXPIRED/)).toBeTruthy())
    expect(respondToApproval).not.toHaveBeenCalled()
  })

  test('reject → respondToApproval(false)', async () => {
    const respondToApproval = vi.fn()
    render(<SendApprovalCard {...mockProps({ respondToApproval })} />)
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: false }))
  })
})

describe('SendApprovalCard — done (output-available)', () => {
  test('shows sent confirmation + message id', () => {
    render(
      <SendApprovalCard
        {...mockProps({
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: true },
          result: {
            internal_id: 51240,
            sent: true,
            message_id: '<sent-1@corp.test>',
            archived_to_sent: true,
            to: ['colleague@example-corp.test'],
            subject: '报价确认结论'
          }
        })}
      />
    )
    expect(screen.getByText(/邮件已发送/)).toBeTruthy()
    expect(screen.getByText(/sent-1@corp.test/)).toBeTruthy()
  })
})
