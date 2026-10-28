// @vitest-environment happy-dom
//
// 看板 DavMail 卡片的登录到期格（task 10-28-davmail-self-reauth 批次 4）。
//
// 到期判据从「token.dat 多少天没刷新」换成「最近一次交互认证 + 登录有效期」：token.dat 每小时
// 随 refresh 重写，老判据永远不会触发。这里钉住 auth_days_left 的三档 + 未记录，以及认证异常时
// 「重新认证」按钮被提成主色、点击打开全局弹窗。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { DavMailHealthData } from '@shared/api/types'

const davmailHealthMock = vi.fn<() => Promise<DavMailHealthData>>()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ admin: { davmailHealth: davmailHealthMock } })
}))

import i18n from '@shared/i18n'
import { DavMailHealthCard } from '../../src/shared/components/admin/DavMailHealthCard'
import { useDavMailReauthStore } from '@shared/state/davmail-reauth'

await i18n.changeLanguage('zh-CN')

function health(overrides: Partial<DavMailHealthData>): DavMailHealthData {
  return {
    enabled: true,
    level: 'ok',
    last_probe_at: null,
    imap_reachable: true,
    smtp_reachable: true,
    consecutive_imap_failures: 0,
    consecutive_smtp_failures: 0,
    token_age_days: 0.01,
    token_mtime_iso: null,
    auth_expires_at: null,
    auth_days_left: null,
    throttle_events_5min: 0,
    last_oauth_error: null,
    last_oauth_error_at: null,
    uid_backfill_paused: false,
    ...overrides
  }
}

async function renderCard(data: DavMailHealthData): Promise<HTMLElement> {
  davmailHealthMock.mockResolvedValue(data)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DavMailHealthCard />
    </QueryClientProvider>
  )
  return screen.findByTestId('davmail-auth-expiry')
}

function reauthButton(): HTMLElement {
  return screen.getByRole('button', { name: '重新认证' })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useDavMailReauthStore.setState({ open: false })
})

describe('DavMailHealthCard — 登录到期格', () => {
  test('充裕（> 3 天）→ 约 N 天，正常色，按钮不突出', async () => {
    const cell = await renderCard(health({ auth_days_left: 26.6 }))
    expect(cell.textContent).toBe('登录约 26 天后过期')
    expect(cell.className).toContain('text-ok')
    expect(reauthButton().getAttribute('data-emphasis')).toBeNull()
  })

  test('≤ 3 天 → warning 色 + 按钮突出', async () => {
    const cell = await renderCard(health({ level: 'warning', auth_days_left: 2.8 }))
    expect(cell.textContent).toBe('登录约 2 天后过期')
    expect(cell.className).toContain('text-warn')
    expect(reauthButton().getAttribute('data-emphasis')).toBe('primary')
  })

  test('≤ 0 → 已过期，critical 色 + 按钮突出', async () => {
    const cell = await renderCard(health({ level: 'critical', auth_days_left: -0.5 }))
    expect(cell.textContent).toBe('登录已过期')
    expect(cell.className).toContain('text-fail')
    expect(reauthButton().getAttribute('data-emphasis')).toBe('primary')
  })

  test('无记录（null）→ 说明怎么开始计时，不显示天数', async () => {
    const cell = await renderCard(health({ auth_days_left: null }))
    expect(cell.textContent).toBe('未记录（在 App 内重新认证一次后开始计时）')
    expect(cell.className).toContain('text-ink-fg-3')
  })

  test('老 token 天数不再参与判断：90 天前刷新、无到期记录也不报红', async () => {
    const cell = await renderCard(health({ token_age_days: 89, auth_days_left: null }))
    expect(cell.className).not.toContain('text-fail')
    expect(screen.queryByText(/估剩余/)).toBeNull()
  })

  test('LOGIN 失败 → 按钮突出（到期还早也一样）', async () => {
    await renderCard(health({ auth_days_left: 20, imap_login_ok: false }))
    expect(reauthButton().getAttribute('data-emphasis')).toBe('primary')
  })

  test('OAuth 错误横幅里的按钮也能打开弹窗', async () => {
    await renderCard(
      health({
        level: 'critical',
        auth_days_left: 20,
        last_oauth_error: 'AADSTS70043: The refresh token has expired',
        last_oauth_error_at: null
      })
    )
    expect(screen.queryByText(/O365Manual/)).toBeNull()
    const buttons = screen.getAllByRole('button', { name: '重新认证' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(useDavMailReauthStore.getState().open).toBe(true)
  })
})
