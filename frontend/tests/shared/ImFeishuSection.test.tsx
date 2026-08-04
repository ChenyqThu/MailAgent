// @vitest-environment happy-dom
//
// ImFeishuSection — 设置-AI「飞书对话」区（08-01 阶段 2 PR-4「信任可见」）。
//
// 覆盖的全是**如实性**契约（改错了用户会被误导的那种），不凑覆盖率：
//   1. flag off → 整区**照常渲染**并显示「未启用」+ 键名。ConnectorsSection 在 flag off 时
//      `return null`，这里刻意相反：`MAILAGENT_IM_FEISHU` 没有 UI 开关，隐身 = 用户既不知
//      道有这个功能、也不知道它为什么不工作。
//   2. flag off 时 `connection_status` 是**上次记录**（serve 被 kill -9 时可能还停在
//      connected）—— 必须显示成 disabled 档，直接当当前状态显示就是撒谎。
//   3. 🔴 绑定码：状态面**不回显**（后端已钉），前端只在点了「生成绑定码」拿到 code 之后
//      才显示那串数字。
//   4. 🔴 审批历史 `available:false`（账本不可达）≠ 「零条」—— 两种情况文案必须分开。
//   5. 上网开关读 env 快照且默认 OFF（未设 → 关），不是「加载中当成开」。
//   6. 远程 web 构建：绑定按钮 disabled（POST /api/im/pair 挂 verify_local_token，远程恒 403）。
//
// 纯 UI 测试：fetch / env store / toast / i18n 全 mock，不碰 IPC 与 better-sqlite3。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string, _opts?: Record<string, unknown>) => key)
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tMock }) }))
vi.mock('@shared/state/toast', () => ({ toastError: vi.fn(), toastSuccess: vi.fn() }))

const { envState, applyEnvPatch } = vi.hoisted(() => ({
  envState: { current: { status: 'ready', snapshot: { values: {} as Record<string, string> } } },
  applyEnvPatch: vi.fn()
}))
vi.mock('@shared/state/env', () => ({
  applyEnvPatch,
  useEnvStore: (sel: (s: { state: unknown }) => unknown) => sel({ state: envState.current })
}))
vi.mock('@shared/state/restart', () => ({
  useRestartStore: (sel: (s: { markRestartRequired: () => void }) => unknown) =>
    sel({ markRestartRequired: vi.fn() })
}))

import {
  ImFeishuSection,
  type ImStatus
} from '@shared/components/settings/custom-ai/ImFeishuSection'

// ─── fixtures ───────────────────────────────────────────────────────────────

/** 真实 `chat_tool_call.updated_at` 的量级（`Date.now()` 毫秒；实测生产行 1785863678495）。
 *  🔴 不能写成十位的秒 —— 那样即便渲染代码按秒解释也照样"看起来对"，闸就白设了。 */
const DECIDED_AT_MS = 1_785_863_678_495

function status(over: Partial<ImStatus> = {}): ImStatus {
  return {
    enabled: true,
    connection_status: 'connected',
    connected_at: '2026-08-04T10:00:00',
    last_event_at: '2026-08-04T10:05:00',
    bound_open_id: 'ou_owner',
    bound_at: '2026-08-04T09:00:00',
    bot_app_name: 'MailAgent',
    bot_open_id: 'ou_bot',
    bot_app_id: 'cli_abc',
    conflict: false,
    conflict_reason: '',
    last_error: '',
    credential_present: true,
    credential_updated_at: 1_750_000_000,
    pair_code_pending: false,
    pair_code_expires_at: 0,
    ...over
  }
}

const fetchMock = vi.fn()

/** 按 URL 路由的 fetch 替身（envelope 形状与 serve-api 一致）。 */
function wireFetch(opts: { status?: ImStatus; approvals?: unknown; pair?: unknown }): void {
  fetchMock.mockImplementation((url: string) => {
    const body = String(url).includes('/im/approvals')
      ? (opts.approvals ?? { available: true, items: [] })
      : String(url).includes('/im/pair')
        ? (opts.pair ?? { code: '123456', expires_at: Math.floor(Date.now() / 1000) + 600 })
        : (opts.status ?? status())
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: body, error: null })
    })
  })
}

function renderUi() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(createElement(QueryClientProvider, { client: qc }, createElement(ImFeishuSection)))
}

beforeEach(() => {
  envState.current = { status: 'ready', snapshot: { values: {} } }
  applyEnvPatch.mockResolvedValue({ ok: true, changedKeys: ['MAILAGENT_IM_WEB_ENABLED'] })
  vi.stubGlobal('fetch', fetchMock)
  wireFetch({})
})

