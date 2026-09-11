// @vitest-environment happy-dom
//
// HistorySyncSection — 设置 → 同步「历史邮件」(task 09-11-history-mail-sync)。
//
// 覆盖：
//   1. 七种状态各自可区分（未开始 / 扫描中 / 同步中 / 完成 / 部分失败或覆盖不完整 / 已取消 / 不支持）
//   2. 重进页面由 GET 的 job 恢复进度
//   3. 进行中每 3 秒轮询
//   4. 取消按钮调 cancel API；已请求取消时按钮置灰
//   5. 客户端校验（先后 / 不晚于今天 / 跨度）挡住请求，合法边界放行
//   6. SSE：同 job_id 的 job.* 事件触发刷新，其他事件不触发；卸载时退订
//   7. ETA 按本页面观察到的处理速率估算
//
// 纯 UI 测试：useMailApi 替换成假 api，i18n 用真 zh-CN 资源（顺带验证 ICU 插值）。
// 只假 Date（固定「今天」= 2026-09-11），setTimeout 保持真实，react-query 轮询照常。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import i18n from '@shared/i18n'
import type { HistorySyncJob, HistorySyncState, SseEvent } from '@shared/api/types'

const { fakeApi, getMock, startMock, cancelMock, unsubMock, sse, toastErrorMock } = vi.hoisted(
  () => {
    const sse: { handler: ((ev: SseEvent) => void) | null } = { handler: null }
    const getMock = vi.fn()
    const startMock = vi.fn()
    const cancelMock = vi.fn()
    const unsubMock = vi.fn()
    const fakeApi = {
      historySync: { get: getMock, start: startMock, cancel: cancelMock },
      events: {
        onEvent: (h: (ev: SseEvent) => void) => {
          sse.handler = h
          return unsubMock
        }
      }
    }
    return { fakeApi, getMock, startMock, cancelMock, unsubMock, sse, toastErrorMock: vi.fn() }
  }
)

vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => fakeApi }))
vi.mock('@shared/state/toast', () => ({ toastError: toastErrorMock }))

import { HistorySyncSection } from '../../src/shared/components/settings/parts/HistorySyncSection'

await i18n.changeLanguage('zh-CN')

function makeState(overrides: Partial<HistorySyncState> = {}): HistorySyncState {
  return {
    supported: true,
    unsupported_reason: null,
    backend: 'outlook_com',
    defaults: { since: '2026-08-28', until: '2026-09-11' },
    max_days: 365,
    notion_enabled: true,
    notion_floor: '2026-01-01',
    job: null,
    ...overrides
  }
}

function makeJob(overrides: Partial<HistorySyncJob> = {}): HistorySyncJob {
  return {
    job_id: 12,
    status: 'running',
    phase: 'syncing',
    since: '2026-07-01',
    until: '2026-07-31',
    counts: {
      scanned: 40,
      existing: 25,
      added: 15,
      processed: 3,
      notion_synced: 2,
      local_only: 1,
      failed: 0,
      empty_msgid: 0
    },
    progress_done: 3,
    progress_total: 10,
    complete: true,
    covered_from: null,
    cancel_requested: false,
    started_at: 1,
    finished_at: null,
    updated_at: 2,
    last_error: null,
    ...overrides
  }
}

function finished(overrides: Partial<HistorySyncJob> = {}): HistorySyncJob {
  return makeJob({ status: 'succeeded', phase: 'done', finished_at: 3, ...overrides })
}

function jobEvent(eventType: string, data: Record<string, unknown>): SseEvent {
  return { event_type: eventType, ts: 0, internal_id: null, data, source: 'job-worker' }
}

function renderSection(): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <HistorySyncSection />
    </QueryClientProvider>
  )
}

