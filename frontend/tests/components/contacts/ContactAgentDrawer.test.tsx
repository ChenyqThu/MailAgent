// @vitest-environment happy-dom
//
// WP7 治理台抽屉的接线：
//   · 队列 tab 同时渲染 pending 与 blocked 两批（后端 `list_suggestions` 只收单个 status，
//     所以是两条查询 —— 少发一条 = 被拦下的建议在界面上凭空消失，与验收「留在队列」相反）；
//   · merge 采纳 → 关抽屉 + 把服务端交回的 id 对交给合并预览（合并本身不在这里落库）；
//   · 采纳被守卫拦下 → 走的是**错误信封**，失效两条队列后那条从 blocked 里读回来；
//   · 工具 tab 列出真实 snake_case 工具名。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { listSuggestions, adoptSuggestion, ignoreSuggestion, runAgentScan, list } = vi.hoisted(
  () => ({
    listSuggestions: vi.fn(),
    adoptSuggestion: vi.fn(),
    ignoreSuggestion: vi.fn(),
    runAgentScan: vi.fn(),
    list: vi.fn()
  })
)

vi.mock('@shared/api/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/api/contacts')>()
  return {
    ...actual,
    createContactsApi: () => ({
      listSuggestions,
      adoptSuggestion,
      ignoreSuggestion,
      runAgentScan,
      list
    })
  }
})

const { toastError, toastSuccess, toastInfo } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))
vi.mock('@shared/state/toast', () => ({ toastError, toastSuccess, toastInfo }))

import i18n from '@shared/i18n'
import { ContactAgentDrawer } from '@shared/components/contacts/ContactAgentDrawer'
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

beforeEach(() => {
  // 提示词编辑区走裸 fetch（`/agent/profile/docs/contact_agent`，与 matters 同源）——
  // 这里只需要让它落定，免得 happy-dom 在 teardown 时把在途请求 abort 成噪声。
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { content: '', defaultContent: '你是通讯录管理员。' } })
    }))
  )
  list.mockResolvedValue({ items: [], total: 0 })
  listSuggestions.mockImplementation(async ({ status }: { status: string }) =>
    status === 'pending' ? { items: [PENDING], next_cursor: null } : { items: [BLOCKED], next_cursor: null }
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
        ? { items: [{ ...PENDING, id: 13, type: 'identity', contact_ids: [3], payload: { field: 'department', value: 'Legal' } }], next_cursor: null }
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

  test('「现在跑一次」：coalesced 时说复用那一轮，不谎报排了新队', async () => {
    runAgentScan.mockResolvedValue({ job_id: 5, status: 'running', created: false, coalesced: true })
    renderDrawer()
    fireEvent.click(screen.getByText('现在跑一次治理扫描'))
    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith('已有一轮治理扫描在跑 · 复用那一轮，没有重复排队')
    )
    expect(toastSuccess).not.toHaveBeenCalled()
  })
})

describe('ContactAgentDrawer · 工具 tab', () => {
  test('列出真实 snake_case 工具名与三档权限（不照抄原型的点号写法）', async () => {
    renderDrawer()
    fireEvent.click(screen.getByText('它能做什么'))
    await waitFor(() => expect(screen.getByText('contact_search')).toBeTruthy())

    expect(screen.getByText('contact_propose_merge')).toBeTruthy()
    expect(screen.getByText('contact_refresh_profile')).toBeTruthy()
    expect(screen.queryByText('contacts.search')).toBeNull()
    expect(screen.getAllByText('读')).toHaveLength(3)
    expect(screen.getAllByText('建议')).toHaveLength(3)
    expect(screen.getAllByText('写（轻）')).toHaveLength(3)
    // 副标说「它读、它提议」，同屏列着写工具 —— 必须说清那三件治理扫描拿不到。
    expect(
      screen.getByText(
        '标「写（轻）」的三件只在主对话里可用，每天那轮治理扫描一件写工具都拿不到。'
      )
    ).toBeTruthy()
  })
})
