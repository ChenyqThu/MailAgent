// @vitest-environment happy-dom
//
// 0813 轮4批AE — owner：「邮件的 AI chat 对话，默认带的附件，怎么还是在外面？不是说了像 notion
// 放里面么？」截图里那枚**信封 chip**（当前邮件的标题 + ×）确实还在灰色输入框的外面上方。
//
// 🔴 它不是附件。批 AB（`composer_attachment_frame.test.tsx`）搬进框的是 `composer.attachments`；
// 这枚是**另一条路**：`ConversationContextChip`，由 AgentConversation 的 `emailContext` 面板状态
// （不是 composer 状态）产出，经 AgentThread 的 `contextChip` prop 传下来。改动前一次性 probe 打
// 出的真实祖先链证明它与整个 composer form 是**兄弟**、共同祖先要一路走到 ViewportFooter：
//
//   chip  → div.flex.flex-wrap（chip 带）→ ViewportFooter → Viewport → ThreadRoot
//   frame → rb-border-glow-inner → rb-border-glow-card → FORM → ViewportFooter → …
//   frame.contains(chip) === false
//
// 本文件钉的就是这条关系翻过来之后不许再翻回去。判据沿用批 AB 的 `frameOf`（从输入区往上走、
// 第一个带圆角的盒子 = 用户眼里的「框」）—— 那个判据是批 AB 自证过不是焊死闸的那一版。
//
// 🔴 事项 chip 与邮件 chip 是同一个组件、同一条 chip 带，所以这里用 ConversationContextChip 直接
// render 就同时覆盖两者；两者的产地/× 语义各自的测试（AgentConversationGuards / MatterConversation）
// 不在本文件重复。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Mail } from 'lucide-react'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { AgentThread } from '@shared/components/agents/AgentThread'
import { ConversationContextChip } from '@shared/components/agents/ConversationContextChip'

const CHIP_LABEL = 'Thanks for your time yesterday'

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function pngFile(name: string): File {
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
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = (): void => {}
})

