// @vitest-environment happy-dom
//
// prd 07-27 — DraftComposeCard render + the edit → re-approve flow, for both tools it serves.
// Asserts: the SUBJECT field the reply card has no room for; approve-without-edit sends only the
// native approval; an edit POSTs ONLY the changed fields to /api/ai/approval/resolve (an untouched
// field must keep its tool-side meaning — on update that is "keep the current value"); the update
// card fetches the draft's CURRENT values from serve-api and prefills/diffs against them; and the
// done state surfaces a failed old-draft delete.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { DraftComposeCard } from '@shared/assistant/tools/mail/DraftComposeCard'

await i18n.changeLanguage('zh-CN')

function mockProps(over: Partial<ToolCallMessagePartProps>): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName: 'email_draft_compose',
    toolCallId: 'tc1',
    args: { mode: 'new', subject: 'Q3 plan', body_markdown: 'proposed body', to: ['a@x.test'] },
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
/** The serve-api draft row the update card fetches as its "before". */
const DRAFT_FACTS = {
  status: 'success',
  data: {
    internal_id: 9,
    subject: 'current subject',
    to_addr: 'bob@x.test',
    cc_addr: '',
    mailbox: '草稿箱'
  }
}

beforeEach(() => {
  // resolveAiGatewayBaseUrl / resolveApiBaseUrl read the URL query.
  window.history.replaceState({}, '', '/?aiGatewayPort=8765&apiPort=8200')
  fetchMock = vi.fn(async (url: string) =>
    url.includes('/api/email/')
      ? new Response(JSON.stringify(DRAFT_FACTS), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      : new Response(JSON.stringify({ status: 'ok', approvalId: 'a' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const editPosts = (): Array<{ url: string; body: Record<string, unknown> }> =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/api/ai/approval/resolve'))
    .map(([url, init]) => ({
      url: String(url),
      body: JSON.parse((init as RequestInit).body as string) as Record<string, unknown>
    }))

describe('DraftComposeCard — compose (pending)', () => {
  test('renders the proposed SUBJECT + recipients + body, all editable', () => {
    render(<DraftComposeCard {...mockProps({})} />)
    expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('Q3 plan')
    expect((screen.getByLabelText('收件人') as HTMLInputElement).value).toBe('a@x.test')
    expect((screen.getByLabelText('草稿正文') as HTMLTextAreaElement).value).toBe('proposed body')
    expect(screen.getByText('创建草稿')).toBeTruthy()
  })

  test('approve WITHOUT editing → respondToApproval(true), NO resolve POST', async () => {
    const respondToApproval = vi.fn()
    render(<DraftComposeCard {...mockProps({ respondToApproval })} />)
    fireEvent.click(screen.getByText('创建草稿'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))
    expect(editPosts()).toHaveLength(0)
  })

  test('editing the subject POSTs ONLY that field, then approves', async () => {
    const respondToApproval = vi.fn()
    render(<DraftComposeCard {...mockProps({ respondToApproval })} />)
    fireEvent.change(screen.getByLabelText('主题'), { target: { value: 'Q4 plan' } })
    fireEvent.click(screen.getByText('创建草稿'))

    await waitFor(() => expect(editPosts()).toHaveLength(1))
    const post = editPosts()[0]
    expect(post.url).toBe('http://127.0.0.1:8765/api/ai/approval/resolve')
    expect(post.body.toolCallId).toBe('tc1')
    // only the changed field rides the side-channel — an untouched body/recipient list keeps its
    // tool-side semantic instead of being re-sent as an explicit override.
    expect(post.body.editedInput).toEqual({ subject: 'Q4 plan' })
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
    render(<DraftComposeCard {...mockProps({ respondToApproval })} />)
    fireEvent.change(screen.getByLabelText('草稿正文'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByText('创建草稿'))
    await waitFor(() => expect(screen.getByText(/E_APPROVAL_EXPIRED/)).toBeTruthy())
    expect(respondToApproval).not.toHaveBeenCalled()
  })

  test('reject → respondToApproval(false)', async () => {
    const respondToApproval = vi.fn()
    render(<DraftComposeCard {...mockProps({ respondToApproval })} />)
    fireEvent.click(screen.getByText('拒绝'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: false }))
  })
})

describe('DraftComposeCard — update (before → after)', () => {
  const updateProps = (over: Partial<ToolCallMessagePartProps> = {}): ToolCallMessagePartProps =>
    mockProps({
      toolName: 'email_draft_update',
      args: { draft_internal_id: 9, subject: 'new subject' },
      ...over
    })

  test("fetches the draft's CURRENT values and prefills the untouched fields from them", async () => {
    render(<DraftComposeCard {...updateProps()} />)
    await waitFor(() =>
      expect((screen.getByLabelText('收件人') as HTMLInputElement).value).toBe('bob@x.test')
    )
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8200/api/email/9')
    // the model's proposal wins where it made one
    expect((screen.getByLabelText('主题') as HTMLInputElement).value).toBe('new subject')
    // …and the change is spelled out as current → proposed
    expect(screen.getByText(/current subject →/)).toBeTruthy()
  })

  test('approving an unedited update POSTs nothing (the backfill stays server-side)', async () => {
    const respondToApproval = vi.fn()
    render(<DraftComposeCard {...updateProps({ respondToApproval })} />)
    await waitFor(() =>
      expect((screen.getByLabelText('收件人') as HTMLInputElement).value).toBe('bob@x.test')
    )
    fireEvent.click(screen.getByText('保存修改'))
    await waitFor(() => expect(respondToApproval).toHaveBeenCalledWith({ approved: true }))
    expect(editPosts()).toHaveLength(0)
  })

  test('a draft that no longer exists degrades to a warning, approve still possible', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/api/email/')
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
    )
    render(<DraftComposeCard {...updateProps()} />)
    await waitFor(() => expect(screen.getByText(/找不到这封草稿/)).toBeTruthy())
    expect(screen.getByText('保存修改')).toBeTruthy()
  })

  test('done + failed old-draft delete → the duplicate is called out', () => {
    render(
      <DraftComposeCard
        {...updateProps({
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: true },
          result: {
            draft_internal_id: 9,
            drafts_folder: 'Drafts',
            old_draft_deleted: false,
            final_subject: 'new subject',
            final_to: ['bob@x.test'],
            user_edited: false
          }
        })}
      />
    )
    expect(screen.getByText(/草稿已更新/)).toBeTruthy()
    expect(screen.getByText(/原草稿删除失败/)).toBeTruthy()
    expect(screen.getByText(/Drafts/)).toBeTruthy()
  })
})

// ── issue #70 — the error phase must say WHY ────────────────────────────────────────────────
//
// Production shipped 8 identical "草稿操作失败，请重试" cards for a run that failed the same way
// every time; the reason (a schema-validation issue naming internal_id) was sitting in the part
// the card was already reading.

describe('DraftComposeCard — error detail', () => {
  /** The errorText ai@7 produces when the model sends internal_id on a mode-'new' compose. */
  const VALIDATION_ERROR_TEXT =
    'AI_InvalidToolInputError: Invalid input for tool email_draft_compose: ' +
    'AI_TypeValidationError: Type validation failed: Value: ' +
    '{"mode":"new","internal_id":0,"body_markdown":"…","to":["a@x.test"]}.\n' +
    'Error message: [\n  {\n    "code": "custom",\n    "path": [\n      "internal_id"\n    ],\n' +
    '    "message": "mode \'new\' takes no internal_id (a new draft has no source email)"\n  }\n]'

  const errorProps = (result: unknown): ToolCallMessagePartProps =>
    mockProps({
      isError: true,
      status: { type: 'incomplete', reason: 'error' },
      approval: { id: 'apr-1', approved: true },
      result
    } as Partial<ToolCallMessagePartProps>)

  test('a schema-validation failure shows the offending field + its message', () => {
    render(<DraftComposeCard {...errorProps({ error: VALIDATION_ERROR_TEXT })} />)
    expect(screen.getByText(/草稿操作失败/)).toBeTruthy()
    // Unwrapped from the JSON dump — the field and the rule, not the raw blob.
    expect(screen.getByText(/internal_id: mode 'new' takes no internal_id/)).toBeTruthy()
    // …and the rejected input is NOT pasted into the card.
    expect(screen.queryByText(/Type validation failed/)).toBeNull()
  })

  test('a coded domain failure is shown as-is', () => {
    render(<DraftComposeCard {...errorProps({ error: '[E_UPSTREAM] imap append refused' })} />)
    expect(screen.getByText('[E_UPSTREAM] imap append refused')).toBeTruthy()
  })

  test('no usable detail → the generic sentence stands alone (no empty line)', () => {
    render(<DraftComposeCard {...errorProps({ error: '   ' })} />)
    expect(screen.getByText(/草稿操作失败/)).toBeTruthy()
  })
})
