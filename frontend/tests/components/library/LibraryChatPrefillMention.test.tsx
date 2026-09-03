// @vitest-environment happy-dom
//
// P2-L14 的另一半：**预置的那枚提及活得下来**（task 09-03；design §9.4 + L16）。
//
// 资料库「对话」按钮做两件事：把带 directive 的指令预填进 composer、把 `LibraryMentionRef`
// 交给面板状态（AgentConversation 走既有的 `onAddLibraryMention`）。两件事之间有一条真实的
// 竞态：AgentComposer 那条「chip 被删就摘掉 mention」的对账**只认 composer 正文**，正文还没
// 落地就先记了引用的话，对账会把它当「chip 已被删」当场摘掉 —— 功能表现为「预置了却没引用」。
//
// 修法是把「记引用」挪进 `ChatPromptDispatcher`：setText 之后盯着 composer 正文，等它真的等于
// 这条指令了再记。所以这里跑的是**真的那条链**（真运行时 + 真 AgentComposer + 真 dispatcher，
// 只有资料库搜索面被替身），验两件事：
//   ① 预填之后引用还在（信封含该 id）—— 竞态没吃掉它；
//   ② 用户把 chip 删掉后引用作废（信封不再含它）—— 隐私地板没被绕过。

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'
import { useMemo, useState } from 'react'

import i18n from '@shared/i18n'

vi.mock('@shared/components/matters/hooks', () => ({
  useMattersApi: () => ({ list: vi.fn(async () => ({ items: [], next_cursor: null })) }),
  useMattersEnabled: () => true
}))

vi.mock('@shared/api/library', () => ({
  createLibraryApi: () => ({
    search: vi.fn(async () => ({
      query: '',
      mode: 'porter',
      search_mode: 'fts',
      semantic: { available: false, model: null, chunks: 0 },
      hits: [],
      warnings: []
    }))
  })
}))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { buildLibraryMentionEnvelope, type LibraryMentionRef } from '@shared/lib/mention-context'
import { AgentComposer } from '@shared/components/agents/AgentComposer'
import { ChatPromptDispatcher } from '@shared/assistant/components/ChatPromptDispatcher'
import { buildLibraryChatPrompt } from '@shared/components/library/libraryChat'

const MENTIONED: LibraryMentionRef = {
  file_id: 42,
  path: 'my-docs/plans/定价.md',
  name: '定价.md',
  size_bytes: 900
}

/** 「对话」按钮真正预填进 composer 的那段文本（含 directive）。 */
const PROMPT = buildLibraryChatPrompt(MENTIONED, (_key, vars) =>
  Object.entries(vars).reduce((out, [k, v]) => out.replaceAll(`{${k}}`, v), `{mention}｜{path}`)
)

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
  vi.clearAllMocks()
  capturedAui = null
  addMention = null
  liveMentions = []
})

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

let addMention: ((file: LibraryMentionRef) => void) | null = null
/** 面板侧「会随发送注入的那份列表」的镜像（与 AgentConversation 的 libraryMentions 同语义）。 */
let liveMentions: readonly LibraryMentionRef[] = []

const dispatched = vi.fn()

function Host(): React.JSX.Element {
  const [libraryMentions, setLibraryMentions] = useState<LibraryMentionRef[]>([])
  liveMentions = libraryMentions
  addMention = (file): void =>
    setLibraryMentions((cur) =>
      cur.some((f) => f.file_id === file.file_id) ? cur : [...cur, file]
    )
  const controls = useMemo<ChatComposerControls>(
    () => ({
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
      libraryMentions,
      onAddLibraryMention: (file: LibraryMentionRef): void => addMention!(file),
      onRemoveLibraryMention: (fileId: number): void =>
        setLibraryMentions((cur) => cur.filter((f) => f.file_id !== fileId)),
      attachments: [],
      onAddAttachment: vi.fn(),
      onRemoveAttachment: vi.fn()
    }),
    [libraryMentions]
  )
  return (
    <ChatComposerControlsProvider value={controls}>
      <AuiProbe />
      {/* 生产里 AgentConversation 递进来的就是这个形状：带提及的指令恒 `prefillOnly`。 */}
      <ChatPromptDispatcher
        request={{ nonce: 1, text: PROMPT, prefillOnly: true, library: MENTIONED }}
        onDispatched={dispatched}
      />
      <AgentComposer />
    </ChatComposerControlsProvider>
  )
}

async function mount(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={9}>
        <Host />
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
  await waitFor(() => expect(capturedAui).not.toBeNull())
}

describe('「对话」按钮预置的提及', () => {
  test('🔴 指令预填进 composer，且引用没被对账吃掉：信封含该 id', async () => {
    await mount()
    await waitFor(() => expect(capturedAui!.composer().getState().text).toBe(PROMPT))
    // 只预填不发送（带提及的那条恒 prefillOnly）。
    await waitFor(() => expect(dispatched).toHaveBeenCalledWith(1, false))
    await waitFor(() => expect(buildLibraryMentionEnvelope(liveMentions)).toContain('id="42"'))
    expect(buildLibraryMentionEnvelope(liveMentions)).toContain('my-docs/plans/定价.md')
  })

  test('🔴 用户把 chip 删掉 → 引用作废（隐私地板没被绕过）', async () => {
    await mount()
    await waitFor(() => expect(buildLibraryMentionEnvelope(liveMentions)).toContain('id="42"'))

    act(() => capturedAui!.composer().setText('算了，换个说法'))
    await waitFor(() => expect(liveMentions).toEqual([]))
    expect(buildLibraryMentionEnvelope(liveMentions)).not.toContain('42')
  })
})
