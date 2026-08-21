// @vitest-environment happy-dom
//
// 设置 → 账户 → Notion 集成：OAuth 连接入口（task 08-20 Lane 3）。
//
// 钉住的是「界面说的话必须是真的」那几条：
//   1. flag-off / 无 IPC 桥（远程 web）→ 手填三键**原样**平铺，一个新按钮都不加；
//   2. 已连接判据 = token 已设 ∧ NOTION_WORKSPACE_ID ∧ EMAIL_DATABASE_ID —— 半配置
//      （少邮件库 ID）必须仍显示「连接 Notion」，不能因为有 workspace 名就假装连上了；
//   3. 每个 phase / errorCode 有具体文案（不是「操作失败」）；
//   4. 库选择器：required 缺字段的置灰**并列出缺哪些**，recommended 缺失只提示不挡；
//   5. 写入成功后标记「需重启后端」（否则用户以为立刻生效）。
// 🔴 新断言均做过变异验证（临时改坏被测逻辑确认变红再还原，见任务执行记录）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { DavMailHealthData, EnvSnapshot } from '@shared/api/types'
import { NOTION_OAUTH_ENV_KEYS, type NotionOauthStatusEvent } from '@shared/lib/notionOauthContract'

const davmailHealthMock = vi.fn<() => Promise<DavMailHealthData>>()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    admin: { davmailHealth: davmailHealthMock },
    settings: { get: vi.fn().mockResolvedValue({ signature: null }), set: vi.fn() }
  })
}))

// env store 的 refresh() 走 makeMailApi()（不是 useMailApi hook）—— done 事件后会调它。
const envGetMock = vi.fn(async () => snapshotValue())
vi.mock('@shared/api/factory', () => ({
  makeMailApi: () => ({ env: { get: envGetMock, set: vi.fn() } })
}))

const flagMock = vi.fn(async () => true)
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, fetchNotionOauthEnabled: () => flagMock() }
})

import i18n from '@shared/i18n'
import { AccountsTab } from '../../src/shared/components/settings/tabs/AccountsTab'
import { useEnvStore } from '@shared/state/env'
import { useRestartStore } from '@shared/state/restart'

await i18n.changeLanguage('zh-CN')

// ---- IPC 桥 stub（preload 在测试环境里不存在）--------------------------------

type Listener = (event: unknown, payload: unknown) => void

const invokeMock = vi.fn<(channel: string, arg?: unknown) => Promise<unknown>>()
let statusListeners: Listener[] = []
let disposedCount = 0

function installBridge(): void {
  ;(window as unknown as { electron?: unknown }).electron = {
    ipcRenderer: {
      invoke: invokeMock,
      on: (_channel: string, listener: Listener) => {
        statusListeners.push(listener)
        return () => {
          disposedCount += 1
          statusListeners = statusListeners.filter((l) => l !== listener)
        }
      }
    }
  }
}

function removeBridge(): void {
  delete (window as unknown as { electron?: unknown }).electron
}

function pushStatus(event: NotionOauthStatusEvent): void {
  act(() => {
    for (const l of [...statusListeners]) l(null, event)
  })
}

// ---- env 快照 ---------------------------------------------------------------

let currentValues: Record<string, string> = {}

function snapshotValue(): EnvSnapshot {
  return {
    path: '/tmp/.env',
    exists: true,
    values: { ...currentValues },
    managedKeys: Object.keys(currentValues),
    secretKeys: ['NOTION_TOKEN']
  }
}

function setEnv(values: Record<string, string>): void {
  currentValues = { MAILAGENT_BACKEND: 'davmail', ...values }
  useEnvStore.setState({ state: { status: 'ready', snapshot: snapshotValue() } })
}

const CONNECTED_ENV = {
  NOTION_TOKEN: '***',
  EMAIL_DATABASE_ID: 'db-email',
  CALENDAR_DATABASE_ID: 'db-cal',
  NOTION_WORKSPACE_ID: 'ws-1',
  NOTION_WORKSPACE_NAME: 'Acme 空间'
}

function renderTab(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AccountsTab />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  davmailHealthMock.mockResolvedValue({
    enabled: true,
    level: 'ok',
    last_probe_at: null,
    imap_reachable: true,
    smtp_reachable: true,
    consecutive_imap_failures: 0,
    consecutive_smtp_failures: 0,
    token_age_days: 1,
    token_mtime_iso: null,
    throttle_events_5min: 0,
    last_oauth_error: null,
    last_oauth_error_at: null,
    uid_backfill_paused: false
  } as DavMailHealthData)
  flagMock.mockResolvedValue(true)
  statusListeners = []
  disposedCount = 0
  installBridge()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  removeBridge()
  currentValues = {}
  useEnvStore.setState({ state: { status: 'idle' } })
  useRestartStore.setState({ required: false, changedKeys: [], lastError: null })
})

