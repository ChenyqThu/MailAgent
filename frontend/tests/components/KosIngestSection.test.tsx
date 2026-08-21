// @vitest-environment happy-dom
//
// issue #59 R7 —「知识库入库」区的门控与警示态。
//
// 覆盖：
//   1. gate=flag_off → 整区一行 DOM 都不渲染（用户没开入库）。
//   2. loading / 取数失败 → 同样 null，不闪空壳（DavMailHealthCard 先例的顺序）。
//   3. gate=active → 区渲染，取数用正确的 days。
//   4. dead_count>0 → 该卡走警示态（人工介入提示在场）；dead=0 → 无警示。
//   5. 健康三态 + last_success_ts 为空时「暂无记录」。
//   6. issue #64 B2：gate=missing_credentials → **显因**而不是静默隐藏，列缺失键名
//      且绝不出现键值。
//   7. issue #64 B1：窗口计数旁边必须有累计计数。
//
// 🔴 门控判据是**后端下发的 data.gate**（producer 面 = ingest flag AND bulk
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
    gate: 'active',
    missing_keys: [],
    days: 7,
    since_ts: 1_700_000_000,
    by_status: { pushed: 120, failed: 3, dead: 0, skipped: 41 },
    // 全量口径：窗口 120 只是累计 9141 的一小截（issue #64 B1 的形状）。
    by_status_all: { pushed: 9141, failed: 3, dead: 0, skipped: 55 },
    total_all: 9199,
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
  test('gate=flag_off: 取数成功但整区一行 DOM 都不渲染', async () => {
    // 入库默认关 = 绝大多数机器。给不用 KOS 的人挂一块「未启用」只是噪音,
    // 所以这一支**有意**保持整区不渲染（≠ issue #64 修的那一支）。
    statsFn.mockResolvedValue(sampleStats({ enabled: false, gate: 'flag_off' }))
    const { container } = renderUi()

    // 等取数 settle 后再断言, 否则「还没 resolve」也会碰巧通过。
    await waitFor(() => expect(statsFn).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))

    expect(screen.queryByTestId('kos-ingest-section')).toBeNull()
    expect(container.textContent).toBe('')
  })

  // 🔴 上游未守约（老后端 / 字段被裁）时不该把整区当成「缺凭据」而弹一块警告。
  // 宁可退回修复前的行为（隐藏）也不误报 —— 同 healthOk 的 typeof guard 纪律。
  test('gate 字段缺席 + enabled=false: 退回修复前行为（隐藏）, 不误报缺凭据', async () => {
    const { gate: _gate, ...noGate } = sampleStats({ enabled: false })
    statsFn.mockResolvedValue(noGate)
    const { container } = renderUi()

    await waitFor(() => expect(statsFn).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))

    expect(container.textContent).toBe('')
  })

  test('gate 字段缺席 + enabled=true: 正常渲染看板', async () => {
    const { gate: _gate, ...noGate } = sampleStats({ enabled: true })
    statsFn.mockResolvedValue(noGate)
    renderUi()

    await waitFor(() => expect(screen.queryByTestId('kos-ingest-section')).not.toBeNull())
    expect(screen.queryByTestId('kos-gate-missing')).toBeNull()
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

  test('gate=active: 区渲染并按传入 days 取数', async () => {
    statsFn.mockResolvedValue(sampleStats())
    renderUi(30)

    await waitFor(() => expect(screen.queryByTestId('kos-ingest-section')).not.toBeNull())
    expect(statsFn).toHaveBeenCalledWith(30)
    await waitFor(() => expect(screen.queryByText('120')).not.toBeNull())
  })
})

// issue #64 主诉：gate 不满足时整区静默消失, 排查只能靠读源码。
describe('KosIngestSection — gate 显因（issue #64）', () => {
  const missing = sampleStats({
    enabled: false,
    gate: 'missing_credentials',
    missing_keys: ['MAILAGENT_BULK_CLIENT_ID', 'MAILAGENT_BULK_CLIENT_SECRET']
  })

  test('gate=missing_credentials: 区块保留 + 列出缺的键名 + 说怎么配', async () => {
    statsFn.mockResolvedValue(missing)
    renderUi()

    // 🔴 区块必须还在 —— 「整区凭空消失」正是这个 issue 的病根。
    await waitFor(() => expect(screen.queryByTestId('kos-ingest-section')).not.toBeNull())
    expect(screen.queryByText('知识库入库')).not.toBeNull()

    const block = screen.getByTestId('kos-gate-missing')
    expect(block.textContent).toContain('MAILAGENT_BULK_CLIENT_ID')
    expect(block.textContent).toContain('MAILAGENT_BULK_CLIENT_SECRET')
    // 光说「缺了」不够, 得指到能补的地方。
    expect(block.textContent).toContain('设置')
    expect(block.textContent).toContain('知识大脑')
  })

  test('缺不同键 → 缺失列表跟着变（前端不自己拼判据, 照后端下发的渲染）', async () => {
    statsFn.mockResolvedValue(
      sampleStats({
        enabled: false,
        gate: 'missing_credentials',
        missing_keys: ['KOS_MCP_BASE']
      })
    )
    renderUi()

    const block = await waitFor(() => screen.getByTestId('kos-gate-missing'))
    expect(block.textContent).toContain('KOS_MCP_BASE')
    // 没缺的键不该出现 —— 否则用户会去改一个本来是对的配置。
    expect(block.textContent).not.toContain('MAILAGENT_BULK_CLIENT_ID')
  })

  // 🔴 missing_keys 是**键名**清单。哪天谁「顺手」把 `KEY=value` 拼进去,
  // 密钥就跟着看板渲染到屏幕上了。
  test('只渲染键名, 绝不出现键值', async () => {
    statsFn.mockResolvedValue(missing)
    const { container } = renderUi()

    await waitFor(() => expect(screen.queryByTestId('kos-gate-missing')).not.toBeNull())
    expect(container.textContent).not.toContain('gbrain_cl_')
    expect(container.textContent).not.toContain('gbrain_cs_')
    expect(container.textContent).not.toContain('=')
  })

  test('缺凭据时不渲染任何计数卡（没有数据可显示, 画个 0 会被当成真值）', async () => {
    statsFn.mockResolvedValue(missing)
    renderUi()

    await waitFor(() => expect(screen.queryByTestId('kos-gate-missing')).not.toBeNull())
    expect(screen.queryByText('已入库')).toBeNull()
    expect(screen.queryByText('每日入库量')).toBeNull()
  })
})

