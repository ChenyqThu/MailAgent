// @vitest-environment happy-dom
//
// 工作台抽屉 v2 的接线：
//   · 队列 tab 同时渲染 pending 与 blocked 两批（后端 `list_suggestions` 只收单个 status，
//     所以是两条查询 —— 少发一条 = 被拦下的建议在界面上凭空消失，与验收「留在队列」相反）；
//   · merge 采纳 → 关抽屉 + 把服务端交回的 id 对交给合并预览（合并本身不在这里落库）；
//   · 采纳被守卫拦下 → 走的是**错误信封**，失效两条队列后那条从 blocked 里读回来；
//   · 运行 tab：主按钮 / 上次扫描行 / 历史列表 / 画像批处理只读镜子，两个新端点各自
//     optional 兜底（后端批未合并 → 显示加载失败，不炸页面）；
//   · 脚部跳转行：在 store 里点名治理行 id 后 navigate 到 /agents。
//
// v2 起抽屉里**没有**工具 tab（工具清单迁去 Agents 页配置抽屉），相应断言搬到
// `tests/components/ContactGovernanceConfigDrawer.test.tsx`。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const {
  listSuggestions,
  adoptSuggestion,
  ignoreSuggestion,
  runAgentScan,
  list,
  agentStatus,
  agentHistory,
  profileDailySummary
} = vi.hoisted(() => ({
  listSuggestions: vi.fn(),
  adoptSuggestion: vi.fn(),
  ignoreSuggestion: vi.fn(),
  runAgentScan: vi.fn(),
  list: vi.fn(),
  agentStatus: vi.fn(),
  agentHistory: vi.fn(),
  profileDailySummary: vi.fn()
}))

vi.mock('@shared/api/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/api/contacts')>()
  return {
    ...actual,
    createContactsApi: () => ({
      listSuggestions,
      adoptSuggestion,
      ignoreSuggestion,
      runAgentScan,
      list,
      agentStatus,
      agentHistory,
      profileDailySummary
    })
  }
})

const { toastError, toastSuccess, toastInfo } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))
vi.mock('@shared/state/toast', () => ({ toastError, toastSuccess, toastInfo }))

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import i18n from '@shared/i18n'
import { ContactAgentDrawer } from '@shared/components/contacts/ContactAgentDrawer'
import { useAgentsNavigation } from '@shared/components/agents/navigation'
import type { ContactGovernanceSuggestion } from '@shared/api/types/contact'

await i18n.changeLanguage('zh-CN')

const PENDING: ContactGovernanceSuggestion = {
  id: 11,
  type: 'merge',
  contact_ids: [1, 2],
  payload: { winner_contact_id: 2, loser_contact_id: 1 },
  evidence: [{ message_id: '<a@corp.test>', quote: '往后请发到新地址' }],
  confidence: 0.9,
  status: 'pending',
  block_reason: null,
  created_at: 1_755_000_000_000,
  decided_at: null
}

const BLOCKED: ContactGovernanceSuggestion = {
  id: 12,
  type: 'identity',
  contact_ids: [3],
  payload: { field: 'department', value: 'Legal' },
  evidence: [{ message_id: '<b@corp.test>', quote: 'Legal, Meridian' }],
  confidence: 0.5,
  status: 'blocked',
  block_reason: 'E_FIELD_LOCKED: identity field is locked: department',
  created_at: 1_754_000_000_000,
  decided_at: 1_754_100_000_000
}

function renderDrawer(over: { onMergePair?: (pair: [number, number]) => void } = {}): {
  onOpenChange: ReturnType<typeof vi.fn>
} {
  const onOpenChange = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ContactAgentDrawer
        open
        onOpenChange={onOpenChange}
        onOpenPerson={vi.fn()}
        onMergePair={over.onMergePair ?? vi.fn()}
      />
    </QueryClientProvider>
  )
  return { onOpenChange }
}

/** 切到「运行」tab 并等它的两条查询落定。 */
async function openRunsTab(): Promise<void> {
  fireEvent.click(screen.getByText('运行'))
  await waitFor(() => expect(agentHistory).toHaveBeenCalled())
}

/** 等 agent-status 那条查询真的落定再断言。
 *  🔴 「什么都不该多渲染」这类否定断言如果在数据回来之前就跑，是**恒绿**的（把组件改坏也
 *  不会红）—— 这个 helper 就是防那种装饰性断言：先确认 queryFn 被调用，再在 act 里 await
 *  同一个 promise，让 react-query 的状态更新与重渲染都提交完。 */
