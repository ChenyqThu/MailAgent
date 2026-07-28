// @vitest-environment happy-dom
//
// 07-28 工作流 B — chat 图片的两处观感缺口：
//   ① composer 的待发送 chip 只有一枚回形针 + 文件名，一张截图和一个 zip 长得一模一样 ——
//      发出去之前根本看不出附的是哪张图（粘/拖/回形针三条入口都一样）；
//   ② 缩略图点不开：待发送 chip 里的、以及已发出消息里那张受气泡宽度约束的图，都只能看个大概。
//
// 修复面：共享 chip 组件对 type==='image' 的附件用 URL.createObjectURL(attachment.file) 出缩略图，
// 两个 composer（邮件面 ThreadComposer / 通用面 AgentComposer）共用同一份 —— 之前是两份逐字节
// 复制的 chip，本文件的「两个面都断言」正是防它们再次分叉。点击缩略图与历史图都开既有的
// ImageLightbox（EmailBodyFrame 导出，邮件附件列表已在用同一枚，不新造第二个浮层）。
//
// objectURL 是有生命周期的资源：本文件同时钉住 revoke —— chip 消失（附件移除 / 卸载）时必须放掉，
// 否则每粘一张图都在 renderer 里留一份不会被 GC 的 blob。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { AssistantThread } from '@shared/assistant/components/thread'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'
import {
  ChatComposerControlsProvider,
  type ChatComposerControls
} from '@shared/assistant/components/composerControls'
import type { MailAgentUIMessage } from '@shared/assistant/uiMessage'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`

function pngFile(name = 'screenshot.png'): File {
  const bin = atob(PNG_BASE64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
}

function textFile(name = 'notes.txt'): File {
  return new File(['plain text payload'], name, { type: 'text/plain' })
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
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  capturedAui = null
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

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

/** 只为让流立刻结束（不改链路）—— 本文件不关心请求体。 */
function stubChatFetch(): void {
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
}

function renderComposer(children?: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
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

/** 一条重载回来的、带图的 user 消息（ui_message_json 反序列化后的形状）。 */
function renderThreadWithImage(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const message = {
    id: '1',
    role: 'user',
    parts: [
      { type: 'text', text: '这张图里写了什么' },
      { type: 'file', url: PNG_DATA_URL, mediaType: 'image/png', filename: 'screenshot.png' }
    ]
  } as MailAgentUIMessage
  return render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider
        gatewayBaseUrl="http://127.0.0.1:1"
        sessionId={7}
        initialMessages={[message]}
      >
        <ChatComposerControlsProvider value={stubControls()}>
          <AssistantThread />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

/** objectURL 打桩：既能拿到「创建了哪些」，也能拿到「放掉了哪些」。 */
function stubObjectUrls(): { created: string[]; revoked: string[] } {
  const created: string[] = []
  const revoked: string[] = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:chip-${created.length}`
    created.push(url)
    return url
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url)
  })
  return { created, revoked }
}

/** lightbox = 挂在 document.body 的 portal（fixed 浮层），不在 render 的 container 里。 */
function lightbox(): HTMLElement | null {
  return screen.queryByRole('dialog')
}

