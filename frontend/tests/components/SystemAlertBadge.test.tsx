// @vitest-environment happy-dom
//
// SystemAlertBadge — TitleBar 告警徽章 + 详情 popover。
//   1. 无告警（counts 0）→ badge 不渲染
//   2. 有告警 → badge 计数；点击展开 popover 列出 title/message/source
//   3. popover footer「前往系统看板」→ navigate /admin/kanban + 弹窗关闭
//   4. Escape 关闭 popover
//
// 此前点击直接 navigate('/admin')（Sprint 11 路由重组后是空 Outlet → 空白
// 页）；现在点击开弹窗，跳转只从 footer 发起且指向具体子路由。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { SystemAlertsData } from '@shared/api/types'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate
}))

const mockSystemAlerts = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    admin: { systemAlerts: mockSystemAlerts }
  })
}))

import i18n from '@shared/i18n'
import { SystemAlertBadge } from '@shared/components/layout/SystemAlertBadge'

await i18n.changeLanguage('zh-CN')

const ALERTS: SystemAlertsData = {
  alerts: [
    {
      level: 'critical',
      source: 'davmail',
      title: 'DavMail IMAP 端口不可达',
      message: '连续 3 次 TCP probe 失败',
      ts: '2026-06-12T10:00:00Z'
    },
    {
      level: 'warning',
      source: 'davmail',
      title: 'DavMail EWS throttling',
      message: '5min 内 4 次 throttle, uid-mapper 已暂停',
      ts: null
    }
  ],
  critical_count: 1,
  warning_count: 1,
  generated_at: '2026-06-12T10:00:05Z'
}

const NO_ALERTS: SystemAlertsData = {
  alerts: [],
  critical_count: 0,
  warning_count: 0,
  generated_at: '2026-06-12T10:00:05Z'
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderBadge(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <SystemAlertBadge />
    </QueryClientProvider>
  )
}

describe('SystemAlertBadge', () => {
  test('renders nothing when there are no active alerts', async () => {
    mockSystemAlerts.mockResolvedValue(NO_ALERTS)
    renderBadge()
    await waitFor(() => expect(mockSystemAlerts).toHaveBeenCalled())
    expect(screen.queryByRole('button')).toBeNull()
  })

  test('shows combined count and opens the detail popover on click', async () => {
    mockSystemAlerts.mockResolvedValue(ALERTS)
    renderBadge()

    const trigger = await screen.findByRole('button', { name: '2 条活动系统告警' })
    // 1 critical + 1 warning → "1!+1"
    expect(trigger.textContent).toContain('1!+1')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '系统告警' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    // Every alert's title + message + source rendered.
    expect(screen.getByText('DavMail IMAP 端口不可达')).toBeTruthy()
    expect(screen.getByText('连续 3 次 TCP probe 失败')).toBeTruthy()
    expect(screen.getByText('DavMail EWS throttling')).toBeTruthy()
    // Severity chips in the header.
    expect(dialog.textContent).toContain('严重 1')
    expect(dialog.textContent).toContain('警告 1')
  })

  test('footer button navigates to /admin/kanban and closes the popover', async () => {
    mockSystemAlerts.mockResolvedValue(ALERTS)
    renderBadge()

    fireEvent.click(await screen.findByRole('button', { name: '2 条活动系统告警' }))
    await screen.findByRole('dialog')

    fireEvent.click(screen.getByRole('button', { name: /前往系统看板/ }))
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/admin/kanban' })
    // reduced-motion (tests/setup.ts) → 退场短路，立即卸载。
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('Escape closes the popover without navigating', async () => {
    mockSystemAlerts.mockResolvedValue(ALERTS)
    renderBadge()

    fireEvent.click(await screen.findByRole('button', { name: '2 条活动系统告警' }))
    await screen.findByRole('dialog')

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
