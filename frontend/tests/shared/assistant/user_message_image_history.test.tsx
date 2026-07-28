// @vitest-environment happy-dom
//
// dogfood 07-27 Lane D — 「黏贴/拖拽图片发出后，消息历史里没有显示图片」。
//
// 缺口只在渲染层：图片以 FileUIPart 进消息（tests/shared/assistant/composer_paste_image.test.tsx
// 钉发送体、tests/ai-gateway/image_file_part.test.ts 钉模型端），react-ai-sdk 的
// AISDKMessageConverter 把 user 的 file part 转成 thread-message `attachments`
// （content = [{type:'image', image:<data URL>}]，且**从 content 里剔除** file part，所以气泡内
// 不会重复渲染），但 UserMessageAttachments 只画了回形针 + 文件名药丸 —— 字节全在手上却一个
// <img> 都不出。修复前本文件的图片用例全红（实测 img 数 = 0）。
//
// assistant-ui 没有现成的图片原语可切：AttachmentPrimitive.unstable_Thumb 渲染的是文件**扩展名**
// 文本（node_modules/@assistant-ui/react/dist/primitives/attachment/AttachmentThumb.js），不是缩略图；
// 官方通路 = MessagePrimitive.Attachments 的 children render function（components prop 已 deprecated），
// 我们已经在用，缺的是里面那段 <img>。
//
// 两条入口都覆盖：① 重载（initialMessages ← chatMessageToUIMessage，切会话/重启回来的那条路）
// ② 发送即时（真实 paste → 真实 transport → useChat 状态 → 同一个 converter）。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AssistantThread } from '@shared/assistant/components/thread'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'

