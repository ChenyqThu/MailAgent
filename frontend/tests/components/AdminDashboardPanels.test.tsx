// @vitest-environment happy-dom
//
// task 08-20-perf-dashboards §2 —「看板信息升级」的三块新面：
//   1. 顶部健康状态行（两个看板共用，只放「能回答要不要动手」的量）
//   2. 派发队列 (outbox) 卡 —— 数据一直在 admin stats 的返回体里，此前前端类型
//      没声明 → 队列积压在 UI 上完全不可见
//   3. 死信区改「计数 + 展开」—— 正常态 0 条，不该让一张 50 行的表铺满首屏
//
// 🔴 outbox 的 `age_buckets` 只统计 **pending** 行；`by_target` 不含 done。测的是
// 「最老那一档决定颜色」这条判据：3 条卡了半小时比 30 条刚进队列糟得多，只给条数
// 看不出来。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { AdminStatsData, DeadLetterItem } from '../../src/shared/api/types'

const healthFn = vi.fn()
const statsFn = vi.fn()
const deadLetterListFn = vi.fn()
const systemAlertsFn = vi.fn()
const kosStatsFn = vi.fn()

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    admin: {
      health: healthFn,
      stats: statsFn,
      deadLetterList: deadLetterListFn,
      deadLetterRetry: vi.fn(),
      deadLetterDelete: vi.fn(),
      davmailHealth: vi.fn().mockResolvedValue({ enabled: false }),
      systemAlerts: systemAlertsFn
    },
    kos: { stats: kosStatsFn }
  })
}))

import i18n from '@shared/i18n'
import { AdminPage } from '../../src/shared/components/admin/AdminPage'

await i18n.changeLanguage('zh-CN')

function stats(outbox?: AdminStatsData['outbox']): AdminStatsData {
  return {
    sync_store: {
      total_emails: 12,
      by_status: { synced: 11, dead_letter: 1 },
      by_mailbox: { 收件箱: 12 },
      failure_queue: 0,
      last_max_row_id: 99,
      last_sync_time: null,
      db_size_mb: 1,
      db_size_bytes: 1024
    },
    ...(outbox ? { outbox } : {})
  }
}

function deadLetterRow(id: number): DeadLetterItem {
  return {
    internal_id: id,
    mailbox: '收件箱',
    subject: `失败邮件 ${id}`,
    sender: 'a@example.test',
    date_received: null,
    retry_count: 5,
    sync_status: 'dead_letter',
    sync_error: 'boom',
    updated_at: Date.now() / 1000 - 120
  }
}

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(createElement(QueryClientProvider, { client: qc }, createElement(AdminPage)))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function primeQueries(): void {
  healthFn.mockResolvedValue({
    db_accessible: true,
    db_version: 41,
    db_version_expected: 41,
    schema_ok: true,
    tables_present: ['email_metadata'],
    tables_missing: [],
    healthy: true,
    notes: []
  })
  systemAlertsFn.mockResolvedValue({
    alerts: [],
    critical_count: 0,
    warning_count: 0,
    generated_at: ''
  })
  kosStatsFn.mockResolvedValue({ enabled: false, gate: 'flag_off' })
  deadLetterListFn.mockResolvedValue([])
}

describe('AdminPage — 派发队列 (outbox) 卡', () => {
  test('渲染 by_status / by_target / age_buckets 三段', async () => {
    primeQueries()
    statsFn.mockResolvedValue(
      stats({
        _source: 'live_query',
        total: 40,
        by_status: { pending: 3, processing: 1, failed: 2, dead_letter: 0, done: 34 },
        by_target: { mailapp: 4, notion: 2 },
        age_buckets: { lt_1m: 1, lt_5m: 1, lt_30m: 0, gt_30m: 1 }
      })
    )
    renderPage()

    const card = await waitFor(() => screen.getByTestId('admin-outbox'))
    expect(card.textContent).toContain('mailapp')
    expect(card.textContent).toContain('notion')
    // 年龄四档全在（含 0 的档也要在：缺档 = 读者以为没这个区间）。
    expect(card.textContent).toContain('>30m')
    expect(card.textContent).toContain('<1m')
  })

  test('_source=error → 说「读取失败」而不是画一排 0（0 会被当成队列是空的）', async () => {
    primeQueries()
    statsFn.mockResolvedValue(
      stats({ _source: 'error', _error: 'OperationalError: no such table: email_outbox' })
    )
    renderPage()

    const card = await waitFor(() => screen.getByTestId('admin-outbox'))
    expect(card.textContent).toContain('读取失败')
    expect(card.textContent).toContain('no such table')
    // 卡里一个计数都不该有（「待派发」这个词在顶部健康行也出现，所以限定在卡内）。
    expect(within(card).queryByText(i18n.t('admin.outbox.pending'))).toBeNull()
  })

  test('返回体没有 outbox 段（老后端）→ 整块不渲染', async () => {
    primeQueries()
    statsFn.mockResolvedValue(stats())
    renderPage()

    await waitFor(() => expect(screen.getAllByText('v41').length).toBeGreaterThan(0))
    expect(screen.queryByTestId('admin-outbox')).toBeNull()
  })
})

