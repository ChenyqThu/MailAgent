// @vitest-environment happy-dom
//
// 0813 owner（参照 Notion 输入框）：「把附件放到对话框里，拉高对话框高度，包含附件，如果附件多
// 换行显示，并进一步拉高对话框高度。全屏/浮窗/抽屉侧栏 都统一优化。」
//
// 改动前的实测形状（本文件的存在理由）：
//   - 邮件面 ThreadComposer = **框外**。textarea 自带 `rounded-lg border bg-ink-3`，那圈边框
//     就是用户眼里的「对话框」，chips 与工具条是它的**兄弟**、挂在框外。
//   - 通用面 AgentComposer = **已经框内**（BorderGlow 卡是框，chips/输入/工具条都在卡里）。
// 收敛办法 = 两面共用 ComposerFrame：chips 行 + 竖排堆栈 + dropzone 一份代码，皮肤各自给。
//
// 本文件钉四件事（都是结构级断言，不是「看起来正常」）：
//   1. chips 在框内 —— 承载皮肤的那个盒子必须**同时**是 chip 和输入区的祖先；
//   2. 框随内容长高 —— 框上不许出现任何 h-/max-h/overflow（chips 区也不单独滚动），
//      三层是同一个 flex-col 的兄弟；
//   3. 零附件 = 不多一个节点（chip 行整个不渲染），多附件 = chip 行 flex-wrap 换行；
//   4. 两面同源 —— 框的堆栈类逐字相同，且三场地（浮窗/侧栏/全屏）确实都落到 AgentComposer。
//
// 粘贴/拖拽的**状态级**回归网不在这里：拖拽在 composer_dropzone.test.tsx、粘贴在
// composer_paste_image.test.tsx（两条都断言 composer.attachments 真的长出来了，而不是看界面）。
// 本批把 onPaste 从 dropzone 直接持有改成经 ComposerFrame 的 rest 透传，靠那两个文件兜住。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAui } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ChatComposerControlsProvider } from '@shared/assistant/components/composerControls'
import { type ChatComposerControls } from '@shared/assistant/components/composerControlsContext'
import { ThreadComposer } from '@shared/assistant/components/composer'
import { AgentComposer } from '@shared/components/agents/AgentComposer'

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

function Harness({
  children,
  controls
}: {
  children: React.ReactNode
  controls?: Partial<ChatComposerControls>
}): React.ReactElement {
  return (
    <QueryClientProvider client={qc}>
      <AiSdkRuntimeProvider gatewayBaseUrl="http://127.0.0.1:1" sessionId={7}>
        <ChatComposerControlsProvider value={stubControls(controls)}>
          <AuiProbe />
          {children}
        </ChatComposerControlsProvider>
      </AiSdkRuntimeProvider>
    </QueryClientProvider>
  )
}

/** 输入区：邮件面是 textarea，通用面是 Lexical 的 contenteditable。 */
function inputOf(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('textarea, [contenteditable="true"]')
  expect(el, '找不到输入区').toBeTruthy()
  return el!
}

/** 「用户眼里的对话框」= 从输入区往上走、第一个**带圆角**的盒子（圆角是这仓里「这是一张卡/
 *  一个框」的判据；v3 token 四档全是 rounded-*）。
 *
 *  🔴 判据必须绑在**皮肤**上，不能绑在 AttachmentDropzone 上 —— 改动前 dropzone 同样是
 *  chips 与输入区的共同祖先（它只是没有皮肤，框画在 textarea 自己身上），拿 dropzone 当
 *  「框」去断言 contains(chip) 改动前后都为真 = 一条焊死的闸。按圆角找就分得开：
 *    · 改动前邮件面 → textarea 自带 rounded-lg，它**就是**那个框，而 chip 是它的兄弟 → 红；
 *    · 改动后邮件面 → textarea 无圆角，往上找到 dropzone 的 rounded-[var(--r-card)] → 绿；
 *    · 通用面改动前后都是往上找到 dropzone 的 rounded-2xl（本来就框内）→ 都绿，符合实情。 */
function frameOf(container: HTMLElement): HTMLElement {
  let el: HTMLElement | null = inputOf(container)
  while (el !== null && el !== container) {
    if (/(^|\s)rounded-/.test(el.getAttribute('class') ?? '')) return el
    el = el.parentElement
  }
  throw new Error('从输入区往上找不到任何带圆角的盒子 —— composer 没有可见的「框」')
}

