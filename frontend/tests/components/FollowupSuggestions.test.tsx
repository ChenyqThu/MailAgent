// @vitest-environment happy-dom
//
// chat UI 优化 W6 — follow-up chips render from the LAST assistant message's suggest_followups
// tool part, on BOTH chat surfaces (AgentThread footer + the email AssistantThread), and degrade
// to nothing when the model didn't call the tool / the prompts cleaned to empty.
//
// (The pure extraction/cleaning logic is pinned in tests/ai-gateway/followup_tool.test.ts; this
// file is the DOM half: parts → visible chips through the real AI SDK runtime conversion.)

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import type { ChatMessage } from '@shared/api/types'
import i18n from '@shared/i18n'

vi.mock('@shared/components/email/TranslatedBody', () => ({
  TranslatedBody: ({ text }: { text: string }) => <div data-testid="md">{text}</div>
}))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import { AssistantThread } from '@shared/assistant/components/thread'
import { SUGGEST_FOLLOWUPS_TOOL_NAME } from '@shared/assistant/followups'
import { AgentThread } from '@shared/components/agents/AgentThread'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!('IntersectionObserver' in globalThis)) {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return []
      }
    }
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {}
  }
})

afterEach(() => {
  cleanup()
})

function fakeMessage(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 1,
    session_id: 10,
    role: 'assistant',
    content: '',
    tokens_input: null,
    tokens_output: null,
    cost_usd: null,
    model: null,
    status: 'complete',
    error_message: null,
    metadata: null,
    thinking: null,
    ui_message_json: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...over
  }
}

/** An assistant row whose ui_message_json (the persisted AI SDK UIMessage SSoT) carries a text
 *  part + a completed suggest_followups tool part with the given output prompts. */
function assistantWithFollowups(prompts: string[], rawArgs?: string[]): ChatMessage {
  return fakeMessage({
    id: 2,
    role: 'assistant',
    content: '总结完了。',
    ui_message_json: JSON.stringify({
      id: 'a2',
      role: 'assistant',
      parts: [
        { type: 'text', text: '总结完了。' },
        {
          type: `tool-${SUGGEST_FOLLOWUPS_TOOL_NAME}`,
          toolCallId: 'tc1',
          state: 'output-available',
          input: { prompts: rawArgs ?? prompts },
          output: { prompts, count: prompts.length }
        }
      ]
    })
  })
}

function mount(messages: ChatMessage[], thread: React.ReactElement): ReturnType<typeof render> {
  return render(
    <AiSdkRuntimeProvider
      gatewayBaseUrl=""
      sessionId={null}
      initialMessages={messages.map(chatMessageToUIMessage)}
    >
      {thread}
    </AiSdkRuntimeProvider>
  )
}

const seeded = (prompts: string[], rawArgs?: string[]): ChatMessage[] => [
  fakeMessage({ id: 1, role: 'user', content: '帮我总结' }),
  assistantWithFollowups(prompts, rawArgs)
]

describe('W6 follow-up chips — parts → chips on both surfaces', () => {
  test('AgentThread: chips render from the tool part (agent surface)', async () => {
    mount(seeded(['接下来做什么？', '帮我起草回复']), <AgentThread />)
    await waitFor(() => expect(screen.getByText('接下来做什么？')).toBeTruthy())
    expect(screen.getByText('帮我起草回复')).toBeTruthy()
  })

  test('AssistantThread (email surface): the SAME chips render above the composer', async () => {
    mount(seeded(['查看相关附件']), <AssistantThread />)
    await waitFor(() => expect(screen.getByText('查看相关附件')).toBeTruthy())
  })

  test('no suggest_followups part → no chips (graceful degrade, no empty block)', async () => {
    mount(
      [
        fakeMessage({ id: 1, role: 'user', content: '帮我总结' }),
        fakeMessage({ id: 2, role: 'assistant', content: '总结完了。' })
      ],
      <AgentThread />
    )
    await waitFor(() => expect(screen.getByText('总结完了。')).toBeTruthy())
    expect(screen.queryByText('接下来做什么？')).toBeNull()
  })

  test('prompts cleaned to empty → no chips (the row itself is absent)', async () => {
    mount(seeded([], ['', '   ']), <AgentThread />)
    await waitFor(() => expect(screen.getByText('总结完了。')).toBeTruthy())
    expect(screen.queryByTestId('followup-suggestions')).toBeNull()
  })

  test('readOnly surfaces suppress the chips (record view / legacy history)', async () => {
    mount(seeded(['接下来做什么？']), <AgentThread readOnly />)
    await waitFor(() => expect(screen.getByText('总结完了。')).toBeTruthy())
    expect(screen.queryByText('接下来做什么？')).toBeNull()
  })
})
