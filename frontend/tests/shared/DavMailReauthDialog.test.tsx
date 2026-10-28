// @vitest-environment happy-dom

// DavMail 重新认证弹窗的接线测试（task 10-28-davmail-self-reauth 批次 4）。
//
// 钉住只有真渲染才会暴露的几件事：
//   ① start 只在点「打开登录页」时调用（打开弹窗不白建会话），拿到链接后交给系统浏览器；
//   ② 「完成认证」的可点态：没会话 / 粗判不像回调 → 不可点；
//   ③ start 失败（409）把后端 message 原样展示；
//   ④ complete 成功 → 成功文案 + 刷新 davmail 健康查询；
//   ⑤ 会话失效（stage=session）/ 授权码过期（AADSTS70008）→ 突出「重新获取链接」；
//   ⑥ 🔴 倒计时到期 → 禁用提交（后端那边会话也到期了，交了只会白等一次失败）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '../../src/shared/i18n'
import { useDavMailReauthStore } from '../../src/shared/state/davmail-reauth'
import { formatRemaining, looksLikeCallback } from '../../src/shared/components/davmail/reauthUi'

await i18n.changeLanguage('zh-CN')

const hoisted = vi.hoisted(() => ({
  startReauth: vi.fn(),
  completeReauth: vi.fn()
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    davmail: { startReauth: hoisted.startReauth, completeReauth: hoisted.completeReauth }
  })
}))

const { DavMailReauthDialog } =
  await import('../../src/shared/components/davmail/DavMailReauthDialog')

const AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/authorize?client_id=x'
const CALLBACK = 'urn:ietf:wg:oauth:2.0:oob?code=0.AAAA-fake-code'
const T0 = new Date(2026, 9, 28, 15, 0, 0).getTime()

/** 会话有效期从调用 start 的那一刻起算 10 分钟（与后端一致）。 */
function sessionFromNow(): { session_id: string; authorize_url: string; expires_at: number } {
  return { session_id: 'sess-1', authorize_url: AUTH_URL, expires_at: Date.now() / 1000 + 600 }
}

let client: QueryClient
let openSpy: ReturnType<typeof vi.fn>

function renderDialog(): void {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <DavMailReauthDialog />
    </QueryClientProvider>
  )
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '完成认证' }) as HTMLButtonElement
}

function refreshButton(): HTMLElement {
  return screen.getByRole('button', { name: '重新获取链接' })
}

async function startSession(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: '在浏览器中打开登录页' }))
  await screen.findByRole('button', { name: '再次打开登录页' })
}

function paste(text: string): void {
  fireEvent.change(screen.getByLabelText('回调地址'), { target: { value: text } })
}

beforeEach(() => {
  hoisted.startReauth.mockReset().mockImplementation(async () => sessionFromNow())
  hoisted.completeReauth.mockReset()
  openSpy = vi.fn()
  window.open = openSpy as unknown as typeof window.open
  useDavMailReauthStore.setState({ open: true })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useDavMailReauthStore.setState({ open: false })
})

describe('DavMailReauthDialog — 获取链接', () => {
  test('打开弹窗不调 start；点按钮才调，并在浏览器打开授权链接', async () => {
    renderDialog()
    expect(hoisted.startReauth).not.toHaveBeenCalled()
    expect(submitButton().disabled).toBe(true)

    await startSession()

    expect(hoisted.startReauth).toHaveBeenCalledTimes(1)
    expect(openSpy).toHaveBeenCalledWith(AUTH_URL, '_blank', 'noopener')
    expect(screen.getByText('链接剩余有效期 10:00')).toBeTruthy()
  })

  test('start 失败（409）→ 原样展示后端 message，不进入会话态', async () => {
    hoisted.startReauth.mockRejectedValue(
      Object.assign(new Error('当前不是 DavMail 后端，无需重新认证'), {
        code: 'E_INVALID_STATE'
      })
    )
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '在浏览器中打开登录页' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('当前不是 DavMail 后端，无需重新认证')
    expect(screen.queryByRole('button', { name: '再次打开登录页' })).toBeNull()
    expect(submitButton().disabled).toBe(true)
  })
})

