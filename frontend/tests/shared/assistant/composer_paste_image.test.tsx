// @vitest-environment happy-dom
//
// issue #61 — 「往 AI 助手对话框粘贴一张图片，base64 有没有随消息发给模型？」
//
// Lane 3 (A2) 修复后：两个 composer 统一走 assistant-ui 标准通路 —— 粘贴/拖拽/回形针都进
// composer.addAttachment → MailAgent AttachmentAdapter（chatAttachmentAdapter.ts：图片 →
// 有界 data URL file part；文本/二进制 → panel injectedContext 老路），chip 由
// ComposerPrimitive.Attachments 从 composer state 渲染（可见反馈）。修复前的行为分裂
// （邮件侧内置 paste 发图但无 chip；通用 Lexical 侧整包零 paste handler、图凭空消失 ——
// owner 2026-07-27 真机复现 = ai_chat.db session 109 那条 109 字节纯 text 消息）由本文件
// 的用例 1（邮件侧）与用例 5（通用侧，修复前 test.fails）钉住并见证转正。
//
// ThreadComposer 侧被覆盖的完整链路（每一跳都是真实代码，无 mock）：
//   1. ThreadComposer 渲染的 ComposerPrimitive.Input 自带 paste→附件 handler
//      （@assistant-ui/react ComposerInput.js:99-109 handlePaste，addAttachmentOnPaste 默认 true），
//      gate 在 threadCapabilities.attachments。
//   2. capability 为真：useMailAgentAiSdkRuntime 现在显式传 adapters.attachments =
//      createMailAgentAttachmentAdapter(...)（Lane 3 前靠 react-ai-sdk 默认注入的
//      vercelAttachmentAdapter）→ @assistant-ui/core external-store-thread-runtime-core.js:97
//      `attachments: !!this._store.adapters?.attachments` = true。
//   3. 发送时 adapter.send() 把小图原字节 pass-through 成 base64 data URL（大图降采样重编码），
//      toCreateMessage 转成 FileUIPart（{type:'file', url, mediaType, filename}）。
//   4. AssistantChatTransport 原样把 messages 放进 POST /api/ai/chat 的 body。
//
// 唯一 stub 的是 globalThis.fetch —— 用来**捕获**真实 transport 组装出来的请求体（不改变链路）。
// 链路的第 5 跳（gateway 侧 convertToModelMessages 把 FileUIPart 变成模型能看的 image content）
// 在 tests/ai-gateway/image_file_part.test.ts 里单独钉。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

// 1x1 透明 PNG（真实字节，读出来的 data URL 必须逐字等于它）
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

