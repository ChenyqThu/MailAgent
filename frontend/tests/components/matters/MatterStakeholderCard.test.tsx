// @vitest-environment happy-dom
//
// 干系人卡的**版式契约**（mockup `frontend/mockups/stakeholder/` 验收版）。
//
// owner 反馈的四条都在这里钉住：
//   · 操作图标从右上角挪到**底栏右侧** —— 放右上角就得给名字恒留 ~96px 让位，
//     4 列密度下「Lucien Chen（陈源泉）」会被截成「Lucien Chen（…」；
//   · 角色是**正文文字 + 2 行封顶**，不再塞进圆角药丸（药丸装不下长角色，会撑两行
//     还把右边的「最近联系」挤没）；
//   · 等待态只留**两个**信号（名字后一颗琥珀点 + 卡片 warn 边框底色）——
//     原来是四个（badge + 头像 ring + 内层底色盒 + 边框），互相打架；
//   · 卡等高（`h-full flex-col` + 底栏 `mt-auto`）。
// 外加：空的「核心」组要有够大的落点（92px 虚线），否则拖过去命中不到。
//
// 卡是**跨两个文件**拼出来的（壳 + 操作在 MatterStakeholderSection，内容在
// MatterContextTab 的 renderBody），所以这里渲染 ContextTab 而不是单测某一个。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'

import i18n from '@shared/i18n'
import type { Matter, MatterStakeholder } from '@shared/api/types/matter'

const { navigate, listRelations, deleteStakeholder, unlinkResource, list } = vi.hoisted(() => ({
  navigate: vi.fn(),
  listRelations: vi.fn(),
  deleteStakeholder: vi.fn(),
  unlinkResource: vi.fn(),
  list: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('@shared/components/contacts/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/components/contacts/hooks')>()
  return { ...actual, useContactsEnabled: () => ({ enabled: false, loading: false }) }
})
vi.mock('@shared/components/matters/hooks', () => ({
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

function stakeholder(overrides: Partial<MatterStakeholder> = {}): MatterStakeholder {
  return {
    id: 1,
    matter_id: 1,
    person_key: 'peer@vendor.com',
    display_name: 'Lucien Chen（陈源泉）',
    email_normalized: 'peer@vendor.com',
    organization: 'ENBU / Omada',
    role: 'Controller 平台整体负责人',
    relationship: null,
    is_waiting_on: false,
    last_contact_at: null,
    source_resource_id: null,
    contact_id: null,
    tier: 'normal',
    deleted_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides
  } as unknown as MatterStakeholder
}

function renderTab(stakeholders: MatterStakeholder[]): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const { container } = render(
    <QueryClientProvider client={client}>
      <MatterContextTab
        matter={matter}
        items={[]}
        resources={[]}
        stakeholders={stakeholders}
        onOpenResource={() => {}}
        onTogglePin={() => {}}
        onChanged={() => {}}
      />
    </QueryClientProvider>
  )
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  listRelations.mockResolvedValue([])
  list.mockResolvedValue({ items: [] })
})

afterEach(cleanup)

const ACTIONS = ['设为核心干系人', '编辑干系人', '移除干系人'] as const

describe('干系人卡版式', () => {
  test('🔴 四颗操作图标在底栏里，不在右上角的绝对定位块里', () => {
    renderTab([stakeholder()])
    const buttons = [
      ...ACTIONS.map((name) => screen.getByRole('button', { name })),
      screen.getByRole('button', { name: /拖动排序/ })
    ]
    for (const button of buttons) {
      expect(button.closest('footer')).not.toBeNull()
      // 右上角那块是 `absolute right-2 top-2` —— 图标不许再回去。
      expect(button.closest('.absolute')).toBeNull()
    }
  })

  test('🔴 名字不为图标让位：不预留右内边距，且自己 truncate', () => {
    const container = renderTab([stakeholder()])
    const name = screen.getByText('Lucien Chen（陈源泉）')
    expect(name.className).toContain('truncate')
    // `pr-24`（96px 让位）是右上角图标方案的遗留，挪到底栏后必须消失。
    expect(container.querySelector('.pr-24')).toBeNull()
  })

  test('🔴 角色是正文文字 + 2 行封顶，不是药丸', () => {
    renderTab([stakeholder()])
    const role = screen.getByText('Controller 平台整体负责人')
    expect(role.className).toContain('line-clamp-2')
    expect(role.className).not.toContain('rounded-full')
  })

  test('🔴 等待态只有两个信号：琥珀点 + 卡片边框底色（无 badge、无头像 ring、无内层盒）', () => {
    const container = renderTab([stakeholder({ is_waiting_on: true })])
    // 文案挪进 tooltip：静止时页面上不该出现「等待中」这类常驻 badge 文字。
    expect(screen.queryByText('等待中')).toBeNull()
    expect(screen.getByRole('img', { name: '等待对方回复' })).toBeTruthy()
    expect(container.querySelector('[class*="ring-2"]')).toBeNull()
    // 卡片本体带 warn 边框；内层不再套第二层 warn 底色盒。
    const card = container.querySelector('article')!
    expect(card.className).toContain('border-warn/20')
    // 卡里唯一带 warn 底色的东西是那颗 1.5×1.5 的点 —— 不许再冒出第二层底色盒。
    expect([...card.querySelectorAll('[class*="bg-warn"]')].map((el) => el.className)).toEqual([
      expect.stringContaining('h-1.5')
    ])
  })

  test('🔴 卡等高：h-full flex-col + 底栏 mt-auto', () => {
    const container = renderTab([stakeholder()])
    const card = container.querySelector('article')!
    expect(card.className).toContain('h-full')
    expect(card.className).toContain('flex-col')
    expect(container.querySelector('footer')!.className).toContain('mt-auto')
  })

  test('操作图标挂了 tooltip（Radix trigger 的 data-state）', () => {
    renderTab([stakeholder()])
    for (const name of ACTIONS) {
      expect(screen.getByRole('button', { name }).getAttribute('data-state')).toBe('closed')
    }
  })

  test('🔴 grip 上的 dnd-kit attributes 没被 tooltip 的 asChild 合并吃掉 —— 吃掉就拖不动了', () => {
    renderTab([stakeholder()])
    const grip = screen.getByRole('button', { name: /拖动排序/ })
    expect(grip.getAttribute('aria-roledescription')).toBeTruthy()
  })

  test('🔴 空的「核心」组渲染 92px 落点 —— 一行文字高的落点拖过去命中不到', () => {
    const container = renderTab([stakeholder()])
    const hint = screen.getByText(/还没标核心干系人/)
    expect(hint.closest('[class*="min-h-[92px]"]')).not.toBeNull()
    // 虚线框，且它就是 core 组的空态（normal 组有人，不走空态）。
    expect(container.querySelector('.border-dashed')).not.toBeNull()
  })
})
