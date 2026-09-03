// @vitest-environment happy-dom
//
// P2-L5 —— composer 附件区的一次性告知「对话附件会保存到资料库」（design §1.4）。
//
// 这条不是装饰：附件的隐私语义变了（此前只活在 renderer 内存里，现在原件会落到资料库并长期
// 留存），变化必须出现在用户看得见的地方。所以断言的是**出现时机**（真有待发附件时才出）、
// **消失条件**（点掉之后永不再来，跨 mount 生效）和**不打扰无附件的人**。
//
// 两个 composer 共用 ComposerChipRow，故两面都钉。

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

const NOTICE_KEY = 'mailagent.chat.attachmentLibraryNotice.v1'

function txtFile(name: string): File {
  return new File(['hello'], name, { type: 'text/plain' })
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

beforeEach(() => {
  window.localStorage.removeItem(NOTICE_KEY)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  capturedAui = null
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

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

async function mount(node: React.ReactNode, attachments: string[] = []): Promise<HTMLElement> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={stubControls()}>
          <AuiProbe />
          {node}
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
  await waitFor(() => expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true))
  if (attachments.length > 0) {
    await act(async () => {
      for (const name of attachments) await capturedAui!.composer().addAttachment(txtFile(name))
    })
    await waitFor(() =>
      expect(capturedAui!.composer().getState().attachments).toHaveLength(attachments.length)
    )
  }
  return container
}

const SURFACES = [
  { name: '邮件面 ThreadComposer', node: <ThreadComposer /> },
  { name: '通用面 AgentComposer', node: <AgentComposer /> }
] as const

describe('对话附件入库的一次性告知', () => {
  for (const surface of SURFACES) {
    test(`${surface.name} — 有待发附件时出现`, async () => {
      await mount(surface.node, ['notes.txt'])
      expect(screen.queryByText(i18n.t('library.chip.composerNotice'))).toBeTruthy()
    })

    test(`${surface.name} — 没有附件时不出现（不打扰只打字的人）`, async () => {
      await mount(surface.node)
      expect(screen.queryByText(i18n.t('library.chip.composerNotice'))).toBeNull()
    })
  }

  test('点掉之后写进 localStorage，并且重新挂载也不再出现', async () => {
    await mount(<ThreadComposer />, ['notes.txt'])
    const notice = screen.getByText(i18n.t('library.chip.composerNotice'))
    const dismiss = notice.parentElement!.querySelector('button')
    expect(dismiss).toBeTruthy()

    fireEvent.click(dismiss!)
    await waitFor(() =>
      expect(screen.queryByText(i18n.t('library.chip.composerNotice'))).toBeNull()
    )
    expect(window.localStorage.getItem(NOTICE_KEY)).toBe('1')

    cleanup()
    await mount(<ThreadComposer />, ['again.txt'])
    expect(screen.queryByText(i18n.t('library.chip.composerNotice'))).toBeNull()
  })

  test('localStorage 已有标记 → 一开始就不出现', async () => {
    window.localStorage.setItem(NOTICE_KEY, '1')
    await mount(<ThreadComposer />, ['notes.txt'])
    expect(screen.queryByText(i18n.t('library.chip.composerNotice'))).toBeNull()
  })
})