afterEach(() => {
  cleanup()
  fetchMock.mockReset()
  applyEnvPatch.mockReset()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// ─── 1 + 2：flag off 如实显示，且不把陈旧的 connection_status 当现状 ────────────

describe('flag off', () => {
  test('整区照常渲染，显示「未启用」并给出 env 键名', async () => {
    wireFetch({ status: status({ enabled: false, connection_status: 'connected' }) })
    renderUi()
    // 先等数据落地（数据到达前药丸是 unknown 档，见下一条用例）
    await screen.findByText('settings.imFeishu.disabledHint')
    // 🔴 上次记录是 connected，但 flag off 时必须显示成 disabled —— 直接显示 connected
    // 就是把一个不存在的连接说成活的。
    expect(screen.getByText('settings.imFeishu.status.disabled')).toBeTruthy()
    expect(screen.queryByText('settings.imFeishu.status.connected')).toBeNull()
  })

  test('状态读取失败 → 说「状态未知」，不说「未启用」', async () => {
    // 🔴 后端没起时 `/im/status` 直接失败。此刻我们**不知道**功能开没开，把药丸渲染成
    // 「未启用」就是替系统做了一句它没资格做的断言（还会把「后端挂了」误导成「没开功能」）。
    fetchMock.mockRejectedValue(new Error('boom'))
    renderUi()
    await screen.findByText('settings.imFeishu.status.unknown')
    expect(screen.queryByText('settings.imFeishu.status.disabled')).toBeNull()
  })

  test('flag off 时不能出绑定码（出了也没有 bot 能收）', async () => {
    wireFetch({ status: status({ enabled: false, bound_open_id: '' }) })
    renderUi()
    const btn = await screen.findByRole('button', { name: 'settings.imFeishu.bind.issue' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})

// ─── 3：绑定码只在主动索取后出现 ──────────────────────────────────────────────

describe('绑定码', () => {
  test('状态面不回显码；点「生成绑定码」后才显示', async () => {
    wireFetch({
      status: status({ bound_open_id: '', pair_code_pending: true, pair_code_expires_at: 1 }),
      pair: { code: '246813', expires_at: Math.floor(Date.now() / 1000) + 600 }
    })
    renderUi()
    const btn = await screen.findByRole('button', { name: 'settings.imFeishu.bind.issue' })
    // 状态里说「有码在等」，但码本身绝不在页面上（后端也不返回它）
    expect(screen.queryByText('246813')).toBeNull()

    fireEvent.click(btn)
    await screen.findByText('246813')
    expect(screen.getByText('settings.imFeishu.pair.howto')).toBeTruthy()
  })
})

// ─── 4：审批历史「读不到」≠「零条」 ───────────────────────────────────────────

describe('审批历史', () => {
  test('available:false → 说读不到，绝不说「没批过」', async () => {
    wireFetch({ approvals: { available: false, items: [] } })
    renderUi()
    await screen.findByText('settings.imFeishu.approvals.unavailable')
    expect(screen.queryByText('settings.imFeishu.approvals.empty')).toBeNull()
  })

  test('available:true + 空 → 说「还没批过」', async () => {
    wireFetch({ approvals: { available: true, items: [] } })
    renderUi()
    await screen.findByText('settings.imFeishu.approvals.empty')
    expect(screen.queryByText('settings.imFeishu.approvals.unavailable')).toBeNull()
  })

  test('rejected 与 approved 用不同徽标（决定的方向不能糊成一种颜色）', async () => {
    wireFetch({
      approvals: {
        available: true,
        items: [
          {
            tool_name: 'email_send',
            approval_status: 'approved',
            decided_at: DECIDED_AT_MS,
            session_id: 7,
            session_title: null
          },
          {
            tool_name: 'email_archive',
            approval_status: 'rejected',
            decided_at: DECIDED_AT_MS + 100_000,
            session_id: 7,
            session_title: null
          }
        ]
      }
    })
    renderUi()
    await screen.findByText('settings.imFeishu.approvals.approved')
    expect(screen.getByText('settings.imFeishu.approvals.rejected')).toBeTruthy()
    expect(screen.getByText('email_send')).toBeTruthy()
  })

  test('decided_at 按**毫秒**渲染（CHAT_DB 是 Date.now()，不是秒）', async () => {
    // 🔴 单位用错既不报错也不会红 —— 只会把 2026 年安静地渲染成五万七千年。本仓两个时间源
    // 单位相反（`pair_code_expires_at` 秒 / `decided_at` 毫秒）且都是整数，肉眼分不出来，
    // 所以拿真实的 `Date.now()` 量级值钉住一次。
    wireFetch({
      approvals: {
        available: true,
        items: [
          {
            tool_name: 'email_send',
            approval_status: 'approved',
            decided_at: DECIDED_AT_MS,
            session_id: 7,
            session_title: null
          }
        ]
      }
    })
    renderUi()
    await screen.findByText(new Date(DECIDED_AT_MS).toLocaleString())
  })
})

// ─── 5：上网开关默认关 + 写 env ───────────────────────────────────────────────

describe('上网开关', () => {
  test('env 未设 → 显示为关（不是「加载中当成开」）', async () => {
    renderUi()
    const sw = await screen.findByRole('switch', { name: 'settings.imFeishu.web.title' })
    expect(sw.getAttribute('aria-checked')).toBe('false')
  })

  test('打开 → 写 MAILAGENT_IM_WEB_ENABLED=true', async () => {
    renderUi()
    const sw = await screen.findByRole('switch', { name: 'settings.imFeishu.web.title' })
    fireEvent.click(sw)
    await waitFor(() =>
      expect(applyEnvPatch).toHaveBeenCalledWith({ MAILAGENT_IM_WEB_ENABLED: 'true' })
    )
  })

  test('env store 未 ready → 禁用（防把加载态误写成关）', async () => {
    envState.current = { status: 'loading', snapshot: { values: {} } } as never
    renderUi()
    const sw = await screen.findByRole('switch', { name: 'settings.imFeishu.web.title' })
    expect(sw.hasAttribute('disabled')).toBe(true)
  })
})

// ─── 6：远程 web 面 ──────────────────────────────────────────────────────────

describe('远程 web 构建', () => {
  test('绑定按钮 disabled（/api/im/pair 只认本地 token）', async () => {
    vi.stubEnv('VITE_BUILD_TARGET', 'web')
    wireFetch({ status: status({ bound_open_id: '' }) })
    renderUi()
    const btn = await screen.findByRole('button', { name: 'settings.imFeishu.bind.issue' })
    expect((btn as HTMLButtonElement).disabled).toBe(true)
  })
})
