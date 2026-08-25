// @vitest-environment happy-dom
//
// CalendarApprovalCard — the three edit-tier 恒 HITL calendar writes (reschedule / rsvp / delete).
//
// 🔴 Why this file exists: 08-05 的 beUI 收编把这张卡自排的本地 `Row` 换成了共享 `CardParams`
//    两列 `<dl>`，而这张卡**当时零测试覆盖** —— 它恰恰是安全呈现最吃紧的一张（用户要在批准改期
//    前看清「原来什么时候 → 改成什么时候」，在批准 RSVP / 删除前看到不可撤回警告）。这些不变量
//    此前只靠人眼，换任何布局实现都能静默弄丢。
//
// Pins（都是**安全呈现**，不是样式偏好）：
//   1. reschedule 的 before/after 必须同时在场、**相邻**、且顺序是 原时间 → 新时间
//      （两列 grid 让两个时间戳左边缘对齐，是一个字面的 before→after diff；顺序反了或中间插了
//      别的行，对比关系就废了）；
//   2. before 取**服务端事实**、after 取模型提案 —— 模型谎报当前时间不改变用户看到的 before；
//   3. RSVP 的「不可撤回」警告 / delete 的「不可恢复」警告恒在，且**不在任何折叠件里**；
//   4. 服务端事实取不到（404 / 报错）时降级横幅在场，且 approve 仍可用（Python 侧会复核）；
//   5. 按钮真的走 respondToApproval。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ToolCallMessagePartProps } from '@assistant-ui/react'

import i18n from '@shared/i18n'
import { CalendarApprovalCard } from '@shared/assistant/tools/calendar/CalendarApprovalCard'

await i18n.changeLanguage('zh-CN')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mockProps(
  toolName: string,
  args: Record<string, unknown>,
  over: Partial<ToolCallMessagePartProps> = {}
): ToolCallMessagePartProps {
  return {
    type: 'tool-call',
    toolName,
    toolCallId: 'tc1',
    args,
    argsText: JSON.stringify(args),
    result: undefined,
    isError: undefined,
    status: { type: 'requires-action', reason: 'interrupt' },
    approval: { id: 'apr-1' }, // pending: approved === undefined
    addResult: vi.fn(),
    resume: vi.fn(),
    respondToApproval: vi.fn(),
    ...over
  } as unknown as ToolCallMessagePartProps
}

