// @vitest-environment happy-dom
//
// harness-chat lane B — ToolGroupCard folds consecutive tool calls. Driven through the REAL ai-sdk
// runtime (useAISDKRuntime → converter → store → MessagePrimitive.Parts ToolGroup slot) so the
// grouping ranges + the parts the summary reads are production-derived. Asserts the two 灾难级 red
// lines plus the count/state header and auto-collapse:
//   ① a single tool renders BARE (no group chrome — zero regression vs the pre-grouping layout).
//   ② a group with an approval-requested / errored tool is FORCE-EXPANDED and cannot be collapsed.

import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { ToolGroupCard } from '@shared/assistant/tools/generic/ToolGroupCard'

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
    addToolApprovalResponse: () => {}
  } as unknown as Parameters<typeof useAISDKRuntime>[0]
}

// Bare tool marker so the group has children without pulling the A2UI cards in. ToolGroupCard reads
// the summary from the store parts, independent of this renderer.
const PARTS = {
  tools: { Fallback: ({ toolName }: { toolName: string }) => <span data-testid="tool">{toolName}</span> },
  ToolGroup: ToolGroupCard
} as unknown as React.ComponentProps<typeof MessagePrimitive.Parts>['components']

function TestAssistant(): React.JSX.Element {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts components={PARTS} />
    </MessagePrimitive.Root>
  )
}
function TestUser(): React.JSX.Element {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts />
    </MessagePrimitive.Root>
  )
}

function Harness({ status, messages }: { status: string; messages: unknown[] }): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, messages))
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages
            components={{ UserMessage: TestUser, AssistantMessage: TestAssistant }}
          />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }

const toolWire = (
  name: string,
  id: string,
  over: Record<string, unknown> = { state: 'input-available', input: {} }
): Record<string, unknown> => ({ type: `tool-${name}`, toolCallId: id, ...over })

const done = (name: string, id: string): Record<string, unknown> =>
  toolWire(name, id, { state: 'output-available', input: {}, output: { ok: true } })

function assistant(parts: unknown[]): Record<string, unknown> {
  return { id: 'a1', role: 'assistant', parts }
}

describe('ToolGroupCard — RED LINE ①: single tool renders bare', () => {
  test('a lone tool call has NO group header and no group toggle button', async () => {
    render(
      <Harness status="streaming" messages={[USER, assistant([toolWire('email_search', 't1')])]} />
    )
    await waitFor(() => expect(screen.getByTestId('tool')).toBeTruthy())
    // no group header text, no group button.
    expect(screen.queryByText(/正在使用工具|使用了|等待授权|有失败/)).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('ToolGroupCard — running / done header + auto-collapse', () => {
  test('multiple running tools → one running-header group (shimmer text)', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          assistant([toolWire('email_search', 't1'), toolWire('kos_query', 't2'), toolWire('email_get', 't3')])
        ]}
      />
    )
    await waitFor(() => expect(screen.getByText('正在使用工具…')).toBeTruthy())
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('true') // running → expanded
    // all three tool markers present inside the group.
    expect(screen.getAllByTestId('tool')).toHaveLength(3)
  })

  test('all-done group (history) → count header + starts collapsed (auto-collapse)', async () => {
    render(
      <Harness
        status="ready"
        messages={[USER, assistant([done('email_search', 't1'), done('kos_query', 't2'), done('email_get', 't3')])]}
      />
    )
    await waitFor(() => expect(screen.getByText('使用了 3 个工具')).toBeTruthy())
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('ToolGroupCard — RED LINE ②: force-expand, cannot collapse', () => {
  test('group containing an approval tool → awaiting header, expanded, click cannot collapse', async () => {
    render(
      <Harness
        status="streaming"
        messages={[
          USER,
          assistant([
            done('email_search', 't1'),
            toolWire('email_draft_reply', 't2', {
              state: 'approval-requested',
              input: {},
              approval: { id: 'ap1' }
            })
          ])
        ]}
      />
    )
    await waitFor(() => expect(screen.getByText('等待授权')).toBeTruthy())
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    // clicking must NOT collapse a force-expanded group (the approval card would vanish).
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })

  test('group containing an errored tool → error header, force-expanded', async () => {
    render(
      <Harness
        status="ready"
        messages={[
          USER,
          assistant([
            done('email_search', 't1'),
            toolWire('email_get', 't2', { state: 'output-error', input: {}, errorText: 'boom' })
          ])
        ]}
      />
    )
    await waitFor(() => expect(screen.getByText('2 个工具 · 有失败')).toBeTruthy())
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
  })
})