describe('composer 待发送 chip — 图片出缩略图', () => {
  test('ThreadComposer：图片附件的 chip 渲染缩略图 <img>（src = 该 File 的 objectURL）', async () => {
    stubChatFetch()
    const { created } = stubObjectUrls()
    const { container } = renderComposer()
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )

    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile())
    })

    const img = await waitFor(() => {
      const found = container.querySelector('img')
      expect(found).toBeTruthy()
      return found as HTMLImageElement
    })
    // 缩略图取的是这张图自己的字节（objectURL），不是通用图标
    expect(created).toHaveLength(1)
    expect(img.getAttribute('src')).toBe(created[0])
    // 文件名仍在 chip 上（缩略图替掉的是回形针图标位，不是整条信息）
    const chip = screen.getByText('screenshot.png').parentElement!
    expect(chip.querySelector('img')).toBe(img)
    // chip 内不再有回形针（工具栏那枚「添加附件」按钮的回形针不在 chip 里，故按 chip 取范围）
    expect(chip.querySelector('.lucide-paperclip')).toBeNull()
  })

  test('ThreadComposer：非图片附件仍是回形针药丸，不塞 <img>', async () => {
    stubChatFetch()
    const { created } = stubObjectUrls()
    const { container } = renderComposer()
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )

    await act(async () => {
      await capturedAui!.composer().addAttachment(textFile())
    })
    await waitFor(() => expect(screen.queryByText('notes.txt')).not.toBeNull())

    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(container.querySelector('.lucide-paperclip')).toBeTruthy()
    // 非图片连 objectURL 都不该创建（不为一个 zip 占着 blob）
    expect(created).toHaveLength(0)
  })

  test('AgentComposer：共用同一份 chip → 通用面的图片 chip 同样出缩略图', async () => {
    stubChatFetch()
    const { created } = stubObjectUrls()
    const { container } = renderComposer(<AgentComposer />)
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )

    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile('agent.png'))
    })

    await waitFor(() => {
      const img = container.querySelector('img')
      expect(img).toBeTruthy()
      expect(img!.getAttribute('src')).toBe(created[0])
    })
    expect(screen.queryByText('agent.png')).not.toBeNull()
  })

  test('移除附件 → 该 chip 的 objectURL 被 revoke（不泄漏 blob）', async () => {
    stubChatFetch()
    const { created, revoked } = stubObjectUrls()
    const { container } = renderComposer()
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )

    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile())
    })
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())
    expect(revoked).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'remove' }))
    await waitFor(() => expect(capturedAui!.composer().getState().attachments).toHaveLength(0))
    await waitFor(() => expect(revoked).toEqual([created[0]]))
  })

  test('卸载整个 composer → objectURL 同样被 revoke', async () => {
    stubChatFetch()
    const { created, revoked } = stubObjectUrls()
    const { container, unmount } = renderComposer()
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile())
    })
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy())

    unmount()
    expect(revoked).toEqual([created[0]])
  })
})

describe('点击放大 — 复用 ImageLightbox', () => {
  test('待发送缩略图点击 → 打开 lightbox（同一张图）；Esc 关闭', async () => {
    stubChatFetch()
    const { created } = stubObjectUrls()
    const { container } = renderComposer()
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile())
    })
    const img = await waitFor(() => {
      const found = container.querySelector('img')
      expect(found).toBeTruthy()
      return found as HTMLImageElement
    })

    expect(lightbox()).toBeNull()
    fireEvent.click(img)

    const box = await waitFor(() => {
      const found = lightbox()
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    // 放大的就是这张图（不是随便一张 / 空 src）
    expect(box.querySelector('img')!.getAttribute('src')).toBe(created[0])

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(lightbox()).toBeNull())
  })

  test('待发送缩略图键盘可达：Enter 也能打开（role=button + tabIndex）', async () => {
    stubChatFetch()
    stubObjectUrls()
    const { container } = renderComposer()
    await waitFor(() =>
      expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true)
    )
    await act(async () => {
      await capturedAui!.composer().addAttachment(pngFile())
    })
    const img = await waitFor(() => {
      const found = container.querySelector('img')
      expect(found).toBeTruthy()
      return found as HTMLImageElement
    })
    expect(img.getAttribute('role')).toBe('button')
    expect(img.getAttribute('tabindex')).toBe('0')

    fireEvent.keyDown(img, { key: 'Enter' })
    await waitFor(() => expect(lightbox()).toBeTruthy())
  })

  test('已发出消息里的图片点击 → 打开 lightbox（data URL 原图）；Esc 关闭', async () => {
    const { container } = renderThreadWithImage()
    await waitFor(() => expect(screen.queryByText('这张图里写了什么')).toBeTruthy())

    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe(PNG_DATA_URL)

    fireEvent.click(img)
    const box = await waitFor(() => {
      const found = lightbox()
      expect(found).toBeTruthy()
      return found as HTMLElement
    })
    expect(box.querySelector('img')!.getAttribute('src')).toBe(PNG_DATA_URL)

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(lightbox()).toBeNull())
  })
})
