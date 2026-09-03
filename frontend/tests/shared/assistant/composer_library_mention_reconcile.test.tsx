// @vitest-environment happy-dom
//
// P2-L8（资料库 epic）—— 🔴 隐私护栏：chip 被删 = 引用作废，资料库那一路必须接进**同一条**对账。
//
// 背景（ComposerPlusMenu 文件头 / AgentComposer 那条 effect 的注释）：agent 面的 @ 是 Lexical 的
// 行内 directive chip，而 Lexical **不给**「directive 被删」的回调。所以 composer 每次文本变化都要
// 重新解析正文里的 directive，把 controls 里没有对应 chip 的那些引用摘掉 —— 否则用户删掉了 chip、
// 视觉上引用已经撤回，发送时却仍然把它注入给模型。
//
// 这里钉的是资料库那一路，并且**验到信封**：摘除之后 `buildLibraryMentionEnvelope` 必须不再含
// 那个 file id（只验回调被调用不够 —— 回调调了而面板状态没变，注入照旧）。真实运行时 + 真实
// AgentComposer，只有资料库搜索面被替身。

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
    search: vi.fn(async () => ({ query: '', mode: 'porter', hits: [], warnings: [] }))
  })
}))

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { buildLibraryMentionEnvelope, type LibraryMentionRef } from '@shared/lib/mention-context'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

const MENTIONED: LibraryMentionRef = {
  file_id: 31,
  path: 'my-docs/plans/vendor-sow.md',
  name: 'vendor-sow.md',
  size_bytes: 2048
}
/** 插入一枚资料库 chip 之后 composer 正文长的样子（默认 directive formatter 的序列化形状）。 */
const CHIP_TEXT = ':library[vendor-sow.md]{name=library-31} 这份文件里的交付日期是哪天'

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
/** 面板侧「会随发送注入的那份列表」的镜像 —— 断言直接拿它去建信封。 */
let liveMentions: readonly LibraryMentionRef[] = []
const removed = vi.fn()

/** 面板侧状态的最小复刻：@ 插入时 add、对账要求摘除时 remove（与 AgentConversation 同语义）。 */
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
      onAddLibraryMention: vi.fn(),
      onRemoveLibraryMention: (fileId: number): void => {
        removed(fileId)
        setLibraryMentions((cur) => cur.filter((f) => f.file_id !== fileId))
      },
      attachments: [],
      onAddAttachment: vi.fn(),
      onRemoveAttachment: vi.fn()
    }),
    [libraryMentions]
  )
  return (
    <ChatComposerControlsProvider value={controls}>
      <AuiProbe />
      <AgentComposer />
    </ChatComposerControlsProvider>
  )
}

/** 设正文并等它真的落到 composer 状态上。 */
async function setComposerText(text: string): Promise<void> {
  act(() => capturedAui!.composer().setText(text))
  await waitFor(() => expect(capturedAui!.composer().getState().text).toBe(text))
}

async function mount(): Promise<void> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <Host />
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
  await waitFor(() => expect(capturedAui).not.toBeNull())
  // 生产时序：chip 先进正文，mention 随插入回调进 controls（对账只摘不加，故不会与插入抢跑）。
  // 🔴 setText 是**异步落地**的（经 Lexical 同步回 composer 状态），必须等正文真的到位再
  // 记 mention —— 否则复刻出来的就不是生产时序。
  await setComposerText(CHIP_TEXT)
  act(() => addMention!(MENTIONED))
  await waitFor(() => expect(buildLibraryMentionEnvelope(liveMentions)).toContain('id="31"'))
  expect(removed).not.toHaveBeenCalled()
}

describe('P2-L8 —— 资料库 mention 接进「chip 被删就摘掉引用」的对账', () => {
  test('chip 还在 → 不摘（对照：闸不是无条件清空）', async () => {
    await mount()
    await setComposerText(`${CHIP_TEXT}？麻烦看一下`)
    expect(removed).not.toHaveBeenCalled()
    expect(buildLibraryMentionEnvelope(liveMentions)).toContain('id="31"')
  })

  test('🔴 chip 被删 → 该文件从 controls 里摘掉，信封不再含它的 id', async () => {
    await mount()
    await setComposerText('这份文件里的交付日期是哪天')
    await waitFor(() => expect(removed).toHaveBeenCalledWith(31))
    expect(liveMentions).toEqual([])
    expect(buildLibraryMentionEnvelope(liveMentions)).toBe('')
    expect(buildLibraryMentionEnvelope(liveMentions)).not.toContain('31')
  })

  test('🔴 正文清空 → 同样摘掉，信封同样不含该 id', async () => {
    await mount()
    await setComposerText('')
    await waitFor(() => expect(removed).toHaveBeenCalledWith(31))
    expect(buildLibraryMentionEnvelope(liveMentions)).not.toContain('vendor-sow.md')
  })
})
