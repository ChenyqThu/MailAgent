// @vitest-environment happy-dom
//
// H3b — 远程图片提示条 / 占位 / 放行的组件级行为。改写规则本身在
// tests/shared/emailRemoteImages.test.ts 单测；这里只验它在 EmailBodyFrame 里被正确接线：
// 提示条只在真有被拦图片时出现、点一下换到放行票才放行、放行作用域是"这封邮件"。
//
// 🔴 「点一下就放行」在 0903 返工批 B2 后不再成立：点击要先用一次**已鉴权**的
// POST /email/remote-image/grant 换签名，换不到就仍是拦截态。故这里 stub 掉 fetch
// （不 mock http_client —— 让 envelope unwrap 走真实现）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const PROXY = 'http://127.0.0.1:8200/api/email/remote-image'
const EXP = 4102444800

/** 记录 grant 请求；按 body 里的 urls 原样签发假票（后端真验签由 pytest 覆盖）。 */
const grantCalls: string[][] = []

function stubGrantFetch(mode: 'ok' | 'fail' | 'empty' | 'partial' = 'ok'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const urls = (JSON.parse(String(init?.body ?? '{}')) as { urls?: string[] }).urls ?? []
      grantCalls.push(urls)
      if (mode === 'fail') return new Response('', { status: 502 })
      // 'partial' = 后端只签出一部分（脏 URL 静默不签 / 超过签发上限被截断）。
      const signable = mode === 'partial' ? urls.slice(0, 1) : urls
      const grants = mode === 'empty' ? [] : signable.map((url) => ({ url, exp: EXP, sig: 'sig1' }))
      return new Response(JSON.stringify({ status: 'success', data: { grants }, meta: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
}

function proxied(url: string): string {
  return `${PROXY}?url=${encodeURIComponent(url)}&exp=${EXP}&sig=sig1`
}

function bodyWith(content: string) {
  return {
    internal_id: 101,
    format: 'html' as const,
    content,
    size_bytes: content.length,
    truncated: false,
    fetched_at: 1,
    fetched_source: 'davmail'
  }
}

function renderFrame(internalId = 101): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } }
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <EmailBodyFrame internalId={internalId} attachments={[]} />
    </QueryClientProvider>
  )
}

function srcdoc(container: HTMLElement): string {
  return container.querySelector('iframe')?.getAttribute('srcdoc') ?? ''
}

/** 解析 srcdoc 取正文里的第一个 <img>。按属性断言，不比字符串 —— `data-mailagent-remote-src="…"`
 *  自带 `src="…"` 子串，朴素的 toContain/not.toContain 会给出反向的假结论。 */
function bodyImg(container: HTMLElement): HTMLImageElement | null {
  const doc = new DOMParser().parseFromString(srcdoc(container), 'text/html')
  return doc.body.querySelector('img')
}