// issue #64 B1：窗口计数被读成「知识库总量」。
describe('KosIngestSection — 窗口 vs 累计口径', () => {
  test('已入库卡：窗口数是主值, 累计数并排出现', async () => {
    statsFn.mockResolvedValue(sampleStats())
    renderUi()

    await waitFor(() => expect(screen.queryByText('120')).not.toBeNull())
    // 「近 7 天 · 累计 9,141」—— 少了后半截, 一次 bulk 滚出窗口时这个数会凭空
    // 掉一个量级, 看起来像知识库被清空。
    expect(screen.queryByText(/近 7 天/)).not.toBeNull()
    expect(screen.queryByText(/累计 9,141/)).not.toBeNull()
  })

  // 🔴 跨 lane 回归（issue #64 Lane A 加了 status='pending' 的延迟首推瞬态行）：
  // 「累计」读的必须是 by_status_all.**pushed**, 不是 total_all（台账全部行数）。
  // 换成后者的话 pending / skipped / failed 会一起算进「累计已入库」—— 正是本 lane
  // 要消灭的那类谎报, 只不过方向反过来（虚高）。
  test('累计只数 pushed：pending / skipped / failed 行不得混进「累计已入库」', async () => {
    statsFn.mockResolvedValue(
      sampleStats({
        by_status: { pushed: 120 },
        by_status_all: { pushed: 9141, failed: 7, dead: 2, skipped: 55, pending: 3 },
        total_all: 9208
      })
    )
    renderUi()

    await waitFor(() => expect(screen.queryByText(/累计 9,141/)).not.toBeNull())
    // total_all（9,208）出现在这里 = 有人把口径换成了「台账全部行数」。
    expect(screen.queryByText(/9,208/)).toBeNull()
  })

  test('by_status_all 缺席（上游未守约）→ 只给窗口口径, 不编一个累计数', async () => {
    const { by_status_all: _all, ...noAll } = sampleStats()
    statsFn.mockResolvedValue(noAll)
    renderUi()

    await waitFor(() => expect(screen.queryByText('120')).not.toBeNull())
    expect(screen.queryByText(/近 7 天/)).not.toBeNull()
    expect(screen.queryByText(/累计/)).toBeNull()
  })

  // 「最近成功 · N 分钟前」是唯一能证明入库还在跑的信号 —— 压在右下角小字里等于没有。
  test('最近成功提到区标题行', async () => {
    const tenMinAgo = Date.now() / 1000 - 600
    statsFn.mockResolvedValue(sampleStats({ last_success_ts: tenMinAgo }))
    renderUi()

    const badge = await waitFor(() => screen.getByTestId('kos-last-success'))
    expect(badge.textContent).toContain('最近成功')
    expect(badge.textContent).toContain('10m 前')
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

// task 08-20-perf-dashboards —「进看板要等半天」的 KOS 侧两个成本：
//   ① 入库默认关的机器每 60s 白烧一次取数，而整区一行 DOM 都不渲染；
//   ② 换 7d/30d/90d 时整区先消失再长回来（下方内容跟着上跳）。
describe('KosIngestSection — 取数门控与换 range 不塌版', () => {
  /** 与顶部 renderUi 的区别：共用一个 QueryClient 且 gcTime 非 0 —— 这两条正是
   *  「上一轮的 gate 还在不在缓存里」的前提，用 gcTime:0 测等于把被测行为抹掉。 */
  function renderWithClient(days: number) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ui = (d: number) =>
      createElement(QueryClientProvider, { client: qc }, createElement(KosIngestSection, { days: d }))
    const utils = render(ui(days))
    return { ...utils, setDays: (d: number) => utils.rerender(ui(d)) }
  }

  test('gate=flag_off：换 range 不再发第二次请求（这台机器没这块区）', async () => {
    statsFn.mockResolvedValue(sampleStats({ enabled: false, gate: 'flag_off' }))
    const { setDays, container } = renderWithClient(7)

    await waitFor(() => expect(statsFn).toHaveBeenCalledTimes(1))
    setDays(30)
    await new Promise((r) => setTimeout(r, 20))

    expect(statsFn).toHaveBeenCalledTimes(1)
    expect(container.textContent).toBe('')
  })

  test('gate=active：换 range 期间旧数据留屏，不塌回空', async () => {
    statsFn.mockResolvedValue(sampleStats())
    const { setDays } = renderWithClient(7)

    await waitFor(() => expect(screen.queryByText('120')).not.toBeNull())
    // 新 range 的请求悬着不 resolve —— 没有 keepPreviousData 的话这一刻整区消失。
    statsFn.mockReturnValue(new Promise(() => {}))
    setDays(30)

    expect(screen.queryByTestId('kos-ingest-section')).not.toBeNull()
    expect(screen.queryByText('120')).not.toBeNull()
  })
})
