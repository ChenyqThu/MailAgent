// @vitest-environment happy-dom
//
// 人物档案页的两条**加载/渲染形态**闸（task 08-20-perf-contacts-render）：
//
// ① waterfall 拆解（P0-3 的第 4 跳）：关联邮件 / 关联事项原先只挂在「detail 到了才渲染」的
//    子树里 —— 详情请求回来之前它们连挂载都没挂载，于是 `GET /contacts/{id}` 成了这两条
//    请求的发车信号。现在三条在 mount 那一刻并发发出。这道闸钉的就是「detail 还悬着的时候
//    mails/matters 已经发出去了」，肉眼在界面上看不出来（骨架屏一样好看）。
// ② `React.memo`（P1-6）：这棵树上千行，props 全部来自 `ContactsWorkspace` —— 那边任何一次
//    state 变动（老形态里包括搜索框每敲一个字符）都会把它整棵重渲染一遍。
//
// 渲染计数用 `ContactProfileCard` 的桩：它在详情树里恒渲染一次（kind='person'），
// 数它的 render 次数 = 数详情树的 render 次数。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { apiGet, apiListMails, apiListMatters, profileCardRenders } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiListMails: vi.fn(),
  apiListMatters: vi.fn(),
  profileCardRenders: { count: 0 }
}))

vi.mock('@shared/api/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/api/contacts')>()
  const named: Record<string, unknown> = {
    get: apiGet,
    listMails: apiListMails,
    listMatters: apiListMatters
  }
  return {
    ...actual,
    // 详情页子树会摸到一串端点（画像刷新 / 锁 / 主邮箱 / 组织关系搜索…）——
    // 逐个列出来只会让这份测试跟着无关端点漂（同 ContactDetailGender.test 的兜底）。
    createContactsApi: () =>
      new Proxy(named, {
        get: (target, prop: string) => {
          if (!(prop in target)) target[prop] = vi.fn(async () => ({ items: [], total: 0 }))
          return target[prop]
        }
      })
  }
})

vi.mock('@shared/components/contacts/ContactProfileCard', () => ({
  ContactProfileCard: () => {
    profileCardRenders.count += 1
    return <div data-testid="profile-card" />
  }
}))

vi.mock('@shared/state/toast', () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn()
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@shared/state/active-email', () => ({
  useActiveEmail: (selector: (s: { setActive: () => void }) => unknown) =>
    selector({ setActive: vi.fn() })
}))

import i18n from '@shared/i18n'
import type { ContactDetailDto } from '@shared/api/types/contact'
import { ContactDetail } from '@shared/components/contacts/ContactDetail'

await i18n.changeLanguage('zh-CN')

const ACTIONS = { onSetKind: vi.fn(), onToggleSelf: vi.fn(), onToggleHidden: vi.fn() }

function detail(): ContactDetailDto {
  return {
    id: 7,
    display_name: '张伟',
    formal_name: null,
    organization: 'Omada Networks',
    department: null,
    role_title: '架构师',
    function: null,
    seniority: null,
    gender: null,
    kind: 'person',
    kind_locked_at: null,
    is_self: false,
    hidden_at: null,
    merged_into: null,
    notes: null,
    phone: null,
    contact_info: {},
    name_variants: [],
    identity_locks: {},
    mail_count: 12,
    sent_to_count: 3,
    first_seen_at: null,
    last_seen_at: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    emails: [
      {
        address: 'zhang@example.com',
        is_primary: true,
        former_at: null,
        mail_count: 12,
        first_seen_at: null,
        last_seen_at: null
      }
    ],
    manager: null,
    manager_src: null,
    reports: [],
    peers: [],
    profile: {
      profile_updated_at: null,
      profile_mail_count: 0,
      profile_model: null,
      profile_status: null,
      profile_attempted_at: null,
      profile_error: null,
      attempted_mail_count: null,
      status: 'unconfigured',
      profile_min: 50,
      eligible: false,
      needed_mail_count: 38,
      suggestions: [],
      document: null,
      profile_json: null
    }
  }
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
}

beforeEach(() => {
  profileCardRenders.count = 0
  apiListMails.mockResolvedValue({ items: [], total: 0, next_cursor: null })
  apiListMatters.mockResolvedValue({ items: [], total: 0 })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('ContactDetail · waterfall', () => {
  test('detail 还没落地时，关联邮件 / 关联事项已经发出（不再等第 4 跳）', async () => {
    // detail 悬着不 resolve —— 老形态下这两条请求要等它 resolve 之后才可能发出。
    let resolveDetail: ((value: ContactDetailDto) => void) | undefined
    apiGet.mockReturnValue(
      new Promise<ContactDetailDto>((resolve) => {
        resolveDetail = resolve
      })
    )

    render(
      <QueryClientProvider client={client()}>
        <ContactDetail contactId={7} showBack={false} actions={ACTIONS} />
      </QueryClientProvider>
    )

    // 此刻界面上是骨架（detail 未落地），但两条关联查询必须已经在路上。
    await waitFor(() => expect(apiListMails).toHaveBeenCalled())
    expect(apiListMatters).toHaveBeenCalled()
    expect(screen.getByTestId('contact-detail-skeleton')).toBeTruthy()
    expect(apiListMails.mock.calls[0]?.[0]).toBe(7)

    await act(async () => {
      resolveDetail?.(detail())
    })
    await screen.findByText('身份信息')
    // 顶层与子组件同 queryKey ⇒ react-query 去重：并发不等于多发一次请求。
    expect(apiListMails).toHaveBeenCalledTimes(1)
    expect(apiListMatters).toHaveBeenCalledTimes(1)
  })
})

describe('ContactDetail · memo', () => {
  test('父层重渲染但 props 没变 → 详情树不重渲染', async () => {
    apiGet.mockResolvedValue(detail())

    // 🔴 QueryClientProvider 留在重渲染的组件**外面**：provider 的 value 变了会强制刷新
    // 每一个 query 消费者，memo 与否都拦不住 —— 那样这道闸测的就不是 memo 了。
    function Host(): React.ReactElement {
      const [tick, setTick] = useState(0)
      return (
        <>
          <button type="button" data-testid="bump" onClick={() => setTick((n) => n + 1)}>
            {tick}
          </button>
          <ContactDetail contactId={7} showBack={false} actions={ACTIONS} />
        </>
      )
    }

    render(
      <QueryClientProvider client={client()}>
        <Host />
      </QueryClientProvider>
    )
    await screen.findByTestId('profile-card')
    const before = profileCardRenders.count

    // 父层连续 render 三次（模拟 workspace 侧的搜索框敲字 / 任意 state 变动）。
    for (let index = 0; index < 3; index += 1) {
      act(() => {
        screen.getByTestId('bump').click()
      })
    }
    expect(screen.getByTestId('bump').textContent).toBe('3')
    expect(profileCardRenders.count).toBe(before)
  })
})
