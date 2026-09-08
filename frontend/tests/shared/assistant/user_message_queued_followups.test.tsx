// @vitest-environment happy-dom
//
// dogfood 0903 续 —— 带 `<queued_followups>` 信封的用户气泡整页崩。
//
// 现象：团队 → 事项跟进一点就白屏，React error #185（Maximum update depth exceeded），
// 崩在 `<UserMessageBody>`。根因不是信封的解析，是**解析放错了位置**：selector 里调
// `parseQueuedFollowups`，命中时返回新数组 → `useAuiState` 底下 `useSyncExternalStore` 的
// getSnapshot 每次都变 → 无限重渲染。未命中返回 null（引用稳定），所以只有真正带信封的
// 会话会炸 —— 这也是为什么它躲过了上一批的 `queuedFollowups.test.ts`（那份测纯函数，
// 纯函数一直是对的）。
//
// 所以本文件必须走**真实渲染链**（同 user_message_library_chip.test.tsx）而不是直接调函数：
// 只有真挂进 runtime，getSnapshot 的稳定性才会被 React 检验——循环一旦回来，render 当场抛错。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AgentThread } from '@shared/components/agents/AgentThread'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { chatMessageToUIMessage, type MailAgentUIMessage } from '@shared/assistant/uiMessage'
import { buildQueuedFollowupsEnvelope } from '../../../src/ai-gateway/queuedInputDispatch'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function stubControls(): ChatComposerControls {
  return {
    model: 'claude-sonnet-4-6',
    availableModels: [],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    agentMentions: [],
    onAddAgentMention: vi.fn(),
    onRemoveAgentMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn()
  }
}

function renderThread(messages: MailAgentUIMessage[]): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider
        gatewayBaseUrl="http://127.0.0.1:1"
        sessionId={null}
        initialMessages={messages}
      >
        <ChatComposerControlsProvider value={stubControls()}>
          <AgentThread readOnly />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

function userRow(id: number, text: string): MailAgentUIMessage {
  return chatMessageToUIMessage({
    id,
    role: 'user',
    content: text,
    thinking: null,
    model: null,
    tokens_input: null,
    tokens_output: null,
    ui_message_json: JSON.stringify({
      id: `ui-${id}`,
      role: 'user',
      parts: [{ type: 'text', text }]
    })
  })
}

describe('用户气泡里的排队追问信封', () => {
  test('信封拆成几行原文渲染，不打 XML，也不把自己渲染崩', async () => {
    renderThread([userRow(1, buildQueuedFollowupsEnvelope(['你能干什么', '再说细一点']))])

    await waitFor(() => expect(screen.queryByText('你能干什么')).toBeTruthy())
    expect(screen.queryByText('再说细一点')).toBeTruthy()
    expect(screen.queryByText(i18n.t('chat.queuedInput.dispatchedLabel'))).toBeTruthy()
    // 信封本身绝不出现在界面上（那是发给模型的载体）。
    expect(document.body.textContent).not.toContain('<queued_followups>')
    expect(document.body.textContent).not.toContain('<message>')
  })

  test('普通消息照旧走 Parts —— 没有信封时不该多出「已发送的追问」标题', async () => {
    renderThread([userRow(2, '普通的一句话')])

    await waitFor(() => expect(screen.queryByText('普通的一句话')).toBeTruthy())
    expect(screen.queryByText(i18n.t('chat.queuedInput.dispatchedLabel'))).toBeNull()
  })

  test('同一线程里信封与普通消息混排都稳 —— 崩的那版在这里就已经抛了', async () => {
    renderThread([
      userRow(3, '先问一句'),
      userRow(4, buildQueuedFollowupsEnvelope(['排队的第一条', '排队的第二条'])),
      userRow(5, '最后再补一句')
    ])

    await waitFor(() => expect(screen.queryByText('最后再补一句')).toBeTruthy())
    expect(screen.queryByText('先问一句')).toBeTruthy()
    expect(screen.queryByText('排队的第一条')).toBeTruthy()
    expect(screen.queryByText('排队的第二条')).toBeTruthy()
  })
})