describe('DavMailReauthDialog — 提交', () => {
  test('粗判：空 / 带空格的短句不可点，含 code= 或长 token 可点', async () => {
    renderDialog()
    await startSession()

    expect(submitButton().disabled).toBe(true)
    paste('   ')
    expect(submitButton().disabled).toBe(true)
    paste('hello world')
    expect(submitButton().disabled).toBe(true)
    paste(`  ${CALLBACK}\n`)
    expect(submitButton().disabled).toBe(false)
  })

  test('成功 → 成功文案 + 刷新 davmail 健康查询；原文照传给后端', async () => {
    hoisted.completeReauth.mockResolvedValue({
      ok: true,
      stage: 'done',
      code: 'OK',
      message: '认证成功'
    })
    renderDialog()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    await startSession()
    paste(CALLBACK)
    fireEvent.click(submitButton())

    expect(await screen.findByText('已恢复，邮件同步会自动继续。')).toBeTruthy()
    expect(hoisted.completeReauth).toHaveBeenCalledWith('sess-1', CALLBACK)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'davmailHealth'] })
  })

  test('普通失败 → 展示 message，「重新获取链接」不突出、仍可再交', async () => {
    hoisted.completeReauth.mockResolvedValue({
      ok: false,
      stage: 'parse',
      code: 'E_PARSE',
      message: '没有在粘贴内容里找到授权码'
    })
    renderDialog()
    await startSession()
    paste(CALLBACK)
    fireEvent.click(submitButton())

    expect((await screen.findByRole('alert')).textContent).toContain('没有在粘贴内容里找到授权码')
    expect(refreshButton().getAttribute('data-emphasis')).toBeNull()
    expect(submitButton().disabled).toBe(false)
  })

  test('授权码过期（AADSTS70008）→ 突出「重新获取链接」', async () => {
    hoisted.completeReauth.mockResolvedValue({
      ok: false,
      stage: 'exchange',
      code: 'AADSTS70008',
      message: '授权码已过期，请重新获取链接'
    })
    renderDialog()
    await startSession()
    paste(CALLBACK)
    fireEvent.click(submitButton())

    await screen.findByRole('alert')
    expect(refreshButton().getAttribute('data-emphasis')).toBe('primary')
  })

  test('会话失效（stage=session）→ 突出「重新获取链接」并禁用提交；重新获取会再调 start', async () => {
    hoisted.completeReauth.mockResolvedValue({
      ok: false,
      stage: 'session',
      code: 'E_SESSION',
      message: '登录会话已过期，请重新获取链接'
    })
    renderDialog()
    await startSession()
    paste(CALLBACK)
    fireEvent.click(submitButton())

    await screen.findByRole('alert')
    expect(refreshButton().getAttribute('data-emphasis')).toBe('primary')
    expect(submitButton().disabled).toBe(true)

    fireEvent.click(refreshButton())
    await waitFor(() => expect(hoisted.startReauth).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  test('并发第二个请求被拒（409 抛错）→ 显示提交失败', async () => {
    hoisted.completeReauth.mockRejectedValue(new Error('已有认证请求在处理中'))
    renderDialog()
    await startSession()
    paste(CALLBACK)
    fireEvent.click(submitButton())

    expect((await screen.findByRole('alert')).textContent).toContain('已有认证请求在处理中')
  })
})

describe('DavMailReauthDialog — 倒计时', () => {
  test('到期 → 禁用提交，提示过期并突出「重新获取链接」', async () => {
    // 🔴 假计时器只在这一条里开，且不能用 findBy：waitFor 的轮询走 setInterval，被假掉后只剩
    // MutationObserver 一条重试路径，会偶发超时。这里改为手动冲刷 start 的 promise。
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    vi.setSystemTime(T0)
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: '在浏览器中打开登录页' }))
    await act(async () => {})
    expect(screen.getByText('链接剩余有效期 10:00')).toBeTruthy()
    paste(CALLBACK)
    expect(submitButton().disabled).toBe(false)

    act(() => {
      vi.advanceTimersByTime(599_000)
    })
    expect(screen.getByText('链接剩余有效期 0:01')).toBeTruthy()
    expect(submitButton().disabled).toBe(false)

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByText('链接已过期，请重新获取')).toBeTruthy()
    expect(submitButton().disabled).toBe(true)
    expect(refreshButton().getAttribute('data-emphasis')).toBe('primary')
  })
})

describe('reauthUi 纯函数', () => {
  test('looksLikeCallback 四种合法输入 + 非法输入', () => {
    expect(looksLikeCallback('urn:ietf:wg:oauth:2.0:oob?code=abc')).toBe(true)
    expect(
      looksLikeCallback('https://login.microsoftonline.com/common/oauth2/nativeclient?code=abc')
    ).toBe(true)
    expect(looksLikeCallback('0.AAAAxxxxxxxxxxxxxxxxxxxxxxxx')).toBe(true)
    expect(looksLikeCallback('\n  urn:ietf:wg:oauth:2.0:oob?code=abc  \n')).toBe(true)
    expect(looksLikeCallback('')).toBe(false)
    expect(looksLikeCallback('short')).toBe(false)
    expect(looksLikeCallback('this is a sentence that is long enough')).toBe(false)
  })

  test('formatRemaining 取整到秒、不出负数', () => {
    expect(formatRemaining(600_000)).toBe('10:00')
    expect(formatRemaining(61_500)).toBe('1:02')
    expect(formatRemaining(-5)).toBe('0:00')
  })
})
