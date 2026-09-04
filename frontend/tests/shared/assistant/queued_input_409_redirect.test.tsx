// @vitest-environment happy-dom
//
// 0903 dogfood —— 撞上会话租约 409 的那一句话不再凭空消失。
//
// composer 一按回车就清空，POST /api/ai/chat 若撞上 409 E_RUN_ACTIVE：gateway 在 onTurnStart
// 之前就返回了，库里一行不落；那条乐观用户消息只活在内存线程里，下一次 settle 重挂载（用重取到
// 的库行重新 seed）就把它抹掉 —— 用户白打一句，界面上还什么都不说。
//
// 修法：transport 的 fetch 包装认出这一种拒绝，把那一轮的文本转投 POST /api/ai/queued-input，
// 退化成排队而不是丢弃。判据必须**同时**是 409 与 error==='E_RUN_ACTIVE' —— 别的 409、别的
// 非 2xx（鉴权 / 体积超限 / 上游拒绝）一律维持现状，否则就是把真错误伪装成「已排队」，
// 用户以为发出去了其实永远不会发。
//
// harness 抄 own_run_remount.test.tsx：真 composer + 真 transport，mock 面只有 fetch 与 useMailApi。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { _resetOwnRunsForTest } from '@shared/assistant/runtime/ownRuns'
import { useQueuedInputRows } from '@shared/assistant/runtime/useQueuedInputRows'
import { ChatPromptDispatcher } from '@shared/assistant/components/ChatPromptDispatcher'
import type { QueuedInput } from '@shared/api/types'
import i18n from '@shared/i18n'

const SESSION_ID = 77
const TEXT = '在发件箱啊，我刚刚发了封邮件的。'

const { stableMailApi } = vi.hoisted(() => ({
  stableMailApi: {
    chat: {
      markSessionRead: vi.fn(async () => {}),
      onTurnPersisted: vi.fn(() => () => {}),
      onQueuedInputChanged: vi.fn(() => () => {})
    }
  }
}))

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => stableMailApi }))

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  _resetOwnRunsForTest()
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
  } as unknown as ChatComposerControls
}

type ChatReply = { status: number; body: unknown }

