// @vitest-environment happy-dom
//
// living-bot-avatar WP5 — 集成冒烟：两个真实 assistant 消息包装层（邮件面 message.tsx +
// agent 面 AgentMessage.tsx）都把 TurnPresence 挂在内容上方（回合进行中头像在场），以及
// AiChatPanel 面板头的 AssistantPanelBotAvatar working 两态。
//
// 重依赖（A2UI 工具卡注册表 / action bar / followups / MessageTiming / lightbox）全部 mock 成
// 惰性空实现 —— 冒烟的对象是「包装层 → TurnPresence 的接线」，不是那些兄弟组件本身；
// TurnPresence / TurnPresenceRow / BotAvatar 用真实实现。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'

vi.mock('@shared/assistant/tools/registerToolUIs', () => ({
  getAssistantPartComponents: () => ({})
}))
vi.mock('@shared/assistant/components/action-bar', () => ({
  AssistantActionBar: () => null,
  UserActionBar: () => null
}))
vi.mock('@shared/assistant/components/FollowupSuggestions', () => ({
  FollowupSuggestions: () => null
}))
vi.mock('@shared/assistant/components/CompactCard', () => ({
  CompactCard: () => null
}))
vi.mock('@shared/assistant/components/MessageTiming', () => ({
  MessageTiming: () => null
}))
vi.mock('@shared/components/email/EmailBodyFrame', () => ({
  ImageLightbox: () => null
}))

// mock 之后再拉真实包装层（vi.mock 提升到 import 之前，这里的顺序只是给读者看的）。
import { AssistantMessage, UserMessage } from '@shared/assistant/components/message'
import {
  AgentAssistantMessage,
  AgentUserMessage
} from '@shared/components/agents/AgentMessage'
import { AssistantPanelBotAvatar } from '@shared/assistant/components/TurnPresence'

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
    setMessages: () => {},
    sendMessage: async () => {},
    regenerate: async () => {},
    stop: () => {},
    addToolResult: () => {},
    addToolOutput: () => {},
    addToolApprovalResponse: () => {}
  } as unknown as Parameters<typeof useAISDKRuntime>[0]
}

function Harness({
  status,
  messages,
  components
}: {
  status: string
  messages: unknown[]
  components: React.ComponentProps<typeof ThreadPrimitive.Messages>['components']
}): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, messages))
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>
          <ThreadPrimitive.Messages components={components} />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

const USER = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }

describe('集成冒烟 — message.tsx（邮件面板 assistant 气泡）', () => {
  const components = { UserMessage, AssistantMessage }

  test('回合进行中（0 parts）→ TurnPresence 在场，空气泡壳不画', async () => {
    const { container } = render(
      <Harness
        status="streaming"
        messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]}
        components={components}
      />
    )
    await waitFor(() => expect(screen.getByTestId('turn-presence')).toBeTruthy())
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('waking')
    // hasBubbleContent 门：pre-first-token 不画空的描边药丸（气泡壳的独有圆角类作判据）。
    expect(container.querySelector('.rounded-bl-md')).toBeNull()
  })

  test('回合结束（ready + 正文）→ TurnPresence 消失，气泡照常', async () => {
    const { container } = render(
      <Harness
        status="ready"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'answer text' }] }
        ]}
        components={components}
      />
    )
    await waitFor(() => expect(screen.getByText('answer text')).toBeTruthy())
    expect(screen.queryByTestId('turn-presence')).toBeNull()
    expect(container.querySelector('.rounded-bl-md')).toBeTruthy()
  })
})

describe('集成冒烟 — AgentMessage.tsx（agent 面全宽排版）', () => {
  const components = { UserMessage: AgentUserMessage, AssistantMessage: AgentAssistantMessage }

  test('回合进行中（0 parts）→ TurnPresence 在场', async () => {
    render(
      <Harness
        status="streaming"
        messages={[USER, { id: 'a1', role: 'assistant', parts: [] }]}
        components={components}
      />
    )
    await waitFor(() => expect(screen.getByTestId('turn-presence')).toBeTruthy())
    expect(screen.getByTestId('turn-presence').dataset.botState).toBe('waking')
  })

  test('回合结束（ready + 正文）→ TurnPresence 消失', async () => {
    render(
      <Harness
        status="ready"
        messages={[
          USER,
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'agent answer' }] }
        ]}
        components={components}
      />
    )
    await waitFor(() => expect(screen.getByText('agent answer')).toBeTruthy())
    expect(screen.queryByTestId('turn-presence')).toBeNull()
  })
})

describe('集成冒烟 — AssistantPanelBotAvatar（AiChatPanel 面板头）', () => {
  test('无后台 run → idle 微动；有后台 run → working', () => {
    const view = render(<AssistantPanelBotAvatar working={false} />)
    expect(screen.getByTestId('panel-bot-avatar').dataset.botState).toBe('idle')
    view.rerender(<AssistantPanelBotAvatar working={true} />)
    expect(screen.getByTestId('panel-bot-avatar').dataset.botState).toBe('working')
  })
})
