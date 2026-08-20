// @vitest-environment happy-dom
//
// v2 任务 ③「记住上次离开的位置」的行为闸。ContactListPane / ContactDetail / 合并对话框 /
// 治理台抽屉全部换成瘦身桩：这几个用例钉的是 ContactsWorkspace 自己的 selectedId / view 编排
// （存 / 取记录、有记录 / 无记录 / 记录已不可见三路分叉、视图在 mount 时就恢复、深链优先级
// 更高），不是那几个组件各自的渲染细节 —— 它们各有自己的测试文件。
//
// 🔴 持久化层走 `vi.mock('@shared/components/contacts/contactLastVisit')` 换成内存实现，不碰
// 真实 `localStorage`：本仓当前 vitest + happy-dom + Node 组合下，happy-dom 环境里裸
// `localStorage` 本身就取不到 —— 拆出独立小模块正是为了让这条闸不依赖那个环境限制。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { ContactRowDto } from '@shared/api/types/contact'

const { ROWS, visitStore, listCalls } = vi.hoisted(() => {
  function person(id: number, name: string): ContactRowDto {
    return {
      id,
      display_name: name,
      formal_name: null,
      organization: null,
      department: null,
      role_title: null,
      function: null,
      seniority: null,
      gender: null,
      kind: 'person',
      hidden_at: null,
      is_self: false,
      mail_count: 40,
      sent_to_count: 12,
      first_seen_at: 1,
      last_seen_at: 2,
      email_count: 1,
      primary_email: `p${id}@corp.test`,
      manager_contact_id: null,
      manager_display_name: null,
      profile_summary: null,
      profile_min: 50,
      profile_eligible: false
    }
  }
  return {
    ROWS: [person(101, '张三'), person(102, '李四'), person(103, '王五')],
    visitStore: { value: null as { id: number; view: 'known' | 'all' } | null },
    listCalls: [] as Array<{ view: string }>
  }
})

vi.mock('@shared/components/contacts/contactLastVisit', () => ({
  readLastContactVisit: () => visitStore.value,
  writeLastContactVisit: (visit: { id: number; view: 'known' | 'all' }) => {
    visitStore.value = visit
  }
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactFlags: () => ({ contactsEnabled: true, contactAgentEnabled: false, loading: false }),
  useContactsApi: () => ({ get: vi.fn(), hide: vi.fn(), setKind: vi.fn(), setSelf: vi.fn() }),
  useInvalidateContact: () => async () => undefined,
  useContactList: (options: { view: string }) => {
    listCalls.push({ view: options.view })
    return { data: { items: ROWS, total: ROWS.length }, isPending: false, isSuccess: true }
  },
  useBackfillProgress: () => ({ data: undefined }),
  useContactAgentStatus: () => ({ data: undefined })
}))

// 列表面只回报它收到的 selectedId —— 编排对不对看这一个属性就够。
vi.mock('@shared/components/contacts/ContactListPane', () => ({
  ContactListPane: (props: { selectedId: number | null; total: number }) => (
    <div
      data-testid="contact-list-pane"
      data-selected-id={props.selectedId ?? ''}
      data-total={props.total}
    />
  )
}))
vi.mock('@shared/components/contacts/ContactDetail', () => ({
  ContactDetail: (props: { contactId: number }) => (
    <div data-testid="contact-detail" data-contact-id={props.contactId} />
  )
}))
vi.mock('@shared/components/contacts/MergeContactsDialog', () => ({
  MergeContactsDialog: () => null
}))
vi.mock('@shared/components/contacts/ContactAgentDrawer', () => ({
  ContactAgentDrawer: () => null
}))

import i18n from '@shared/i18n'
import { ContactsWorkspace } from '@shared/components/contacts/ContactsWorkspace'
import { useContactNavigation } from '@shared/components/contacts/navigation'

await i18n.changeLanguage('zh-CN')

/** ContactsWorkspace 内部有三条 `useMutation`（治理写面），所以仍要 QueryClientProvider ——
 *  即便列表 / 详情那几条查询已经被上面的 hooks mock 换掉。 */
function renderWorkspace(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ContactsWorkspace />
    </QueryClientProvider>
  )
}

function selectedId(): string {
  return screen.getByTestId('contact-list-pane').getAttribute('data-selected-id') ?? ''
}

beforeEach(() => {
  visitStore.value = null
  listCalls.length = 0
  useContactNavigation.getState().clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContactsWorkspace · 冷启动选中', () => {
  test('无记录 → 默认选中列表第一个', async () => {
    renderWorkspace()
    await waitFor(() => expect(selectedId()).toBe('101'))
  })

  test('有记录且那个人还在可见集里 → 恢复它（不是巧合命中第一条）', async () => {
    visitStore.value = { id: 103, view: 'known' }
    renderWorkspace()
    await waitFor(() => expect(selectedId()).toBe('103'))
    expect(screen.getByTestId('contact-detail').getAttribute('data-contact-id')).toBe('103')
  })

  test('记录里的人已不可见（合并 / 隐藏 / 改判）→ 退化成第一个', async () => {
    visitStore.value = { id: 999, view: 'known' }
    renderWorkspace()
    await waitFor(() => expect(selectedId()).toBe('101'))
    // 🔴 退化**不回写**记录：那一条还可能有用（那个人只是暂时不在这个视图里），
    // 用「列表恰好第一行」把它覆盖掉是不可逆的。
    expect(visitStore.value).toEqual({ id: 999, view: 'known' })
  })

  test('视图在 mount 时就恢复 —— 不先按默认视图拉一次再切过去', async () => {
    visitStore.value = { id: 102, view: 'all' }
    renderWorkspace()
    await waitFor(() => expect(selectedId()).toBe('102'))
    // 一次都不该以 'known' 发起列表查询（多一次请求 + 一次跳版）。
    expect(listCalls.every((call) => call.view === 'all')).toBe(true)
  })

  test('深链（⌘K / PersonChip）压过冷启动初选', async () => {
    visitStore.value = { id: 103, view: 'known' }
    act(() => {
      useContactNavigation.getState().open(102)
    })
    renderWorkspace()
    await waitFor(() => expect(selectedId()).toBe('102'))
  })
})
