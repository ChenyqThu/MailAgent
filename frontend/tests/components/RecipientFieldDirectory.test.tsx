// @vitest-environment happy-dom
//
// RecipientField × 通讯录（08-28 dogfood）：
//   · chip 显示**姓名**而不是裸邮箱 —— 预填收件人（reply/forward/草稿续编）用户
//     一个字没打，补全查询不会发，名字只能来自 POST /contacts/resolve 那一批；
//   · 通讯录 display_name 优先于邮件头/补全学到的名字；
//   · 不在库的地址老老实实显示邮箱（不臆造，也不留空）；
//   · 补全下拉行 = 姓名 / 组织 / 邮箱三段（无姓名时主行降级成 local-part），
//     且**任意片段**（含中文名）都会去查通讯录，不是只认邮箱。
//
// 姓名匹配本身在服务端两条 lane 合流（tests/main/contact_suggest.test.ts +
// tests/repository/test_contact_suggest.py），这里只锁前端接线与呈现。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockContactSuggest, resolveSpy, contactsFlag } = vi.hoisted(() => ({
  mockContactSuggest: vi.fn(),
  resolveSpy: vi.fn(),
  contactsFlag: { enabled: true }
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ email: { contactSuggest: mockContactSuggest } })
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: contactsFlag.enabled, loading: false }),
  useContactsApi: () => ({ resolve: resolveSpy })
}))

import { RecipientField } from '../../src/shared/components/email/compose/RecipientField'
import { SenderChip } from '../../src/shared/components/email/compose/SenderChip'

/** POST /contacts/resolve 的 chip 最小集（键 = 请求里的原输入串，null = 不在库）。 */
function chip(displayName: string | null, email: string, formalName: string | null = null) {
  return {
    id: 1,
    display_name: displayName,
    formal_name: formalName,
    kind: 'person' as const,
    primary_email: email
  }
}

/**
 * 命中高亮把一行拆成 `<mark>` + 文本节点，而 getByText 的默认 matcher 只看**直接
 * 子文本节点** —— 直接按字符串查会漏。这里按整段 textContent 精确匹配那一行的
 * span（精确 = 主行显示成整条邮箱时会红，是这几条断言的判据所在）。
 */
function line(scope: HTMLElement, text: string): HTMLElement {
  return within(scope).getByText(
    (_content, el) =>
      el?.tagName === 'SPAN' &&
      el.textContent === text &&
      // 只要叶子那一段 —— 外层行容器（名字 + 外部标记）的 textContent 可能与
      // 名字一字不差，两个都匹配会让 getByText 直接抛「找到多个」。
      el.querySelector('span') === null
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  contactsFlag.enabled = true
  mockContactSuggest.mockResolvedValue([])
  resolveSpy.mockResolvedValue({ items: {} })
})

afterEach(() => {
  cleanup()
})

function renderField(props: Partial<React.ComponentProps<typeof RecipientField>> = {}): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <RecipientField
        label="To"
        values={[]}
        placeholder="add"
        onChange={vi.fn()}
        selfEmail="me@acme.com"
        {...props}
      />
    </QueryClientProvider>
  )
}

function renderSender(email: string | null): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  render(
    <QueryClientProvider client={qc}>
      <SenderChip email={email} fallbackLabel="未知发件人" />
    </QueryClientProvider>
  )
}

describe('SenderChip — 发件人也走同一条姓名口径', () => {
  test('解析出姓名时显示姓名，地址仍常驻在旁边', async () => {
    resolveSpy.mockResolvedValue({ items: { 'me@acme.com': chip('陈源泉', 'me@acme.com') } })
    // 大小写混排 —— `USER_EMAIL` 是人手填的，查表必须按归一地址走。
    renderSender('Me@Acme.com')

    await screen.findByTitle('陈源泉 <Me@Acme.com>')
    // 发件人是「署谁的名发出去」——只剩一个中文名会让人不确定用的哪个邮箱。
    expect(screen.getByText('Me@Acme.com')).toBeTruthy()
  })

  test('不在通讯录时只显示地址（不重复渲染两遍）', async () => {
    resolveSpy.mockResolvedValue({ items: { 'me@acme.com': null } })
    renderSender('me@acme.com')

    await waitFor(() => expect(resolveSpy).toHaveBeenCalled())
    expect(screen.getAllByText('me@acme.com')).toHaveLength(1)
  })

  test('地址还没读到时走占位文案，且一次都不解析', () => {
    renderSender(null)

    expect(screen.getByText('未知发件人')).toBeTruthy()
    expect(resolveSpy).not.toHaveBeenCalled()
  })
})

