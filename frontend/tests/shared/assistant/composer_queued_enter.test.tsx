// @vitest-environment happy-dom
//
// task 09-03 Lane A —— 「运行中根本无法发送消息」的回归网。
//
// 0902 那一批只测了 form submit（`fireEvent.submit`），于是全绿而功能是死的：运行中 Enter
// **永远到不了** form submit —— 两个 composer 各被库自己的一段逻辑吞掉：
//   • assistant-ui 的 ComposerInput：`if (threadState.isRunning && !hasQueue) return`
//     （hasQueue = capabilities.queue，我们的 ai-sdk runtime 恒为 false）；
//   • @assistant-ui/react-lexical 的 KeyboardPlugin：`if (isRunning) return false`。
// 且两面运行中都只渲染停止键（`ThreadPrimitive.If running`），连点都没得点。
//
// 所以本文件的用例一律**从键盘事件 / 真实按钮点击出发**，并在真 runtime 的 running 态下跑
// （status:'streaming' → thread.isRunning 为真，同 thread_running_guard 的做法）。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AssistantRuntimeProvider, useAui } from '@assistant-ui/react'
import { useAISDKRuntime } from '@assistant-ui/react-ai-sdk'

import i18n from '@shared/i18n'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN')
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
  if (!('IntersectionObserver' in globalThis)) {
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): [] {
        return []
      }
    }
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = (): void => {}
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function stubControls(over: Partial<ChatComposerControls> = {}): ChatComposerControls {
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
    onRemoveAttachment: vi.fn(),
    ...over
  }
}

/** ai@6 useChat 的最小面（同 thread_running_guard 的桩）：status 决定 thread.isRunning，
 *  sendMessage 是「库把这一轮真的发出去了」的观察点。 */
function stubChatHelpers(
  status: string,
  sendMessage: ReturnType<typeof vi.fn>
): Parameters<typeof useAISDKRuntime>[0] {
  return {
    status,
    messages: [],
    error: undefined,
    setMessages: () => {},
    sendMessage,
    regenerate: async () => {},
    stop: () => {},
    addToolResult: () => {},
    addToolOutput: () => {},
    addToolApprovalResponse: () => {}
  } as unknown as Parameters<typeof useAISDKRuntime>[0]
}

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })

function Harness({
  status,
  sendMessage,
  controls,
  children
}: {
  status: string
  sendMessage: ReturnType<typeof vi.fn>
  controls: Partial<ChatComposerControls>
  children: React.ReactNode
}): React.JSX.Element {
  const runtime = useAISDKRuntime(stubChatHelpers(status, sendMessage))
  return (
    <QueryClientProvider client={qc}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ChatComposerControlsProvider value={stubControls(controls)}>
          <AuiProbe />
          {children}
        </ChatComposerControlsProvider>
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  )
}

const QUEUE_ON = { queuedInputEnabled: true, queueModeActive: true } as const

function sendButtons(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: i18n.t('chat.composer.send') })
}

/** 🔴 assistant-ui 的 tap store 经 MessageChannel 批量刷新：写完 composer 文本必须让出一次宏
 *  任务，否则同步读到的仍是空串 —— 不等它，用例会在「文本压根没进去」的假前提下全绿。 */