beforeEach(() => {
  vi.clearAllMocks()
  grantCalls.length = 0
  stubGrantFetch('ok')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('EmailBodyFrame — 远程图片', () => {
  test('默认拦截：提示条出现，正文里是占位而非原始远程 URL', async () => {
    mockBody.mockResolvedValue(
      bodyWith('<p>hi</p><img src="https://tracker.example/px.gif" width="600" height="200">')
    )
    const { container } = renderFrame()

    expect(await screen.findByText('为保护隐私，已拦截 1 张远程图片。')).toBeTruthy()
    const img = bodyImg(container)
    // 原始远程地址不作为可加载的 src 出现（只留在 inert 的 data 属性里）。
    expect(img?.hasAttribute('src')).toBe(false)
    expect(img?.getAttribute('data-mailagent-remote-src')).toBe('https://tracker.example/px.gif')
    expect(img?.classList.contains('mailagent-remote-image')).toBe(true)
    // 尺寸推导写进变量 → 占位不塌版式。
    expect(img?.style.getPropertyValue('--ma-remote-w').trim()).toBe('600px')
    expect(img?.style.getPropertyValue('--ma-remote-h').trim()).toBe('200px')
  })

  test('点「加载图片」后换到放行票，提示条消失，img 改写成带签名的代理 URL', async () => {
    mockBody.mockResolvedValue(bodyWith('<img src="https://cdn.example/hero.png">'))
    const { container } = renderFrame()

    fireEvent.click(await screen.findByRole('button', { name: '加载图片' }))

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '加载图片' })).toBeNull()
    })
    // 换票请求带的是这封信里扫出来的远程 URL 清单。
    expect(grantCalls).toEqual([['https://cdn.example/hero.png']])
    const img = bodyImg(container)
    expect(img?.getAttribute('src')).toBe(proxied('https://cdn.example/hero.png'))
    expect(img?.classList.contains('mailagent-remote-image')).toBe(false)
    expect(img?.hasAttribute('data-mailagent-remote-src')).toBe(false)
  })

  test('🔴 换票失败时不放行：正文仍是占位，提示条换成失败文案', async () => {
    stubGrantFetch('fail')
    mockBody.mockResolvedValue(bodyWith('<img src="https://cdn.example/hero.png">'))
    const { container } = renderFrame()

    fireEvent.click(await screen.findByRole('button', { name: '加载图片' }))

    expect(await screen.findByText('这次没能加载远程图片，请再试一次。')).toBeTruthy()
    const img = bodyImg(container)
    expect(img?.hasAttribute('src')).toBe(false)
    expect(img?.classList.contains('mailagent-remote-image')).toBe(true)
  })

  test('🔴 后端一张票都没签出来时同样不放行（fail-closed）', async () => {
    stubGrantFetch('empty')
    mockBody.mockResolvedValue(bodyWith('<img src="https://cdn.example/hero.png">'))
    const { container } = renderFrame()

    fireEvent.click(await screen.findByRole('button', { name: '加载图片' }))

    expect(await screen.findByText('这次没能加载远程图片，请再试一次。')).toBeTruthy()
    expect(bodyImg(container)?.hasAttribute('src')).toBe(false)
  })

  test('🔴 只签出一部分时：签到的显示，没签到的说清「还有 N 张没能加载」', async () => {
    // 后端对签不了的 URL 静默不签、超过签发上限的丢掉（都不整批失败）—— 那几张仍是占位，
    // 不说清楚就像个 bug。
    stubGrantFetch('partial')
    mockBody.mockResolvedValue(
      bodyWith('<img src="https://cdn.example/a.png"><img src="https://cdn.example/b.png">')
    )
    const { container } = renderFrame()

    fireEvent.click(await screen.findByRole('button', { name: '加载图片' }))

    expect(await screen.findByText('还有 1 张远程图片没能加载。')).toBeTruthy()
    const doc = new DOMParser().parseFromString(srcdoc(container), 'text/html')
    const imgs = doc.body.querySelectorAll('img')
    expect(imgs[0]?.getAttribute('src')).toBe(proxied('https://cdn.example/a.png'))
    // 没换到票的那张 fail-closed：仍是占位，不会裸着发出去。
    expect(imgs[1]?.hasAttribute('src')).toBe(false)
    expect(imgs[1]?.classList.contains('mailagent-remote-image')).toBe(true)
  })

  test('全部签出时不出「还有 N 张没能加载」', async () => {
    mockBody.mockResolvedValue(bodyWith('<img src="https://cdn.example/a.png">'))
    renderFrame()

    fireEvent.click(await screen.findByRole('button', { name: '加载图片' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: '加载图片' })).toBeNull())
    expect(screen.queryByText(/没能加载/)).toBeNull()
  })

  test('🔴 正文里硬编码指向本机代理的 URL：零点击时不发请求、计入提示条', async () => {
    // 复核实测出的零点击追踪链路：CSP 放行了 127.0.0.1，主进程又对该端口无条件注入本地
    // token ⇒ 只要这条 URL 留在 srcDoc 里，打开邮件的瞬间就出网了。
    const evil = `${PROXY}?url=${encodeURIComponent('https://tracker.example/p.png?rcpt=UID')}`
    mockBody.mockResolvedValue(
      bodyWith(`<img srcset="${evil}"><table><tr><td background="${evil}">x</td></tr></table>`)
    )
    const { container } = renderFrame()

    expect(await screen.findByText('为保护隐私，已拦截 2 张远程图片。')).toBeTruthy()
    // srcDoc 里一条可加载的代理引用都不剩（data 属性里的 inert 备份不算）。
    const doc = new DOMParser().parseFromString(srcdoc(container), 'text/html')
    expect(doc.body.querySelector('[srcset]')).toBeNull()
    expect(doc.body.querySelector('[background]')).toBeNull()
    // 没点之前一个换票请求都没发过。
    expect(grantCalls).toEqual([])
  })

  test('🔴 cid: 内联图片不算远程 —— 不出提示条、正文一个字不动', async () => {
    mockBody.mockResolvedValue(bodyWith('<img src="cid:image001.png@01D9ABCD">'))
    const { container } = renderFrame()

    await waitFor(() => expect(srcdoc(container)).toContain('cid:image001.png@01D9ABCD'))
    expect(screen.queryByRole('button', { name: '加载图片' })).toBeNull()
  })

  test('纯文本邮件不出提示条', async () => {
    mockBody.mockResolvedValue(bodyWith('<p>没有图片的邮件</p>'))
    renderFrame()

    await waitFor(() => expect(mockBody).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: '加载图片' })).toBeNull()
  })

  test('放行作用域是这封邮件：换邮件回到默认拦截', async () => {
    mockBody.mockResolvedValue(bodyWith('<img src="https://cdn.example/hero.png">'))
    const { rerender } = renderFrame(101)

    fireEvent.click(await screen.findByRole('button', { name: '加载图片' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '加载图片' })).toBeNull())

    // 同一个组件实例换 internalId（EmailBodyFrame 本体不随换邮件重挂载）。
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } }
    })
    rerender(
      <QueryClientProvider client={queryClient}>
        <EmailBodyFrame internalId={202} attachments={[]} />
      </QueryClientProvider>
    )

    expect(await screen.findByRole('button', { name: '加载图片' })).toBeTruthy()
  })
})