// 1x1 透明 PNG（真实字节）
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`
const GIF_DATA_URL = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='

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

/** 从 provider 内部抓 aui client（发送侧要等 capabilities.attachments 就位才能 paste）。 */
let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

function renderThread(initialMessages?: MailAgentUIMessage[]): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider
        gatewayBaseUrl="http://127.0.0.1:1"
        sessionId={7}
        {...(initialMessages ? { initialMessages } : {})}
      >
        <ChatComposerControlsProvider value={stubControls()}>
          <AuiProbe />
          <AssistantThread />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

/** 一条重载回来的 user 消息（ui_message_json 反序列化后的形状）。 */
function userMessage(parts: MailAgentUIMessage['parts']): MailAgentUIMessage {
  return { id: '1', role: 'user', parts } as MailAgentUIMessage
}

function filePart(
  url: string,
  mediaType: string,
  filename: string
): MailAgentUIMessage['parts'][0] {
  return { type: 'file', url, mediaType, filename } as MailAgentUIMessage['parts'][0]
}

/** 用户消息的根节点（data-message-id 由 MessagePrimitive.Root 打上）。 */
function messageRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector('[data-message-id]')
  expect(root).toBeTruthy()
  return root as HTMLElement
}

describe('用户气泡 — 重载出来的图片消息', () => {
  test('图片 file part → 渲染出带 data URL 的 <img>，尺寸受约束', async () => {
    const { container } = renderThread([
      userMessage([
        { type: 'text', text: '这张图里写了什么' },
        filePart(PNG_DATA_URL, 'image/png', 'screenshot.png')
      ])
    ])
    await waitFor(() => expect(screen.queryByText('这张图里写了什么')).toBeTruthy())

    const imgs = messageRoot(container).querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    const img = imgs[0]!
    // 🔴 核心：src 就是那张图的 data URL —— 历史里真的能看见它
    expect(img.getAttribute('src')).toBe(PNG_DATA_URL)
    // 文件名进 alt/title（不再占一行可见文本，鼠标悬停/图挂了仍可辨认）
    expect(img.getAttribute('alt')).toBe('screenshot.png')
    expect(img.getAttribute('title')).toBe('screenshot.png')
    // 尺寸上限在场：data URL 可能是 1568px 长边的大图，不设上限会把气泡撑爆
    expect(img.className).toMatch(/\bmax-h-/)
    expect(img.className).toMatch(/\bmax-w-\[/)
    // 图不进气泡正文（converter 把 user 的 file part 从 content 里剔除了）—— 只出现一次
    expect(container.querySelectorAll('img')).toHaveLength(1)
  })

  test('多图横排 wrap，每张各自成图', async () => {
    const { container } = renderThread([
      userMessage([
        { type: 'text', text: '看这两张' },
        filePart(PNG_DATA_URL, 'image/png', 'a.png'),
        filePart(GIF_DATA_URL, 'image/gif', 'b.gif')
      ])
    ])
    await waitFor(() => expect(screen.queryByText('看这两张')).toBeTruthy())

    const imgs = messageRoot(container).querySelectorAll('img')
    expect(imgs).toHaveLength(2)
    expect([...imgs].map((i) => i.getAttribute('src'))).toEqual([PNG_DATA_URL, GIF_DATA_URL])
    // 容器 wrap：任意数量的图都不会撑出一行横向溢出
    expect(imgs[0]!.parentElement!.className).toMatch(/\bflex-wrap\b/)
  })

  test('纯图消息（无文本）不画空气泡，图照常显示', async () => {
    const { container } = renderThread([
      userMessage([filePart(PNG_DATA_URL, 'image/png', 'only.png')])
    ])
    await waitFor(() => expect(container.querySelectorAll('img')).toHaveLength(1))
    // 没有文本 part → content 为空 → 不渲染 accent 气泡（否则是一枚空药丸）
    expect(messageRoot(container).querySelector('[class*="c-accent"]')).toBeNull()
  })

  test('非图片附件仍是回形针 + 文件名药丸（不塞 <img>）', async () => {
    const { container } = renderThread([
      userMessage([
        { type: 'text', text: '看这个包' },
        filePart('data:application/zip;base64,UEsDBA==', 'application/zip', 'bundle.zip')
      ])
    ])
    await waitFor(() => expect(screen.queryByText('看这个包')).toBeTruthy())

    const root = messageRoot(container)
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.querySelector('.lucide-paperclip')).toBeTruthy()
    expect(root.textContent).toContain('bundle.zip')
  })

  test('纯文本消息渲染不回退：气泡在、无附件行、无图', async () => {
    const { container } = renderThread([userMessage([{ type: 'text', text: '只有文字' }])])
    await waitFor(() => expect(screen.queryByText('只有文字')).toBeTruthy())

    const root = messageRoot(container)
    // accent 气泡仍在且带原文
    const bubble = root.querySelector('[class*="c-accent"]')
    expect(bubble).toBeTruthy()
    expect(bubble!.textContent).toBe('只有文字')
    // 附件那一路整段不激活：既无 <img> 也无回形针
    expect(root.querySelectorAll('img')).toHaveLength(0)
    expect(root.querySelector('.lucide-paperclip')).toBeNull()
  })
})

// ── 发送即时 ────────────────────────────────────────────────────────────────────
// 重载与即时走的是同一个 converter，但 owner 看到的第一现场是「刚发出去那一刻」，所以两端都钉。

function pngFile(name = 'screenshot.png'): File {
  const bin = atob(PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
}

/** 派发一个真实的 paste 事件（composer 内置 handler → adapter.add → composer attachments）。 */
function firePaste(el: Element, files: File[]): Event {
  const ev = createEvent.paste(el, {
    clipboardData: {
      files,
      items: files.map((f) => ({ kind: 'file', type: f.type })),
      types: [],
      getData: () => ''
    }
  })
  fireEvent(el, ev)
  return ev
}

describe('用户气泡 — 刚发出去那一刻', () => {
  test('粘贴图片 + 发送 → 用户气泡下方立刻出现这张图', async () => {
    // transport 真实组装请求；stub fetch 只为让流立刻结束（不改链路）。
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream' }
          })
      )
    )
    const { container } = renderThread()
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    // 内置 paste handler 的门是 threadCapabilities.attachments（adapter 装好才为真）
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    const ev = firePaste(textarea, [pngFile()])
    expect(ev.defaultPrevented).toBe(true)
    // adapter.add() 是异步的（FileReader）—— 必须等附件真的落进 composer state 再发，
    // 否则发出去的是一条没有 file part 的纯文本消息（本用例自己踩过）。
    await waitFor(() => expect(capturedAui!.composer().getState().attachments).toHaveLength(1))

    fireEvent.change(textarea, { target: { value: '这张图里写了什么' } })
    fireEvent.submit(container.querySelector('form')!)

    await waitFor(() => expect(screen.queryByText('这张图里写了什么')).toBeTruthy())
    await waitFor(() => {
      const imgs = messageRoot(container).querySelectorAll('img')
      expect(imgs).toHaveLength(1)
      expect(imgs[0]!.getAttribute('src')).toBe(PNG_DATA_URL)
    })
  })
})