describe('AdminPage — 死信「计数 + 展开」', () => {
  test('默认收起：给计数不给 50 行表格', async () => {
    primeQueries()
    statsFn.mockResolvedValue(stats())
    deadLetterListFn.mockResolvedValue([deadLetterRow(1), deadLetterRow(2)])
    renderPage()

    await waitFor(() => expect(screen.getByTestId('dead-letter-toggle')).toBeTruthy())
    // 明细行不在 DOM 里（不是 display:none —— 收起就不该渲染 50 行）。
    expect(screen.queryByText('失败邮件 1')).toBeNull()
    expect(screen.getByTestId('dead-letter-toggle').getAttribute('aria-expanded')).toBe('false')
  })

  test('点开 → 表格与 retry/delete 交互原样在场', async () => {
    primeQueries()
    statsFn.mockResolvedValue(stats())
    deadLetterListFn.mockResolvedValue([deadLetterRow(1), deadLetterRow(2)])
    renderPage()

    const toggle = await waitFor(() => screen.getByTestId('dead-letter-toggle'))
    fireEvent.click(toggle)

    expect(screen.getByText('失败邮件 1')).toBeTruthy()
    expect(screen.getByText('失败邮件 2')).toBeTruthy()
    // 按 role 取而不是按文案取：「重试」同时是表头列名 admin.col.retries。
    expect(screen.getAllByRole('button', { name: i18n.t('admin.retry') }).length).toBe(2)
  })

  test('0 条时不出现展开按钮（没有可展开的东西）', async () => {
    primeQueries()
    statsFn.mockResolvedValue(stats())
    renderPage()

    await waitFor(() => expect(screen.getByText(i18n.t('admin.noDeadLetter'))).toBeTruthy())
    expect(screen.queryByTestId('dead-letter-toggle')).toBeNull()
  })
})

describe('SystemHealthRow — 只放能回答「要不要动手」的量', () => {
  test('死信 / outbox 待派发带最老年龄档 / 严重告警各占一格', async () => {
    primeQueries()
    statsFn.mockResolvedValue(
      stats({
        _source: 'live_query',
        by_status: { pending: 3 },
        // 2 条刚进队列 + 1 条卡了半小时：要的是**最老**那一档，不是最多那一档、
        // 也不是从新往老数到的第一档。
        age_buckets: { lt_1m: 2, lt_5m: 0, lt_30m: 0, gt_30m: 1 }
      })
    )
    renderPage()

    // 🔴 状态行本身第一帧就在（占位），所以必须等到值落位再断言，否则断的是「—」。
    await waitFor(() => expect(screen.getByTestId('health-dead-letter').textContent).toContain('1'))
    const row = screen.getByTestId('system-health-row')
    // 🔴 判据是「最老那一档」：3 条全卡在 >30m，只给 "3" 看不出严重性。
    expect(screen.getByTestId('health-outbox').textContent).toContain('3 · >30m')
    expect(row.textContent).toContain('v41')
  })

  test('KOS 未启用入库 → 不出现 KOS 那一格（没开的机器不该多一个恒 0 的点）', async () => {
    primeQueries()
    statsFn.mockResolvedValue(stats())
    renderPage()

    await waitFor(() => expect(screen.getByTestId('system-health-row')).toBeTruthy())
    expect(screen.queryByTestId('health-kos-dead')).toBeNull()
  })

  test('KOS 入库开着 → dead 计数在场（全量口径）', async () => {
    primeQueries()
    kosStatsFn.mockResolvedValue({ enabled: true, gate: 'active', dead_count: 4 })
    statsFn.mockResolvedValue(stats())
    renderPage()

    await waitFor(() => expect(screen.queryByTestId('health-kos-dead')).not.toBeNull())
    expect(screen.getByTestId('health-kos-dead').textContent).toContain('4')
  })
})
