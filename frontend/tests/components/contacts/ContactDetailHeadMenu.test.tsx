// @vitest-environment happy-dom
//
// 档案头「更多操作」里的两个邮件动作（09-02：从列表行菜单搬过来的）。
//
// 钉三件事：
//   ① 菜单顶部有「写邮件」，点了预填收件人 = 本人主邮箱；
//   ② 「写邮件并抄送上级」**只在有上级时**渲染，抄送取 `detail.manager.primary_email`
//      （同 `ContactOrgSection` 的抄送钮，不为它再取一次详情）；
//   ③ 没有上级时那一项一个字节都不进菜单 —— 渲染出来点了只会开一个没抄送的草稿。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { apiGet, apiListMails, apiListMatters } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiListMails: vi.fn(),
  apiListMatters: vi.fn()
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
    // 逐个列出来只会让这份测试跟着无关端点漂，用 Proxy 兜底成 vi.fn。
    createContactsApi: () =>
      new Proxy(named, {
        get: (target, prop: string) => {
          if (!(prop in target)) target[prop] = vi.fn(async () => ({ items: [], total: 0 }))
          return target[prop]
        }
      })
  }
})

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
import type { ContactDetailDto, ContactRelPersonDto } from '@shared/api/types/contact'
import { ContactDetail } from '@shared/components/contacts/ContactDetail'
import { useComposeNewStore } from '@shared/state/compose-new'

await i18n.changeLanguage('zh-CN')

function manager(): ContactRelPersonDto {
  return {
    id: 9,
    display_name: 'Boss',
    formal_name: null,
    organization: 'Omada Networks',
    role_title: null,
    kind: 'person',
    mail_count: 5,
    primary_email: 'boss@example.com'
  }
}

function detailOf(overrides: Partial<ContactDetailDto> = {}): ContactDetailDto {
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
    },
    ...overrides
  }
}

async function openHeadMenu(detail: ContactDetailDto): Promise<void> {
  apiGet.mockResolvedValue(detail)
  apiListMails.mockResolvedValue({ items: [], total: 0, next_cursor: null })
  apiListMatters.mockResolvedValue({ items: [], total: 0 })
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={queryClient}>
      <ContactDetail
        contactId={7}
        showBack={false}
        actions={{ onSetKind: vi.fn(), onToggleSelf: vi.fn(), onToggleHidden: vi.fn() }}
      />
    </QueryClientProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: '更多操作' }))
}

afterEach(() => {
  cleanup()
  useComposeNewStore.setState({ open: false, prefillTo: null, prefillCc: null })
  vi.clearAllMocks()
})

describe('档案头「更多操作」· 邮件动作', () => {
  test('「写邮件」预填收件人 = 本人主邮箱，不带抄送', async () => {
    await openHeadMenu(detailOf())

    fireEvent.click(screen.getByRole('menuitem', { name: '写邮件' }))
    const state = useComposeNewStore.getState()
    expect(state.open).toBe(true)
    expect(state.prefillTo).toBe('zhang@example.com')
    expect(state.prefillCc).toBeNull()
  })

  test('有上级：「写邮件并抄送上级」抄送上级主邮箱', async () => {
    await openHeadMenu(detailOf({ manager: manager(), manager_src: 'manual' }))

    fireEvent.click(screen.getByRole('menuitem', { name: '写邮件并抄送上级' }))
    const state = useComposeNewStore.getState()
    expect(state.prefillTo).toBe('zhang@example.com')
    expect(state.prefillCc).toEqual(['boss@example.com'])
  })

  test('没有上级：菜单里没有「写邮件并抄送上级」（「写邮件」照常在）', async () => {
    await openHeadMenu(detailOf())

    expect(screen.queryByRole('menuitem', { name: '写邮件并抄送上级' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: '写邮件' })).toBeTruthy()
  })
})