/** `/api/ai/chat` 按 `reply` 应答；`/api/ai/queued-input` 的入队按 `enqueueOk`。 */
function stubFetch(reply: ChatReply, enqueueOk = true): ReturnType<typeof vi.fn> {
  const rows: QueuedInput[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/ai/queued-input')) {
      if ((init?.method ?? 'GET').toUpperCase() === 'GET') {
        return new Response(JSON.stringify({ items: rows }), { status: 200 })
      }
      if (!enqueueOk) {
        return new Response(JSON.stringify({ error: 'E_QUEUE_FULL' }), { status: 400 })
      }
      const content = JSON.parse(String(init?.body ?? '{}')).content as string
      const now = Date.now()
      rows.push({
        id: rows.length + 1,
        sessionId: SESSION_ID,
        runId: null,
        mode: 'follow_up',
        content,
        status: 'queued',
        createdAt: now,
        updatedAt: now
      })
      return new Response(JSON.stringify({ item: rows.at(-1) }), { status: 200 })
    }
    if (url.includes('/api/ai/chat')) {
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function enqueuePosts(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/api/ai/queued-input'))
    .map(([, init]) => JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')))
}

function mount(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:8300" sessionId={SESSION_ID}>
        <ChatComposerControlsProvider value={stubControls()}>
          <ThreadComposer />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

function send(text: string): HTMLTextAreaElement {
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
  fireEvent.change(textarea, { target: { value: text } })
  fireEvent.submit(textarea.closest('form')!)
  return textarea
}

const RUN_ACTIVE_409: ChatReply = {
  status: 409,
  body: { error: 'E_RUN_ACTIVE', hint: 'a chat run is already streaming for this session' }
}

/** 排队条读的就是这个 hook（QueuedInputBar / 两个面板同源）—— 用它当「UI 对不对得上」的探针。 */
function QueuedRowsProbe({ onRows }: { onRows: (rows: QueuedInput[]) => void }): null {
  const { rows } = useQueuedInputRows({
    enabled: true,
    gatewayBaseUrl: 'http://127.0.0.1:8300',
    sessionId: SESSION_ID
  })
  onRows(rows)
  return null
}

describe('撞上租约 409 的那一句话转投队列', () => {
  test('409 + E_RUN_ACTIVE → 转投 POST /api/ai/queued-input（带 sessionId 与原文）', async () => {
    const fetchMock = stubFetch(RUN_ACTIVE_409)
    mount()

    send(TEXT)

    await waitFor(() => expect(enqueuePosts(fetchMock)).toHaveLength(1))
    expect(enqueuePosts(fetchMock)[0]).toEqual({ sessionId: SESSION_ID, content: TEXT })
  })

  test.each([
    {
      lane: '409 但不是 E_RUN_ACTIVE',
      reply: { status: 409, body: { error: 'E_QUEUED_INPUT_STATE' } } as ChatReply
    },
    {
      lane: '非 409（上游 500）',
      reply: { status: 500, body: { error: 'E_RUN_ACTIVE' } } as ChatReply
    },
    {
      lane: '409 但响应体不是 JSON',
      reply: { status: 409, body: undefined } as ChatReply
    }
  ])('$lane → 维持现状，绝不转投（不能把真错误伪装成「已排队」）', async ({ reply }) => {
    const fetchMock = stubFetch(reply)
    mount()

    send(TEXT)

    await new Promise((r) => setTimeout(r, 80))
    expect(enqueuePosts(fetchMock)).toHaveLength(0)
  })

  test('转投之后排队条真的画得出来（不是静默转投）', async () => {
    const fetchMock = stubFetch(RUN_ACTIVE_409)
    let seen: QueuedInput[] = []
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:8300" sessionId={SESSION_ID}>
          <ChatComposerControlsProvider value={stubControls()}>
            <ThreadComposer />
          </ChatComposerControlsProvider>
        </AiSdkRuntimeProvider>
        <QueuedRowsProbe
          onRows={(rows) => {
            seen = rows
          }}
        />
      </QueryClientProvider>
    )

    send(TEXT)

    await waitFor(() => expect(enqueuePosts(fetchMock)).toHaveLength(1))
    // 🔴 判据是排队条读到的**真行**，不是「发过一次 POST」——静默转投正是要避免的那种修法。
    await waitFor(() => expect(seen.map((row) => row.content)).toEqual([TEXT]))
  })

  // 🔴 与既有那条恢复路的交界。ChatPromptDispatcher（邮件工具栏「创建事项」那条）自己也处理
  // 「409 或 transport 构造失败」：append 之后盯 thread，有界窗口内那条用户消息没落地就把文本
  // 交还 composer。两条路要是都动手，同一句话会**既进队列又回到输入框**，用户按一次回车就发
  // 第二遍。本用例钉的就是这个不变量：转投成功时 composer 必须保持空。
  test('与 ChatPromptDispatcher 不打架：指令撞 409 后只进队列，不同时回填 composer', async () => {
    const fetchMock = stubFetch(RUN_ACTIVE_409)
    const onDispatched = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
    render(
      <QueryClientProvider client={qc}>
        <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:8300" sessionId={SESSION_ID}>
          <ChatComposerControlsProvider value={stubControls()}>
            <ChatPromptDispatcher
              request={{ nonce: 1, text: TEXT }}
              onDispatched={onDispatched}
            />
            <ThreadComposer />
          </ChatComposerControlsProvider>
        </AiSdkRuntimeProvider>
      </QueryClientProvider>
    )

    await waitFor(() => expect(enqueuePosts(fetchMock)).toHaveLength(1))
    expect(enqueuePosts(fetchMock)[0]).toEqual({ sessionId: SESSION_ID, content: TEXT })

    // 等过 ChatPromptDispatcher 的 4 秒兜底窗（PROMPT_ACCEPT_TIMEOUT_MS）——它若也动手，
    // composer 这时就会拿到同一句话。
    await new Promise((r) => setTimeout(r, 4300))
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    expect(enqueuePosts(fetchMock)).toHaveLength(1)
  }, 10_000)

  test('转投失败 → 文本回填 composer（至少不丢字）', async () => {
    const fetchMock = stubFetch(RUN_ACTIVE_409, false)
    mount()
    const textarea = send(TEXT)

    await waitFor(() => expect(enqueuePosts(fetchMock)).toHaveLength(1))
    await waitFor(() => expect(textarea.value).toBe(TEXT))
  })

  test('转投成功 → composer 保持空（那句话已经在排队条里，别再塞回输入框）', async () => {
    const fetchMock = stubFetch(RUN_ACTIVE_409)
    mount()
    const textarea = send(TEXT)

    await waitFor(() => expect(enqueuePosts(fetchMock)).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 60))
    expect(textarea.value).toBe('')
  })
})