async function settleAgentStatus(): Promise<void> {
  await waitFor(() => expect(agentStatus).toHaveBeenCalled())
  await act(async () => {
    await agentStatus.mock.results[0]?.value
  })
}

beforeEach(() => {
  useAgentsNavigation.getState().clear()
  // 提示词编辑区已搬去 Agents 页配置抽屉，这个抽屉不再发那条裸 fetch；stub 一个兜底的
  // fetch 只是免得 happy-dom 在 teardown 时把任何在途请求 abort 成噪声。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ data: {} }) }))
  )
  list.mockResolvedValue({ items: [], total: 0 })
  // 默认给「后端还没上这两个键」的形态 —— 老后端下抽屉必须什么都不多渲染。
  agentStatus.mockResolvedValue({
    enabled: true,
    pending_count: 1,
    last_fire_day: '2026-08-19',
    last_scan_at: 1_755_600_000_000
  })
  agentHistory.mockResolvedValue({ items: [] })
  profileDailySummary.mockResolvedValue({
    date: '2026-08-19',
    attempted: 0,
    ok: 0,
    skipped: 0,
    failed: 0,
    last_attempted_at: null,
    fire_hour: 4
  })
  listSuggestions.mockImplementation(async ({ status }: { status: string }) =>
    status === 'pending'
      ? { items: [PENDING], next_cursor: null }
      : { items: [BLOCKED], next_cursor: null }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ContactAgentDrawer · 队列 tab', () => {
  test('pending 与 blocked 各发一条查询，两批都渲染', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('被拦下的建议')).toBeTruthy())

    expect(listSuggestions).toHaveBeenCalledWith({ status: 'pending' })
    expect(listSuggestions).toHaveBeenCalledWith({ status: 'blocked' })
    expect(screen.getByText('合并同人')).toBeTruthy()
    expect(
      screen.getByText('原因 · E_FIELD_LOCKED: identity field is locked: department')
    ).toBeTruthy()
    // tab 上的计数 = **待审**条数（与胶囊徽标同口径），blocked 不混进这个数。
    expect(screen.getByText('待审建议 1')).toBeTruthy()
  })

  test('两批都空才显示空态', async () => {
    listSuggestions.mockResolvedValue({ items: [], next_cursor: null })
    renderDrawer()
    await waitFor(() => expect(screen.getByText('没有待审建议')).toBeTruthy())
  })

  test('merge 采纳：关抽屉 + 把服务端交回的 id 对交给合并预览', async () => {
    adoptSuggestion.mockResolvedValue({
      id: 11,
      status: 'adopted',
      decided_at: 1,
      merge_pair: [1, 2]
    })
    const onMergePair = vi.fn()
    const { onOpenChange } = renderDrawer({ onMergePair })
    await waitFor(() => expect(screen.getByText('打开合并预览')).toBeTruthy())

    fireEvent.click(screen.getByText('打开合并预览'))
    await waitFor(() => expect(onMergePair).toHaveBeenCalledWith([1, 2]))
    expect(adoptSuggestion).toHaveBeenCalledWith(11)
    expect(onOpenChange).toHaveBeenCalledWith(false)
    // 合并没有在这里落库，所以不该报「已采纳」那句成功文案。
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  test('采纳被守卫拦下（错误信封）→ 重新拉两条队列 + 说清没写入任何字段', async () => {
    const error = Object.assign(new Error('identity field is locked: department'), {
      code: 'E_FIELD_LOCKED'
    })
    adoptSuggestion.mockRejectedValue(error)
    listSuggestions.mockImplementation(async ({ status }: { status: string }) =>
      status === 'pending'
        ? {
            items: [
              {
                ...PENDING,
                id: 13,
                type: 'identity',
                contact_ids: [3],
                payload: { field: 'department', value: 'Legal' }
              }
            ],
            next_cursor: null
          }
        : { items: [], next_cursor: null }
    )
    renderDrawer()
    await waitFor(() => expect(screen.getByText('采纳')).toBeTruthy())
    const before = listSuggestions.mock.calls.length

    fireEvent.click(screen.getByText('采纳'))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        '建议未采纳 · 已留在队列里，没有写入任何字段',
        'identity field is locked: department'
      )
    )
    // 失效两条队列 → blocked 那条会把它读回来（此处以「又拉了一轮」为判据）。
    await waitFor(() => expect(listSuggestions.mock.calls.length).toBeGreaterThan(before))
  })

  test('忽略：调 ignore 端点 + 成功文案', async () => {
    ignoreSuggestion.mockResolvedValue({ id: 11, status: 'ignored', decided_at: 1 })
    renderDrawer()
    await waitFor(() => expect(screen.getByText('忽略')).toBeTruthy())

    fireEvent.click(screen.getByText('忽略'))
    await waitFor(() => expect(ignoreSuggestion).toHaveBeenCalledWith(11))
    expect(toastSuccess).toHaveBeenCalledWith('已忽略这条建议 · 下轮有新证据时可能再提')
  })

  // WP7 dogfood：治理 job failed（实测 E_DISABLED）之后抽屉里零呈现 —— 用户只看得见
  // 「什么都没发生」，空队列被当成「没发现问题」。v2 起这句短警示与「运行」tab 的整行详版
  // 并存，两处读同一条 agent-status 查询。
  test('上一轮扫描 failed → 队列顶部亮出错误码', async () => {
    agentStatus.mockResolvedValue({
      enabled: true,
      pending_count: 0,
      last_fire_day: '2026-08-19',
      last_scan_at: 1_755_600_000_000,
      last_scan_status: 'failed',
      last_scan_error: 'E_DISABLED'
    })
    renderDrawer()

    await waitFor(() => expect(screen.getByText(/上次治理扫描失败：E_DISABLED/)).toBeTruthy())
    // 与「队列读取失败」是两回事，别混成一句。
    expect(screen.queryByText('待审建议读取失败 · 这里显示的可能不是全部')).toBeNull()
  })

  // 🔴 两个键是 optional：后端没上线时 undefined → 一行都不许多渲染（可选链兜底）。
  test('后端还没给这两个键 → 不亮失败行', async () => {
    renderDrawer()
    await settleAgentStatus()

    expect(screen.queryByText(/上次治理扫描失败/)).toBeNull()
  })

  test('succeeded → 不亮失败行（成功不需要额外噪声）', async () => {
    agentStatus.mockResolvedValue({
      enabled: true,
      pending_count: 1,
      last_fire_day: '2026-08-19',
      last_scan_at: 1_755_600_000_000,
      last_scan_status: 'succeeded',
      last_scan_error: null
    })
    renderDrawer()
    await settleAgentStatus()

    expect(screen.queryByText(/上次治理扫描失败/)).toBeNull()
  })
})

