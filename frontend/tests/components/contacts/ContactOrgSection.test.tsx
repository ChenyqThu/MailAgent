// @vitest-environment happy-dom
//
// WP5 —— 组织关系区：上级卡渲染 / 解除（只存一侧：manager 解除写自己那行、
// 下级解除写对方那行）/ 点击跳人物页 / 「写邮件并抄送上级」预填（收件人=TA、
// 抄送=TA 的上级）/ 空态（未设上级虚线引导 + noReports）/ auto 标记结构位 /
// peers 空整块不渲染。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockSetManager, mockInvalidate } = vi.hoisted(() => ({
  mockSetManager: vi.fn(),
  mockInvalidate: vi.fn()
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsApi: () => ({ setManager: mockSetManager }),
  useContactList: () => ({ data: { items: [], total: 0 }, isPending: false }),
  useInvalidateContact: () => mockInvalidate
}))

import i18n from '@shared/i18n'
import type { ContactDetailDto, ContactRelPersonDto } from '@shared/api/types/contact'
import { ContactOrgSection } from '@shared/components/contacts/ContactOrgSection'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { useComposeNewStore } from '@shared/state/compose-new'

await i18n.changeLanguage('zh-CN')

function relPerson(id: number, name: string, email: string): ContactRelPersonDto {
  return {
    id,
    display_name: name,
    name_en: null,
    organization: 'ACME',
    role_title: null,
    kind: 'person',
    mail_count: 5,
    primary_email: email
  }
}

function detailOf(overrides: Partial<ContactDetailDto> = {}): ContactDetailDto {
  return {
    id: 1,
    display_name: 'Alice',
    name_en: null,
    organization: 'ACME',
    department: null,
    role_title: null,
    function: null,
    seniority: null,
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
    mail_count: 20,
    sent_to_count: 5,
    first_seen_at: null,
    last_seen_at: null,
    created_at: 1,
    updated_at: 1,
    emails: [
      {
        address: 'alice@x.com',
        is_primary: true,
        former_at: null,
        mail_count: 20,
        first_seen_at: null,
        last_seen_at: null
      }
    ],
    manager: null,
    manager_src: null,
    reports: [],
    peers: [],
    profile: null,
    ...overrides
  }
}

function renderSection(detail: ContactDetailDto) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <ContactOrgSection detail={detail} />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSetManager.mockResolvedValue(detailOf())
  mockInvalidate.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  useComposeNewStore.setState({ open: false, prefillTo: null, prefillCc: null })
  useContactNavigation.setState({ targetContactId: null })
})

describe('ContactOrgSection', () => {
  test('未设上级：虚线引导 + 分区头无「写邮件并抄送上级」；无下级：noReports', () => {
    renderSection(detailOf())
    expect(screen.getByText('未设上级 · 指定后可以一键抄送，列表也能按汇报线分组')).toBeTruthy()
    expect(screen.getByText('还没有人把 TA 设为上级')).toBeTruthy()
    expect(screen.queryByText('写邮件并抄送上级')).toBeNull()
    // peers 空 → 整块不渲染
    expect(screen.queryByText('同组织同事（自动归类，不是手工关系）')).toBeNull()
  })

  test('上级卡渲染 + hover 解除写自己那行 (id, null)', async () => {
    renderSection(detailOf({ manager: relPerson(9, 'Boss', 'boss@x.com'), manager_src: 'manual' }))
    expect(screen.getByText('Boss')).toBeTruthy()
    // manual 来源不出现 AI 标记（auto 结构位另测）
    expect(screen.queryByText('从邮件推断')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '解除关系' }))
    await waitFor(() => expect(mockSetManager).toHaveBeenCalledWith(1, null))
  })

  test('manager_src=auto → 「从邮件推断」标记结构位可感知', () => {
    renderSection(detailOf({ manager: relPerson(9, 'Boss', 'boss@x.com'), manager_src: 'auto' }))
    expect(screen.getByText('从邮件推断')).toBeTruthy()
  })

  test('下级解除写对方那行 (report.id, null)', async () => {
    renderSection(
      detailOf({
        manager: relPerson(9, 'Boss', 'boss@x.com'),
        manager_src: 'manual',
        reports: [relPerson(7, 'Rex', 'rex@x.com')]
      })
    )
    const unlinks = screen.getAllByRole('button', { name: '解除关系' })
    expect(unlinks).toHaveLength(2)
    fireEvent.click(unlinks[1]!)
    await waitFor(() => expect(mockSetManager).toHaveBeenCalledWith(7, null))
  })

  test('点击上级卡 → 人物页直达通道（useContactNavigation）', () => {
    renderSection(detailOf({ manager: relPerson(9, 'Boss', 'boss@x.com'), manager_src: 'manual' }))
    fireEvent.click(screen.getByText('Boss'))
    expect(useContactNavigation.getState().targetContactId).toBe(9)
  })

  test('「写邮件并抄送上级」→ 收件人=TA、抄送=上级主邮箱', () => {
    renderSection(detailOf({ manager: relPerson(9, 'Boss', 'boss@x.com'), manager_src: 'manual' }))
    fireEvent.click(screen.getByText('写邮件并抄送上级'))
    const state = useComposeNewStore.getState()
    expect(state.open).toBe(true)
    expect(state.prefillTo).toBe('alice@x.com')
    expect(state.prefillCc).toEqual(['boss@x.com'])
  })

  test('peers 非空才渲染整块，点击 pill 跳人物页', () => {
    renderSection(detailOf({ peers: [relPerson(5, 'Pat', 'pat@x.com')] }))
    expect(screen.getByText('同组织同事（自动归类，不是手工关系）')).toBeTruthy()
    fireEvent.click(screen.getByText('Pat'))
    expect(useContactNavigation.getState().targetContactId).toBe(5)
  })
})