afterEach(() => {
  cleanup()
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

let capturedAui: ReturnType<typeof useAui> | null = null
function AuiProbe(): null {
  capturedAui = useAui()
  return null
}

/** 输入区：通用面是 Lexical 的 contenteditable。 */
function inputOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
  expect(el, '找不到输入区').toBeTruthy()
  return el!
}

/** 「用户眼里的对话框」= 从输入区往上走、第一个带圆角的盒子（判据与批 AB 逐字同源，见
 *  composer_attachment_frame.test.tsx 的 frameOf 注释：绑皮肤而不是绑 dropzone）。 */
function frameOf(container: HTMLElement): HTMLElement {
  let el: HTMLElement | null = inputOf(container)
  while (el !== null && el !== container) {
    if (/(^|\s)rounded-/.test(el.getAttribute('class') ?? '')) return el
    el = el.parentElement
  }
  throw new Error('从输入区往上找不到任何带圆角的盒子 —— composer 没有可见的「框」')
}

/** context chip 的根节点（× 钮的祖先里那个带 rounded 的盒子）。 */
function contextChipOf(container: HTMLElement): HTMLElement {
  const label = Array.from(container.querySelectorAll('span')).find(
    (s) => s.textContent === CHIP_LABEL
  )
  expect(label, 'context chip 没渲染出来').toBeTruthy()
  return label!.parentElement!
}

/** 生产里 AgentConversation 传下来的是 **fragment**（不是再包一层容器）—— 这里逐样复刻，
 *  否则测的就不是生产形状。 */
function contextChips(): React.ReactNode {
  return (
    <>
      <ConversationContextChip
        icon={<Mail size={12} strokeWidth={2} className="shrink-0 text-coral" />}
        label={CHIP_LABEL}
        onRemove={vi.fn()}
      />
    </>
  )
}

async function mount(
  attachments: string[] = [],
  chip: React.ReactNode = contextChips()
): Promise<{ container: HTMLElement }> {
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={stubControls()}>
          <AuiProbe />
          <AgentThread contextChip={chip} />
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
  await waitFor(() => expect(capturedAui!.thread().getState().capabilities.attachments).toBe(true))
  if (attachments.length > 0) {
    await act(async () => {
      for (const name of attachments) await capturedAui!.composer().addAttachment(pngFile(name))
    })
    await waitFor(() =>
      expect(capturedAui!.composer().getState().attachments).toHaveLength(attachments.length)
    )
  }
  return { container }
}

describe('会话上下文 chip 与输入区同框（owner 0813 · Notion 形态）', () => {
  test('chip 在框内：框同时是 chip 与输入区的祖先', async () => {
    const { container } = await mount()
    const frame = frameOf(container)
    const chip = contextChipOf(container)

    // 改动前这条必红：当时 chip 与整个 composer form 是 ViewportFooter 里的兄弟，
    // frame.contains(chip) === false（一次性 probe 实测，见文件头的祖先链）。
    expect(frame.contains(chip), 'context chip 不在框内').toBe(true)
    expect(frame.contains(inputOf(container)), '输入区不在框内').toBe(true)
  })

  test('chip 排在输入区之前（chips 在上、输入在下、工具条最后）', async () => {
    const { container } = await mount()
    const frame = frameOf(container)
    const chip = contextChipOf(container)
    const kids = Array.from(frame.children)
    const chipRowIdx = kids.findIndex((k) => k.contains(chip))
    const inputIdx = kids.findIndex(
      (k) => k === inputOf(container) || k.contains(inputOf(container))
    )
    expect(chipRowIdx).toBeGreaterThanOrEqual(0)
    expect(chipRowIdx).toBeLessThan(inputIdx)
  })

  test('与附件 chip 同处一条 flex-wrap，且上下文在前、附件在后', async () => {
    const { container } = await mount(['a.png'])
    const chip = contextChipOf(container)
    const attachment = container.querySelector('img[alt=""]')!.closest('span')!

    // 🔴 同一个直接父节点 = 真·同一条换行流。中间若再包一层容器，上下文 chips 会自成一个
    // 换行上下文、与附件各换各的行 —— 那不是 owner 要的形态。
    expect(chip.parentElement, '上下文 chip 与附件 chip 不在同一条 chip 行').toBe(
      attachment.parentElement
    )

    const row = chip.parentElement!
    const kids = Array.from(row.children)
    expect(kids.indexOf(chip)).toBeLessThan(kids.indexOf(attachment))

    // 多个时换行、不横向挤扁 / 不横向滚动。
    const rowCls = row.getAttribute('class') ?? ''
    expect(rowCls).toContain('flex-wrap')
    expect(rowCls).not.toMatch(/(^|\s|:)(max-)?h-/)
    expect(rowCls).not.toMatch(/(^|\s|:)overflow-/)
  })

  test('框随 chips 长高：框上不设任何高度 / 溢出约束', async () => {
    const { container } = await mount(['a.png', 'b.png', 'c.png'])
    const frameCls = frameOf(container).getAttribute('class') ?? ''
    expect(frameCls).toContain('flex-col')
    expect(frameCls).not.toMatch(/(^|\s|:)(max-)?h-/)
    expect(frameCls).not.toMatch(/(^|\s|:)overflow-/)
  })

  test('没有上下文 chip 且零附件时，chip 行整个不渲染（不占高度）', async () => {
    const { container } = await mount([], null)
    const frame = frameOf(container)
    // 框里只剩「输入 + 工具条」两层。
    expect(frame.children.length).toBe(2)
    expect(Array.from(container.querySelectorAll('span')).some((s) => s.textContent === CHIP_LABEL))
      .toBe(false)
  })

  test('chip 皮肤与附件 chip 同档：bg-ink-3 实心（框是 ink-2，同档会只剩描边）', async () => {
    const { container } = await mount(['a.png'])
    const chipCls = contextChipOf(container).getAttribute('class') ?? ''
    const attachmentCls =
      container.querySelector('img[alt=""]')!.closest('span')!.getAttribute('class') ?? ''
    for (const cls of ['bg-ink-3', 'border-ink-border', 'rounded-md', 'text-meta']) {
      expect(chipCls, `context chip 缺 ${cls}`).toContain(cls)
      expect(attachmentCls, `attachment chip 缺 ${cls}`).toContain(cls)
    }
    // 框是 ink-2 —— chip 若也是 ink-2 就没有填充差（批 AB 在反方向修过的同一个坑）。
    expect(chipCls).not.toMatch(/(^|\s)bg-ink-2(\s|$)/)
  })
})

// ── 结构：chip 不再有第二个渲染出口 ──────────────────────────────────────────────────────────────
describe('contextChip 只有一个渲染出口（composer 框内）', () => {
  const SRC = resolve(__dirname, '../../../src')
  const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8')

  test('AgentThread 只把 contextChip 透传给 AgentComposer，不自己渲染', () => {
    const src = read('shared/components/agents/AgentThread.tsx')
    expect(src).toMatch(/<AgentComposer\s+contextChip=\{contextChip\}\s*\/>/)
    // 改动前是 `{!readOnly && contextChip}` 直接铺在 ViewportFooter 里 —— 那是「框外」的成因。
    expect(src).not.toMatch(/\{\s*!readOnly\s*&&\s*contextChip\s*\}/)
  })

  test('AgentComposer 把它交给共享的 ComposerFrame（不另起第三种 chip 容器）', () => {
    const src = read('shared/components/agents/AgentComposer.tsx')
    expect(src).toMatch(/leadingChips=\{contextChip\}/)
    expect(src).not.toMatch(/<ComposerPrimitive\.AttachmentDropzone/)
  })

  test('AgentConversation 传的是平铺 chips 而不是再包一层 flex 容器', () => {
    const src = read('shared/components/agents/AgentConversation.tsx')
    // 包一层就会自成换行上下文（见上面那条同父断言）。
    expect(src).not.toMatch(/<div className="flex flex-wrap items-center gap-1\.5">\s*\{matter\.chip\}/)
    expect(src).toMatch(/contextChips\s*=/)
  })
})
