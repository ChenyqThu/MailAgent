// @vitest-environment happy-dom
//
// dogfood 07-27 Lane D 第二现场 — owner 真机复验「图片历史仍不显示」。
//
// 第一轮只修了邮件面板的 UserMessage；owner 实际用的是**通用对话**（Cmd+O / AgentConversation →
// AgentThread → AgentUserMessage，真机 session 113 anchor_type='general'、标题「图片内容识别请求」）。
// 那个渲染器**整个没有附件行**，只画 MessagePrimitive.Parts —— 而 AISDKMessageConverter 会把 user
// 的 file part 从 content 里剔除、只留在 message.attachments（convertMessage.ts:200-201），于是图在
// 这条面上连回形针药丸都不剩，直接消失。两个面症状不同（邮件面 = 有药丸无图；通用面 = 什么都没有），
// 根子都在「有没有那一行」。
//
// 本文件钉通用面；邮件面在 user_message_image_history.test.tsx。两边共用同一个
// UserMessageAttachments（从 assistant/components/message 导出）—— 再抄第三份必然再次分叉。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AgentThread } from '@shared/components/agents/AgentThread'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import { chatMessageToUIMessage, type MailAgentUIMessage } from '@shared/assistant/uiMessage'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

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
    thinkingSupported: false,
    thinkingEnabled: false,
    onToggleThinking: vi.fn(),
    model: 'claude-sonnet-4-6',
    availableModels: [],
    onModelChange: vi.fn(),
    modelPickerDisabled: false,
    mentions: [],
    onAddMention: vi.fn(),
    onRemoveMention: vi.fn(),
    attachments: [],
    onAddAttachment: vi.fn(),
    onRemoveAttachment: vi.fn()
  }
}

function renderAgentThread(initialMessages: MailAgentUIMessage[]): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider
        gatewayBaseUrl="http://127.0.0.1:1"
        sessionId={113}
        initialMessages={initialMessages}
      >
        <ChatComposerControlsProvider value={stubControls()}>
          <AgentThread readOnly />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

function messageRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-message-id]')
  expect(root).toBeTruthy()
  return root as HTMLElement
}

// ── 读投影层 ───────────────────────────────────────────────────────────────────
// 渲染的入口是 `chat.messages.map(chatMessageToUIMessage)`，喂进来的行是 serve-api
// `GET /chat/sessions/{id}/messages` 的原样 JSON（`SELECT *`，无 pydantic response_model）。
// 这里按**真实 wire 形状**造行（而不是直接手写 UIMessage），把投影层一起罩进用例里：
// 带 ui_message_json 的行走 canonical 路径（图在），不带的行走 content 文本合成 fallback（图无、
// 但文本历史不能坏 —— 那是 legacy / pre-v9 行的正常形态）。

interface WireRow {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  thinking: string | null
  model: string | null
  tokens_input: number | null
  tokens_output: number | null
  ui_message_json?: string | null
}

function wireRow(over: Partial<WireRow> & Pick<WireRow, 'id' | 'role' | 'content'>): WireRow {
  return {
    session_id: 113,
    thinking: null,
    model: null,
    tokens_input: null,
    tokens_output: null,
    ...over
  }
}

/** 真机 348 行的形状（url 换成 1x1 PNG，其余逐字段同构）。 */
function imageUiMessageJson(text: string, filename = 'image.png'): string {
  return JSON.stringify({
    id: 'VedRCFwlbekdkNaZ',
    role: 'user',
    metadata: {},
    parts: [
      { type: 'text', text },
      { type: 'file', url: PNG_DATA_URL, mediaType: 'image/png', filename }
    ]
  })
}

describe('通用对话（AgentThread）— 图片历史', () => {
  test('带 ui_message_json 的行 → 用户气泡下渲染出这张图', async () => {
    const rows = [wireRow({ id: 348, role: 'user', content: '这个图片呢' })]
    rows[0]!.ui_message_json = imageUiMessageJson('这个图片呢')
    const { container } = renderAgentThread(rows.map(chatMessageToUIMessage))
    await waitFor(() => expect(screen.queryByText('这个图片呢')).toBeTruthy())

    const imgs = messageRoot(container).querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    expect(imgs[0]!.getAttribute('src')).toBe(PNG_DATA_URL)
    expect(imgs[0]!.getAttribute('alt')).toBe('image.png')
    // 尺寸上限在场（data URL 可能是几百 KB 的大图）
    expect(imgs[0]!.className).toMatch(/\bmax-h-/)
    expect(imgs[0]!.className).toMatch(/\bmax-w-\[/)
  })

  test('不带 ui_message_json 的 legacy 行 → 文本 fallback 不变（无图、但历史正常）', async () => {
    const rows = [wireRow({ id: 100, role: 'user', content: '一条老消息' })]
    const { container } = renderAgentThread(rows.map(chatMessageToUIMessage))
    await waitFor(() => expect(screen.queryByText('一条老消息')).toBeTruthy())

    const root = messageRoot(container)
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.querySelector('.lucide-paperclip')).toBeNull()
  })

  test('纯图消息（无文本）不画空气泡，图照常显示', async () => {
    const row = wireRow({ id: 349, role: 'user', content: '' })
    row.ui_message_json = JSON.stringify({
      id: 'imgonly',
      role: 'user',
      parts: [{ type: 'file', url: PNG_DATA_URL, mediaType: 'image/png', filename: 'only.png' }]
    })
    const { container } = renderAgentThread([chatMessageToUIMessage(row)])
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))
    // 没有 text part → content 空 → 不渲染气泡壳（否则是一枚空药丸）
    expect(messageRoot(container).querySelector('.bg-ink-3.rounded-2xl')).toBeNull()
  })

  test('纯文本消息渲染不回退：气泡在、无附件行', async () => {
    const row = wireRow({ id: 101, role: 'user', content: '只有文字' })
    row.ui_message_json = JSON.stringify({
      id: 'textonly',
      role: 'user',
      parts: [{ type: 'text', text: '只有文字' }]
    })
    const { container } = renderAgentThread([chatMessageToUIMessage(row)])
    await waitFor(() => expect(screen.queryByText('只有文字')).toBeTruthy())

    const root = messageRoot(container)
    expect(root.textContent).toContain('只有文字')
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.querySelector('.lucide-paperclip')).toBeNull()
  })

  test('非图片附件仍是回形针药丸（不塞 <img>）', async () => {
    const row = wireRow({ id: 102, role: 'user', content: '看这个包' })
    row.ui_message_json = JSON.stringify({
      id: 'zip',
      role: 'user',
      parts: [
        { type: 'text', text: '看这个包' },
        {
          type: 'file',
          url: 'data:application/zip;base64,UEsDBA==',
          mediaType: 'application/zip',
          filename: 'bundle.zip'
        }
      ]
    })
    const { container } = renderAgentThread([chatMessageToUIMessage(row)])
    await waitFor(() => expect(screen.queryByText('看这个包')).toBeTruthy())

    const root = messageRoot(container)
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.querySelector('.lucide-paperclip')).toBeTruthy()
    expect(root.textContent).toContain('bundle.zip')
  })
})
