// @vitest-environment happy-dom
//
// issue #59 R7 —「知识库入库」区的门控与警示态。
//
// 覆盖：
//   1. enabled=false → 整区一行 DOM 都不渲染（producer 面未启用）。
//   2. loading / 取数失败 → 同样 null，不闪空壳（DavMailHealthCard 先例的顺序）。
//   3. enabled=true → 区渲染，取数用正确的 days。
//   4. dead_count>0 → 该卡走警示态（人工介入提示在场）；dead=0 → 无警示。
//   5. 健康三态 + last_success_ts 为空时「暂无记录」。
//
// 🔴 门控判据是**后端下发的 data.enabled**（producer 面 = ingest flag AND bulk
// client 三键），不是 `/chat/config.kosConfigured`（那是 consumer 面凭据，两套
// 独立）。gate 与数据同一个响应，不另开 fetch —— 所以这里只 mock kos.stats，
// 没有任何 /chat/config 探针参与。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'

import type { KosStatsData } from '../../src/shared/api/types'

const statsFn = vi.fn()

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ kos: { stats: statsFn } })
}))

import i18n from '@shared/i18n'
import { KosIngestSection } from '../../src/shared/components/llm/KosIngestSection'

await i18n.changeLanguage('zh-CN')

function sampleStats(overrides: Partial<KosStatsData> = {}): KosStatsData {
  // 形状 = team-lead 钉死的 GET /api/kos/stats 契约（health 从未探测时整个对象
  // 为 null；by_status 的键可能缺席）。
  return {
    enabled: true,
    days: 7,
    since_ts: 1_700_000_000,
    by_status: { pushed: 120, failed: 3, dead: 0, skipped: 41 },
    by_error_code: { E_KOS_TOKEN_NETWORK: 2, E_KOS_NETWORK: 1 },
    pending_retry: 3,
    dead_count: 0,
    last_success_ts: 1_700_000_500,
    health: { ok: true, checked_at: 1_700_000_600 },
    daily: [
      { date: '2026-07-19', pushed: 20, failed: 0 },
      { date: '2026-07-20', pushed: 35, failed: 3 }
    ],
    _source: 'live_query',
    ...overrides
  }
}

function renderUi(days = 7) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    createElement(QueryClientProvider, { client: qc }, createElement(KosIngestSection, { days }))
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('KosIngestSection — 门控', () => {
  test('enabled=false: 取数成功但整区一行 DOM 都不渲染', async () => {
    statsFn.mockResolvedValue(sampleStats({ enabled: false }))
    const { container } = renderUi()

    // 等取数 settle 后再断言, 否则「还没 resolve」也会碰巧通过。
    await waitFor(() => expect(statsFn).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.queryByTestId('kos-ingest-section')).toBeNull()
    expect(container.textContent).toBe('')
  })

  test('取数失败: 同样 null, 不渲染半截空壳', async () => {
    statsFn.mockRejectedValue(new Error('E_CLI_FAILED'))
    const { container } = renderUi()

    await waitFor(() => expect(statsFn).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))

    expect(container.textContent).toBe('')
  })

  test('loading 期: 不闪空壳（先判 isLoading 再判 gate）', () => {
    statsFn.mockReturnValue(new Promise(() => {}))
    const { container } = renderUi()
    expect(container.textContent).toBe('')
  })

  test('enabled=true: 区渲染并按传入 days 取数', async () => {
    statsFn.mockResolvedValue(sampleStats())
    renderUi(30)

    await waitFor(() => expect(screen.queryByTestId('kos-ingest-section')).not.toBeNull())
    expect(statsFn).toHaveBeenCalledWith(30)
    await waitFor(() => expect(screen.queryByText('120')).not.toBeNull())
  })
})

describe('KosIngestSection — dead 警示态', () => {
  test('dead_count=0: 无警示提示', async () => {
    statsFn.mockResolvedValue(sampleStats())
    renderUi()

    await waitFor(() => expect(statsFn).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('无需人工介入')).not.toBeNull())
    expect(screen.queryByTestId('kos-dead-warning')).toBeNull()
  })

  test('dead_count>0: 走警示态 + 指向手动补漏', async () => {
    statsFn.mockResolvedValue(
      sampleStats({ dead_count: 7, by_status: { pushed: 120, failed: 3, dead: 7, skipped: 41 } })
    )
    renderUi()

    await waitFor(() => expect(screen.queryByTestId('kos-dead-warning')).not.toBeNull())
    const warn = screen.getByTestId('kos-dead-warning')
    // 🔴 dead 有两种成因（永久错误直接落 dead / 超重试上限），用户动作不同,
    // 所以文案必须中性、把判断推给错误码分布 —— 不能写死成「自动重试已放弃,
    // 请手动补漏」(对从未重试过的永久错误那半是误导, 手动补也会同样失败)。
    expect(warn.textContent).toContain('错误码')
    expect(warn.textContent).not.toContain('bulk-ingest')
    // 警示卡容器（StatCard tone='warn'）用 warn 色, 不与普通计数卡同形。
    expect(warn.closest('.border-warn\\/30')).not.toBeNull()
  })
})

