// @vitest-environment happy-dom
//
// 通讯录工作台的三条**加载/渲染形态**闸（task 08-20-perf-contacts-render）：
//
// ① 渲染放大（P1-6）：搜索框每敲一个字符，老形态会重渲染整个工作台 —— 虚拟列表的每个可见行
//    + 千行详情树。根因是两处叠加：`qInput` 住在 workspace、`actions` 的 useMemo 依赖里放了
//    react-query v5 每次 render 都换新的 `useMutation` 返回对象（⇒ actions 每次都是新引用 ⇒
//    摊进 rowProps 后 react-window 的浅比较全线失效）。这道闸数的就是可见行的 render 次数。
//    🔴 数之前先断言「本来有行在渲染」——不然这条断言在 0 == 0 上恒绿。
// ② waterfall（P0-3 的第 2/3 跳）：上次选中的人在 mount 时就进 selectedId，详情与列表并发发出，
//    而不是等列表落定的 effect 才产生 selectedId。
// ③ 显示档位持久化（P3-10）：`sort` 进列表 queryKey —— 不记住 = 改过排序切走再回来必冷取。
//
// 列表面 / 行渲染用**真件**（这三件事全在它们身上），详情页与两个 overlay 用瘦身桩。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { RowComponentProps } from 'react-window'

import type { ContactRowDto } from '@shared/api/types/contact'

const {
  API,
  EMPTY_QUERY,
  LOADED_LIST,
  PENDING_LIST,
  visitStore,
  prefsStore,
  listCalls,
  listState,
  rowRenders,
  detailRenders
} = vi.hoisted(() => {
  function person(id: number, name: string): ContactRowDto {
    return {
      id,
      display_name: name,
      formal_name: null,
      organization: 'Omada Networks',
      department: null,
      role_title: '架构师',
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
  const rows = Array.from({ length: 30 }, (_unused, index) =>
    person(101 + index, `联系人 ${index}`)
  )
  const noop = (): void => undefined
  const pageShape = {
    fetchNextPage: noop,
    hasNextPage: false,
    isFetchingNextPage: false
  }
  return {
    // 🔴 三份返回值都是**常量**：react-query 在没有新数据时 `data` 是稳定引用，桩每次 render
    // 现造一个新对象会让 `items` / `rows` 的 useMemo 恒失效 —— 那样下面数 render 次数的两条闸
    // 测的就是桩的形态、不是被测代码的形态（第一版就是这么写的，结果闸红在自己身上）。
    EMPTY_QUERY: { data: undefined },
    // 同理：真的 `useContactsApi` 是 `useMemo(…, [])`（稳定），桩每次现造一个对象会让
    // `actions` 的 useMemo 恒失效。
    API: { get: noop, hide: noop, setKind: noop, setSelf: noop },
    LOADED_LIST: {
      data: { pages: [{ items: rows, total: rows.length, next_cursor: null }] },
      isPending: false,
      isSuccess: true,
      ...pageShape
    },
    PENDING_LIST: { data: undefined, isPending: true, isSuccess: false, ...pageShape },
    visitStore: { value: null as { id: number; view: 'known' | 'all' } | null },
    prefsStore: {
      value: { sort: 'density', groupBy: 'none', density: 'compact' } as {
        sort: 'density' | 'recent' | 'name'
        groupBy: string
        density: string
      }
    },
    listCalls: [] as Array<{ view: string; q: string; sort: string }>,
    listState: { pending: false },
    rowRenders: { count: 0 },
    detailRenders: { count: 0 }
  }
})

vi.mock('@shared/components/contacts/contactLastVisit', () => ({
  readLastContactVisit: () => visitStore.value,
  writeLastContactVisit: (visit: { id: number; view: 'known' | 'all' }) => {
    visitStore.value = visit
  }
}))

// 持久化层同 contactLastVisit 走内存桩：happy-dom 环境里裸 localStorage 取不到。
vi.mock('@shared/components/contacts/contactListPrefs', () => ({
  readContactListPrefs: () => prefsStore.value,
  writeContactListPrefs: (prefs: typeof prefsStore.value) => {
    prefsStore.value = prefs
  }
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsApi: () => API,
  useInvalidateContact: () => async () => undefined,
  useContactListPaged: (options: { view: string; q: string; sort: string }) => {
    listCalls.push({ view: options.view, q: options.q, sort: options.sort })
    return listState.pending ? PENDING_LIST : LOADED_LIST
  },
  useBackfillProgress: () => EMPTY_QUERY,
  useContactAgentStatus: () => EMPTY_QUERY
}))

// 行是真件 —— 只在外面套一层计数（react-window 拿到的仍是同一个稳定引用的组件）。
vi.mock('@shared/components/contacts/ContactRow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/components/contacts/ContactRow')>()
  return {
    ...actual,
    ContactVirtualRow: (
      props: RowComponentProps<import('@shared/components/contacts/ContactRow').ContactRowsProps>
    ) => {
      rowRenders.count += 1
      return createElement(actual.ContactVirtualRow, props)
    }
  }
})