const CONNECT_BUTTON = '连接 Notion'
const MANUAL_DISCLOSURE = '手动填写 Token 与数据库 ID'

describe('AccountsTab — Notion OAuth 入口门控', () => {
  test('flag-on + Electron → 出现「连接 Notion」，手填三键收进折叠区', async () => {
    setEnv({})
    renderTab()

    expect(await screen.findByRole('button', { name: CONNECT_BUTTON })).toBeTruthy()
    expect(screen.getByText(MANUAL_DISCLOSURE)).toBeTruthy()
  })

  test('flag-off → 现状不变：无按钮、无折叠区，三个字段平铺', async () => {
    flagMock.mockResolvedValue(false)
    setEnv({})
    renderTab()

    await waitFor(() => expect(flagMock).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: CONNECT_BUTTON })).toBeNull()
    expect(screen.queryByText(MANUAL_DISCLOSURE)).toBeNull()
    expect(screen.getByText('邮件数据库 ID')).toBeTruthy()
  })

  test('没有 IPC 桥（远程 web / preload 缺席）→ 同样退回手填原样', async () => {
    removeBridge()
    setEnv({})
    renderTab()

    await waitFor(() => expect(flagMock).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: CONNECT_BUTTON })).toBeNull()
    expect(screen.queryByText(MANUAL_DISCLOSURE)).toBeNull()
  })
})

describe('AccountsTab — 已连接判据（三项齐全才算连上）', () => {
  test('三项齐全 → 显示 workspace 名 + 重新授权 / 从本机移除连接', async () => {
    setEnv(CONNECTED_ENV)
    renderTab()

    expect(await screen.findByText('Acme 空间')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新授权' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '从本机移除连接' })).toBeTruthy()
    // 文案必须如实说明 Notion 侧授权仍在
    expect(screen.getByText(/Notion 侧的授权需要到 Notion/)).toBeTruthy()
  })

  test('半配置（有 token 与 workspace、缺邮件库 ID）→ 仍是未连接态', async () => {
    setEnv({ NOTION_TOKEN: '***', NOTION_WORKSPACE_ID: 'ws-1', NOTION_WORKSPACE_NAME: 'Acme 空间' })
    renderTab()

    expect(await screen.findByRole('button', { name: CONNECT_BUTTON })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '从本机移除连接' })).toBeNull()
  })
})

describe('AccountsTab — 授权状态机 UI', () => {
  test('点连接 → 走 notionOauth:start；phase 与 errorCode 各有具体文案', async () => {
    invokeMock.mockResolvedValue({ ok: true, attemptId: 'att-1' })
    setEnv({})
    renderTab()

    const btn = await screen.findByRole('button', { name: CONNECT_BUTTON })
    await act(async () => {
      fireEvent.click(btn)
    })
    expect(invokeMock).toHaveBeenCalledWith('notionOauth:start')
    expect(screen.getByText(/已在浏览器打开 Notion 授权页/)).toBeTruthy()

    pushStatus({ attemptId: 'att-1', phase: 'exchanging' })
    expect(screen.getByText('正在换取访问令牌…')).toBeTruthy()

    pushStatus({ attemptId: 'att-1', phase: 'error', errorCode: 'port_unavailable' })
    expect(screen.getByText(/9280 与 9281 端口都被占用/)).toBeTruthy()
  })

  test('旧 attempt 的迟到事件被丢弃（不打断当前这次）', async () => {
    invokeMock.mockResolvedValue({ ok: true, attemptId: 'att-2' })
    setEnv({})
    renderTab()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: CONNECT_BUTTON }))
    })
    pushStatus({ attemptId: 'att-OLD', phase: 'error', errorCode: 'cancelled' })

    expect(screen.queryByText(/授权已取消/)).toBeNull()
    expect(screen.getByText(/已在浏览器打开 Notion 授权页/)).toBeTruthy()
  })

  test('写入完成 → 提示重启后端，且 NOTION_OAUTH_ENV_KEYS 整份都进了重启清单', async () => {
    invokeMock.mockResolvedValue({ ok: true, attemptId: 'att-3' })
    setEnv({})
    renderTab()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: CONNECT_BUTTON }))
    })
    pushStatus({
      attemptId: 'att-3',
      phase: 'done',
      workspaceName: 'Acme 空间',
      emailDbTitle: 'Email Inbox',
      calendarDbTitle: 'Calendar'
    })

    expect(screen.getByText(/重启后端后开始同步到 Notion/)).toBeTruthy()
    const restart = useRestartStore.getState()
    expect(restart.required).toBe(true)
    // 键集本身由 tests/main/notion_oauth_env_contract.test.ts 对着 main 的真实 patch
    // 锁死；这里只确认 UI 真的把整份清单交给了重启横幅。
    expect([...restart.changedKeys].sort()).toEqual([...NOTION_OAUTH_ENV_KEYS].sort())
  })

  test('卸载时反订阅（用 on() 返回的 disposer，防 listener 泄漏）', async () => {
    setEnv({})
    renderTab()
    await screen.findByRole('button', { name: CONNECT_BUTTON })
    cleanup()
    expect(disposedCount).toBeGreaterThan(0)
    expect(statusListeners.length).toBe(0)
  })
})

