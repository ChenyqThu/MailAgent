// @vitest-environment happy-dom
//
// G-14 入口 + G-17 三小项在 ContextTab 上的接线。
//   · G-14 —— 「关联资料」按钮存在（0812 之前 ContextTab 一个添加口都没有）；
//   · G-17 ② —— 资料行上有「解除关联」（此前只在 ResourceDrawer 里，要先点开抽屉）；
//   · G-17 ③ —— 分组头右侧「+ 关联」；
//   · G-17 ① —— 干系人「最近联系」能定位到邮件时才是按钮，定位不到就是静态文字
//     （不做「永远可点但点了没反应」）。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter, MatterResourceListItem, MatterStakeholder } from '@shared/api/types/matter'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { useActiveEmail } from '@shared/state/active-email'

const { navigate, listRelations, deleteStakeholder, unlinkResource, list } = vi.hoisted(() => ({
  navigate: vi.fn(),
  listRelations: vi.fn(),
  deleteStakeholder: vi.fn(),
  unlinkResource: vi.fn(),
  list: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
// 通讯录 WP4 —— 干系人卡互链入口的 flag 投影（真 hook 会 fetch /chat/config；
// 测试里钉 enabled=true 让可点分支可断言）。🔴 partial mock：本 tab 还渲染
// MatterStakeholderPicker，它 import 同模块的 useContactList 等 hooks——整模块
// 替换会把它们炸成 undefined。navigation store 用真实现。
vi.mock('@shared/components/contacts/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/components/contacts/hooks')>()
  return { ...actual, useContactsEnabled: () => ({ enabled: true, loading: false }) }
})
vi.mock('@shared/components/matters/hooks', () => ({
  // G-33 —— `useMatterUndoToast` 经这条通道执行撤销；本用例不点撤销，给个哑实现即可。
  useMatterChatApi: () => ({ contextSnapshot: vi.fn(), applyUndo: vi.fn() }),
  useMattersApi: () => ({
    listRelations,
    deleteStakeholder,
    unlinkResource,
    list,
    listResourceCandidates: vi.fn(),
    listResourceAttachments: vi.fn()
  })
}))

const { MatterContextTab } = await import('@shared/components/matters/MatterContextTab')

await i18n.changeLanguage('zh-CN')

const matter = { public_id: 'MAT-0001', version: 3, title: 'Ours' } as unknown as Matter

function emailResource(id: number): MatterResourceListItem {
  return {
    resource: {
      id,
      kind: 'email',
      provider: 'mailagent',
      external_key: `email:${900 + id}`,
      canonical_url: null,
      title: `Kickoff mail ${id}`,
      metadata: { sender: 'peer@vendor.com' },
      access_policy: 'allowed',
      created_at: 0,
      updated_at: 0,
      available: true
    },
    link: {
      id,
      matter_id: 1,
      resource_id: id,
      relation_type: null,
      pinned: false,
      added_by_kind: 'user',
      added_by_id: null,
      confidence: null,
      provenance: {},
      confirmed_at: 1,
      sub_state: 'none',
      deleted_at: null,
      created_at: 0,
      updated_at: 0
    }
  } as unknown as MatterResourceListItem
}

function stakeholder(
  sourceResourceId: number | null,
  contactId: number | null = null
): MatterStakeholder {
  return {
    id: 1,
    matter_id: 1,
    person_key: 'peer@vendor.com',
    display_name: 'Peer Name',
    email_normalized: 'peer@vendor.com',
    organization: 'Vendor',
    role: '审批人',
    relationship: null,
    is_waiting_on: false,
    last_contact_at: 1_700_000_000_000,
    source_resource_id: sourceResourceId,
    contact_id: contactId,
    deleted_at: null,
    created_at: 0,
    updated_at: 0
  }
}

function renderTab(stakeholders: MatterStakeholder[]): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MatterContextTab
        matter={matter}
        items={[]}
        resources={[emailResource(5)]}
        stakeholders={stakeholders}
        onOpenResource={() => {}}
        onTogglePin={() => {}}
        onChanged={() => {}}
      />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listRelations.mockResolvedValue([])
  list.mockResolvedValue({ items: [] })
  useActiveEmail.setState({ activeInternalId: null })
  useContactNavigation.setState({ targetContactId: null })
})

afterEach(cleanup)

describe('MatterContextTab —— G-14 / G-17 入口', () => {
  test('G-14：段头有「关联资料」入口', () => {
    renderTab([stakeholder(5)])
    expect(screen.getAllByRole('button', { name: '关联资料' }).length).toBeGreaterThan(0)
  })

  test('G-17 ②③：资料行有「解除关联」，分组头有「+ 关联」', () => {
    renderTab([stakeholder(5)])
    expect(screen.getByRole('button', { name: '解除关联' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: '往这一组关联资料' }).length).toBeGreaterThan(0)
  })

  test('G-17 ①：来源资料能定位到邮件 → 「最近联系」是按钮，点了打开那封邮件', () => {
    renderTab([stakeholder(5)])
    const button = screen.getByRole('button', { name: /最近联系/ })
    button.click()
    expect(useActiveEmail.getState().activeInternalId).toBe(905)
    expect(navigate).toHaveBeenCalledWith({ to: '/' })
  })

  test('G-17 ①：定位不到邮件（手输入的干系人）→ 是静态文字，不是假按钮', () => {
    renderTab([stakeholder(null)])
    expect(screen.queryByRole('button', { name: /最近联系/ })).toBeNull()
    expect(screen.getByText(/最近联系/)).toBeTruthy()
  })

  // 通讯录 WP4 —— 干系人卡「头像+姓名」块的人物页互链入口。
  test('WP4：contact_id 非空 → 身份块是按钮，点击落 navigation store + 跳 /contacts', () => {
    renderTab([stakeholder(5, 42)])
    const button = screen.getByRole('button', { name: /Peer Name/ })
    expect(button.getAttribute('title')).toBe('打开 Peer Name 的人物页')
    button.click()
    expect(useContactNavigation.getState().targetContactId).toBe(42)
    expect(navigate).toHaveBeenCalledWith({ to: '/contacts' })
  })

  test('WP4：contact_id 为空（纯本事项行）→ 身份块不是按钮（不做假入口）', () => {
    renderTab([stakeholder(5, null)])
    expect(screen.queryByRole('button', { name: /Peer Name/ })).toBeNull()
    expect(screen.getByText('Peer Name')).toBeTruthy()
  })
})