async function flushTapStore(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function typeIntoComposer(text: string): Promise<void> {
  act(() => capturedAui!.composer().setText(text))
  await flushTapStore()
}

// 🔴 running 档只证「Enter / 按钮确实入队」——「没有真发」在这一档是恒绿的（库自己就把发送关了），
// 真发的风险全在 isRunning 为假的那一档（待决审批 / 后台 run），见每个 describe 末尾那两条。
describe('ThreadComposer —— 运行中 Enter / 发送键入队（弹出窗场地）', () => {
  test('running + 排队模式：Enter 走入队、清空输入', async () => {
    const onEnqueueQueuedInput = vi.fn()
    render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <ThreadComposer />
      </Harness>
    )
    await typeIntoComposer('等它跑完再看这条')
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement

    fireEvent.keyDown(textarea, { key: 'Enter' })

    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('等它跑完再看这条')
    await flushTapStore()
    expect(capturedAui!.composer().getState().text).toBe('')
  })

  test('running + 排队模式：Shift+Enter 不入队（仍是换行）', async () => {
    const onEnqueueQueuedInput = vi.fn()
    render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <ThreadComposer />
      </Harness>
    )
    await typeIntoComposer('换行不发')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true })
    expect(onEnqueueQueuedInput).not.toHaveBeenCalled()
  })

  test('running + 排队模式：停止键旁有发送键，点击入队', async () => {
    const onEnqueueQueuedInput = vi.fn()
    render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <ThreadComposer />
      </Harness>
    )
    await typeIntoComposer('点按钮也要能发')
    expect(screen.getByRole('button', { name: i18n.t('chat.composer.cancel') })).toBeTruthy()
    const send = sendButtons()
    expect(send).toHaveLength(1)

    fireEvent.click(send[0]!)
    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('点按钮也要能发')
  })

  test('running 但非排队场地：只有停止键，Enter 不入队（现状不变）', async () => {
    const onEnqueueQueuedInput = vi.fn()
    render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ queuedInputEnabled: false, queueModeActive: false, onEnqueueQueuedInput }}
      >
        <ThreadComposer />
      </Harness>
    )
    await typeIntoComposer('这条不该进队列')
    expect(screen.getByRole('button', { name: i18n.t('chat.composer.cancel') })).toBeTruthy()
    expect(sendButtons()).toHaveLength(0)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onEnqueueQueuedInput).not.toHaveBeenCalled()
  })

  test('排队模式但没有前台流（待决审批 / 后台 run）：Enter 入队，不真发', async () => {
    const onEnqueueQueuedInput = vi.fn()
    const sendMessage = vi.fn(async () => {})
    render(
      <Harness
        status="ready"
        sendMessage={sendMessage}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <ThreadComposer />
      </Harness>
    )
    await typeIntoComposer('审批还没决，先排着')

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })

    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('审批还没决，先排着')
    await flushTapStore()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  // R1 —— `ComposerPrimitive.Send` 是 type="button" 直调 send()（不提交 form，Root 的 onSubmit
  // 拦不住），所以排队模式下它一颗都不能渲染：这一档 isRunning 为假，它可点且真发。
  test('排队模式但没有前台流：发送位只有入队键，点击不真发', async () => {
    const onEnqueueQueuedInput = vi.fn()
    const sendMessage = vi.fn(async () => {})
    render(
      <Harness
        status="ready"
        sendMessage={sendMessage}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <ThreadComposer />
      </Harness>
    )
    await typeIntoComposer('点键也只进队列')
    expect(screen.queryByRole('button', { name: i18n.t('chat.composer.cancel') })).toBeNull()
    const send = sendButtons()
    expect(send).toHaveLength(1)

    fireEvent.click(send[0]!)

    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('点键也只进队列')
    await flushTapStore()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  // R3 —— sendDisabled（事项对话里的持续状态 / 审批占着 run lease）时 Enter 被守卫拒掉，
  // 入队键必须一起禁，否则变成「回车被拒、点键却入队」。
  test('排队模式 + sendDisabled：入队键禁用', async () => {
    render(
      <Harness
        status="ready"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, sendDisabled: true, onEnqueueQueuedInput: vi.fn() }}
      >
        <ThreadComposer />
      </Harness>
    )
    await typeIntoComposer('上下文还没解析完')
    const send = sendButtons()
    expect(send).toHaveLength(1)
    expect((send[0] as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('AgentComposer —— 运行中 Enter / 发送键入队（AI Chat 主场地）', () => {
  test('running + 排队模式：Enter 走入队、清空输入', async () => {
    const onEnqueueQueuedInput = vi.fn()
    const { container } = render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <AgentComposer />
      </Harness>
    )
    await typeIntoComposer('先记下这句')
    const editable = container.querySelector('[contenteditable="true"]')!

    fireEvent.keyDown(editable, { key: 'Enter' })

    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('先记下这句')
    await flushTapStore()
    expect(capturedAui!.composer().getState().text).toBe('')
  })

  test('running + 排队模式：trigger popover 开着时 Enter 留给候选项，不入队', async () => {
    const onEnqueueQueuedInput = vi.fn()
    const { container } = render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <AgentComposer />
      </Harness>
    )
    // 打 '/' 开出斜杠命令列表（同 composer_send_gate 的做法）。
    await typeIntoComposer('/')
    await screen.findByText(i18n.t('agentView.quickActions.summarize.label'))

    fireEvent.keyDown(container.querySelector('[contenteditable="true"]')!, { key: 'Enter' })

    expect(onEnqueueQueuedInput).not.toHaveBeenCalled()
  })

  test('running + 排队模式：停止键旁有发送键，点击入队', async () => {
    const onEnqueueQueuedInput = vi.fn()
    render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <AgentComposer />
      </Harness>
    )
    await typeIntoComposer('点按钮也要能发')
    expect(screen.getByRole('button', { name: i18n.t('chat.composer.cancel') })).toBeTruthy()
    const send = sendButtons()
    expect(send).toHaveLength(1)

    fireEvent.click(send[0]!)
    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('点按钮也要能发')
  })

  test('running 但非排队场地：只有停止键，Enter 不入队（现状不变）', async () => {
    const onEnqueueQueuedInput = vi.fn()
    const { container } = render(
      <Harness
        status="streaming"
        sendMessage={vi.fn(async () => {})}
        controls={{ queuedInputEnabled: false, queueModeActive: false, onEnqueueQueuedInput }}
      >
        <AgentComposer />
      </Harness>
    )
    await typeIntoComposer('这条不该进队列')
    expect(screen.getByRole('button', { name: i18n.t('chat.composer.cancel') })).toBeTruthy()
    expect(sendButtons()).toHaveLength(0)

    fireEvent.keyDown(container.querySelector('[contenteditable="true"]')!, { key: 'Enter' })
    expect(onEnqueueQueuedInput).not.toHaveBeenCalled()
  })

  // 🔴 这一档 Lexical 的 KEY_ENTER_COMMAND 不再早退（它只在 isRunning 时 return false），
  // 会直接 `aui.composer().send()` —— 拦截失效在这里才看得见。
  test('排队模式但没有前台流（待决审批 / 后台 run）：Enter 入队，不真发', async () => {
    const onEnqueueQueuedInput = vi.fn()
    const sendMessage = vi.fn(async () => {})
    const { container } = render(
      <Harness
        status="ready"
        sendMessage={sendMessage}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <AgentComposer />
      </Harness>
    )
    await typeIntoComposer('审批还没决，先排着')

    fireEvent.keyDown(container.querySelector('[contenteditable="true"]')!, { key: 'Enter' })

    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('审批还没决，先排着')
    await flushTapStore()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  // R1 —— 同 ThreadComposer：排队模式下 `ComposerPrimitive.Send` 一颗都不渲染。
  test('排队模式但没有前台流：发送位只有入队键，点击不真发', async () => {
    const onEnqueueQueuedInput = vi.fn()
    const sendMessage = vi.fn(async () => {})
    render(
      <Harness
        status="ready"
        sendMessage={sendMessage}
        controls={{ ...QUEUE_ON, onEnqueueQueuedInput }}
      >
        <AgentComposer />
      </Harness>
    )
    await typeIntoComposer('点键也只进队列')
    expect(screen.queryByRole('button', { name: i18n.t('chat.composer.cancel') })).toBeNull()
    const send = sendButtons()
    expect(send).toHaveLength(1)

    fireEvent.click(send[0]!)

    expect(onEnqueueQueuedInput).toHaveBeenCalledWith('点键也只进队列')
    await flushTapStore()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  // R3 —— Lexical 输入框在 sendDisabled 下**不会**变 disabled（用户照样能打字），所以入队键
  // 必须自己禁，否则「Enter 被守卫拒掉、点键却入队」。
  test('排队模式 + sendDisabled：入队键禁用', async () => {
    render(
      <Harness
        status="ready"
        sendMessage={vi.fn(async () => {})}
        controls={{ ...QUEUE_ON, sendDisabled: true, onEnqueueQueuedInput: vi.fn() }}
      >
        <AgentComposer />
      </Harness>
    )
    await typeIntoComposer('上下文还没解析完')
    const send = sendButtons()
    expect(send).toHaveLength(1)
    expect((send[0] as HTMLButtonElement).disabled).toBe(true)
  })
})