describe('AccountsTab — 库选择器', () => {
  // 标题刻意与分组标题（「邮件库」/「日历库」）不同名 —— 否则 getByLabelText 撞车。
  const CANDIDATES = [
    { id: 'ds-ok', title: 'Email Inbox', role: 'email', valid: true, missing: [], warnings: [] },
    {
      id: 'ds-warn',
      title: 'Meetings',
      role: 'calendar',
      valid: true,
      missing: [],
      warnings: ['AI Summary (rich_text)']
    },
    {
      id: 'ds-bad',
      title: 'Half-baked Inbox',
      role: 'email',
      valid: false,
      missing: ['Message ID (rich_text)', 'Thread ID (rich_text)'],
      warnings: []
    }
  ]

  async function openSelector(): Promise<void> {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === 'notionOauth:start') return { ok: true, attemptId: 'att-sel' }
      if (channel === 'notionOauth:listDatabases') return CANDIDATES
      return { ok: true }
    })
    setEnv({})
    renderTab()
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: CONNECT_BUTTON }))
    })
    pushStatus({ attemptId: 'att-sel', phase: 'need_selection' })
    await screen.findByText('选择要使用的数据库')
  }

  test('缺必需字段的候选置灰并列出缺哪些；缺可选字段只提示不挡', async () => {
    await openSelector()

    // 每个候选在两个分组里各出现一次（同一个库既可能被选成邮件库也可能被看成日历库），
    // 故断言按分组作用域来。
    const [emailGroup, calendarGroup] = screen.getAllByRole('radiogroup')
    expect(
      within(emailGroup).getByText(/缺少必需字段：Message ID \(rich_text\)、Thread ID/)
    ).toBeTruthy()
    expect(within(calendarGroup).getByText(/缺少可选字段：AI Summary/)).toBeTruthy()

    // 邮件库分组里：合法的可选，缺字段的 disabled（且原因就写在旁边）
    expect(within(emailGroup).getByLabelText('Email Inbox').hasAttribute('disabled')).toBe(false)
    expect(within(emailGroup).getByLabelText('Half-baked Inbox').hasAttribute('disabled')).toBe(
      true
    )
    // 日历库分组里，邮件库候选同样不可选（角色不匹配，并说明原因）
    expect(within(calendarGroup).getByLabelText('Email Inbox').hasAttribute('disabled')).toBe(true)
    expect(within(calendarGroup).getAllByText('不是这一类的库（字段签名不匹配）').length).toBe(2)
  })

  test('各选一个后提交 → 走 notionOauth:selectDatabases', async () => {
    await openSelector()

    const [emailGroup, calendarGroup] = screen.getAllByRole('radiogroup')
    await act(async () => {
      fireEvent.click(within(emailGroup).getByLabelText('Email Inbox'))
    })
    await act(async () => {
      fireEvent.click(within(calendarGroup).getByLabelText('Meetings'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '使用所选数据库' }))
    })

    expect(invokeMock).toHaveBeenCalledWith('notionOauth:selectDatabases', {
      attemptId: 'att-sel',
      emailDbId: 'ds-ok',
      calendarDbId: 'ds-warn'
    })
  })
})

describe('AccountsTab — 从本机移除连接', () => {
  test('确认后走 notionOauth:removeConnection，并再次要求重启', async () => {
    invokeMock.mockResolvedValue({ ok: true })
    setEnv(CONNECTED_ENV)
    renderTab()

    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: '从本机移除连接' }))
    })
    // 确认框文案要说清「清了什么 + Notion 侧仍需自行撤销 + 已同步内容不受影响」
    expect(
      screen.getByText(/如需彻底撤销请到 Notion 的「设置 → 我的连接」里移除 MailAgent/)
    ).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '移除连接' }))
    })
    expect(invokeMock).toHaveBeenCalledWith('notionOauth:removeConnection')
    expect(useRestartStore.getState().required).toBe(true)
  })
})
