// P2g — notion_agent_chat tool against a mock platform. Verifies tier/category/
// surface, input forwarding (incl. defaults), ok/error mapping, thread_id
// pass-through, validation, and the user-edited-input path.

import { describe, expect, test, vi } from 'vitest'

import { createNotionAgentTools } from '../../../src/shared/chat/tools/builtin/notion_agent'
import type { ChatToolPlatform, NotionAgentChatResult } from '../../../src/shared/chat/platform'
import type { ToolExecCtx } from '../../../src/shared/chat/tools/registry'

const ctx: ToolExecCtx = { sessionId: 1, emailId: null, signal: new AbortController().signal }

function mockPlatform(over: Partial<ChatToolPlatform> = {}): ChatToolPlatform {
  return { ...over } as unknown as ChatToolPlatform
}

describe('notion_agent_chat tool', () => {
  test('tier preview + category notion + cli surface', () => {
    const [t] = createNotionAgentTools(mockPlatform())
    expect(t.name).toBe('notion_agent_chat')
    expect(t.confirmationTier).toBe('preview')
    expect(t.category).toBe('notion')
    expect(t.surface).toBe('cli')
  })

  test('forwards input (defaulting optionals) + maps ok result', async () => {
    const notionAgentChat = vi.fn(
      async (): Promise<NotionAgentChatResult> => ({
        text: 'answer',
        threadId: 'thr-9',
        status: 'ok',
        metadata: { thread_id: 'thr-9' }
      })
    )
    const [t] = createNotionAgentTools(mockPlatform({ notionAgentChat }))
    const res = await t.handler({ message: 'q', thread_id: 'thr-9', model: 'm' }, ctx)
    // codex review — input AND the harness abort signal are forwarded.
    expect(notionAgentChat).toHaveBeenCalledWith(
      { message: 'q', threadId: 'thr-9', model: 'm', agentPageId: null },
      ctx.signal
    )
    // codex review LOW — status + metadata surfaced alongside text + thread_id.
    expect(res).toMatchObject({
      ok: true,
      output: { text: 'answer', thread_id: 'thr-9', status: 'ok', metadata: { thread_id: 'thr-9' } }
    })
  })

  test('error status → ok:false with the notion error code', async () => {
    const notionAgentChat = vi.fn(
      async (): Promise<NotionAgentChatResult> => ({
        text: '',
        threadId: null,
        status: 'error',
        metadata: null,
        errorCode: 'E_NOTION_AGENT_NOT_INSTALLED',
        errorMessage: 'no cli'
      })
    )
    const [t] = createNotionAgentTools(mockPlatform({ notionAgentChat }))
    const res = await t.handler({ message: 'q' }, ctx)
    expect(res).toMatchObject({ ok: false, code: 'E_NOTION_AGENT_NOT_INSTALLED' })
  })

  test('requires message', async () => {
    const [t] = createNotionAgentTools(mockPlatform({ notionAgentChat: vi.fn() }))
    expect(await t.handler({}, ctx)).toMatchObject({ ok: false, code: 'E_INVALID_ARG' })
  })

  test('honors user-edited input from the confirm dialog', async () => {
    const notionAgentChat = vi.fn(
      async (): Promise<NotionAgentChatResult> => ({
        text: 'x',
        threadId: null,
        status: 'ok',
        metadata: null
      })
    )
    const [t] = createNotionAgentTools(mockPlatform({ notionAgentChat }))
    const res = await t.handler(
      { message: 'orig' },
      { ...ctx, userEditedInput: { message: 'edited' } }
    )
    expect(notionAgentChat).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'edited' }),
      ctx.signal
    )
    expect(res).toMatchObject({ ok: true, output: { user_edited: true } })
  })
})