describe('ContactAgentDrawer · 运行 tab', () => {
  test('主按钮从脚部上移进运行 tab —— 队列 tab 上看不到它', async () => {
    renderDrawer()
    await waitFor(() => expect(screen.getByText('待审建议 1')).toBeTruthy())
    expect(screen.queryByText('现在跑一次治理扫描')).toBeNull()

    await openRunsTab()
    expect(screen.getByText('现在跑一次治理扫描')).toBeTruthy()
  })

  test('「现在跑一次」：coalesced 时说复用那一轮，不谎报排了新队', async () => {
    runAgentScan.mockResolvedValue({
      job_id: 5,
      status: 'running',
      created: false,
      coalesced: true
    })
    renderDrawer()
    await openRunsTab()

    fireEvent.click(screen.getByText('现在跑一次治理扫描'))
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith('已有一轮治理扫描在跑 · 复用那一轮，没有重复排队')
    )
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  test('上一轮还在跑 → 主按钮禁用（再点只会被后端合流成「什么都没发生」）', async () => {
    agentStatus.mockResolvedValue({
      enabled: true,
      pending_count: 0,
      last_fire_day: '2026-08-19',
      last_scan_at: 1_755_600_000_000,
      last_scan_status: 'running',
      last_scan_error: null
    })
    renderDrawer()
    await openRunsTab()
    await waitFor(() => expect(screen.getByText('扫描中…')).toBeTruthy())

    const button = screen.getByText('扫描中…').closest('button')
    expect(button?.disabled).toBe(true)
    // 「上次扫描」行同时把进行中态说出来（与按钮同源，不各说各话）。
    expect(screen.getByText('正在读增量邮件与通讯录…')).toBeTruthy()
  })

  test('E_DISABLED 不只印一个码，还说下一步去哪儿开', async () => {
    agentStatus.mockResolvedValue({
      enabled: true,
      pending_count: 0,
      last_fire_day: '2026-08-19',
      last_scan_at: 1_755_600_000_000,
      last_scan_status: 'failed',
      last_scan_error: 'E_DISABLED'
    })
    renderDrawer()
    await openRunsTab()

    await waitFor(() =>
      expect(screen.getByText('治理 Agent 行当前是停用状态 —— 到 Agents 页打开后再跑')).toBeTruthy()
    )
  })

  test('历史列表：最近 10 轮，成功报产出条数，失败报错误码', async () => {
    // 时刻是 epoch **毫秒**（后端出口已把 async_jobs 的秒统一转换）。「一小时前」动态值
    // → 时间列必是「今天 HH:mm」；单位再错一档会落到 1970 或公元五万年，`^今天 ` 断言会红。
    const oneHourAgoMs = Date.now() - 3600_000
    agentHistory.mockResolvedValue({
      items: [
        {
          job_id: 9,
          status: 'succeeded',
          created_at: oneHourAgoMs,
          started_at: oneHourAgoMs + 1_000,
          finished_at: oneHourAgoMs + 30_000,
          last_error: null,
          suggestions_created: 3,
          trigger_kind: 'manual'
        },
        {
          job_id: 8,
          status: 'failed',
          created_at: oneHourAgoMs - 86_400_000,
          started_at: null,
          finished_at: null,
          last_error: 'E_LLM_TIMEOUT',
          suggestions_created: null,
          trigger_kind: 'schedule'
        }
      ]
    })
    renderDrawer()
    await openRunsTab()

    await waitFor(() => expect(screen.getByText('治理扫描历史')).toBeTruthy())
    expect(agentHistory).toHaveBeenCalledWith({ limit: 10 })
    expect(screen.getByText('产出 3 条建议')).toBeTruthy()
    // trigger_kind：manual 标一枚、schedule 是常态不标 —— 恰好一枚。
    expect(screen.getAllByText('手动')).toHaveLength(1)
    expect(screen.getByText('E_LLM_TIMEOUT')).toBeTruthy()
    expect(screen.getByText(/^今天 /)).toBeTruthy()
    expect(screen.getByText(/^昨天 /)).toBeTruthy()
  })

  test('历史端点还没上线（404）→ 一行加载失败，不炸页面', async () => {
    agentHistory.mockRejectedValue(new Error('HTTP 404'))
    renderDrawer()
    await openRunsTab()

    await waitFor(() =>
      expect(screen.getByText('扫描历史读取失败 · 上面的「上次扫描」仍然是准的')).toBeTruthy()
    )
    // 页面其余部分照常在。
    expect(screen.getByText('现在跑一次治理扫描')).toBeTruthy()
  })

  test('画像批处理是只读镜子：三档计数出，但**不给开关**', async () => {
    profileDailySummary.mockResolvedValue({
      date: '2026-08-19',
      attempted: 18,
      ok: 12,
      skipped: 5,
      failed: 1,
      last_attempted_at: 1_755_600_000_000,
      fire_hour: 4
    })
    renderDrawer()
    await openRunsTab()

    await waitFor(() => expect(screen.getByText('画像批处理')).toBeTruthy())
    expect(screen.getByText('18')).toBeTruthy()
    expect(screen.getByText('成功 12')).toBeTruthy()
    expect(screen.getByText('证据不足 5')).toBeTruthy()
    expect(screen.getByText('失败 1')).toBeTruthy()
    // 🔴 开关只在 Agents 页「联系人画像」卡上 —— 这里多一个就分裂出「哪个是权威」。
    expect(screen.queryByRole('switch')).toBeNull()
  })

  test('画像汇总端点还没上线 → 一行加载失败，不炸页面', async () => {
    profileDailySummary.mockRejectedValue(new Error('HTTP 404'))
    renderDrawer()
    await openRunsTab()

    await waitFor(() => expect(screen.getByText('画像批处理汇总读取失败')).toBeTruthy())
    expect(screen.getByText('治理扫描历史')).toBeTruthy()
  })
})

describe('ContactAgentDrawer · 脚部跳转', () => {
  test('「去配置」：点名治理行 id 进 store + 关抽屉 + 跳 /agents', async () => {
    const { onOpenChange } = renderDrawer()
    await waitFor(() => expect(screen.getByText('去配置')).toBeTruthy())

    fireEvent.click(screen.getByText('去配置'))

    expect(useAgentsNavigation.getState().targetAgentId).toBe('contact_governance_agent')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(navigate).toHaveBeenCalledWith({ to: '/agents', search: { tab: 'agents' } })
  })
})
