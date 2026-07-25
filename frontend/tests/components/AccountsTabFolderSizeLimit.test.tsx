// @vitest-environment happy-dom
//
// 设置 → 账户 → DavMail：IMAP 文件夹视图上限（davmail.folderSizeLimit）。
//
// 2026-07-24 事故的可配置化：10617 封收件箱 + 未配 folderSizeLimit → 每次
// SELECT/STATUS 经 EWS 全量枚举 → 整条同步链停摆。这里钉住两件事：
//   1. 字段只在 davmail 源下出现（applescript 用户不该看到一个对他无意义的开关）。
//   2. **状态行必须诚实** —— 配置文件找不到时明说「当前不生效」，写进去了明说
//      「重启 DavMail 桥后才生效」。假装保存成功正是这次改动要根除的东西。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { DavMailHealthData } from '@shared/api/types'

const davmailHealthMock = vi.fn<() => Promise<DavMailHealthData>>()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    admin: { davmailHealth: davmailHealthMock },
    settings: { get: vi.fn().mockResolvedValue({ signature: null }), set: vi.fn() }
  })
}))

import i18n from '@shared/i18n'
import { AccountsTab } from '../../src/shared/components/settings/tabs/AccountsTab'
import { useEnvStore } from '@shared/state/env'

await i18n.changeLanguage('zh-CN')

const LABEL = 'IMAP 文件夹视图上限（封）'

function setEnv(backend: string, limit = '500'): void {
  useEnvStore.setState({
    state: {
      status: 'ready',
      snapshot: {
        path: '/tmp/.env',
        exists: true,
        values: {
          MAILAGENT_BACKEND: backend,
          DAVMAIL_FOLDER_SIZE_LIMIT: limit,
          // 填齐 Notion 两键: 否则 NotionDisabledNotice 也是 role="status",
          // 会和本测断言的状态行撞车。
          NOTION_TOKEN: '***',
          EMAIL_DATABASE_ID: 'db-id'
        },
        managedKeys: ['MAILAGENT_BACKEND', 'DAVMAIL_FOLDER_SIZE_LIMIT'],
        secretKeys: ['NOTION_TOKEN']
      }
    }
  })
}

function health(overrides: Partial<DavMailHealthData>): DavMailHealthData {
  return {
    enabled: true,
    level: 'ok',
    last_probe_at: '2026-07-24T10:00:00',
    imap_reachable: true,
    smtp_reachable: true,
    consecutive_imap_failures: 0,
    consecutive_smtp_failures: 0,
    token_age_days: 3,
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
})

describe('AccountsTab — DAVMAIL_FOLDER_SIZE_LIMIT 字段', () => {
  test('davmail 源下渲染字段，说明写清用途与代价', async () => {
    davmailHealthMock.mockResolvedValue(health({ folder_size_limit_status: null }))
    setEnv('davmail')
    renderTab()

    expect(await screen.findByText(LABEL)).toBeTruthy()
    const helper = screen.getByText(/只让 DavMail 在 IMAP 里暴露每个文件夹最近 N 封邮件/)
    // 用途（不配会停摆）+ 代价（老邮件在 IMAP 层不可见，但本地历史不受影响）都要说到
    expect(helper.textContent).toContain('EWS')
    expect(helper.textContent).toContain('停摆')
    expect(helper.textContent).toContain('已同步到本地的历史邮件不受影响')
  })

  test('applescript 源下不渲染（该项只对 DavMail 有意义）', () => {
    davmailHealthMock.mockResolvedValue(health({ folder_size_limit_status: 'unchanged' }))
    setEnv('applescript')
    renderTab()

    expect(screen.queryByText(LABEL)).toBeNull()
  })
})

describe('AccountsTab — folderSizeLimit 落地状态行（诚实性）', () => {
  test('配置文件缺失 → 明说当前不生效 + 给出路径与手改方法', async () => {
    davmailHealthMock.mockResolvedValue(
      health({
        folder_size_limit_status: 'file_missing',
        folder_size_limit_path: '/nope/davmail-poc/config/davmail.properties',
        folder_size_limit_desired: 500,
        folder_size_limit_file_value: null
      })
    )
    setEnv('davmail')
    renderTab()

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('此设置当前不生效')
    expect(status.textContent).toContain('/nope/davmail-poc/config/davmail.properties')
    expect(status.textContent).toContain('DAVMAIL_ROOT')
  })

  test('已写入 → 明说需重启 DavMail 桥才生效', async () => {
    davmailHealthMock.mockResolvedValue(
      health({
        folder_size_limit_status: 'updated',
        folder_size_limit_path: '/x/config/davmail.properties',
        folder_size_limit_desired: 500,
        folder_size_limit_file_value: 500
      })
    )
    setEnv('davmail')
    renderTab()

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('已写入 DavMail 配置文件')
    expect(status.textContent).toContain('重启 DavMail 桥')
  })

  test('文件里已是该值 → 只报告现状，不假装刚做了什么', async () => {
    davmailHealthMock.mockResolvedValue(
      health({
        folder_size_limit_status: 'unchanged',
        folder_size_limit_path: '/x/config/davmail.properties',
        folder_size_limit_desired: 500,
        folder_size_limit_file_value: 500
      })
    )
    setEnv('davmail')
    renderTab()

    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('已是 500 封')
    expect(status.textContent).not.toContain('重启 DavMail 桥')
  })

  test('后端没跑过同步（状态缺失）→ 不渲染状态行，不瞎猜', async () => {
    davmailHealthMock.mockResolvedValue(health({ folder_size_limit_status: null }))
    setEnv('davmail')
    renderTab()

    await screen.findByText(LABEL)
    await waitFor(() => expect(davmailHealthMock).toHaveBeenCalled())
    expect(screen.queryByRole('status')).toBeNull()
  })
})