async function status(): Promise<HTMLElement> {
  return screen.findByTestId('history-sync-status')
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 8, 11, 12, 0, 0))
  getMock.mockReset()
  startMock.mockReset()
  cancelMock.mockReset()
  unsubMock.mockReset()
  toastErrorMock.mockReset()
  sse.handler = null
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('HistorySyncSection — 七种状态', () => {
  test.each<[string, Partial<HistorySyncState>, string, string]>([
    ['未开始', { job: null }, 'idle', '还没有同步过'],
    ['排队中', { job: makeJob({ status: 'queued', phase: 'scanning' }) }, 'scanning', '排队等待'],
    ['扫描中', { job: makeJob({ phase: 'scanning' }) }, 'scanning', '正在扫描邮箱'],
    ['同步中', { job: makeJob() }, 'syncing', '正在同步'],
    ['完成', { job: finished() }, 'done', '同步完成'],
    [
      '部分失败',
      { job: finished({ status: 'partial_failure', last_error: 'Notion 超时' }) },
      'problem',
      '部分邮件同步失败'
    ],
    [
      '覆盖不完整',
      { job: finished({ complete: false, covered_from: '2026-07-10' }) },
      'problem',
      '只覆盖到 2026-07-10'
    ],
    [
      '失败',
      { job: finished({ status: 'failed', last_error: '邮箱不可用' }) },
      'problem',
      '同步失败'
    ],
    ['已取消', { job: finished({ status: 'aborted' }) }, 'cancelled', '已取消']
  ])('%s', async (_name, overrides, state, headline) => {
    getMock.mockResolvedValue(makeState(overrides))
    renderSection()
    const el = await status()
    expect(el.dataset.state).toBe(state)
    expect(el.textContent).toBe(headline)
  })

  test('不支持：显示原因，不渲染按钮和日期', async () => {
    getMock.mockResolvedValue(
      makeState({
        supported: false,
        unsupported_reason: 'backend_applescript',
        backend: 'applescript'
      })
    )
    renderSection()
    const el = await screen.findByTestId('history-sync-unsupported')
    expect(el.textContent).toContain('AppleScript')
    expect(el.textContent).toContain('mailagent init')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryByLabelText('起始日期')).toBeNull()
    expect(screen.queryByTestId('history-sync-status')).toBeNull()
  })

  test('未开始：日期取默认值，开始按钮可点，无进度无摘要', async () => {
    getMock.mockResolvedValue(makeState())
    renderSection()
    await status()
    expect((screen.getByLabelText('起始日期') as HTMLInputElement).value).toBe('2026-08-28')
    expect((screen.getByLabelText('结束日期') as HTMLInputElement).value).toBe('2026-09-11')
    expect(button('开始同步').disabled).toBe(false)
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByTestId('history-sync-summary')).toBeNull()
    expect(screen.getByText('早于 2026-01-01 的邮件只存本地，不推到 Notion。')).toBeTruthy()
  })

  test('Notion 未启用时不提 Notion 起始日期', async () => {
    getMock.mockResolvedValue(makeState({ notion_enabled: false }))
    renderSection()
    await status()
    expect(screen.queryByText(/不推到 Notion/)).toBeNull()
  })

  test('扫描中：开始按钮置灰，有取消，没有进度条', async () => {
    getMock.mockResolvedValue(makeState({ job: makeJob({ phase: 'scanning' }) }))
    renderSection()
    await status()
    expect(button('开始同步').disabled).toBe(true)
    expect(button('取消').disabled).toBe(false)
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  test('同步中：进度条 + 已处理 x / y，日期显示任务范围且不可改', async () => {
    getMock.mockResolvedValue(makeState({ job: makeJob() }))
    renderSection()
    await screen.findByText('已处理 3 / 10')
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('3')
    const since = screen.getByLabelText('起始日期') as HTMLInputElement
    expect(since.value).toBe('2026-07-01')
    expect(since.disabled).toBe(true)
    expect(button('开始同步').disabled).toBe(true)
    expect(screen.queryByTestId('history-sync-summary')).toBeNull()
  })

  test('完成：摘要六项计数，无警示', async () => {
    getMock.mockResolvedValue(makeState({ job: finished() }))
    renderSection()
    const el = await status()
    expect(el.className).not.toMatch(/text-(warn|fail)/)
    const summary = screen.getByTestId('history-sync-summary')
    const count = (f: string): string | null =>
      summary.querySelector(`[data-field="${f}"]`)?.textContent ?? null
    expect(count('scanned')).toBe('40')
    expect(count('existing')).toBe('25')
    expect(count('added')).toBe('15')
    expect(count('notion_synced')).toBe('2')
    expect(count('local_only')).toBe('1')
    expect(count('failed')).toBe('0')
    expect(summary.textContent).not.toContain('原因')
    expect(button('开始同步').disabled).toBe(false)
  })

  test('覆盖不完整：标题带警示色 + 说明覆盖到的日期', async () => {
    getMock.mockResolvedValue(
      makeState({ job: finished({ complete: false, covered_from: '2026-07-10' }) })
    )
    renderSection()
    const el = await status()
    expect(el.className).toContain('text-warn')
    expect(screen.getByText('邮箱视图只保留到 2026-07-10，更早的邮件没有扫描到。')).toBeTruthy()
  })

  test('部分失败 / 失败：显示原因', async () => {
    getMock.mockResolvedValue(
      makeState({ job: finished({ status: 'failed', last_error: '邮箱不可用' }) })
    )
    renderSection()
    const el = await status()
    expect(el.className).toContain('text-fail')
    expect(screen.getByText('原因：邮箱不可用')).toBeTruthy()
  })
})

describe('HistorySyncSection — 恢复与轮询', () => {
  test('重进页面：进度来自 GET 的 job', async () => {
    getMock.mockResolvedValueOnce(makeState({ job: makeJob({ progress_done: 3 }) }))
    const first = renderSection()
    await screen.findByText('已处理 3 / 10')
    first.unmount()

    getMock.mockResolvedValue(makeState({ job: makeJob({ progress_done: 5 }) }))
    renderSection()
    await screen.findByText('已处理 5 / 10')
    expect((screen.getByLabelText('结束日期') as HTMLInputElement).value).toBe('2026-07-31')
  })

  test('任务进行中每 3 秒轮询一次', async () => {
    getMock.mockResolvedValue(makeState({ job: makeJob() }))
    renderSection()
    await status()
    expect(getMock).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2), { timeout: 4500 })
  })
})

