// @vitest-environment happy-dom
//
// 09-10 dogfood —— 自动压缩之后，对话面板整页报「System messages must have exactly one text
// message part」。压缩标记的 canonical 是 role='system' + 一个 data-compact 数据块，assistant-ui 在
// 渲染前就拒收（system 消息必须恰好一段文本）。回放层把它规整成一段摘要文本 + custom.compact。
//
// 🔴 这条闸必须真挂 runtime：只测 chatMessageToUIMessage 的形状，拦不住「形状对了但运行时仍拒收」。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AgentThread } from '@shared/components/agents/AgentThread'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'

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

const metadata = {
  kind: 'compact',
  version: 1,
  compactedThroughMessageId: 1040,
  firstKeptMessageId: 1041,
  tokensBefore: 180_000,
  estimatedTokensAfter: 12_000,
  model: 'claude-sonnet-4-6',
  reason: 'threshold',
  valid: true,
  createdAt: 1_789_078_194_146
}

/** 真机 1042 行的形状（compact.ts compactUiMessage 的 canonical，逐字段同构）。 */
const compactRow = {
  id: 1042,
  role: 'system' as const,
  content: '十节摘要正文',
  thinking: null,
  model: 'claude-sonnet-4-6',
  tokens_input: null,
  tokens_output: null,
  ui_message_json: JSON.stringify({
    id: `compact-${metadata.createdAt}`,
    role: 'system',
    metadata,
    parts: [{ type: 'data-compact', data: { metadata, summary: '十节摘要正文' } }]
  })
}

const userRow = {
  id: 1043,
  role: 'user' as const,
  content: '接着说',
  thinking: null,
  model: null,
  tokens_input: null,
  tokens_output: null
}

describe('压缩标记回放进 runtime', () => {
  test('带压缩行的会话能渲染：压缩卡片在，后续消息在，面板不崩', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <AiSdkRuntimeProvider
          gatewayBaseUrl="http://127.0.0.1:1"
          sessionId={328}
          initialMessages={[compactRow, userRow].map(chatMessageToUIMessage)}
        >
          <ChatComposerControlsProvider value={stubControls()}>
            <AgentThread readOnly />
          </ChatComposerControlsProvider>
        </AiSdkRuntimeProvider>
      </QueryClientProvider>
    )
    expect(await screen.findByText('已压缩上下文')).toBeTruthy()
    expect(screen.getByText('#1040 → #1041')).toBeTruthy()
    expect(screen.getByText('接着说')).toBeTruthy()
  })
})