vi.mock('@shared/components/contacts/ContactDetail', () => ({
  ContactDetail: (props: { contactId: number }) => {
    detailRenders.count += 1
    return <div data-testid="contact-detail" data-contact-id={props.contactId} />
  }
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

function renderWorkspace(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ContactsWorkspace />
    </QueryClientProvider>
  )
}

function searchInput(): HTMLInputElement {
  return screen.getByLabelText('搜索姓名 / 名字变体 / 邮箱 / 组织') as HTMLInputElement
}

beforeEach(() => {
  visitStore.value = null
  prefsStore.value = { sort: 'density', groupBy: 'none', density: 'compact' }
  listCalls.length = 0
  listState.pending = false
  rowRenders.count = 0
  detailRenders.count = 0
  useContactNavigation.getState().clear()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContactsWorkspace · 渲染放大', () => {
  test('搜索框敲字：可见行与详情页都不重渲染（防抖前的每一帧）', async () => {
    renderWorkspace()
    await waitFor(() => expect(screen.getByTestId('contact-detail')).toBeTruthy())

    // 🔴 先证明「本来有行在渲染」——否则下面的「次数不变」在 0 上恒成立。
    await waitFor(() => expect(rowRenders.count).toBeGreaterThan(0))
    expect(document.querySelectorAll('[data-react-window-index]').length).toBeGreaterThan(0)
    const rowsBefore = rowRenders.count
    const detailBefore = detailRenders.count

    for (const value of ['张', '张三', '张三丰']) {
      fireEvent.change(searchInput(), { target: { value } })
    }
    expect(searchInput().value).toBe('张三丰')

    expect(rowRenders.count).toBe(rowsBefore)
    expect(detailRenders.count).toBe(detailBefore)
  })

  test('workspace 自己重渲染（拖宽列表列）也不带着可见行重渲染', async () => {
    // 🔴 这条与上面那条钉的是**两处不同的修复**：上面钉「敲字不再惊动 workspace」，这条钉
    // 「workspace 真的重渲染时，rowProps 的浅比较仍然拦得住」——后者要求 `actions` /
    // `onToggleGroup` 是稳定引用（v5 的 useMutation 返回对象放进依赖数组就恒失效）。
    // 拖宽只改 `listWidth`，与行数据无关，是最干净的「无关重渲染」触发器。
    renderWorkspace()
    await waitFor(() => expect(rowRenders.count).toBeGreaterThan(0))
    const separator = screen.getByRole('separator', { name: '拖动调整列表宽度' })
    const rowsBefore = rowRenders.count

    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    fireEvent.keyDown(separator, { key: 'ArrowRight' })

    expect(separator.getAttribute('aria-valuenow')).not.toBe('320')
    expect(rowRenders.count).toBe(rowsBefore)
  })

  test('防抖过后搜索词照常上行进查询（下沉输入框没把搜索弄丢）', async () => {
    renderWorkspace()
    await waitFor(() => expect(rowRenders.count).toBeGreaterThan(0))

    fireEvent.change(searchInput(), { target: { value: ' 张三 ' } })
    // 防抖 250ms 之后列表查询才该看见它（trim 过）。
    await waitFor(() => expect(listCalls.at(-1)?.q).toBe('张三'), { timeout: 2000 })
  })
})

describe('ContactsWorkspace · waterfall', () => {
  test('列表还在 pending 时，详情已经按上次的记录挂起来了', async () => {
    visitStore.value = { id: 117, view: 'known' }
    listState.pending = true
    renderWorkspace()

    const detail = await screen.findByTestId('contact-detail')
    expect(detail.getAttribute('data-contact-id')).toBe('117')
    // 列表确实还没落定（这一帧的骨架屏就是证据）。
    expect(screen.getByTestId('contact-list-skeleton')).toBeTruthy()
  })

  test('列表落定后那个人不在可见集里 → 仍然退化成第一行', async () => {
    visitStore.value = { id: 999, view: 'known' }
    renderWorkspace()
    await waitFor(() =>
      expect(screen.getByTestId('contact-detail').getAttribute('data-contact-id')).toBe('101')
    )
    // 退化**不回写**记录（v2 任务 ③ 的老纪律，不该被本批改掉）。
    expect(visitStore.value).toEqual({ id: 999, view: 'known' })
  })
})

describe('ContactsWorkspace · 显示档位持久化', () => {
  test('mount 时就按记住的排序发查询（不先按默认档拉一次）', async () => {
    prefsStore.value = { sort: 'name', groupBy: 'none', density: 'compact' }
    renderWorkspace()
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0))
    expect(listCalls.every((call) => call.sort === 'name')).toBe(true)
  })

  test('改排序 → 落盘（下次进来才不会退回默认档）', async () => {
    renderWorkspace()
    await waitFor(() => expect(rowRenders.count).toBeGreaterThan(0))

    fireEvent.click(screen.getByLabelText('排序'))
    fireEvent.click(await screen.findByText('最近往来'))

    await waitFor(() => expect(prefsStore.value.sort).toBe('recent'))
    expect(listCalls.at(-1)?.sort).toBe('recent')
  })
})
