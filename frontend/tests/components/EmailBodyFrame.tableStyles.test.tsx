// @vitest-environment happy-dom
//
// 回归闸：HTML 邮件正文里的表格样式（0903 owner 反馈，例邮件 internal_id 1000015057）。
//
// 病根两条，都是我们自己的样式压过了作者的排版：
//   H1 `table td, table th { border: 1px solid ... }` 无差别描框 —— HTML 邮件几乎全部
//      用表格排版（role="presentation" / border="0" / 嵌套若干层），于是每一层布局表格
//      的每一格都画出了框，正文满屏莫名其妙的方框（同一封在 Outlook 里是干净的）。
//   H2 `table { width: auto !important }` 把作者写的宽度全部作废 —— 新闻信的骨架是
//      「固定 600px 居中 + 多层嵌套」，宽度一废嵌套就塌，正文被挤成中间一窄条。
//
// 本文件钉两件事：
//   ① 后处理只给「作者自己声明了边框」的数据表格打 .mailagent-table-bordered，
//      布局表格（含 style 里写了 border-collapse / border-spacing / border-radius 的）
//      一律不打 —— 子串匹配 border 会让原 bug 原样复发。
//   ② BODY_CSS 里不再有 width:auto !important，也不再有无条件的 td/th 边框；
//      max-width:100%（防撑破详情列）与横向滚动容器保留。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockBody } = vi.hoisted(() => ({ mockBody: vi.fn() }))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    email: { body: mockBody },
    attachment: { readDataUrl: vi.fn() }
  })
}))

import i18n from '@shared/i18n'
import { EmailBodyFrame } from '../../src/shared/components/email/EmailBodyFrame'

await i18n.changeLanguage('zh-CN')

function renderFrame(): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailBodyFrame internalId={101} attachments={[]} />
    </QueryClientProvider>
  )
}

/** 渲染 + 把 `html` 当作 iframe 已 load 完的文档交给后处理，返回该文档。 */
async function settledDoc(html: string): Promise<Document> {
  const { container } = renderFrame()
  const iframe = (await waitFor(() => {
    const el = container.querySelector('iframe')
    if (!el) throw new Error('iframe not mounted yet')
    return el
  })) as HTMLIFrameElement
  const doc = iframe.contentDocument
  if (!doc?.body) throw new Error('iframe has no contentDocument')
  doc.body.innerHTML = html
  act(() => {
    iframe.dispatchEvent(new Event('load'))
  })
  return doc
}

function bordered(doc: Document, selector: string): boolean {
  const el = doc.querySelector(selector)
  if (!el) throw new Error(`fixture missing: ${selector}`)
  return el.classList.contains('mailagent-table-bordered')
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBody.mockResolvedValue({
    internal_id: 101,
    format: 'html',
    content: '<p>body</p>',
    size_bytes: 100,
    truncated: false,
    fetched_at: 1,
    fetched_source: 'davmail'
  })
})

afterEach(() => {
  cleanup()
})

describe('EmailBodyFrame — 表格边框判定', () => {
  test('排版表格不被标记（含 border-collapse / border-spacing / border-radius 的 style）', async () => {
    const doc = await settledDoc(`
      <table id="outer" role="presentation" border="0" cellspacing="0"
             style="border-collapse:collapse;border-spacing:0">
        <tbody><tr><td style="padding:0;border-radius:6px">
          <table id="inner" width="600" style="border-collapse:collapse">
            <tbody><tr><td>hi</td></tr></tbody>
          </table>
        </td></tr></tbody>
      </table>`)

    expect(bordered(doc, '#outer')).toBe(false)
    expect(bordered(doc, '#inner')).toBe(false)
    // 后处理确实跑过（否则上面两条会因「什么都没做」而假绿）
    expect(doc.querySelector('#outer')?.parentElement?.className).toBe('mailagent-table-scroll')
  })

  test('border 属性非 0 的数据表格被标记，border="0" 不被标记', async () => {
    const doc = await settledDoc(`
      <table id="data" border="1"><tbody><tr><td>a</td><td>b</td></tr></tbody></table>
      <table id="layout" border="0"><tbody><tr><td>a</td></tr></tbody></table>`)

    expect(bordered(doc, '#data')).toBe(true)
    expect(bordered(doc, '#layout')).toBe(false)
  })

  test('作者 inline border 声明被认，border:0 / border:none 不被认', async () => {
    const doc = await settledDoc(`
      <table id="tbl-border" style="border:1px solid #ccc"><tbody><tr><td>a</td></tr></tbody></table>
      <table id="tbl-zero" style="border:0;border-collapse:collapse"><tbody><tr><td>a</td></tr></tbody></table>
      <table id="tbl-none" style="border:1px none #ccc"><tbody><tr><td>a</td></tr></tbody></table>
      <table id="cell-border"><tbody><tr>
        <td style="padding:4px;border-bottom:1px solid #ddd">a</td>
      </tr></tbody></table>`)

    expect(bordered(doc, '#tbl-border')).toBe(true)
    expect(bordered(doc, '#tbl-zero')).toBe(false)
    expect(bordered(doc, '#tbl-none')).toBe(false)
    expect(bordered(doc, '#cell-border')).toBe(true)
  })

  test('嵌套布局表不因外层数据表而被标记', async () => {
    const doc = await settledDoc(`
      <table id="data" border="1"><tbody><tr><td>
        <table id="nested" role="presentation"><tbody><tr><td>x</td></tr></tbody></table>
      </td></tr></tbody></table>`)

    expect(bordered(doc, '#data')).toBe(true)
    expect(bordered(doc, '#nested')).toBe(false)
  })
})

describe('EmailBodyFrame — BODY_CSS 表格宽度与边框', () => {
  async function srcDocCss(): Promise<string> {
    const { container } = renderFrame()
    const iframe = (await waitFor(() => {
      const el = container.querySelector('iframe')
      if (!el) throw new Error('iframe not mounted yet')
      return el
    })) as HTMLIFrameElement
    return iframe.getAttribute('srcdoc') ?? ''
  }

  test('不再强制 width:auto，保留 max-width:100% 与横向滚动容器', async () => {
    const css = await srcDocCss()

    // 作者写的固定宽度（600px 新闻信）必须生效 —— 强制 auto 会把嵌套层级压塌。
    expect(css).not.toContain('width: auto !important')
    // 上限仍在：超宽表格不撑破详情列，压不下去的由滚动容器兜底。
    expect(css).toContain('max-width: 100% !important')
    expect(css).toContain('.mailagent-table-scroll { max-width: 100%; overflow-x: auto;')
  })

  test('td/th 无条件规则里没有边框，边框只挂在 .mailagent-table-bordered 上', async () => {
    const css = await srcDocCss()

    const unconditional = /table td, table th \{[^}]*\}/.exec(css)?.[0] ?? ''
    expect(unconditional).not.toBe('')
    expect(unconditional).not.toMatch(/border\s*:/)
    // padding 等可读性样式仍然无差别保留
    expect(unconditional).toContain('padding: 6px 10px')
    expect(css).toContain('table.mailagent-table-bordered > tbody > tr > td')
  })
})
