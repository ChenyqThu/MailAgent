// @vitest-environment happy-dom
//
// 08-27 P4d — 日历新建/编辑表单的三处收尾：
//   ① 与会者接通讯录（搜姓名 / 搜邮箱 → 下拉三段行 → chip 显姓名），
//      且**手输一个通讯录里没有的合法邮箱仍然能加**；
//   ② 编辑态日历选择器置灰 + 说清为什么；
//   ③ 重复规则一句话式 + 自然语言回显（句子本身的口径在 tests/shared/rruleSummary.test.ts）。
//
// 与既有的 EventFormModal.test.tsx 分文件：那边守的是与会者 dirty 三态（数据安全），
// mock 的 t 不做插值；这里要断言带插值的文案，两套 mock 放一个文件会互相打架。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type { CalendarEventOccurrence } from '../../src/shared/api/types'

const { eventCreate, eventUpdate, contactSuggest, resolveSpy, stableDetail, stableNames } =
  vi.hoisted(() => ({
    eventCreate: vi.fn(),
    eventUpdate: vi.fn(),
    contactSuggest: vi.fn(),
    resolveSpy: vi.fn(),
    // 稳定引用：detail effect 的 deps 含 detail，每次 render 换新对象会打成死循环。
    stableDetail: { rrule: '', description: '', attendees: [] } as Record<string, unknown>,
    stableNames: ['工作', '个人'] as string[]
  }))

// 组件用 t(key, defaultString) / t(key, defaultString, vars)：返回默认串并做 ICU 单括号
// 插值 —— 「添加 “xxx”」「移除 xxx」这些断言要的就是插值后的样子。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, dflt?: unknown, vars?: unknown) => {
      const base = typeof dflt === 'string' ? dflt : key
      const bag = (typeof dflt === 'object' ? dflt : vars) as Record<string, unknown> | undefined
      if (!bag) return base
      return base.replace(/\{(\w+)\}/g, (whole, name: string) =>
        name in bag ? String(bag[name]) : whole
      )
    }
  })
}))

vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({
    calendar: { eventCreate, eventUpdate },
    email: { contactSuggest }
  })
}))

vi.mock('@shared/components/contacts/hooks', () => ({
  useContactsEnabled: () => ({ enabled: true, loading: false }),
  useContactsApi: () => ({ resolve: resolveSpy })
}))

vi.mock('@shared/components/calendar/hooks/useCalendarEvents', () => ({
  CALENDAR_EVENTS_KEY: ['calendar', 'events'],
  useCalendarEvent: () => ({ data: stableDetail, isLoading: false }),
  useCalendarNames: () => ({ data: stableNames, isLoading: false })
}))

vi.mock('@shared/state/toast', () => ({ toastSuccess: vi.fn(), toastError: vi.fn() }))

import { EventFormModal } from '../../src/shared/components/calendar/EventFormModal'

function renderModal(occurrence: CalendarEventOccurrence | null): void {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } }
  })
  render(
    <QueryClientProvider client={qc}>
      <EventFormModal open onClose={() => {}} occurrence={occurrence} />
    </QueryClientProvider>
  )
}

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 1,
    ical_uid: 'uid-1',
    recurrence_id: null,
    sequence: 0,
    summary: '周会',
    occurrence_start_iso: '2026-06-01T09:00:00+00:00',
    occurrence_end_iso: '2026-06-01T10:00:00+00:00',
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '工作',
    organizer: 'me@example.com',
    attendees: [],
    location: '',
    url: '',
    status: 'CONFIRMED',
    response_status: 'ACCEPTED',
    source: 'caldav',
    notion_page_id: null,
    related_email_internal_id: null,
    ...over
  }
}

/** POST /contacts/resolve 的 chip 最小集（键 = 归一后的地址）。 */
function chip(displayName: string | null, email: string) {
  return {
    id: 1,
    display_name: displayName,
    formal_name: null,
    kind: 'person' as const,
    primary_email: email
  }
}

function attendeeInput(): HTMLInputElement {
  return screen.getByLabelText('与会者') as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  eventCreate.mockResolvedValue({})
  eventUpdate.mockResolvedValue({})
  contactSuggest.mockResolvedValue([])
  resolveSpy.mockResolvedValue({ items: {} })
  stableDetail.description = ''
  stableDetail.rrule = ''
})

afterEach(() => cleanup())

