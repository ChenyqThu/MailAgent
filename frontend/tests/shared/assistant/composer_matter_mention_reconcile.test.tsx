// @vitest-environment happy-dom
//
// S4 (task 08-18) —— 🔴 隐私护栏：chip 被删 = 引用作废，事项那一路必须接进**同一条**对账。
//
// 背景（ComposerPlusMenu 文件头 / AgentComposer 那条 effect 的注释）：agent 面的 @ 是 Lexical 的
// 行内 directive chip，而 Lexical **不给**「directive 被删」的回调。所以 composer 每次文本变化都要
// 重新解析正文里的 directive，把 controls 里没有对应 chip 的那些引用摘掉 —— 否则用户删掉了 chip、
// 视觉上引用已经撤回，发送时却仍然把它注入给模型。
//
// 这里钉的是事项那一路：删 chip → onRemoveMatterMention 被调用；chip 还在 → 不许误摘（对照，
// 防止把闸写成「无条件清空」也能过）。真实运行时 + 真实 AgentComposer，只有事项搜索面被替身。

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

import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import type { MatterMentionRef } from '@shared/lib/mention-context'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

const MENTIONED: MatterMentionRef = {
  public_id: 'MAT-0012',
  title: 'Vendor launch',
  status: 'active'
}
/** 插入一枚事项 chip 之后 composer 正文长的样子（默认 directive formatter 的序列化形状）。 */
const CHIP_TEXT = ':matter[Vendor launch]{name=matter-MAT-0012} 这件事进展如何'

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
})

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

let addMention: ((matter: MatterMentionRef) => void) | null = null
const removed = vi.fn()

/** 面板侧状态的最小复刻：@ 插入时 add、对账要求摘除时 remove（与 AgentConversation 同语义）。 */
function Host(): React.JSX.Element {
  const [matterMentions, setMatterMentions] = useState<MatterMentionRef[]>([])
  addMention = (matter): void =>
    setMatterMentions((cur) =>
      cur.some((m) => m.public_id === matter.public_id) ? cur : [...cur, matter]
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
      matterMentions,
      onAddMatterMention: vi.fn(),
      onRemoveMatterMention: (publicId: string): void => {
        removed(publicId)
        setMatterMentions((cur) => cur.filter((m) => m.public_id !== publicId))
      },
      attachments: [],
      onAddAttachment: vi.fn(),
      onRemoveAttachment: vi.fn()
    }),
    [matterMentions]
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
  // 记 mention —— 否则复刻出来的就不是生产时序（chip 先在正文里，插入回调随后进 controls）。
  await setComposerText(CHIP_TEXT)
  act(() => addMention!(MENTIONED))
  expect(removed).not.toHaveBeenCalled()
}

describe('S4 —— 事项 mention 接进「chip 被删就摘掉引用」的对账', () => {
  test('chip 还在 → 不摘（对照：闸不是无条件清空）', async () => {
    await mount()
    await setComposerText(`${CHIP_TEXT}？麻烦看一下`)
    expect(removed).not.toHaveBeenCalled()
  })

  test('🔴 chip 被删 → 该事项从 controls 里摘掉（不会再随发送注入）', async () => {
    await mount()
    await setComposerText('这件事进展如何')
    await waitFor(() => expect(removed).toHaveBeenCalledWith('MAT-0012'))
  })

  test('🔴 正文清空 → 同样摘掉', async () => {
    await mount()
    await setComposerText('')
    await waitFor(() => expect(removed).toHaveBeenCalledWith('MAT-0012'))
  })
})
