// @vitest-environment happy-dom
//
// 0812 dogfood P0 —— 邮件工具栏「事项」按钮点了没反应。
//
// 根因不在按钮：工具栏 header 为了窄宽下不横向溢出挂了 `overflow-x-auto`，按 CSS Overflow 3
// 「一轴 auto 则另一轴的 visible 计算成 auto」，那条 44px 高的 header 同时成了纵向裁剪容器，
// `absolute top-9` 的弹层只剩几像素露在框内。修法是让弹层 portal 出去 —— 本用例就钉这一条：
// 面板必须挂在 document.body 下、而**不是**在裁剪容器的子树里。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'

const { mattersApi, navigate } = vi.hoisted(() => ({
  mattersApi: {
    lookupResourceLinks: vi.fn(async () => ({ results: {} })),
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(),
    create: vi.fn(),
    linkResource: vi.fn(),
    unlinkResource: vi.fn(),
    patchResource: vi.fn()
  },
  navigate: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@shared/components/matters/hooks', () => ({ useMattersApi: () => mattersApi }))
vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))

const { MatterLinkPopover } = await import('@shared/components/matters/MatterLinkPopover')

await i18n.changeLanguage('zh-CN')

/** 复刻工具栏的形状：一个 `overflow-x-auto` 的裁剪 header + 里面的锚点容器。 */
function ClippedHost(): React.ReactElement {
  const anchorRef = useRef<HTMLDivElement>(null)
  return (
    <header data-testid="clipping-header" className="h-11 overflow-x-auto">
      <div ref={anchorRef} data-testid="anchor" className="relative">
        <button type="button">事项</button>
        <MatterLinkPopover
          open
          anchorRef={anchorRef}
          source={{
            internalId: 42,
            threadId: null,
            subject: 'Vendor launch',
            sender: 'a@b.test',
            receivedAt: null,
            threadCount: 1
          }}
          onClose={vi.fn()}
        />
      </div>
    </header>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.lookupResourceLinks.mockResolvedValue({ results: {} })
  mattersApi.list.mockResolvedValue({ items: [] })
})

afterEach(cleanup)

describe('MatterLinkPopover — portal escapes the clipping toolbar', () => {
  test('面板挂在 body 下，不在 overflow 裁剪容器的子树里', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <ClippedHost />
      </QueryClientProvider>
    )

    const panel = await screen.findByRole('dialog', { name: '事项' })
    const header = screen.getByTestId('clipping-header')
    expect(header.contains(panel)).toBe(false)
    expect(document.body.contains(panel)).toBe(true)
    // fixed 定位 + 锚点算出来的 top/left（happy-dom 里 rect 全 0 → 落在视口左上的兜底位）。
    expect(panel.className).toContain('fixed')
    expect(panel.style.top).not.toBe('')
    expect(panel.style.left).not.toBe('')
  })
})

/** 可开关的宿主：用来验 Esc 关闭 + 关闭后焦点归位（codex #8）。 */
function ToggleHost(): React.ReactElement {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <div ref={anchorRef} className="relative">
      <button type="button" data-testid="trigger" onClick={() => setOpen(true)}>
        事项
      </button>
      <MatterLinkPopover
        open={open}
        anchorRef={anchorRef}
        source={{
          internalId: 42,
          threadId: null,
          subject: 'Vendor launch',
          sender: 'a@b.test',
          receivedAt: null,
          threadCount: 1
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}

describe('MatterLinkPopover — 键盘可退出 + 焦点归位（codex #8）', () => {
  test('Esc 关闭面板，并把焦点还给触发按钮', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <ToggleHost />
      </QueryClientProvider>
    )
    const trigger = screen.getByTestId('trigger')
    trigger.focus()
    fireEvent.click(trigger)
    await screen.findByRole('dialog', { name: '事项' })

    // 它是 role="dialog"，此前却只能点遮罩/关闭钮退出 —— 键盘用户按 Esc 毫无反应。
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '事项' })).toBeNull())
    // portal 到 body 之后，不显式归位焦点就会落到 body 上（键盘位置当场丢失）。
    expect(document.activeElement).toBe(trigger)
  })
})

/** G-25 (Q2=c)：工具栏捕获形态 —— AI 调研创建 / 快速新建 / 跟进 Agent 次级入口。 */
function CaptureHost({
  onAiResearch,
  onCreateFollowupAgent
}: {
  onAiResearch?: () => void
  onCreateFollowupAgent?: () => void
}): React.ReactElement {
  const anchorRef = useRef<HTMLDivElement>(null)
  return (
    <div ref={anchorRef} className="relative">
      <MatterLinkPopover
        open
        anchorRef={anchorRef}
        source={{
          internalId: 42,
          threadId: 'thread-1',
          subject: 'Vendor launch',
          sender: 'a@b.test',
          receivedAt: null,
          threadCount: 3
        }}
        onAiResearch={onAiResearch}
        onCreateFollowupAgent={onCreateFollowupAgent}
        onClose={vi.fn()}
      />
    </div>
  )
}

describe('MatterLinkPopover — 捕获浮层的三个新行（G-25）', () => {
  test('传了 onAiResearch → 「AI 调研创建」行在最上、创建行改标「快速新建」，点击各自触发', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    const onAiResearch = vi.fn()
    const onCreateFollowupAgent = vi.fn()
    render(
      <QueryClientProvider client={client}>
        <CaptureHost onAiResearch={onAiResearch} onCreateFollowupAgent={onCreateFollowupAgent} />
      </QueryClientProvider>
    )
    await screen.findByRole('dialog', { name: '事项' })

    fireEvent.click(screen.getByRole('button', { name: 'AI 调研创建' }))
    expect(onAiResearch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '快速新建' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '创建新事项' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '为此线程建立跟进 Agent' }))
    expect(onCreateFollowupAgent).toHaveBeenCalledTimes(1)
  })

  test('不传两个新入口（⌘K 消费方）→ 形态与既有版本一致', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })
    render(
      <QueryClientProvider client={client}>
        <CaptureHost />
      </QueryClientProvider>
    )
    await screen.findByRole('dialog', { name: '事项' })
    expect(screen.getByRole('button', { name: '创建新事项' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'AI 调研创建' })).toBeNull()
    expect(screen.queryByRole('button', { name: '为此线程建立跟进 Agent' })).toBeNull()
  })
})