describe('KosIngestSection — 健康（非实时快照）', () => {
  test('health=null（从未探测）→ 渲染成「未探测」而不是异常', async () => {
    statsFn.mockResolvedValue(sampleStats({ health: null }))
    renderUi()

    await waitFor(() => expect(screen.queryByText('未探测')).not.toBeNull())
    // 「不可达」是异常态文案 —— 从未探测绝不能落到它身上。
    expect(screen.queryByText('不可达')).toBeNull()
  })

  // 🔴 回归：上游曾返回「对象在、字段全 null」而不是 null。只判 `health == null`
  // 的话 `health.ok` 是 undefined → falsy → 渲染「不可达」，于是刚升级、从未探活过
  // 的机器全都会看到 KOS 异常。判据必须是 typeof === 'boolean'。
  test('🔴 health 是字段全 null 的对象（上游未守约）→ 仍收敛到「未探测」, 不误报异常', async () => {
    statsFn.mockResolvedValue(
      sampleStats({
        health: {
          status: null,
          checked_at: null,
          detail: null,
          consecutive_failed_rounds: 0
        } as unknown as KosStatsData['health']
      })
    )
    renderUi()

    await waitFor(() => expect(screen.queryByText('未探测')).not.toBeNull())
    expect(screen.queryByText('不可达')).toBeNull()
    expect(screen.queryByText('可达')).toBeNull()
  })

  test('health.ok=false → 不可达, 失败原因进 tooltip', async () => {
    statsFn.mockResolvedValue(
      sampleStats({
        health: { ok: false, checked_at: 1_700_000_600, detail: 'connection refused' }
      })
    )
    renderUi()

    await waitFor(() => expect(screen.queryByText('不可达')).not.toBeNull())
    expect(screen.queryByText('未探测')).toBeNull()
    // detail 是后端契约外的附加字段, 不可达时才有用 —— 挂 tooltip 不占行内空间。
    const title = screen.getByText('不可达').closest('[title]')?.getAttribute('title')
    expect(title).toContain('connection refused')
  })

  test('detail 缺席（附加字段可选）→ tooltip 只有时间, 不出现 undefined', async () => {
    statsFn.mockResolvedValue(sampleStats({ health: { ok: true, checked_at: 1_700_000_600 } }))
    renderUi()

    await waitFor(() => expect(screen.queryByText('可达')).not.toBeNull())
    const title = screen.getByText('可达').closest('[title]')?.getAttribute('title')
    expect(title).not.toContain('undefined')
    expect(title).not.toContain('null')
  })

  // 🔴 后端无积压时不探活 → health 非 null 也可能是很旧的快照。只给绝对时间
  // 会被当成刚测过, 所以必须带相对时间, 且标题说「上次检查」而非「健康状态」。
  test('陈旧快照: 带相对时间, 标题是「上次检查」', async () => {
    const threeDaysAgo = Date.now() / 1000 - 3 * 86400
    statsFn.mockResolvedValue(sampleStats({ health: { ok: true, checked_at: threeDaysAgo } }))
    renderUi()

    await waitFor(() => expect(screen.queryByText('上次检查')).not.toBeNull())
    expect(screen.queryByText('可达')).not.toBeNull()
    expect(screen.queryByText('· 3d 前')).not.toBeNull()
    // 「健康状态」会让人以为是实时探测结果。
    expect(screen.queryByText('健康状态')).toBeNull()
  })
})

describe('KosIngestSection — table_missing', () => {
  test('enabled=true + _source=table_missing: 正常渲染零值, 不隐藏也不报错', async () => {
    // 没跑过 bulk 的机器：台账表不存在，后端返全零。这条链路 enabled 仍可能为 true。
    statsFn.mockResolvedValue(
      sampleStats({
        _source: 'table_missing',
        by_status: {},
        by_error_code: {},
        pending_retry: 0,
        dead_count: 0,
        last_success_ts: null,
        health: null,
        daily: []
      })
    )
    renderUi()

    await waitFor(() => expect(screen.queryByTestId('kos-ingest-section')).not.toBeNull())
    expect(screen.queryByText('暂无记录')).not.toBeNull()
    expect(screen.queryByText('窗口内无失败')).not.toBeNull()
    expect(screen.queryByTestId('kos-dead-warning')).toBeNull()
  })

  test('_source=schema_stale: 数字是真的, 错误码那栏不谎报「无失败」', async () => {
    // 装了新版但后端还没重启跑 v41 迁移：老形状表里 status/pushed_at 都在,
    // 只有 error_code 列不存在 → by_error_code 恒空。此时说「窗口内无失败」是撒谎。
    statsFn.mockResolvedValue(
      sampleStats({
        _source: 'schema_stale',
        by_status: { pushed: 7471, failed: 0, dead: 0, skipped: 0 },
        by_error_code: {}
      })
    )
    renderUi()

    await waitFor(() => expect(screen.queryByText('7,471')).not.toBeNull())
    expect(screen.queryByText('窗口内无失败')).toBeNull()
    expect(screen.queryByText('错误码待后端重启迁移后可见')).not.toBeNull()
  })
})

describe('KosIngestSection — 最近成功推送', () => {
  test('last_success_ts 为空 → 「暂无记录」, 不渲染任何时间戳', async () => {
    statsFn.mockResolvedValue(sampleStats({ last_success_ts: null }))
    renderUi()

    await waitFor(() => expect(screen.queryByText('暂无记录')).not.toBeNull())
  })

  test('有值 → 显示「多久以前」而非只给一个绝对时间（防被扫读成刚推过）', async () => {
    const fortyDaysAgo = Date.now() / 1000 - 40 * 86400
    statsFn.mockResolvedValue(sampleStats({ last_success_ts: fortyDaysAgo }))
    renderUi()

    await waitFor(() => expect(screen.queryByText('40d 前')).not.toBeNull())
    expect(screen.queryByText('暂无记录')).toBeNull()
  })
})
