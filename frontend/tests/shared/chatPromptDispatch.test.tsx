// @vitest-environment happy-dom
//
// 0812 —— 邮件工具栏「创建事项」的传递链：store 排队 → dock 里的 dispatcher 发出或预填。
//
// 钉住的三条纪律：
//   · 指令是一条**普通用户消息**（走 thread.append），邮件引用另由 email context chip 承载 ——
//     没有第五条注入路径；
//   · **不硬发**：run 在途 / composer 被审批闸锁着时退回预填 composer，而不是撞 409 或被静默吞掉；
//   · 🔴 codex #4 —— **「append() 调用返回」不是「已发出」**：它不返回 send Promise、内部异步执行。
//     若被别的发送 / approval resume 抢先（409 E_RUN_ACTIVE）或 transport 构造请求失败，旧实现
//     已经把 nonce 消费掉、也没回填 composer，用户这一次点击**静默消失**。现在必须看见那条用户
//     消息真的落进 thread 才消费 nonce；没落地就把文本交还 composer。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'

type FakeContentPart = { type: string; text?: string }
type FakeMessage = { role: string; content: FakeContentPart[] }

const { threadState, append, setText, composerState, listeners } = vi.hoisted(() => ({
  threadState: { isRunning: false, messages: [] as FakeMessage[] },
  append: vi.fn(),
  setText: vi.fn(),
  // `text` 是 09-03 加的：dispatcher 现在也把 composer 正文当观测面（预置库文件提及那条腿要
  // 等正文真的落地才记引用），所以这份替身得有它。
  composerState: { runConfig: { marker: 'run-config' }, text: '' },
  listeners: new Set<() => void>()
}))

// useAuiState 是 dispatcher 的两个观测面：thread 变了没 + composer 正文是什么；这里以最小实现
// 镜像它（selector(state) + 订阅），让测试能显式驱动"消息落地"这一刻。
vi.mock('@assistant-ui/react', () => ({
  useAui: () => ({
    thread: () => ({ getState: () => threadState, append }),
    composer: () => ({ getState: () => composerState, setText })
  }),
  useAuiState: (
    selector: (state: { thread: typeof threadState; composer: typeof composerState }) => unknown
  ) => {
    const { useSyncExternalStore } = require('react') as typeof import('react')
    return useSyncExternalStore(
      (onChange: () => void) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
      () => selector({ thread: threadState, composer: composerState })
    )
  }
}))

const { ChatPromptDispatcher } = await import('@shared/assistant/components/ChatPromptDispatcher')
const { useAIChatPanel, startChatWithPrompt } = await import('@shared/state/ai-chat-panel')

