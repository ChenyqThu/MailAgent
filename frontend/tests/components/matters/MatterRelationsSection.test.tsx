// @vitest-environment happy-dom
//
// G-15 —— 关联事项的渲染面。此前后端能写、前端零展示（能力落空点），所以这里盯的是
// 「写进去的东西真的看得见」：关系类型 / 对端标题 / PubId / 备注 / 点进对端。
//
// 🔴 关系是**有向**的，本事项可能在任一端 —— 卡上永远显示对端，且入向要用被动措辞
//（`depends_on` 出向是「依赖」，入向是「被依赖」），否则方向读反。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter, MatterRelation } from '@shared/api/types/matter'
import { useMatterNavigation } from '@shared/components/matters/navigation'

const { listRelations, deleteRelation, list } = vi.hoisted(() => ({
  listRelations: vi.fn(),
  deleteRelation: vi.fn(),
  list: vi.fn()
}))

vi.mock('@shared/components/matters/hooks', () => ({
  // G-33 —— `useMatterUndoToast` 经这条通道执行撤销；本用例不点撤销，给个哑实现即可。
  useMatterChatApi: () => ({ contextSnapshot: vi.fn(), applyUndo: vi.fn() }),
  useMattersApi: () => ({ listRelations, deleteRelation, list })
}))

const { MatterRelationsSection } = await import('@shared/components/matters/MatterRelationsSection')

await i18n.changeLanguage('zh-CN')

const matter = { public_id: 'MAT-0001', version: 3, title: 'Ours' } as unknown as Matter

function relation(overrides: Partial<MatterRelation> = {}): MatterRelation {
  return {
    id: 7,
    source_matter_id: 1,
    target_matter_id: 2,
    relation_type: 'depends_on',
    confidence: null,
    provenance: { note: '等对方合规先过' },
    provenance_json: '{"note":"等对方合规先过"}',
    confirmed_at: null,
    deleted_at: null,
    created_at: 0,
    updated_at: 0,
    source_public_id: 'MAT-0001',
    source_title: 'Ours',
    target_public_id: 'MAT-0042',
    target_title: 'Vendor compliance',
    ...overrides
  }
}

function renderSection(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MatterRelationsSection matter={matter} onChanged={() => {}} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue({ items: [] })
  useMatterNavigation.setState({ targetPublicId: null })
})

afterEach(cleanup)

describe('MatterRelationsSection', () => {
  test('出向关系：类型 Pip + 对端标题 + PubId + provenance.note 备注', async () => {
    listRelations.mockResolvedValue([relation()])
    renderSection()
    await waitFor(() => expect(screen.getByText('Vendor compliance')).toBeTruthy())
    expect(screen.getByText('MAT-0042')).toBeTruthy()
    expect(screen.getByText('依赖')).toBeTruthy()
    expect(screen.getByText('等对方合规先过')).toBeTruthy()
  })

  test('入向关系显示对端 + 被动措辞（方向不读反）', async () => {
    listRelations.mockResolvedValue([
      relation({
        source_public_id: 'MAT-0042',
        source_title: 'Upstream deal',
        target_public_id: 'MAT-0001',
        target_title: 'Ours'
      })
    ])
    renderSection()
    await waitFor(() => expect(screen.getByText('Upstream deal')).toBeTruthy())
    expect(screen.getByText('被依赖')).toBeTruthy()
    expect(screen.queryByText('Ours')).toBeNull()
  })

  test('点对端卡片 → 打开那个事项', async () => {
    listRelations.mockResolvedValue([relation()])
    renderSection()
    await waitFor(() => expect(screen.getByText('Vendor compliance')).toBeTruthy())
    screen.getByText('Vendor compliance').closest('button')?.click()
    expect(useMatterNavigation.getState().targetPublicId).toBe('MAT-0042')
  })

  test('没有备注时不渲染空段；空列表走空态', async () => {
    listRelations.mockResolvedValue([relation({ provenance: {} })])
    renderSection()
    await waitFor(() => expect(screen.getByText('Vendor compliance')).toBeTruthy())
    expect(screen.queryByText('等对方合规先过')).toBeNull()

    cleanup()
    listRelations.mockResolvedValue([])
    renderSection()
    await waitFor(() => expect(screen.getByText('还没有关联事项')).toBeTruthy())
  })
})
