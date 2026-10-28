// @vitest-environment happy-dom
//
// 设置 → 账户 → DavMail：登录状态行 + 「重新认证」入口（task 10-28-davmail-self-reauth 主入口）。
// 只在 davmail 源下出现；点击打开全局重认证弹窗；到期信息跟 auth_days_left 走。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { DavMailHealthData } from '@shared/api/types'

const davmailHealthMock = vi.fn<() => Promise<DavMailHealthData>>()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    admin: { davmailHealth: davmailHealthMock },
    settings: { get: vi.fn().mockResolvedValue({ signature: null }), set: vi.fn() }
  })
}))
// Notion 授权入口的开关探测会真发 fetch，测试结束时被 happy-dom 中止并打一行 AbortError。
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, fetchNotionOauthEnabled: async () => true }
})

import i18n from '@shared/i18n'
import { AccountsTab } from '../../src/shared/components/settings/tabs/AccountsTab'
import { useEnvStore } from '@shared/state/env'
import { useDavMailReauthStore } from '@shared/state/davmail-reauth'

await i18n.changeLanguage('zh-CN')

function setEnv(backend: string): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values: { MAILAGENT_BACKEND: backend, NOTION_TOKEN: '***', EMAIL_DATABASE_ID: 'db-id' },
        managedKeys: ['MAILAGENT_BACKEND'],
        secretKeys: ['NOTION_TOKEN']
      }
    }
  })
}

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
    throttle_events_5min: 0,
    last_oauth_error: null,
    last_oauth_error_at: null,
    uid_backfill_paused: false,
    ...overrides
  }
}

function renderTab(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AccountsTab />
    </QueryClientProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useEnvStore.setState({ state: { status: 'idle' } })
  useDavMailReauthStore.setState({ open: false })
})

describe('AccountsTab — DavMail 重新认证入口', () => {
  test('davmail 源：显示到期信息，点「重新认证」打开弹窗', async () => {
    davmailHealthMock.mockResolvedValue(health({ auth_days_left: 29.4 }))
    setEnv('davmail')
    renderTab()

    expect(await screen.findByText('登录约 29 天后过期')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新认证' }))
    expect(useDavMailReauthStore.getState().open).toBe(true)
  })

  test('davmail 源、无交互认证记录 → 显示「未记录」', async () => {
    davmailHealthMock.mockResolvedValue(health({ auth_days_left: null }))
    setEnv('davmail')
    renderTab()

    expect(await screen.findByText('未记录（在 App 内重新认证一次后开始计时）')).toBeTruthy()
  })

  test('applescript 源 → 不渲染入口', () => {
    davmailHealthMock.mockResolvedValue(health({ auth_days_left: 1 }))
    setEnv('applescript')
    renderTab()

    expect(screen.queryByText('DavMail 登录')).toBeNull()
    expect(screen.queryByRole('button', { name: '重新认证' })).toBeNull()
  })
})