/** 模拟 thread 真的收下了这条用户消息（optimistic 落地）。 */
function landUserMessage(text: string): void {
  act(() => {
    threadState.messages = [
      ...threadState.messages,
      { role: 'user', content: [{ type: 'text', text }] }
    ]
    listeners.forEach((fn) => fn())
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  threadState.isRunning = false
  threadState.messages = []
  listeners.clear()
  useAIChatPanel.setState({
    visible: false,
    matterTarget: null,
    matterConversationEpoch: 0,
    pendingPrompt: null
  })
  // 默认：append 立刻把消息落进 thread（正常路径）。
  append.mockImplementation((message: { content: FakeContentPart[] }) => {
    const text = message.content.find((part) => part.type === 'text')?.text ?? ''
    landUserMessage(text)
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('startChatWithPrompt — 把指令递给主 agent', () => {
  test('展开 dock + 清事项身份 + 排队指令（带 emailId 门）', () => {
    useAIChatPanel.setState({ matterTarget: { id: 7, publicId: 'MAT-0007', title: 'x' } })
    startChatWithPrompt('创建事项', 4242)
    const state = useAIChatPanel.getState()
    expect(state.visible).toBe(true)
    // 这是一次**通用** agent 请求，不该继承上一次的事项身份。
    expect(state.matterTarget).toBeNull()
    expect(state.pendingPrompt).toEqual({ text: '创建事项', emailId: 4242, nonce: 1 })
  })

  test('连点两次是两次请求（nonce 自增）', () => {
    startChatWithPrompt('创建事项', 1)
    startChatWithPrompt('创建事项', 1)
    expect(useAIChatPanel.getState().pendingPrompt?.nonce).toBe(2)
  })

  test('consumeChatPrompt 只清自己那一条（不吞掉后来的请求）', () => {
    startChatWithPrompt('第一条', 1)
    const first = useAIChatPanel.getState().pendingPrompt!.nonce
    startChatWithPrompt('第二条', 1)
    useAIChatPanel.getState().consumeChatPrompt(first)
    expect(useAIChatPanel.getState().pendingPrompt?.text).toBe('第二条')
    useAIChatPanel.getState().consumeChatPrompt(first + 1)
    expect(useAIChatPanel.getState().pendingPrompt).toBeNull()
  })
})

describe('ChatPromptDispatcher — 发出 or 预填', () => {
  test('空闲时直接发出，并带上 composer 当前的 runConfig', async () => {
    const onDispatched = vi.fn()
    render(
      <ChatPromptDispatcher request={{ nonce: 1, text: '创建事项' }} onDispatched={onDispatched} />
    )
    expect(append).toHaveBeenCalledWith({
      content: [{ type: 'text', text: '创建事项' }],
      runConfig: composerState.runConfig
    })
    expect(setText).not.toHaveBeenCalled()
    // 消费发生在**看见消息落地之后**，不是 append 返回的那一刻。
    await waitFor(() => expect(onDispatched).toHaveBeenCalledWith(1, true))
  })

  test('run 在途 → 预填 composer 而不是硬发（会撞 run 互斥 409）', () => {
    threadState.isRunning = true
    const onDispatched = vi.fn()
    render(
      <ChatPromptDispatcher request={{ nonce: 1, text: '创建事项' }} onDispatched={onDispatched} />
    )
    expect(append).not.toHaveBeenCalled()
    expect(setText).toHaveBeenCalledWith('创建事项')
    expect(onDispatched).toHaveBeenCalledWith(1, false)
  })

  test('prefillOnly（父组件判定本宿主给不出那封邮件的引用）→ 空闲也只预填', () => {
    const onDispatched = vi.fn()
    render(
      <ChatPromptDispatcher
        request={{ nonce: 1, text: '创建事项', prefillOnly: true }}
        onDispatched={onDispatched}
      />
    )
    expect(append).not.toHaveBeenCalled()
    expect(setText).toHaveBeenCalledWith('创建事项')
    expect(onDispatched).toHaveBeenCalledWith(1, false)
  })

  test('同一个 nonce 只派发一次（重渲染不重发）', () => {
    const onDispatched = vi.fn()
    const view = render(
      <ChatPromptDispatcher request={{ nonce: 1, text: '创建事项' }} onDispatched={onDispatched} />
    )
    view.rerender(
      <ChatPromptDispatcher request={{ nonce: 1, text: '创建事项' }} onDispatched={onDispatched} />
    )
    expect(append).toHaveBeenCalledTimes(1)
  })

  test('request=null（门没开：会话非空 / 引用 chip 还没就位）→ 什么都不做', () => {
    render(<ChatPromptDispatcher request={null} onDispatched={vi.fn()} />)
    expect(append).not.toHaveBeenCalled()
    expect(setText).not.toHaveBeenCalled()
  })
})

describe('ChatPromptDispatcher — 「调用返回」不是「已发出」（codex #4）', () => {
  test('线程没收下（409 抢先 / transport 构造失败）→ 不当成已发送，文本交还 composer', async () => {
    vi.useFakeTimers()
    // append 被调用了，但那条用户消息永远没落进 thread —— 正是 409 E_RUN_ACTIVE 的形态。
    append.mockImplementation(() => {})
    const onDispatched = vi.fn()
    render(
      <ChatPromptDispatcher request={{ nonce: 9, text: '创建事项' }} onDispatched={onDispatched} />
    )
    expect(append).toHaveBeenCalledTimes(1)
    // 关键：此刻**还没有**消费 nonce（旧实现在这里已经 onDispatched(9, true) 并清掉了请求）。
    expect(onDispatched).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(setText).toHaveBeenCalledWith('创建事项')
    expect(onDispatched).toHaveBeenCalledWith(9, false)
  })

  test('append 同步抛（transport 构造失败）→ 立即回填 composer，不算已发送', () => {
    append.mockImplementation(() => {
      throw new Error('transport build failed')
    })
    const onDispatched = vi.fn()
    render(
      <ChatPromptDispatcher request={{ nonce: 3, text: '创建事项' }} onDispatched={onDispatched} />
    )
    expect(setText).toHaveBeenCalledWith('创建事项')
    expect(onDispatched).toHaveBeenCalledWith(3, false)
  })

  test('历史上有同样内容的用户消息也不算数（只看 append 之后新增的那一段）', async () => {
    vi.useFakeTimers()
    threadState.messages = [{ role: 'user', content: [{ type: 'text', text: '创建事项' }] }]
    append.mockImplementation(() => {})
    const onDispatched = vi.fn()
    render(
      <ChatPromptDispatcher request={{ nonce: 5, text: '创建事项' }} onDispatched={onDispatched} />
    )
    expect(onDispatched).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(onDispatched).toHaveBeenCalledWith(5, false)
  })
})
