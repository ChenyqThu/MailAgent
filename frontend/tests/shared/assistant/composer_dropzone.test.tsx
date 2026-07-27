// @vitest-environment happy-dom
//
// issue #61 Lane 3 (A2) — 拖拽 + chip 渲染/删除 + 文本附件老路的组件级覆盖（粘贴链路在
// composer_paste_image.test.tsx）。三件事：
//
//   1. ComposerPrimitive.AttachmentDropzone 真的把拖进来的文件送进 composer.addAttachment
//      （两个 composer 都套了 wrapper）；
//   2. chip 从 composer state 渲染（文件名可见），AttachmentPrimitive.Remove 一键删除，且经
//      真实 AiSdkRuntimeProvider 的 attachmentBridge 反映射到 panel 回调 —— 回归面 #5；
//   3. 文本附件仍走 injectedContext 老路：消息体里**没有** file part，前缀块（panel 的
//      buildInjectedContext）照常出现在 body.injectedContext —— 回归面 #1/#3 的端到端形态。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import type { AttachmentPanelBridge } from '@shared/assistant/runtime/chatAttachmentAdapter'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'
import { buildAttachmentBlock, type ChatAttachment } from '@shared/lib/chat-attachments'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function pngFile(name = 'dropped.png'): File {
  const bin = atob(PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
}

function textFile(name = 'notes.txt', content = 'plain text payload'): File {
  return new File([content], name, { type: 'text/plain' })
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {}
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  capturedAui = null
})

function stubControls(over: Partial<ChatComposerControls> = {}): ChatComposerControls {
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
    onRemoveAttachment: vi.fn(),
    ...over
  }
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

/** panel 侧最小仿真：bridge 落进本地数组，buildInjectedContext 用真实 buildAttachmentBlock。 */
function makePanel(): {
  bridge: AttachmentPanelBridge
  added: ChatAttachment[]
  removed: string[]
  buildInjectedContext: () => Promise<string>
} {
  const added: ChatAttachment[] = []
  const removed: string[] = []
  return {
    added,
    removed,
    bridge: {
      onAdd: (a) => added.push(a),
      onRemove: (id) => {
        removed.push(id)
        const idx = added.findIndex((a) => a.id === id)
        if (idx !== -1) added.splice(idx, 1)
      }
    },
    buildInjectedContext: async () => buildAttachmentBlock(added)
  }
}

function Harness({
  children,
  bridge,
  buildInjectedContext
}: {
  children?: React.ReactNode
  bridge?: AttachmentPanelBridge
  buildInjectedContext?: () => Promise<string>
}): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider
        gatewayBaseUrl="http://127.0.0.1:1"
        sessionId={7}
        attachmentBridge={bridge}
        buildInjectedContext={buildInjectedContext}
      >
        <ChatComposerControlsProvider value={stubControls()}>
          <AuiProbe />
          {children ?? <ThreadComposer />}
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

function stubChatFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

type SentPart = { type: string; url?: string; text?: string }
function lastChatBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/ai/chat')).at(-1)
  if (!call) return {}
  const init = call[1] as RequestInit | undefined
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
}

/** 在元素上派发 drop（dataTransfer.files 挂真实 File）。 */
function fireDrop(el: Element, files: File[]): void {
  fireEvent.drop(el, { dataTransfer: { files } })
}

describe('AttachmentDropzone — 拖拽落进 adapter 通路', () => {
  test('ThreadComposer：drop PNG → composer state + chip 可见；Remove 删除', async () => {
    stubChatFetch()
    const { container } = render(<Harness />)
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    const textarea = screen.getByRole('textbox')

    fireDrop(textarea, [pngFile()])
    await waitFor(() => {
      expect(capturedAui!.composer().getState().attachments).toHaveLength(1)
    })
    // chip 从 composer state 渲染出来（可见反馈 —— issue #61 的观感修复本体）。
    expect(screen.queryByText('dropped.png')).not.toBeNull()
    // dropzone 元素存在（data-dragging 高亮属性由 primitive 管理）。
    expect(container.querySelector('form > div')).toBeTruthy()

    // AttachmentPrimitive.Remove → composer.removeAttachment → chip 消失。
    fireEvent.click(screen.getByRole('button', { name: 'remove' }))
    await waitFor(() => {
      expect(capturedAui!.composer().getState().attachments).toHaveLength(0)
    })
    expect(screen.queryByText('dropped.png')).toBeNull()
  })

  test('AgentComposer：drop PNG → composer state + chip 可见；Remove 删除', async () => {
    stubChatFetch()
    const { container } = render(
      <Harness>
        <AgentComposer />
      </Harness>
    )
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    const editable = container.querySelector('[contenteditable="true"]')!
    fireDrop(editable, [pngFile('agent-drop.png')])
    await waitFor(() => {
      expect(capturedAui!.composer().getState().attachments).toHaveLength(1)
    })
    expect(screen.queryByText('agent-drop.png')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'remove' }))
    await waitFor(() => {
      expect(capturedAui!.composer().getState().attachments).toHaveLength(0)
    })
    expect(screen.queryByText('agent-drop.png')).toBeNull()
  })
})

describe('文本附件 — injectedContext 老路端到端不变', () => {
  test('addAttachment(txt) → 桥进 panel、chip 可见；发送时无 file part、前缀块在 body.injectedContext', async () => {
    const fetchMock = stubChatFetch()
    const panel = makePanel()
    const { container } = render(
      <Harness bridge={panel.bridge} buildInjectedContext={panel.buildInjectedContext} />
    )
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )

    await act(async () => {
      await capturedAui!.composer().addAttachment(textFile())
    })
    // 桥接：panel 拿到 readAttachment 语义完整的 ChatAttachment（含文本内容）。
    expect(panel.added).toHaveLength(1)
    expect(panel.added[0].content).toBe('plain text payload')
    // chip 可见，且 id 与 panel 侧一致（回归面 #5）。
    expect(screen.queryByText('notes.txt')).not.toBeNull()
    expect(capturedAui!.composer().getState().attachments[0]!.id).toBe(panel.added[0].id)

    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '总结一下附件' } })
    fireEvent.submit(container.querySelector('form')!)

    await waitFor(() => expect(lastChatBody(fetchMock).messages).toBeTruthy())
    const body = lastChatBody(fetchMock)
    const messages = body.messages as Array<{ role: string; parts: SentPart[] }>
    const last = messages.at(-1)!
    // 老路（回归面 #1/#3）：文本附件不进 parts —— 没有任何 file part……
    expect(last.parts.every((p) => p.type !== 'file')).toBe(true)
    // ……它的内容作为 untrusted 前缀块走 body.injectedContext（gateway 端 prepend）。
    expect(String(body.injectedContext)).toContain('notes.txt')
    expect(String(body.injectedContext)).toContain('plain text payload')
    expect(String(body.injectedContext)).toContain('untrusted')
  })

  test('chip Remove → 桥的 onRemove 同步 panel（不留幽灵注入）', async () => {
    stubChatFetch()
    const panel = makePanel()
    render(<Harness bridge={panel.bridge} buildInjectedContext={panel.buildInjectedContext} />)
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    await act(async () => {
      await capturedAui!.composer().addAttachment(textFile('gone.txt'))
    })
    const id = panel.added[0]!.id
    fireEvent.click(screen.getByRole('button', { name: 'remove' }))
    await waitFor(() => expect(panel.removed).toEqual([id]))
    expect(panel.added).toHaveLength(0)
  })
})
