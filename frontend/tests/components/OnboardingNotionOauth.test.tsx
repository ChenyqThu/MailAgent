// @vitest-environment happy-dom
//
// Onboarding「邮件同步配置」步的 Notion 授权入口（task 08-20 Lane 3）。
//
// 钉住两件容易做错的事：
//   1. 授权成功后**不回填**手填字段 —— renderer 从来没有 token（main 直接写 .env），
//      回填空值会让用户以为没配、回填掩码会在提交时把真 token 覆盖掉。所以正确形态是
//      收起三个字段 + 显示已连接横幅 + 留一个「改为手动填写」的逃生口。
//   2. flag-off / 无 IPC 桥 → 向导原样（一个新控件都不加）。
// 🔴 新断言均做过变异验证（临时改坏被测逻辑确认变红再还原，见任务执行记录）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { NotionOauthStatusEvent } from '@shared/lib/notionOauthContract'

vi.mock('../../src/electron/renderer/onboarding/ipc', () => ({
  listMailAccounts: vi.fn(async () => ({ accounts: ['Exchange'], mailboxes: ['收件箱'] })),
  detectDavmail: vi.fn(async () => ({ bridgeUp: false, detected: {} })),
  commitConfig: vi.fn(async () => ({ ok: true }))
}))

const flagMock = vi.fn(async () => true)
vi.mock('@shared/components/settings/custom-ai/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, fetchNotionOauthEnabled: () => flagMock() }
})

import { StepConfig, type ConfigForm } from '../../src/electron/renderer/onboarding/steps'

type Listener = (event: unknown, payload: unknown) => void

const invokeMock = vi.fn<(channel: string, arg?: unknown) => Promise<unknown>>()
let statusListeners: Listener[] = []

function installBridge(): void {
  ;(window as unknown as { electron?: unknown }).electron = {
    ipcRenderer: {
      invoke: invokeMock,
      on: (_channel: string, listener: Listener) => {
        statusListeners.push(listener)
        return () => {
          statusListeners = statusListeners.filter((l) => l !== listener)
        }
      }
    }
  }
}

function pushStatus(event: NotionOauthStatusEvent): void {
  act(() => {
    for (const l of [...statusListeners]) l(null, event)
  })
}

function renderStep(): void {
  const form: ConfigForm = { USER_EMAIL: 'me@company.com', MAIL_ACCOUNT_NAME: 'Exchange' }
  render(
    <div className="ob">
      <StepConfig
        form={form}
        setForm={vi.fn()}
        backend="applescript"
        onNext={vi.fn()}
        onBack={vi.fn()}
        submitError={null}
        setCommitError={vi.fn()}
      />
    </div>
  )
}

beforeEach(() => {
  flagMock.mockResolvedValue(true)
  statusListeners = []
  invokeMock.mockResolvedValue({ ok: true, attemptId: 'att-ob' })
  installBridge()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete (window as unknown as { electron?: unknown }).electron
})

describe('Onboarding StepConfig — Notion 授权入口', () => {
  test('flag-on → 出现「连接 Notion」，手填三键仍在（可跳过授权）', async () => {
    renderStep()

    expect(await screen.findByRole('button', { name: /连接 Notion/ })).toBeTruthy()
    expect(screen.getByText('Notion Token')).toBeTruthy()
    expect(screen.getByText('邮件数据库 ID')).toBeTruthy()
  })

  test('flag-off → 向导原样，无授权按钮', async () => {
    flagMock.mockResolvedValue(false)
    renderStep()

    await waitFor(() => expect(flagMock).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: /连接 Notion/ })).toBeNull()
    expect(screen.getByText('Notion Token')).toBeTruthy()
  })

  test('授权成功 → 收起手填三键 + 显示已连接横幅（不回填 token）', async () => {
    renderStep()

    const connectBtn = await screen.findByRole('button', { name: /连接 Notion/ })
    await act(async () => {
      fireEvent.click(connectBtn)
    })
    expect(invokeMock).toHaveBeenCalledWith('notionOauth:start')

    pushStatus({
      attemptId: 'att-ob',
      phase: 'done',
      workspaceName: 'Acme 空间',
      emailDbTitle: 'Email Inbox',
      calendarDbTitle: 'Calendar'
    })

    expect(screen.getByText(/已连接 Notion · Acme 空间/)).toBeTruthy()
    expect(screen.getByText(/已自动写入配置/)).toBeTruthy()
    // 手填三键收起 —— 且没有任何输入框被塞进 token/掩码
    expect(screen.queryByText('Notion Token')).toBeNull()
    expect(screen.queryByPlaceholderText('secret_xxxxxxxx…')).toBeNull()

    // 逃生口：仍可改回手填
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '改为手动填写 Token 与数据库 ID' }))
    })
    expect(screen.getByText('Notion Token')).toBeTruthy()
    expect(screen.getByPlaceholderText('secret_xxxxxxxx…').getAttribute('value')).toBe('')
  })

  test('授权失败 → 具体原因 + 指路手填，配置不动', async () => {
    renderStep()

    const connectBtn = await screen.findByRole('button', { name: /连接 Notion/ })
    await act(async () => {
      fireEvent.click(connectBtn)
    })
    pushStatus({ attemptId: 'att-ob', phase: 'error', errorCode: 'port_unavailable' })

    expect(screen.getByText(/9280 \/ 9281 端口都被占用/)).toBeTruthy()
    expect(screen.getByText('Notion Token')).toBeTruthy()
  })
})
