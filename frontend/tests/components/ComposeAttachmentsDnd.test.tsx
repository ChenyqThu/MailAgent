// @vitest-environment happy-dom
//
// L0 compose 拖拽附件 — ComposePanelInner mode='new' (无预填 query, 附件面最小外壳):
//   - drop 文件 → 复用 handleFilesSelected 管线 (uploadComposeAttachment → chip)
//   - drop 超 20MB → 前端先拦, 不上传
//   - 纯文本拖拽 (types 不含 'Files') → 不激活提示层、不上传 (TipTap 原生行为不被抢)
//   - dragEnter (含 Files) → 提示层出现; dragDepth 计数抗子元素抖动; leave 归零/drop 后消失

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockSend, mockSettingsGet, mockUpload, mockToastError } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockSettingsGet: vi.fn(),
  mockUpload: vi.fn(),
  mockToastError: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { send: mockSend, uploadComposeAttachment: mockUpload },
    settings: { get: mockSettingsGet }
  })
}))

vi.mock('@shared/state/toast', () => ({
  toastError: mockToastError,
  toastSuccess: vi.fn()
}))

vi.mock('../../src/shared/components/email/EmailBodyFrame', () => ({
  EmailBodyFrame: () => null
}))

import i18n from '@shared/i18n'
import { ComposePanelInner } from '../../src/shared/components/email/compose/ComposePanel'
import { COMPOSE_INLINE_IMAGE_DROP_FLAG } from '../../src/shared/components/email/compose/editor-extensions'

await i18n.changeLanguage('zh-CN')

const DROP_HINT = '松开以添加附件'

function renderPanel(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <ComposePanelInner internalId={-1} mode="new" onClose={() => {}} />
    </QueryClientProvider>
  )
  return screen.getByRole('main')
}

function makeFile(name: string, bytes: number[], type = 'application/pdf'): File {
  return new File([new Uint8Array(bytes)], name, { type })
}

/** happy-dom 下真造 21MB Blob 慢; 用小文件 + 实例级 size 覆写模拟超限。 */
function makeOversizeFile(name: string): File {
  const f = makeFile(name, [1])
  Object.defineProperty(f, 'size', { value: 21 * 1024 * 1024 })
  return f
}

/** fireEvent 的 dataTransfer 以自有属性挂在原生事件上, React 合成事件原样透传。 */
function dt(files: File[], types: string[]): { files: File[]; types: string[] } {
  return { files, types }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSettingsGet.mockResolvedValue({ userEmail: 'me@acme.com', signature: null })
  mockSend.mockResolvedValue({ sent: true })
  mockUpload.mockResolvedValue({
    stage_id: 'st-1',
    filename: 'report.pdf',
    size: 3,
    mime: 'application/pdf'
  })
})

afterEach(() => cleanup())

describe('ComposePanel — L0 拖拽附件 (mode=new)', () => {
  test('拖入文件 → 走既有上传管线 → chip 展示, 提示层随 drop 消失', async () => {
    const zone = renderPanel()
    fireEvent.dragEnter(zone, { dataTransfer: dt([], ['Files']) })
    expect(screen.getByText(DROP_HINT)).toBeTruthy()
    fireEvent.drop(zone, { dataTransfer: dt([makeFile('report.pdf', [1, 2, 3])], ['Files']) })
    // drop 后提示层立刻消失
    expect(screen.queryByText(DROP_HINT)).toBeNull()
    await waitFor(() =>
      expect(mockUpload).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'report.pdf', mime: 'application/pdf' })
      )
    )
    // bytes 与 file input 路径同源 (File → ArrayBuffer)
    const arg = mockUpload.mock.calls[0][0]
    expect(new Uint8Array(arg.bytes)).toEqual(new Uint8Array([1, 2, 3]))
    await waitFor(() => expect(screen.getByText('report.pdf')).toBeTruthy())
    expect(screen.getByLabelText('移除 report.pdf')).toBeTruthy()
  })

  test('拖入超 20MB → 复用前端体积拦截: 不上传、无 chip、报错 toast', async () => {
    const zone = renderPanel()
    fireEvent.drop(zone, { dataTransfer: dt([makeOversizeFile('huge.zip')], ['Files']) })
    await new Promise((r) => setTimeout(r, 20))
    expect(mockUpload).not.toHaveBeenCalled()
    expect(mockToastError).toHaveBeenCalled()
    expect(screen.queryByText('huge.zip')).toBeNull()
  })

  test('纯文本拖拽 (types 不含 Files) → 不激活提示层、不加附件', async () => {
    const zone = renderPanel()
    fireEvent.dragEnter(zone, { dataTransfer: dt([], ['text/plain']) })
    expect(screen.queryByText(DROP_HINT)).toBeNull()
    fireEvent.drop(zone, { dataTransfer: dt([], ['text/plain']) })
    await new Promise((r) => setTimeout(r, 20))
    expect(mockUpload).not.toHaveBeenCalled()
  })

  test('composeInlineImage 已消费的 drop（事件带标记）→ 收尾提示层但不进附件链', async () => {
    // 图片拖进正文时编辑器插件先内联插入并在原生事件上打标记（同一事件对象冒泡
    // 到 <main>）；面板只清掉提示层，不再把同一文件当附件重复添加。
    const zone = renderPanel()
    fireEvent.dragEnter(zone, { dataTransfer: dt([], ['Files']) })
    expect(screen.getByText(DROP_HINT)).toBeTruthy()
    const dropEvent = createEvent.drop(zone, {
      dataTransfer: dt([makeFile('pic.png', [1, 2, 3], 'image/png')], ['Files'])
    })
    ;(dropEvent as unknown as Record<string, unknown>)[COMPOSE_INLINE_IMAGE_DROP_FLAG] = true
    fireEvent(zone, dropEvent)
    expect(screen.queryByText(DROP_HINT)).toBeNull()
    await new Promise((r) => setTimeout(r, 20))
    expect(mockUpload).not.toHaveBeenCalled()
  })

  test('激活态生命周期: dragDepth 计数抗子元素抖动, leave 归零才消失', () => {
    const zone = renderPanel()
    fireEvent.dragEnter(zone, { dataTransfer: dt([], ['Files']) })
    expect(screen.getByText(DROP_HINT)).toBeTruthy()
    // 掠过子元素: enter(depth=2) + leave(depth=1) → 仍激活 (不抖)
    fireEvent.dragEnter(zone, { dataTransfer: dt([], ['Files']) })
    fireEvent.dragLeave(zone)
    expect(screen.getByText(DROP_HINT)).toBeTruthy()
    // 归零 → 消失
    fireEvent.dragLeave(zone)
    expect(screen.queryByText(DROP_HINT)).toBeNull()
  })
})
