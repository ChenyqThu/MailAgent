// @vitest-environment happy-dom
//
// P2-L5 —— 用户气泡下的「已存入资料库 / 未归档」chip（design §1.4 的 F3 深链那一枚）。
//
// 走**真实读投影链**而不是直接挂组件：`ui_message_json` → `chatMessageToUIMessage` →
// AI SDK 消息 → react-ai-sdk 的 converter → `message.content`。这条链上有一处很容易想当然的
// 地方：converter 会把 user 的 `file` part 搬去 `attachments` 并从 content 里删掉，但
// `data-*` part 是**留在 content 里**的（转成 `{type:'data', name, data}`）。chip 能不能画出来
// 全看这一点，所以断言必须穿过整条链，不能只 render 组件。
//
// 两个用户气泡渲染器（邮件面 message.tsx / 通用面 AgentMessage.tsx）共用同一份
// `UserMessageLibraryChips`，本文件钉通用面这条，另一处由同一份组件保证。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AgentThread } from '@shared/components/agents/AgentThread'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { chatMessageToUIMessage, type MailAgentUIMessage } from '@shared/assistant/uiMessage'

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
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={113} initialMessages={messages}>
        <ChatComposerControlsProvider value={stubControls()}>
          <AgentThread readOnly />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

function rowWithParts(id: number, content: string, parts: unknown[]): MailAgentUIMessage {
  return chatMessageToUIMessage({
    id,
    role: 'user',
    content,
    thinking: null,
    model: null,
    tokens_input: null,
    tokens_output: null,
    ui_message_json: JSON.stringify({ id: `ui-${id}`, role: 'user', parts })
  })
}

describe('用户气泡的 data-library chip', () => {
  test('入库成功 → 画一枚可点的「已存入资料库」chip，带库里的文件名', async () => {
    const { container } = renderThread([
      rowWithParts(1, '看看这个', [
        { type: 'text', text: '看看这个' },
        {
          type: 'data-library',
          data: {
            name: 'report.docx',
            archived: true,
            fileId: 42,
            path: 'chat-attachments/2026-09/report.docx'
          }
        }
      ])
    ])
    await waitFor(() => expect(screen.queryByText('看看这个')).toBeTruthy())

    expect(screen.queryByText('report.docx')).toBeTruthy()
    expect(screen.queryByText(i18n.t('library.chip.archived'))).toBeTruthy()
    const chip = screen.getByText('report.docx').closest('button')
    expect(chip).toBeTruthy()
    expect((chip as HTMLButtonElement).disabled).toBe(false)
    expect(container.querySelector('.lucide-archive')).toBeTruthy()
  })

  test('入库失败 → chip 标「未归档」且不可点（没有去处的 chip 不给点）', async () => {
    renderThread([
      rowWithParts(2, '这个呢', [
        { type: 'text', text: '这个呢' },
        { type: 'data-library', data: { name: 'big.zip', archived: false } }
      ])
    ])
    await waitFor(() => expect(screen.queryByText('这个呢')).toBeTruthy())

    expect(screen.queryByText(i18n.t('library.chip.notArchived'))).toBeTruthy()
    expect(screen.queryByText(i18n.t('library.chip.archived'))).toBeNull()
    const chip = screen.getByText('big.zip').closest('button')
    expect((chip as HTMLButtonElement).disabled).toBe(true)
    // hover 提示说清楚了「这次只把抽取文本发给了模型」
    expect((chip as HTMLButtonElement).getAttribute('title')).toBe(
      i18n.t('library.chip.notArchivedHint')
    )
  })

  test('没有 data-library part 的消息 → 一个 chip 都不画', async () => {
    const { container } = renderThread([
      rowWithParts(3, '纯文本', [{ type: 'text', text: '纯文本' }])
    ])
    await waitFor(() => expect(screen.queryByText('纯文本')).toBeTruthy())
    expect(container.querySelector('.lucide-archive')).toBeNull()
    expect(screen.queryByText(i18n.t('library.chip.archived'))).toBeNull()
  })

  test('纯附件消息（无 text part）也画 chip —— 气泡不渲染时 chip 不能跟着消失', async () => {
    renderThread([
      rowWithParts(4, '', [
        {
          type: 'data-library',
          data: { name: 'only.pdf', archived: true, fileId: 9, path: 'chat-attachments/2026-09/only.pdf' }
        }
      ])
    ])
    await waitFor(() => expect(screen.queryByText('only.pdf')).toBeTruthy())
    expect(screen.queryByText(i18n.t('library.chip.archived'))).toBeTruthy()
  })
})