function pngFile(name = 'screenshot.png'): File {
  const bin = atob(PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
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

/** 从 provider 内部抓 aui client，好直接读 composer 的 attachments state（第 1-2 跳的落点）。 */
let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

function Harness({ children }: { children?: React.ReactNode } = {}): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={stubControls()}>
          <AuiProbe />
          {children ?? <ThreadComposer />}
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

/** stub fetch 只为捕获 transport 真实组装的请求体；返回一个立即结束的 SSE 流。 */
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

type SentPart = { type: string; url?: string; mediaType?: string; filename?: string; text?: string }
type SentMessage = { role: string; parts: SentPart[] }

/** 取最后一次 POST /api/ai/chat 的 body.messages。 */
function sentMessages(fetchMock: ReturnType<typeof vi.fn>): SentMessage[] {
  const call = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/ai/chat')).at(-1)
  if (!call) return []
  const init = call[1] as RequestInit | undefined
  return (JSON.parse(String(init?.body ?? '{}')) as { messages?: SentMessage[] }).messages ?? []
}

/** 在 textarea 上派发一个真实的 paste 事件（testing-library 会把 clipboardData 挂上去）。
 *  返回事件对象，好断言 defaultPrevented（= 内置 handler 是否接管了这次粘贴）。 */
function firePaste(el: Element, init: { files?: File[]; text?: string }): Event {
  const clipboardData = {
    files: init.files ?? [],
    items: (init.files ?? []).map((f) => ({ kind: 'file', type: f.type })),
    types: init.text != null ? ['text/plain'] : [],
    getData: () => init.text ?? ''
  }
  const ev = createEvent.paste(el, { clipboardData })
  fireEvent(el, ev)
  return ev
}

describe('issue #61 前置判定 — 粘贴图片是否真的以 file part 发给模型', () => {
  test('粘贴 PNG → composer attachments 收下 → 发送时消息体里出现 base64 data URL 的 file part', async () => {
    const fetchMock = stubChatFetch()
    const { container } = render(<Harness />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    // ① 内置 handler 接管了这次粘贴（capability.attachments 为真的直接证据）
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    const ev = firePaste(textarea, { files: [pngFile()] })
    await waitFor(() => expect(ev.defaultPrevented).toBe(true))

    // ② 附件真的进了 assistant-ui 的 composer state（Lane 3 起 chip 也从这里渲染）
    await waitFor(() => {
      const atts = capturedAui!.composer().getState().attachments
      expect(atts).toHaveLength(1)
      expect(atts[0]).toMatchObject({ type: 'image', name: 'screenshot.png' })
    })

    // ③ 发送 → 断言真实 transport 组装出来的 messages
    fireEvent.change(textarea, { target: { value: '这张图里写了什么' } })
    fireEvent.submit(container.querySelector('form')!)

    await waitFor(() => expect(sentMessages(fetchMock).length).toBeGreaterThan(0))
    const last = sentMessages(fetchMock).at(-1)!
    expect(last.role).toBe('user')

    const fileParts = last.parts.filter((p) => p.type === 'file')
    expect(fileParts).toHaveLength(1)
    expect(fileParts[0]).toMatchObject({
      type: 'file',
      mediaType: 'image/png',
      filename: 'screenshot.png'
    })
    // 🔴 核心断言：url 就是图片的 base64 data URL —— 图确实随消息发出去了
    expect(fileParts[0].url).toBe(PNG_DATA_URL)
    // 文本 part 仍在（图不是取代文本，是并列）
    expect(last.parts.some((p) => p.type === 'text' && p.text === '这张图里写了什么')).toBe(true)
  })

  test('反向 — 纯文本粘贴不被接管、不产生 file part', async () => {
    const fetchMock = stubChatFetch()
    const { container } = render(<Harness />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    // 无 file 的 paste：内置 handler 直接 return，不 preventDefault（浏览器默认插入文本照常）
    const ev = firePaste(textarea, { text: 'hello there' })
    await new Promise((r) => setTimeout(r, 30))
    expect(ev.defaultPrevented).toBe(false)
    expect(capturedAui!.composer().getState().attachments).toHaveLength(0)

    fireEvent.change(textarea, { target: { value: 'hello there' } })
    fireEvent.submit(container.querySelector('form')!)

    await waitFor(() => expect(sentMessages(fetchMock).length).toBeGreaterThan(0))
    const last = sentMessages(fetchMock).at(-1)!
    expect(last.parts.every((p) => p.type !== 'file')).toBe(true)
  })

  test('capability 前提 — runtime 的 attachments adapter 存在（MailAgent 自定义 adapter）', async () => {
    stubChatFetch()
    render(<Harness />)
    // 这一条独立于 paste：它直接钉住「useMailAgentAiSdkRuntime 显式传了 adapters.attachments」
    // 这个前提。哪天有人传了 adapters:{attachments:undefined}，上面两条会以「粘贴没反应」的
    // 形式红，这一条会告诉你红在哪。
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    // Lane 3 转正：chip 现在由 ComposerPrimitive.Attachments 从 composer state 渲染 ——
    // addAttachment 后文件名可见（修复前这里断言 toBeNull()，钉的是「图进了消息体但没 chip」
    // 的观感 bug，正是 issue #61 的病根之一）。
    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile())
    })
    expect(capturedAui!.composer().getState().attachments).toHaveLength(1)
    expect(screen.queryByText('screenshot.png')).not.toBeNull()
  })

  // ── AgentComposer（owner 真机复现的那个 composer）────────────────────────────────────────────
  //
  // 先钉 harness 本身是好的，这样下面那条 test.fails 的红一定来自 bug、不是来自装置坏了。
  test('AgentComposer harness sanity — capability 为真、Enter 真的把消息发出去了', async () => {
    const fetchMock = stubChatFetch()
    const { container } = render(
      <Harness>
        <AgentComposer />
      </Harness>
    )
    // 关键前提：通用会话与邮件会话共用同一个 AiSdkRuntimeProvider，所以 attachments capability
    // 在这边**同样为真** —— addAttachment 可用，Lexical 侧只是没人调它。
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    const editable = container.querySelector('[contenteditable="true"]')!
    expect(editable).toBeTruthy()

    // 手动走 runtime 的 addAttachment（绕过缺失的 paste 接线）→ 图片照样能发出去。
    // 这是「修复只需接线、不需要新管道」的直接证据。
    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile())
    })
    act(() => capturedAui!.composer().setText('这张图里写了什么'))
    fireEvent.keyDown(editable, { key: 'Enter' })

    await waitFor(() => expect(sentMessages(fetchMock).length).toBeGreaterThan(0))
    const fileParts = sentMessages(fetchMock)
      .at(-1)!
      .parts.filter((p) => p.type === 'file')
    expect(fileParts).toHaveLength(1)
    expect(fileParts[0].url).toBe(PNG_DATA_URL)
  })

  // 🔴 issue #61 的**真实断点复现**（owner 2026-07-27 真机就是这条路径）——已转正。
  //
  // 修复前必失败（当时标 test.fails）：LexicalComposerInput 没有 paste handler，粘贴的 File
  // 直接被丢弃，发出去的消息里只有 text part —— 与 ai_chat.db 里 id=339 那条 109 字节的记录
  // 一致。Lane 3 在 AgentComposer 的 Dropzone 包装上接了 onPaste → aui.composer()
  // .addAttachment()（AgentComposer.tsx onComposerPaste），本条随之转回 test。
  test('issue #61 — AgentComposer 粘贴 PNG 产生 file part（Lexical paste 接线，Lane 3 修复）', async () => {
    const fetchMock = stubChatFetch()
    const { container } = render(
      <Harness>
        <AgentComposer />
      </Harness>
    )
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    const editable = container.querySelector('[contenteditable="true"]')!

    firePaste(editable, { files: [pngFile()] })
    await new Promise((r) => setTimeout(r, 60))

    act(() => capturedAui!.composer().setText('这张图里写了什么'))
    fireEvent.keyDown(editable, { key: 'Enter' })
    await waitFor(() => expect(sentMessages(fetchMock).length).toBeGreaterThan(0))

    const fileParts = sentMessages(fetchMock)
      .at(-1)!
      .parts.filter((p) => p.type === 'file')
    expect(fileParts).toHaveLength(1)
    expect(fileParts[0].url).toBe(PNG_DATA_URL)
  })
})