describe('与会者 · 接通讯录', () => {
  test('搜姓名片段命中通讯录候选，选中后 chip 显姓名、提交带上 CN', async () => {
    contactSuggest.mockResolvedValue([
      { email: 'alice@acme.com', name: '陈源泉', org: 'TP-Link', score: 9 }
    ])
    renderModal(null)

    const input = attendeeInput()
    fireEvent.focus(input)
    // 敲的是中文名，不是邮箱 —— 这一条才是「接通讯录」与老的「输 email 回车」的分界。
    fireEvent.change(input, { target: { value: '陈源' } })

    // 🔴 只能在补全下拉里找 option —— `<select>` 的 `<option>` 同样是 role=option，
    // 直接 findAllByRole('option') 会立刻命中日历/重复那几个下拉，等于什么都没等。
    const listbox = await screen.findByRole('listbox', { name: '与会者候选' })
    const [opt] = within(listbox).getAllByRole('option')
    expect(contactSuggest.mock.calls.at(-1)?.[0]).toBe('陈源')
    // 行形态 = 姓名 / 组织 / 邮箱三段（与 compose 同一个组件）。
    expect(within(opt!).getByText('TP-Link')).toBeTruthy()

    const btn = opt!.querySelector('button') as HTMLButtonElement
    fireEvent.mouseDown(btn)
    fireEvent.click(btn)

    // chip 上显示姓名，title 仍带完整地址。
    const chipEl = await screen.findByTitle('陈源泉 <alice@acme.com>')
    expect(within(chipEl).getByText('陈源泉')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('事件标题'), { target: { value: '对齐会' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(eventCreate).toHaveBeenCalledTimes(1))
    expect(eventCreate.mock.calls[0][0].attendees).toEqual([
      { email: 'alice@acme.com', name: '陈源泉' }
    ])
  })

  test('预填的与会者也显示通讯录姓名（用户一个字没打，补全压根不会发）', async () => {
    resolveSpy.mockResolvedValue({ items: { 'bob@acme.com': chip('王大锤', 'bob@acme.com') } })
    // 事件本身没带 CN —— 名字只能来自 /contacts/resolve 那一批。
    renderModal(makeOccurrence({ attendees: [{ email: 'bob@acme.com' }] }))

    const chipEl = await screen.findByTitle('王大锤 <bob@acme.com>')
    expect(within(chipEl).getByText('王大锤')).toBeTruthy()
    expect(contactSuggest).not.toHaveBeenCalled()
  })

  test('通讯录里没有的合法邮箱：下拉给「添加」那一行，回车直接加', async () => {
    contactSuggest.mockResolvedValue([]) // 通讯录一条都没命中
    renderModal(null)

    const input = attendeeInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'stranger@x.com' } })

    await screen.findByText('添加 “stranger@x.com”')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.getByTitle('stranger@x.com')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('事件标题'), { target: { value: '外部会' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(eventCreate).toHaveBeenCalledTimes(1))
    expect(eventCreate.mock.calls[0][0].attendees).toEqual([{ email: 'stranger@x.com' }])
  })

  test('失焦也提交（补全没开着的那条路）', async () => {
    renderModal(null)
    const input = attendeeInput()
    fireEvent.change(input, { target: { value: 'late@x.com' } })
    fireEvent.blur(input)

    await waitFor(() => expect(screen.getByTitle('late@x.com')).toBeTruthy())
  })

  test('非法输入不落 chip（红描边脉冲，不静默吞掉）', () => {
    renderModal(null)
    const input = attendeeInput()
    fireEvent.change(input, { target: { value: '这不是邮箱' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.queryByTitle('这不是邮箱')).toBeNull()
    expect(input.value).toBe('这不是邮箱')
  })
})

describe('编辑态的日历选择器', () => {
  test('置灰 + 说清为什么', () => {
    renderModal(makeOccurrence())
    const select = screen.getByLabelText('日历') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(select.value).toBe('工作')
    expect(
      screen.getByText(
        '换日历等于删掉再建一次，事件会换个身份、与会者的回执也跟着丢。要换日历请新建一个事件。'
      )
    ).toBeTruthy()
  })

  test('新建态照常可选，也不出那句解释', () => {
    renderModal(null)
    const select = screen.getByLabelText('日历') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    fireEvent.change(select, { target: { value: '个人' } })
    expect(select.value).toBe('个人')
  })
})

describe('重复规则 · 一句话 + 回显', () => {
  test('每周一、三，共 10 次', () => {
    renderModal(null)
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: 'WEEKLY' } })

    const days = screen.getByRole('group', { name: '每周重复日' })
    fireEvent.click(within(days).getByText('一'))
    fireEvent.click(within(days).getByText('三'))
    fireEvent.change(screen.getByLabelText('结束方式'), { target: { value: 'count' } })

    expect(screen.getByTestId('rrule-summary').textContent).toBe('每周一、三，共 10 次')
  })

  test('不重复时不出回显，也不出「每 N」那截', () => {
    renderModal(null)
    expect(screen.queryByTestId('rrule-summary')).toBeNull()
    expect(screen.queryByLabelText('重复间隔')).toBeNull()
  })

  test('改了规则 → 提交带上 RRULE（回显与真正发出去的是同一份状态）', async () => {
    renderModal(null)
    fireEvent.change(screen.getByPlaceholderText('事件标题'), { target: { value: '周会' } })
    fireEvent.change(screen.getByLabelText('重复'), { target: { value: 'WEEKLY' } })
    const days = screen.getByRole('group', { name: '每周重复日' })
    fireEvent.click(within(days).getByText('一'))
    fireEvent.click(within(days).getByText('三'))

    expect(screen.getByTestId('rrule-summary').textContent).toBe('每周一、三')
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() => expect(eventCreate).toHaveBeenCalledTimes(1))
    expect(eventCreate.mock.calls[0][0].rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE')
  })
})