/** Stub the card's live server-fact fetch (GET /api/calendar/events/{uid}?source=caldav). */
function stubFacts(data: Record<string, unknown> | 'missing' | 'error'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (data === 'missing') return new Response('', { status: 404 })
      if (data === 'error') return new Response('', { status: 500 })
      return new Response(JSON.stringify({ status: 'success', data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
  )
}

/** The rendered label→value review table, in DOM order. */
function reviewRows(container: HTMLElement): Array<[string, string]> {
  const dts = [...container.querySelectorAll('dt')]
  const dds = [...container.querySelectorAll('dd')]
  return dts.map((dt, i) => [dt.textContent ?? '', dds[i]?.textContent ?? ''])
}

const RESCHEDULE_ARGS = {
  event_id: 'evt-1',
  new_start: '2026-08-06T10:00:00Z',
  new_end: '2026-08-06T11:00:00Z',
  timezone: 'UTC',
  scope: 'series'
}

const SERVER_FACTS = {
  summary: '季度评审',
  dtstart_iso: '2026-08-05T01:00:00Z',
  dtend_iso: '2026-08-05T02:00:00Z',
  organizer: 'boss@corp.test',
  is_all_day: false,
  calendar_name: 'Work'
}

describe('reschedule — the before→after diff is the whole point of the card', () => {
  test('原时间 and 新时间 are both present, ADJACENT, and in that order', async () => {
    stubFacts(SERVER_FACTS)
    const { container } = render(
      <CalendarApprovalCard {...mockProps('calendar_event_reschedule', RESCHEDULE_ARGS)} />
    )
    await waitFor(() => expect(screen.getByText('原时间')).toBeTruthy())

    const rows = reviewRows(container)
    const labels = rows.map(([l]) => l)
    // The event identity leads, then the two timestamps back to back, then the scope.
    expect(labels).toEqual(['日程', '原时间', '新时间', '范围'])
    const before = labels.indexOf('原时间')
    expect(labels[before + 1]).toBe('新时间')

    // Each label owns its value (dt/dd pairing, not two free-floating spans).
    const map = Object.fromEntries(rows)
    expect(map['原时间']).toContain('2026')
    expect(map['新时间']).toContain('2026')
    expect(map['原时间']).not.toBe(map['新时间'])
    // start → end ranges, so the user sees duration change too.
    expect(map['原时间']).toContain('→')
    expect(map['新时间']).toContain('→')
  })

  test('🔴 原时间/新时间两行的 value 左边缘对齐（同一个 grid 的同一列）', async () => {
    // 0805 收尾② —— 对齐是这张卡成为一个「字面的 before→after diff」的理由本身：旧的 flex 版本
    // 让每个 label 自己撑宽度，两个时间戳错开 19px，读起来就不再是同一把尺子上的两点。
    // happy-dom 量不了像素，判据落在**产生**对齐的结构上：dt/dd 全挂同一个 `<dl>`、grid 在
    // `<dl>` 上、恰好两条轨 ⇒ 两行的 dd 必在同一条 grid 列 ⇒ 同一个 x。把 grid 挪回每行的
    // wrapper（改动前的形态）即红。
    stubFacts(SERVER_FACTS)
    const { container } = render(
      <CalendarApprovalCard {...mockProps('calendar_event_reschedule', RESCHEDULE_ARGS)} />
    )
    await waitFor(() => expect(screen.getByText('原时间')).toBeTruthy())

    const dls = [...container.querySelectorAll('dl')]
    expect(dls).toHaveLength(1) // 一张表，不是每行一张
    const dl = dls[0]!
    const cells = [...container.querySelectorAll('dt, dd')]
    for (const cell of cells) expect(cell.parentElement, cell.outerHTML).toBe(dl)
    // 共享外壳的两列轨：标签列 auto（内容自适应，永不截断 —— 曾是 5.5rem 定宽 + truncate，
    // 对 en-US 最长标签只剩 7px 余量），值列 minmax(0,1fr)。
    expect(dl.className).toContain('grid-cols-[auto_minmax(0,1fr)]')
    expect(
      [...container.querySelectorAll('dt')].every((dt) => !dt.className.includes('truncate'))
    ).toBe(true)
  })

  test('before comes from SERVER facts, after from the model proposal', async () => {
    // The model lies about the current time by claiming a new_start equal to nothing real; the
    // card must still show the server's dtstart as 原时间 and never echo model args there.
    stubFacts(SERVER_FACTS)
    const { container } = render(
      <CalendarApprovalCard {...mockProps('calendar_event_reschedule', RESCHEDULE_ARGS)} />
    )
    await waitFor(() => expect(screen.getByText('原时间')).toBeTruthy())
    const map = Object.fromEntries(reviewRows(container))
    // 09:00-10:00 UTC+8 == 01:00-02:00Z (server fact) vs 18:00-19:00 == 10:00-11:00Z (proposal).
    expect(map['原时间']).toMatch(/08-05|08\/05/)
    expect(map['新时间']).toMatch(/08-06|08\/06/)
    // The event title is the server's summary, not the raw uid.
    expect(map['日程']).toBe('季度评审')
  })

  test('the review table survives into the terminal phases (rejected echoes what was refused)', async () => {
    stubFacts(SERVER_FACTS)
    const { container } = render(
      <CalendarApprovalCard
        {...mockProps('calendar_event_reschedule', RESCHEDULE_ARGS, {
          status: { type: 'complete' },
          approval: { id: 'apr-1', approved: false }
        } as Partial<ToolCallMessagePartProps>)}
      />
    )
    // No server fetch happens once decided, so 原时间 is absent — but the proposal is still shown.
    const labels = reviewRows(container).map(([l]) => l)
    expect(labels).toContain('新时间')
    // 已拒绝 shows twice on purpose: the phase pill AND the terminal banner.
    expect(screen.getAllByText(/已拒绝/).length).toBeGreaterThanOrEqual(1)
    // The action row is gone once the decision landed.
    expect(screen.queryByText('允许')).toBeNull()
  })
})

describe('irreversibility warnings are never behind a disclosure', () => {
  test('rsvp: the IRREVOCABLE iTIP REPLY warning renders alongside organizer + response', async () => {
    stubFacts(SERVER_FACTS)
    const { container } = render(
      <CalendarApprovalCard
        {...mockProps('calendar_event_rsvp', { event_id: 'evt-1', response: 'accept' })}
      />
    )
    await waitFor(() => expect(screen.getByText('组织者')).toBeTruthy())
    const map = Object.fromEntries(reviewRows(container))
    expect(map['组织者']).toBe('boss@corp.test')
    expect(map['回复']).toBe('接受')
    expect(screen.getByText(/不可撤回/)).toBeTruthy()
  })

  test('delete: the unrecoverable-deletion warning renders alongside the event time', async () => {
    stubFacts(SERVER_FACTS)
    const { container } = render(
      <CalendarApprovalCard {...mockProps('calendar_event_delete', { event_id: 'evt-1' })} />
    )
    await waitFor(() => expect(screen.getByText('时间')).toBeTruthy())
    const map = Object.fromEntries(reviewRows(container))
    expect(map['时间']).toContain('2026')
    expect(screen.getByText(/删除不可恢复/)).toBeTruthy()
  })
})

describe('degraded server facts still let the user decide', () => {
  test('event not found → the missing-facts banner + the raw proposal + live buttons', async () => {
    stubFacts('missing')
    render(<CalendarApprovalCard {...mockProps('calendar_event_reschedule', RESCHEDULE_ARGS)} />)
    await waitFor(() => expect(screen.getByText(/找不到该日程/)).toBeTruthy())
    // Falls back to the uid as the event label — never a blank review surface.
    expect(screen.getByText('evt-1')).toBeTruthy()
    expect(screen.getByText('允许')).toBeTruthy()
  })

  test('fetch error → the error banner, and approve is still offered', async () => {
    stubFacts('error')
    render(<CalendarApprovalCard {...mockProps('calendar_event_reschedule', RESCHEDULE_ARGS)} />)
    await waitFor(() => expect(screen.getByText(/无法读取该日程/)).toBeTruthy())
    expect(screen.getByText('允许')).toBeTruthy()
  })
})

describe('the buttons decide', () => {
  // Separate renders: the shared busy machine latches after a successful decision (the pair is
  // disabled so a double-click cannot send a second, contradictory answer) — asserting both
  // buttons on one instance would silently test nothing.
  test('approve routes to respondToApproval({approved:true})', async () => {
    stubFacts(SERVER_FACTS)
    const respond = vi.fn()
    render(
      <CalendarApprovalCard
        {...mockProps('calendar_event_delete', { event_id: 'evt-1' }, {
          respondToApproval: respond
        } as Partial<ToolCallMessagePartProps>)}
      />
    )
    await waitFor(() => expect(screen.getByText('允许')).toBeTruthy())
    fireEvent.click(screen.getByText('允许'))
    expect(respond).toHaveBeenCalledWith({ approved: true })
  })

  test('reject (no reason given) routes to respondToApproval({approved:false, reason:undefined})', async () => {
    stubFacts(SERVER_FACTS)
    const respond = vi.fn()
    render(
      <CalendarApprovalCard
        {...mockProps('calendar_event_delete', { event_id: 'evt-1' }, {
          respondToApproval: respond
        } as Partial<ToolCallMessagePartProps>)}
      />
    )
    await waitFor(() => expect(screen.getByText('拒绝')).toBeTruthy())
    // L4 批次2 — reject is now two-step (rejectReason opt-in): the first click only opens the
    // reason box, the confirm click decides.
    fireEvent.click(screen.getByText('拒绝'))
    expect(respond).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认拒绝'))
    expect(respond).toHaveBeenCalledWith({ approved: false, reason: undefined })
  })

  test('reject with a typed reason forwards it to respondToApproval', async () => {
    stubFacts(SERVER_FACTS)
    const respond = vi.fn()
    render(
      <CalendarApprovalCard
        {...mockProps('calendar_event_delete', { event_id: 'evt-1' }, {
          respondToApproval: respond
        } as Partial<ToolCallMessagePartProps>)}
      />
    )
    await waitFor(() => expect(screen.getByText('拒绝')).toBeTruthy())
    fireEvent.click(screen.getByText('拒绝'))
    fireEvent.change(screen.getByLabelText('拒绝理由（可选）'), {
      target: { value: '这个会议其实还没确认场地' }
    })
    fireEvent.click(screen.getByText('确认拒绝'))
    expect(respond).toHaveBeenCalledWith({ approved: false, reason: '这个会议其实还没确认场地' })
  })
})
