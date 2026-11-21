// @vitest-environment happy-dom

import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { AssistantMessage } from '@shared/assistant/components/message'
import { AgentAssistantMessage } from '@shared/components/agents/AgentMessage'
import { TurnProcessGroup } from '@shared/assistant/tools/generic/TurnProcessGroup'

await i18n.changeLanguage('zh-CN')

beforeAll(() => {
  for (const key of ['ResizeObserver', 'IntersectionObserver'] as const) {
    if (!(key in globalThis)) {
      ;(globalThis as Record<string, unknown>)[key] = class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): [] {
          return []
        }
      }
    }
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}
})

afterEach(() => {
  cleanup()
})

function stubChatHelpers(status: string, messages: unknown[]): Parameters<typeof useAISDKRuntime>[0] {
  return {
    status,
    messages,
    error: undefined,
    setMessages: () => {},
    sendMessage: async () => {},
    regenerate: async () => {},
    stop: () => {},
    addToolResult: () => {},
    addToolOutput: () => {},
    addToolApprovalResponse: () => {},
    id: 'test-chat'
  } as unknown as Parameters<typeof useAISDKRuntime>[0]
}

function TestUser(): React.JSX.Element {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  )
}

function Harness({
  status,
  messages,
  Assistant = AssistantMessage
}: {
  status: string
  messages: unknown[]
  Assistant?: React.ComponentType
}): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, messages))
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages
            components={{ UserMessage: TestUser, AssistantMessage: Assistant }}
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'find redis docs' }] }

describe('TurnProcessGroup — unified auto-collapse timeline', () => {
  test('expands with active narration while streaming, then auto-collapses when prose begins', async () => {
    const runningTurn = [
      USER,
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '**Searching inbox**\nLooking closely', state: 'done' },
          {
            type: 'tool-email_search_fulltext',
            toolCallId: 't1',
            state: 'input-available',
            input: { query: 'redis timeout' }
          }
        ]
      }
    ]
    const { rerender } = render(<Harness status="streaming" messages={runningTurn} />)

    const toggle = await waitFor(() =>
      screen.getByTestId('turn-process-group').querySelector('button[aria-expanded]')
    )
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByText('正在全文搜索邮件「redis timeout」…').length).toBeGreaterThan(0)

    const settledWithProse = [
      USER,
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '**Searching inbox**\nLooking closely', state: 'done' },
          {
            type: 'tool-email_search_fulltext',
            toolCallId: 't1',
            state: 'output-available',
            input: { query: 'redis timeout' },
            output: { items: [{ internal_id: 1, subject: 'Redis fix' }] }
          },
          { type: 'text', text: '已经定位到相关邮件。' }
        ]
      }
    ]
    rerender(<Harness status="ready" messages={settledWithProse} />)

    await waitFor(() =>
      expect(
        screen
          .getByTestId('turn-process-group')
          .querySelector('button[aria-expanded]')
          ?.getAttribute('aria-expanded')
      ).toBe('false')
    )
    expect(screen.getByText(/已完成 2 步 · 全文搜索邮件/)).toBeTruthy()
    expect(screen.getByText('已经定位到相关邮件。')).toBeTruthy()
  })

  test('bounds live trace to last 3 steps with show-all toggle on AgentAssistantMessage', async () => {
    const manySteps = [
      USER,
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'step 0', state: 'done' },
          { type: 'tool-email_search_fulltext', toolCallId: 't1', state: 'output-available', input: { query: 'first-hidden' }, output: { items: [] } },
          { type: 'tool-email_get', toolCallId: 't2', state: 'output-available', input: {}, output: {} },
          { type: 'tool-email_body', toolCallId: 't3', state: 'output-available', input: {}, output: {} },
          { type: 'tool-kos_query', toolCallId: 't4', state: 'input-available', input: { q: 'visible-last' } }
        ]
      }
    ]
    render(<Harness status="streaming" messages={manySteps} Assistant={AgentAssistantMessage} />)

    const showAllBtn = await waitFor(() => screen.getByText('展开全部 5 步'))
    expect(screen.queryByText('first-hidden')).toBeNull()
    expect(screen.getByText('visible-last')).toBeTruthy()

    fireEvent.click(showAllBtn)
    await waitFor(() => expect(screen.getByText('first-hidden')).toBeTruthy())
  })

  test('keeps TurnProcessGroup exported', () => {
    expect(typeof TurnProcessGroup).toBe('function')
  })
})