async function mount(
  node: React.ReactNode,
  attachments: string[] = []
): Promise<{ container: HTMLElement }> {
  const { container } = render(<Harness>{node}</Harness>)
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

const SURFACES = [
  { name: '邮件面 ThreadComposer（弹出窗 / 邮件 chat 面板）', node: <ThreadComposer /> },
  { name: '通用面 AgentComposer（浮窗 / 抽屉侧栏 / 全屏）', node: <AgentComposer /> }
] as const

describe('附件 chips 与输入区同框（owner 0813 · Notion 形态）', () => {
  for (const surface of SURFACES) {
    test(`${surface.name} — chip 在框内：框同时是 chip 与输入区的祖先`, async () => {
      const { container } = await mount(surface.node, ['a.png'])
      const frame = frameOf(container)
      const chip = container.querySelector('img[alt=""]')?.closest('span')
      expect(chip, 'chip 没渲染出来').toBeTruthy()

      // 「框内」的判据 = 祖先关系，不是肉眼。改动前邮件面这条必红：当时的框是 textarea
      // 自己，chip 是它的兄弟，textarea.contains(chip) === false。
      expect(frame.contains(chip!), 'chip 不在框内').toBe(true)
      expect(frame.contains(inputOf(container)), '输入区不在框内').toBe(true)

      // 且 chip 行排在输入区**之前**（Notion 形态：chips 在上，输入在下，工具条最后）。
      const kids = Array.from(frame.children)
      const chipRowIdx = kids.findIndex((k) => k.contains(chip!))
      const inputIdx = kids.findIndex((k) => k === inputOf(container) || k.contains(inputOf(container)))
      expect(chipRowIdx).toBeGreaterThanOrEqual(0)
      expect(chipRowIdx).toBeLessThan(inputIdx)
    })

    test(`${surface.name} — 框随内容长高：不设高度、chips 区不自滚`, async () => {
      const { container } = await mount(surface.node, ['a.png', 'b.png', 'c.png'])
      const frame = frameOf(container)
      const frameCls = frame.getAttribute('class') ?? ''

      // 竖排堆栈：三层是同一个 flex-col 的兄弟 → 多一行 chips 就多占一行高度。
      expect(frameCls).toContain('flex-col')

      // 🔴 长高的实现手法 = 框上**没有**任何高度/溢出约束。写死 h-/max-h 会让 chips 去挤压
      // 输入区（owner 明确不要），给 chips 区加 overflow 则是把问题藏进一个小滚动条里。
      expect(frameCls).not.toMatch(/(^|\s|:)(max-)?h-/)
      expect(frameCls).not.toMatch(/(^|\s|:)overflow-/)

      const chipRow = container.querySelector('img[alt=""]')!.closest('span')!.parentElement!
      const chipRowCls = chipRow.getAttribute('class') ?? ''
      expect(chipRowCls).not.toMatch(/(^|\s|:)(max-)?h-/)
      expect(chipRowCls).not.toMatch(/(^|\s|:)overflow-/)
      // 附件多 → 换行（而不是横向挤扁 / 横向滚动）。
      expect(chipRowCls).toContain('flex-wrap')

      // 输入区自己的 max-h-32 是文本溢出的老行为，与本层无关，必须还在 —— 且它挂在框的
      // **后代**上而不是框上（挂到框上就变成「整框封顶」，chips 一多就会去挤压输入区）。
      // 两面的落点不同（邮件面在 textarea 自己身上，通用面在 Lexical 的 editor 外壳上），
      // 所以按类名找、不按元素找。
      const capped = frame.querySelector('[class*="max-h-32"]')
      expect(capped, '输入区的 max-h-32 不见了').toBeTruthy()
      expect(capped).not.toBe(frame)
    })

    test(`${surface.name} — 零附件时 chip 行整个不渲染（不占高度）`, async () => {
      const { container } = await mount(surface.node)
      const frame = frameOf(container)
      // 框里只剩「输入 + 工具条」两层；没有任何空的 chip 行占位。
      expect(frame.children.length).toBe(2)
      expect(container.querySelector('img[alt=""]')).toBeNull()
    })
  }

  test('两面同源：框的堆栈类逐字相同（皮肤之外没有第二份布局）', async () => {
    const { container: mail } = await mount(<ThreadComposer />, ['a.png'])
    const mailCls = new Set((frameOf(mail).getAttribute('class') ?? '').split(/\s+/))
    cleanup()
    capturedAui = null
    const { container: agent } = await mount(<AgentComposer />, ['a.png'])
    const agentCls = new Set((frameOf(agent).getAttribute('class') ?? '').split(/\s+/))

    // ComposerFrame 里那一份基础堆栈 —— 两面必须逐字都有。皮肤（圆角/描边/底色）各自给，
    // 故只断言交集包含堆栈，不断言两个集合相等。
    for (const cls of [
      'flex',
      'w-full',
      'flex-col',
      'gap-1.5',
      'p-2',
      'transition-colors',
      'duration-fast',
      'data-[dragging=true]:bg-coral/5'
    ]) {
      expect(mailCls.has(cls), `邮件面缺 ${cls}`).toBe(true)
      expect(agentCls.has(cls), `通用面缺 ${cls}`).toBe(true)
    }
  })

  test('邮件面的框自己带皮肤；通用面的皮肤在外层 BorderGlow 卡上', async () => {
    const { container: mail } = await mount(<ThreadComposer />)
    const mailFrameCls = frameOf(mail).getAttribute('class') ?? ''
    // 邮件面：border/bg/圆角从 textarea 搬到了框（改动前这三样在 textarea 上）。
    expect(mailFrameCls).toContain('rounded-[var(--r-card)]')
    expect(mailFrameCls).toContain('border')
    expect(mailFrameCls).toContain('bg-ink-2')
    // 输入区自此无边框、透明底 —— 否则会在框里再画一个框（双层框）。
    const ta = inputOf(mail).getAttribute('class') ?? ''
    expect(ta).toContain('bg-transparent')
    expect(ta).not.toMatch(/(^|\s)rounded-lg(\s|$)/)

    // 🔴 chip 是 bg-ink-3，所以框必须是 ink-2：两者同档时亮色下双双纯白，chip 在框上会
    // 丢掉填充差、只剩描边，与通用面（实心 chip 浮在 ink-2 卡上）观感劈叉。
    expect(mailFrameCls).not.toContain('bg-ink-3')

    cleanup()
    capturedAui = null
    const { container: agent } = await mount(<AgentComposer />)
    // 通用面：皮肤在 BorderGlow 卡上，框只补一个圆角让 data-dragging 底色洗跟着卡走。
    expect(agent.querySelector('.rb-border-glow-card')).toBeTruthy()
    expect(frameOf(agent).getAttribute('class') ?? '').toContain('rounded-2xl')
  })
})

// ── 三场地一致性 ────────────────────────────────────────────────────────────────────────────────
// owner 点名的三个场地（全屏 / 浮窗 / 抽屉侧栏）不是三个 composer：它们都渲染 AgentConversation
// → AgentThread → AgentComposer，所以上面那组针对 AgentComposer 的断言一次覆盖三处。这条把
// 「同一个 composer」这个前提本身钉住 —— 将来谁给某个场地叉一份 composer 出来，这里先红。
//   · 全屏     = /sessions 的 AgentViewLayout（浮窗右上角的「全屏」是导航动作，不是模态的最大化态）
//   · 浮窗/侧栏 = AssistantChatModal 的两种 mode（侧栏由 AssistantChatDock 宿主挂载）
describe('三场地都落到同一个 AgentComposer', () => {
  const SRC = resolve(__dirname, '../../../src')
  const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8')

  test.each([
    ['浮窗 + 抽屉侧栏', 'shared/assistant/modal/AssistantChatModal.tsx'],
    ['全屏 /sessions', 'shared/components/agents/AgentViewLayout.tsx']
  ])('%s → AgentConversation', (_label, rel) => {
    expect(read(rel)).toContain('AgentConversation')
  })

  test('抽屉侧栏宿主 AssistantChatDock → AssistantChatModal', () => {
    expect(read('shared/assistant/modal/AssistantChatDock.tsx')).toContain('AssistantChatModal')
  })

  test('AgentConversation → AgentThread → AgentComposer', () => {
    expect(read('shared/components/agents/AgentConversation.tsx')).toContain('AgentThread')
    expect(read('shared/components/agents/AgentThread.tsx')).toContain('AgentComposer')
  })

  test('两个 composer 的 chip 行/框只有一份实现（AgentComposer 不再自持 wrapper）', () => {
    const agent = read('shared/components/agents/AgentComposer.tsx')
    expect(agent).toContain('ComposerFrame')
    // 改动前这里有一个 AgentAttachmentChips 本地 wrapper（「两处逐字节复制」的历史病根）。
    // 判**声明与使用**、不判字符串出现 —— 文件头的沿革注释里还留着这个名字，那是有意的。
    expect(agent).not.toMatch(/function\s+AgentAttachmentChips/)
    expect(agent).not.toMatch(/<AgentAttachmentChips[\s/>]/)
    expect(agent).not.toMatch(/<ComposerPrimitive\.AttachmentDropzone/)
  })
})