describe('RecipientField — chip 显示通讯录姓名', () => {
  test('预填的 chip 解析出姓名后显示姓名，title 仍带完整地址', async () => {
    resolveSpy.mockResolvedValue({
      items: { 'alice@acme.com': chip('陈源泉', 'alice@acme.com') }
    })
    renderField({ values: ['alice@acme.com'] })

    // 用户一个字没打 —— 补全查询压根不发，名字只能来自 resolve。
    expect(mockContactSuggest).not.toHaveBeenCalled()
    const chipEl = await screen.findByTitle('陈源泉 <alice@acme.com>')
    expect(within(chipEl).getByText('陈源泉')).toBeTruthy()
  })

  test('formal_name 是 display_name 空时的回退', async () => {
    resolveSpy.mockResolvedValue({
      items: { 'alice@acme.com': chip(null, 'alice@acme.com', '陈源泉') }
    })
    renderField({ values: ['alice@acme.com'] })

    await screen.findByTitle('陈源泉 <alice@acme.com>')
  })

  test('不在通讯录的地址显示邮箱本身（title 只有地址）', async () => {
    resolveSpy.mockResolvedValue({ items: { 'stranger@x.com': null } })
    renderField({ values: ['stranger@x.com'] })

    await waitFor(() => expect(resolveSpy).toHaveBeenCalled())
    const chipEl = screen.getByTitle('stranger@x.com')
    expect(within(chipEl).getByText('stranger@x.com')).toBeTruthy()
  })

  test('通讯录姓名压过补全学到的邮件头名字', async () => {
    resolveSpy.mockResolvedValue({
      items: { 'alice@acme.com': chip('陈源泉', 'alice@acme.com') }
    })
    // 邮件头里这个人最后一次署的是老名字。
    mockContactSuggest.mockResolvedValue([{ email: 'alice@acme.com', name: 'Alice Old', score: 4 }])
    renderField({ values: ['alice@acme.com'] })

    const input = screen.getByLabelText('To')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ali' } })
    await waitFor(() => expect(mockContactSuggest).toHaveBeenCalled())

    await screen.findByTitle('陈源泉 <alice@acme.com>')
    expect(screen.queryByText('Alice Old')).toBeNull()
  })

  test('归一后一次性解析：大小写不同的同一地址只请求一条', async () => {
    renderField({ values: ['Alice@Acme.com', 'alice@acme.com'] })

    await waitFor(() => expect(resolveSpy).toHaveBeenCalled())
    expect(resolveSpy).toHaveBeenCalledWith(['alice@acme.com'])
  })
})

describe('RecipientField — 补全下拉的行形态', () => {
  test('有姓名的候选给出姓名 / 组织 / 邮箱三段', async () => {
    mockContactSuggest.mockResolvedValue([
      { email: 'alice@acme.com', name: '陈源泉', org: 'TP-Link', score: 9 }
    ])
    renderField()
    const input = screen.getByLabelText('To')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ali' } })

    const [opt] = await screen.findAllByRole('option')
    expect(line(opt!, '陈源泉')).toBeTruthy()
    expect(line(opt!, 'TP-Link')).toBeTruthy()
    expect(line(opt!, 'alice@acme.com')).toBeTruthy()
  })

  test('没有姓名的候选主行降级成 local-part，完整地址仍在次行', async () => {
    mockContactSuggest.mockResolvedValue([{ email: 'bob@acme.com', score: 1 }])
    renderField()
    const input = screen.getByLabelText('To')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'bo' } })

    const [opt] = await screen.findAllByRole('option')
    expect(line(opt!, 'bob')).toBeTruthy()
    expect(line(opt!, 'bob@acme.com')).toBeTruthy()
  })

  test('中文名片段照样去查通讯录（补全不是只认邮箱）', async () => {
    mockContactSuggest.mockResolvedValue([
      { email: 'alice@acme.com', name: '陈源泉', org: 'TP-Link', score: 9 }
    ])
    renderField()
    const input = screen.getByLabelText('To')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '陈源' } })

    await waitFor(() => expect(mockContactSuggest).toHaveBeenCalled())
    expect(mockContactSuggest.mock.calls.at(-1)?.[0]).toBe('陈源')
    const opts = await screen.findAllByRole('option')
    expect(opts).toHaveLength(1)
  })
})
