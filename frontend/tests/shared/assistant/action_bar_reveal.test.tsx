// @vitest-environment happy-dom
//
// W5 「回答完成收束」—— action row 在回合落地那一刻做一次 opacity 0→1 淡入。
//
// 这里钉的是**收束的两个端点**，不是过渡的中间帧（happy-dom 不跑 CSS transition）：
//   · 回合进行中：ActionBarPrimitive.Root 的 hideWhenRunning 让整条 bar 不在 DOM 里；
//   · 回合完成后：bar 挂上，并在下一帧从 `opacity-0 pointer-events-none` 翻成 `opacity-100`
//     —— 🔴 这条断言真正防的是「rAF 没落地 → 按钮永久隐形」这个最吓人的失败形态，而不是动效好不好看。
// 用 inlineOnHover（agent 面）那条：它不带 KosSaveButton，于是整个用例不需要 mailApi/IPC。

import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { AssistantActionBar } from '@shared/assistant/components/action-bar'

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

function stubChatHelpers(
  status: string,
  messages: unknown[]
): Parameters<typeof useAISDKRuntime>[0] {
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

function TestAssistant(): React.JSX.Element {
  return (
    <MessagePrimitive.Root>
      <MessagePrimitive.Parts />
      <AssistantActionBar inlineOnHover />
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
const ASSISTANT = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '答完了。' }] }

describe('AssistantActionBar — W5 回答完成收束', () => {
  test('回合进行中：bar 根本不在 DOM 里（hideWhenRunning）', async () => {
    render(<Harness status="streaming" messages={[USER, ASSISTANT]} />)
    await waitFor(() => expect(screen.getByText('答完了。')).toBeTruthy())
    expect(screen.queryByLabelText('复制')).toBeNull()
  })

  test('回合完成：bar 挂上后翻成可见（不会卡在 opacity-0 / pointer-events-none）', async () => {
    render(<Harness status="ready" messages={[USER, ASSISTANT]} />)
    const copy = await waitFor(() => screen.getByLabelText('复制'))
    const row = copy.parentElement as HTMLElement
    // 一次性淡入用的是 slow 档（380ms token），不是裸时长。
    expect(row.className).toContain('duration-slow')
    await waitFor(() => expect(row.className).toContain('opacity-100'))
    expect(row.className).not.toContain('pointer-events-none')
  })
})
