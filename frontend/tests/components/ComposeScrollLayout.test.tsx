// @vitest-environment happy-dom
//
// composer 滚动区布局铁律 —— dogfood「正文和引用原文会重叠, 正文稍微长就交叠」的回归闸。
//
// 根因 (9866b6bd 引入): 正文块挂 `flex-1` = `flex: 1 1 0%`。basis:0 让盒高只由 flex 剩余
// 空间决定, 而块上的显式 `min-height` 又顶掉了 flex item 默认的 `min-height:auto`
// (内容下限) —— 于是盒高与内容高彻底脱钩, 长正文溢出盒外 (overflow 默认 visible)
// 直接画到下方引用块上。真实浏览器实测 (900x700 视口 / 5 附件 / 40 行正文):
//   修前 editorBox.height=257 而内容底部 y=1898, 引用块 top=659 → 交叠 1239px
//   修后 editorBox.height=1496 = 内容高, 引用块 top=1898 → 交叠 0
//
// 为什么这里不断言 boundingRect: happy-dom 没有排版引擎, getBoundingClientRect /
// offsetHeight 对任何元素恒返回 0 (已实测, 连显式 inline height 也是 0), 几何断言
// 在这个 runner 里恒真、证明不了任何事。故改断言几何背后的**布局属性不变式**:
// 滚动区的每个直接子块都必须 shrink-0 + 保持默认 basis:auto (盒高 = 内容高),
// 且不得脱离文档流 —— 这三条同时成立时, 相邻兄弟在纵向 flex 里几何上不可能交叠。
// 几何验证本身在真实浏览器里做 (数字见上), vitest 这层锁住不变式不被改回去。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockSend, mockSettingsGet, mockUpload, mockDraftPlan, mockEmailGet } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSettingsGet: vi.fn(),
  mockUpload: vi.fn(),
  mockDraftPlan: vi.fn(),
  mockEmailGet: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: {
      send: mockSend,
      uploadComposeAttachment: mockUpload,
      draftPlan: mockDraftPlan,
      get: mockEmailGet
    },
    settings: { get: mockSettingsGet }
  })
}))

vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))
vi.mock('../../src/shared/components/email/EmailBodyFrame', () => ({
  EmailBodyFrame: () => null
}))

import i18n from '@shared/i18n'
import { ComposePanelInner } from '../../src/shared/components/email/compose/ComposePanel'

await i18n.changeLanguage('zh-CN')

/** 40 段正文 —— dogfood 复现用的「稍微长一点」量级。 */
const LONG_BODY_HTML = Array.from(
  { length: 40 },
  (_, i) => `<p>正文第 ${i + 1} 段 lorem ipsum dolor sit amet consectetur.</p>`
).join('')

const REPLY_PLAN = {
  internal_id: 42,
  mode: 'reply' as const,
  to: ['peer@acme.com'],
  cc: [],
  bcc: [],
  subject: 'Re: 合同',
  reply_html: LONG_BODY_HTML,
  quote_html: '<blockquote>被引用的原文</blockquote>',
  forward_intro_html: '',
  attachments: 2,
  warnings: []
}

function renderWithClient(node: React.ReactNode): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function makeFile(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/pdf' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  mockUpload.mockImplementation(async (arg: { filename: string }) => ({
    stage_id: `st-${arg.filename}`,
    filename: arg.filename,
    size: 3,
    mime: 'application/pdf'
  }))
  mockDraftPlan.mockResolvedValue(REPLY_PLAN)
  mockEmailGet.mockResolvedValue({ internal_id: 42, attachments: [] })
})

afterEach(() => cleanup())

/** 纵向 flex 滚动区里「盒高恒等于内容高」的三条件。任一条破了就可能出现兄弟交叠。 */
function expectCannotOverlapSiblings(el: HTMLElement, label: string): void {
  const cls = el.className
  // ① 不收缩: 负剩余空间时不会被压到内容高以下。
  expect(cls, `${label} 必须 shrink-0`).toMatch(/(^|\s)shrink-0(\s|$)/)
  // ② 不得用 flex-1 (= flex:1 1 0%): basis:0 让盒高与内容高脱钩 —— 本 bug 的根因。
  expect(cls, `${label} 不得用 flex-1 (basis:0 会让盒高脱离内容高)`).not.toMatch(
    /(^|\s)flex-1(\s|$)/
  )
  // ③ 不得脱离文档流: absolute/fixed 的高度不参与父级排版, 同样会画到兄弟上。
  expect(cls, `${label} 不得脱离文档流`).not.toMatch(/(^|\s)(absolute|fixed)(\s|$)/)
  expect(el.style.position).not.toBe('absolute')
  expect(el.style.position).not.toBe('fixed')
}

describe('ComposePanel — 滚动区布局铁律 (长正文 + 引用 + 多附件同时在场)', () => {
  test('三者同时在场时, 滚动区每个直接子块都不可能与兄弟交叠', async () => {
    renderWithClient(<ComposePanelInner internalId={42} mode="reply" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('引用原文')).toBeTruthy())

    // 5 个附件 —— 超过默认展开阈值, 走折叠路径。
    const fileInput = screen.getByLabelText('附件', { selector: 'input' }) as HTMLInputElement
    fireEvent.change(fileInput, {
      target: { files: [1, 2, 3, 4, 5].map((n) => makeFile(`f${n}.pdf`)) }
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /5 个附件/ })).toBeTruthy())

    const scrollOwner = screen.getByTestId('compose-scroll-owner')
    const children = Array.from(scrollOwner.children) as HTMLElement[]
    // 附件架 + 正文 + 引用块 + 「原附件不重传」提示 —— 组合确实全在场才算数,
    // 否则这条测试会在某块意外不渲染时静默退化成空断言。
    expect(children.length).toBe(4)
    expect(screen.getByTestId('attachment-tray-grid')).toBeTruthy()
    expect(screen.getByText(/正文第 40 段/)).toBeTruthy()

    children.forEach((child, i) => expectCannotOverlapSiblings(child, `滚动区子块 #${i}`))
  })

  test('正文块: grow 撑满可视区但永不收缩 (flex-1 会让长正文画到引用块上)', () => {
    renderWithClient(<ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />)
    const editorBlock = screen.getByTestId('compose-editor-block')
    expectCannotOverlapSiblings(editorBlock, '正文块')
    // grow: 正文短时仍撑满可视区 (手感不回退到"编辑区缩在顶上一小条")。
    expect(editorBlock.className).toMatch(/(^|\s)grow(\s|$)/)
  })

  test('正文块自身不再是滚动容器 (滚动权归 compose-scroll-owner 单一所有者)', () => {
    renderWithClient(<ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />)
    expect(screen.getByTestId('compose-editor-block').className).not.toContain('overflow-y-auto')
    expect(screen.getByTestId('compose-scroll-owner').className).toContain('overflow-y-auto')
  })
})
