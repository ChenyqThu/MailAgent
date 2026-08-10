// @vitest-environment happy-dom
//
// 回归闸：iframe 文档「换代」后译文必须被重新注入。
//
// 病根（2026-08-10 owner 报「翻译了的邮件按钮亮着但不显示译文，关一次再开才出来」）：
// BodyIframe 曾用 boolean `docReady` 当注入门。文档就绪会发生**两次** ——
//   ① 挂载时 iframe 的 contentDocument 还是 about:blank（真实 Chromium 下它的
//      readyState 就是 'complete'，于是 setupObservers() 当场同步跑一遍）；
//   ② srcDoc 真正 load 完之后再跑一遍。
// 第 ① 次已经把 docReady 置 true，第 ② 次再置 true 值不变 ⇒ 不产生重渲染 ⇒ 注入
// effect 收不到「文档换了」的信号。它在第 ① 次时对着空的 about:blank 注入（0 命中），
// 第 ② 次真文档到位后再没人补注入 —— 于是按钮亮着、正文没译文。手动 toggle 让
// translations 走 segments→null→segments，依赖真变了才重跑，所以「关一次再开就好」。
//
// 本测试不依赖 readyState 的环境差异（happy-dom 给的是 'interactive'），而是直接
// 模拟那两次文档就绪，把失效模式本身钉住：第二次就绪后译文必须在。
//
// 修复 = boolean 门换成单调递增的 docGeneration 计数（批处理吞不掉）。

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
import type { TranslationSegment } from '../../src/shared/api/types'

await i18n.changeLanguage('zh-CN')

const SEGMENTS: TranslationSegment[] = [{ src: 'Hello world paragraph.', tgt: '你好，世界段落。' }]
const REAL_BODY = '<p>Hello world paragraph.</p>'

function renderFrame(translations: TranslationSegment[] | null): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailBodyFrame internalId={101} attachments={[]} translations={translations} />
    </QueryClientProvider>
  )
}

function injectedCount(iframe: HTMLIFrameElement): number {
  return iframe.contentDocument?.querySelectorAll('.mailagent-translation').length ?? 0
}

/** 模拟一次「文档就绪」：先把 contentDocument 换成给定内容，再发 load。 */
function settleDocument(iframe: HTMLIFrameElement, html: string): void {
  const doc = iframe.contentDocument
  if (!doc?.body) throw new Error('iframe has no contentDocument')
  doc.body.innerHTML = html
  act(() => {
    iframe.dispatchEvent(new Event('load'))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockBody.mockResolvedValue({
    internal_id: 101,
    format: 'html',
    content: REAL_BODY,
    size_bytes: 100,
    truncated: false,
    fetched_at: 1,
    fetched_source: 'davmail'
  })
})

afterEach(() => {
  cleanup()
})

describe('EmailBodyFrame — 译文注入跨文档换代', () => {
  test('第二次文档就绪后重新注入（挂载时的空 about:blank 不能把门焊死）', async () => {
    const { container } = renderFrame(SEGMENTS)

    const iframe = (await waitFor(() => {
      const el = container.querySelector('iframe')
      if (!el) throw new Error('iframe not mounted yet')
      return el
    })) as HTMLIFrameElement

    // ① 第一次就绪 —— 空文档（真实浏览器里就是 about:blank）。注入必然 0 命中。
    settleDocument(iframe, '')
    expect(injectedCount(iframe)).toBe(0)

    // ② 第二次就绪 —— srcDoc 真正 load 完。这一次必须补上注入。
    settleDocument(iframe, REAL_BODY)

    await waitFor(() => {
      expect(injectedCount(iframe)).toBe(1)
    })
    expect(iframe.contentDocument?.querySelector('.mailagent-translation')?.textContent).toBe(
      '你好，世界段落。'
    )
  })

  test('translations=null 时文档换代不会凭空注入', async () => {
    const { container } = renderFrame(null)

    const iframe = (await waitFor(() => {
      const el = container.querySelector('iframe')
      if (!el) throw new Error('iframe not mounted yet')
      return el
    })) as HTMLIFrameElement

    settleDocument(iframe, '')
    settleDocument(iframe, REAL_BODY)

    expect(injectedCount(iframe)).toBe(0)
  })
})
