// @vitest-environment happy-dom
//
// 2a review LOW-3 —— 「几条会话被订阅」不能按选中数报。
//
// 勾了「订阅整条会话」只是**请求** `link_scope: 'thread'`；没有 thread_id 的邮件后端会退成
// 单封关联并回一条 `thread_unavailable` warning。按 `mailPicked.length` 报数 = 对着一封没有
// 线程的邮件也说「1 条会话已订阅」。判据必须取每次写入自己返回的 warnings。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter } from '@shared/api/types/matter'

const { mattersApi, mailApi, toastSuccess } = vi.hoisted(() => ({
  mattersApi: {
    listResourceCandidates: vi.fn(),
    listResourceAttachments: vi.fn(),
    linkResource: vi.fn()
  },
  mailApi: { email: { list: vi.fn(), search: vi.fn() } },
  toastSuccess: vi.fn()
}))

vi.mock('@shared/components/matters/hooks', () => ({ useMattersApi: () => mattersApi }))
vi.mock('@shared/hooks/useMailApi', () => ({ useMailApi: () => mailApi }))
vi.mock('@shared/hooks/useConnectorQuickRows', () => ({
  useConnectorQuickRows: () => ({ rows: [], available: false, anyActive: false })
}))
vi.mock('@shared/components/settings/custom-ai/shared', () => ({
  fetchConnectorToolsEnabled: vi.fn(async () => false)
}))
vi.mock('@shared/components/matters/useMatterUndoToast', () => ({
  useMatterUndoToast: () => vi.fn()
}))
vi.mock('@shared/state/toast', () => ({
  toastSuccess,
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  useToastStore: { getState: () => ({ push: vi.fn(), dismiss: vi.fn() }) }
}))

const { MatterLinkResourceModal } =
  await import('@shared/components/matters/MatterLinkResourceModal')

await i18n.changeLanguage('zh-CN')

const matter = { public_id: 'MAT-0001', version: 3, title: 'Ours' } as unknown as Matter

function renderModal(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={client}>
      <MatterLinkResourceModal
        matter={matter}
        resources={[]}
        open
        onOpenChange={vi.fn()}
        onChanged={vi.fn()}
      />
    </QueryClientProvider>
  )
}

/** 勾上两封邮件（推荐候选那一组的行）。 */
async function pickTwoMails(): Promise<void> {
  const rows = await screen.findAllByText(/Mail [12]/)
  for (const row of rows) {
    const label = row.closest('label')
    if (label) fireEvent.click(label.querySelector('input[type="checkbox"]') as HTMLInputElement)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mattersApi.listResourceCandidates.mockResolvedValue({
    items: [
      {
        external_key: 'email:1',
        title: 'Mail 1',
        metadata: { internal_id: 1 },
        scope: 'local',
        reason: '同线程',
        evidence: [],
        confidence: 0.7
      },
      {
        external_key: 'email:2',
        title: 'Mail 2',
        metadata: { internal_id: 2 },
        scope: 'local',
        reason: '同线程',
        evidence: [],
        confidence: 0.6
      }
    ],
    local_candidate_count: 2
  })
  mattersApi.listResourceAttachments.mockResolvedValue([])
  mailApi.email.list.mockResolvedValue([])
  mailApi.email.search.mockResolvedValue({ items: [], total_indexed: 0 })
})

afterEach(cleanup)

describe('MatterLinkResourceModal — 订阅数按真实结果报', () => {
  test('一封回了 thread_unavailable → 只算另一封订阅成功', async () => {
    mattersApi.linkResource
      .mockResolvedValueOnce({ matter: { version: 4 }, warnings: [] })
      .mockResolvedValueOnce({ matter: { version: 5 }, warnings: ['thread_unavailable'] })
    renderModal()
    await pickTwoMails()
    fireEvent.click(screen.getByRole('button', { name: /^关联$/ }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    // 关联 2 项、订阅 1 条 —— 而不是「订阅 2 条」。
    expect(toastSuccess.mock.calls[0][0]).toContain('2')
    expect(toastSuccess.mock.calls[0][0]).toMatch(/1 个会话已订阅/)
  })

  test('没勾「订阅整条会话」→ 订阅数为 0', async () => {
    mattersApi.linkResource
      .mockResolvedValueOnce({ matter: { version: 4 }, warnings: [] })
      .mockResolvedValueOnce({ matter: { version: 5 }, warnings: [] })
    renderModal()
    await pickTwoMails()
    fireEvent.click(screen.getByRole('checkbox', { name: /订阅所选会话/ }))
    fireEvent.click(screen.getByRole('button', { name: /^关联$/ }))

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledTimes(1))
    expect(toastSuccess.mock.calls[0][0]).not.toMatch(/会话已订阅/)
  })
})