describe('HistorySyncSection — 取消', () => {
  test('点取消调 cancel API 并刷新状态', async () => {
    getMock.mockResolvedValue(makeState({ job: makeJob() }))
    cancelMock.mockResolvedValue({ job_id: 12, cancel_requested: true })
    renderSection()
    await status()
    fireEvent.click(button('取消'))
    await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
  })

  test('已请求取消：按钮显示「正在取消…」且不可再点', async () => {
    getMock.mockResolvedValue(makeState({ job: makeJob({ cancel_requested: true }) }))
    renderSection()
    await status()
    expect(button('正在取消…').disabled).toBe(true)
  })
})

describe('HistorySyncSection — 开始与校验', () => {
  async function setRange(since: string, until: string): Promise<void> {
    fireEvent.change(await screen.findByLabelText('起始日期'), { target: { value: since } })
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: until } })
  }

  test.each([
    ['起始晚于结束', '2026-09-05', '2026-09-01', '起始日期不能晚于结束日期'],
    ['结束晚于今天', '2026-09-01', '2026-09-12', '结束日期不能晚于今天'],
    ['跨度超过上限', '2025-09-10', '2026-09-11', '范围最长 365 天']
  ])('%s：显示错误，不调用 API', async (_name, since, until, message) => {
    getMock.mockResolvedValue(makeState())
    renderSection()
    await setRange(since, until)
    fireEvent.click(button('开始同步'))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(startMock).not.toHaveBeenCalled()
  })

  test('跨度恰好等于上限：放行', async () => {
    getMock.mockResolvedValue(makeState())
    startMock.mockResolvedValue({ job_id: 30, was_created: true })
    renderSection()
    await setRange('2025-09-11', '2026-09-11')
    fireEvent.click(button('开始同步'))
    await waitFor(() =>
      expect(startMock).toHaveBeenCalledWith({ since: '2025-09-11', until: '2026-09-11' })
    )
  })

  test('默认范围直接开始：带默认日期调用，随后刷新状态', async () => {
    getMock.mockResolvedValue(makeState())
    startMock.mockResolvedValue({ job_id: 30, was_created: true })
    renderSection()
    await status()
    fireEvent.click(button('开始同步'))
    await waitFor(() =>
      expect(startMock).toHaveBeenCalledWith({ since: '2026-08-28', until: '2026-09-11' })
    )
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
  })

  test('开始失败：toast 报错', async () => {
    getMock.mockResolvedValue(makeState())
    startMock.mockRejectedValue(Object.assign(new Error('backend busy'), { code: 'E_INVALID_ARG' }))
    renderSection()
    await status()
    fireEvent.click(button('开始同步'))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith('无法开始同步', 'backend busy'))
  })
})

describe('HistorySyncSection — SSE', () => {
  test('同 job_id 的 job.* 事件触发刷新，其他事件不触发', async () => {
    getMock.mockResolvedValue(makeState({ job: makeJob() }))
    renderSection()
    await status()
    expect(getMock).toHaveBeenCalledTimes(1)

    act(() => {
      sse.handler?.(jobEvent('job.progress', { job_id: 99, done: 1, total: 2 }))
      sse.handler?.(jobEvent('email.new', { job_id: 12 }))
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(getMock).toHaveBeenCalledTimes(1)

    act(() => {
      sse.handler?.(jobEvent('job.progress', { job_id: 12, done: 4, total: 10 }))
    })
    await waitFor(() => expect(getMock).toHaveBeenCalledTimes(2))
  })

  test('卸载时退订', async () => {
    getMock.mockResolvedValue(makeState({ job: makeJob() }))
    const r = renderSection()
    await status()
    r.unmount()
    expect(unsubMock).toHaveBeenCalledTimes(1)
  })
})

describe('HistorySyncSection — 预计剩余时间', () => {
  test('按两次取数之间的处理速率估算', async () => {
    getMock.mockResolvedValueOnce(
      makeState({ job: makeJob({ progress_done: 10, progress_total: 100 }) })
    )
    renderSection()
    await screen.findByText('已处理 10 / 100')
    expect(screen.queryByText(/预计/)).toBeNull()

    // 60 秒处理了 10 封，剩 80 封 → 480 秒 → 约 8 分钟。
    vi.setSystemTime(new Date(2026, 8, 11, 12, 1, 0))
    getMock.mockResolvedValueOnce(
      makeState({ job: makeJob({ progress_done: 20, progress_total: 100 }) })
    )
    act(() => {
      sse.handler?.(jobEvent('job.progress', { job_id: 12 }))
    })
    await screen.findByText('已处理 20 / 100')
    expect(screen.getByText('预计还需约 8 分钟')).toBeTruthy()
  })
})
