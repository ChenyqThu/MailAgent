// @vitest-environment happy-dom
//
// 详情抽屉的性别行（owner 拍板：**图标按钮切换**，不用下拉）。
//
// 钉三件事：
//   ① 三段（未设置 / 男 / 女）都在，且每段有可读的 aria-label —— 段里只有图标，
//      少了 aria-label 读屏念出来就是三个空按钮；
//   ② 点击发出的 PATCH body 是 `{ gender: 'male' }` / `{ gender: null }`
//      （「未设置」= 清空 = NULL，与后端「NULL 即未知」对齐）；
//   ③ 🔒 gender **不落锁** —— 这行不出锁按钮，采纳后也不能报「已保存并锁定」
//      （`FIELD_LABEL_KEY` 里根本没有 gender，漏过滤会报出「undefined 已保存并锁定」）。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { apiGet, apiPatch, apiListMails, apiListMatters } = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
  apiListMails: vi.fn(),
  apiListMatters: vi.fn()
}))

vi.mock('@shared/api/contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/api/contacts')>()
  const named: Record<string, unknown> = {
    get: apiGet,
    patch: apiPatch,
    listMails: apiListMails,
    listMatters: apiListMatters
  }
  return {
    ...actual,
    // 详情页子树会摸到一串端点（画像刷新 / 锁 / 主邮箱 / 组织关系搜索…）。
    // 逐个列出来只会让这份测试跟着无关端点漂 → 用 Proxy 兜底成 vi.fn。
    createContactsApi: () =>
      new Proxy(named, {
        get: (target, prop: string) => {
          if (!(prop in target)) target[prop] = vi.fn(async () => ({ items: [], total: 0 }))
          return target[prop]
        }
      })
  }
})

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))
vi.mock('@shared/state/toast', () => ({ toastError, toastSuccess, toastInfo: vi.fn() }))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))

vi.mock('@shared/state/active-email', () => ({
  useActiveEmail: (selector: (s: { setActive: () => void }) => unknown) =>
    selector({ setActive: vi.fn() })
}))

import i18n from '@shared/i18n'
import type { ContactDetailDto, ContactGender } from '@shared/api/types/contact'
import { ContactDetail } from '@shared/components/contacts/ContactDetail'

await i18n.changeLanguage('zh-CN')

function detailOf(gender: ContactGender | null): ContactDetailDto {
  return {
    id: 7,
    display_name: '张伟',
    formal_name: null,
    organization: 'Omada Networks',
    department: null,
    role_title: '架构师',
    function: null,
    seniority: null,
    gender,
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

async function renderDetail(gender: ContactGender | null): Promise<void> {
  apiGet.mockResolvedValue(detailOf(gender))
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
  // 详情是异步取的 —— 等身份区落地再断言。
  await screen.findByText('性别')
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('详情抽屉 · 性别行（三态图标 segmented）', () => {
  test('三段都在且各有 aria-label（段里只有图标，没有可见文字）', async () => {
    await renderDetail(null)

    const unset = screen.getByRole('tab', { name: '未设置' })
    const male = screen.getByRole('tab', { name: '男' })
    const female = screen.getByRole('tab', { name: '女' })
    // 图标按钮：不带任何文本。
    expect(male.textContent).toBe('')
    expect(female.textContent).toBe('')
    // 未知态选中「未设置」段。
    expect(unset.getAttribute('aria-selected')).toBe('true')
    expect(male.getAttribute('aria-selected')).toBe('false')
  })

  test('已有值时选中对应段（male → 男段 aria-selected）', async () => {
    await renderDetail('male')

    expect(screen.getByRole('tab', { name: '男' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByRole('tab', { name: '未设置' }).getAttribute('aria-selected')).toBe('false')
  })

  test('点「女」发 PATCH { gender: "female" }', async () => {
    apiPatch.mockResolvedValue({})
    await renderDetail(null)

    fireEvent.click(screen.getByRole('tab', { name: '女' }))
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(7, { gender: 'female' }))
  })

  // 🔒 「未设置」是清空，body 必须是 null 而不是省略键或空串 —— 后端按 NULL 存未知。
  test('从已有值点回「未设置」发 PATCH { gender: null }', async () => {
    apiPatch.mockResolvedValue({})
    await renderDetail('male')

    fireEvent.click(screen.getByRole('tab', { name: '未设置' }))
    await waitFor(() => expect(apiPatch).toHaveBeenCalledWith(7, { gender: null }))
  })

  // 🔒 gender 不在 CONTACT_LOCKABLE_FIELDS 里：既不该出锁按钮，也不该报「已保存并锁定」。
  test('性别行不落锁：无锁按钮，成功后不报「已保存并锁定」', async () => {
    apiPatch.mockResolvedValue({})
    await renderDetail(null)

    const row = screen.getByText('性别').parentElement
    expect(row?.querySelector('[title="锁定"], [title="已锁定"]')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: '男' }))
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(1))
    // 一条 toast 都不该报（更不能报出「undefined 已保存并锁定」）。
    const messages = toastSuccess.mock.calls.map((call) => String(call[0]))
    expect(messages.some((message) => message.includes('锁定'))).toBe(false)
    expect(messages.some((message) => message.includes('undefined'))).toBe(false)
  })

  test('档案头姓名后带性别图标（未知不带）', async () => {
    await renderDetail('female')
    expect(screen.getAllByTitle('女').length).toBeGreaterThan(0)

    cleanup()
    vi.clearAllMocks()
    await renderDetail(null)
    expect(screen.queryByTitle('女')).toBeNull()
    expect(screen.queryByTitle('男')).toBeNull()
  })
})
