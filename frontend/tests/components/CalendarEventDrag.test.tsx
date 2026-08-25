// @vitest-environment happy-dom
//
// Lane C (#5) — timeline 事件块拖拽改期/改时长的交互层。
//
// 纯换算/吸附在 tests/shared/calendar-time-grid.test.ts, 这里只钉行为:
//   ① 4px 起手阈值 —— 阈值以下是点击 (照常开抽屉), 以上是拖拽;
//   ② 真拖拽之后那一发 click 必须被吞掉 (否则松手就把抽屉开了);
//   ③ Escape 取消 = 不提交且也不开抽屉;
//   ④ resize 手柄只动结束时间;
//   ⑤ 乐观 override 期内, 显示与「再拖一次」的基准都以 override 为准;
//   ⑥ 不给 onReschedule (非组织者/只读) = 无手柄、拖不动。

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'

import type { CalendarEventOccurrence } from '../../src/shared/api/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_k: string, dflt?: unknown, vars?: Record<string, unknown>) => {
      let s = typeof dflt === 'string' ? dflt : String(_k)
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replaceAll(`{${k}}`, String(v))
        }
      }
      return s
    }
  })
}))

import { EventBlock } from '../../src/shared/components/calendar/EventBlock'
import { HOUR_PX } from '../../src/shared/components/calendar/lib/timeGrid'

/** 本地日 10:00 → 11:00 的样本 occurrence (拖拽 clamp 以本地日为界)。 */
const DAY = new Date(2026, 7, 24).getTime()
const START = DAY + 10 * 60 * 60_000
const END = DAY + 11 * 60 * 60_000
const TOP_PX = ((START - DAY) / 3_600_000) * HOUR_PX
const HEIGHT_PX = ((END - START) / 3_600_000) * HOUR_PX

function makeOccurrence(over: Partial<CalendarEventOccurrence> = {}): CalendarEventOccurrence {
  return {
    id: 7,
    ical_uid: 'uid-drag-7',
    recurrence_id: null,
    sequence: 0,
    summary: '拖拽样本',
    occurrence_start_iso: new Date(START).toISOString(),
    occurrence_end_iso: new Date(END).toISOString(),
    is_recurrence_instance: false,
    is_all_day: false,
    calendar_name: '日历',
    organizer: '',
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

interface Rendered {
  block: Element
  handle: Element | null
  onClick: ReturnType<typeof vi.fn>
  onReschedule: ReturnType<typeof vi.fn>
}

function renderBlock(
  opts: {
    draggable?: boolean
    timeOverride?: { startIso: string; endIso: string } | null
    event?: CalendarEventOccurrence
  } = {}
): Rendered {
  const { draggable = true, timeOverride = null, event = makeOccurrence() } = opts
  const onClick = vi.fn()
  const onReschedule = vi.fn()
  const { container } = render(
    <EventBlock
      event={event}
      topPx={TOP_PX}
      heightPx={HEIGHT_PX}
      onClick={onClick}
      timeOverride={timeOverride}
      onReschedule={draggable ? onReschedule : undefined}
    />
  )
  return {
    block: container.querySelector('.evt')!,
    handle: container.querySelector('.evt-resize'),
    onClick,
    onReschedule
  }
}

/** 一次完整的指针拖拽: 按下 → 移动 → 松手 → (浏览器补的) click。 */
function drag(target: Element, dyPx: number, opts: { escape?: boolean } = {}): void {
  fireEvent.pointerDown(target, { button: 0, clientY: 200 })
  fireEvent.pointerMove(window, { clientY: 200 + dyPx })
  if (opts.escape) fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.pointerUp(window, { clientY: 200 + dyPx })
  fireEvent.click(target)
}

function hhmm(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('EventBlock 拖拽改期', () => {
  test('位移不足 4px → 当点击处理: 不提交, 抽屉照常打开', () => {
    const r = renderBlock()
    drag(r.block, 3)
    expect(r.onReschedule).not.toHaveBeenCalled()
    expect(r.onClick).toHaveBeenCalledTimes(1)
  })

  test('下拖一格 → 提交 +15min 且时长不变; 随后的 click 被吞掉不开抽屉', () => {
    const r = renderBlock()
    drag(r.block, 12)
    expect(r.onReschedule).toHaveBeenCalledTimes(1)
    const next = r.onReschedule.mock.calls[0][0]
    expect(next.mode).toBe('move')
    expect(hhmm(next.startIso)).toBe('10:15')
    expect(hhmm(next.endIso)).toBe('11:15')
    expect(r.onClick).not.toHaveBeenCalled()
  })

  test('拖拽中块跟手位移 (预览与提交同源)', () => {
    const r = renderBlock()
    fireEvent.pointerDown(r.block, { button: 0, clientY: 200 })
    fireEvent.pointerMove(window, { clientY: 212 })
    expect((r.block as HTMLElement).style.top).toBe(`${TOP_PX + 12}px`)
    fireEvent.pointerUp(window, { clientY: 212 })
    // 松手后预览归零, 位置交回视图 (视图那边由 override 顶上)
    expect((r.block as HTMLElement).style.top).toBe(`${TOP_PX}px`)
  })

  test('Escape 取消 → 不提交, 也不开抽屉', () => {
    const r = renderBlock()
    drag(r.block, 24, { escape: true })
    expect(r.onReschedule).not.toHaveBeenCalled()
    expect(r.onClick).not.toHaveBeenCalled()
  })

  test('底缘手柄挂在块内底边 (块 overflow:hidden, 手柄必须是子节点且贴底)', () => {
    const r = renderBlock()
    const handle = r.handle as HTMLElement
    expect(handle.parentElement).toBe(r.block)
    expect(handle.style.position).toBe('absolute')
    expect(handle.style.bottom).toBe('0px')
    expect(handle.style.cursor).toBe('ns-resize')
    // 手柄比 15min 一格 (12px) 窄, 不盖住块内文本
    expect(parseFloat(handle.style.height)).toBeLessThan(12)
  })

  test('底缘手柄改时长 → 只动结束时间', () => {
    const r = renderBlock()
    expect(r.handle).toBeTruthy()
    drag(r.handle!, 24)
    expect(r.onReschedule).toHaveBeenCalledTimes(1)
    const next = r.onReschedule.mock.calls[0][0]
    expect(next.mode).toBe('resize')
    expect(hhmm(next.startIso)).toBe('10:00')
    expect(hhmm(next.endIso)).toBe('11:30')
  })

  test('Join 小钮不参与拖拽起手 (手抖几 px 不该把会议改期掉)', () => {
    const event = makeOccurrence({ url: 'https://teams.microsoft.com/l/meetup-join/x' })
    const r = renderBlock({ event })
    const join = r.block.querySelector('.evt-join')!
    fireEvent.pointerDown(join, { button: 0, clientY: 200 })
    fireEvent.pointerMove(window, { clientY: 224 })
    fireEvent.pointerUp(window, { clientY: 224 })
    expect(r.onReschedule).not.toHaveBeenCalled()
  })

  test('不可拖 (非组织者/只读) → 无手柄, 拖动只当点击', () => {
    const r = renderBlock({ draggable: false })
    expect(r.handle).toBeNull()
    drag(r.block, 24)
    expect(r.onReschedule).not.toHaveBeenCalled()
    expect(r.onClick).toHaveBeenCalledTimes(1)
  })
})

describe('EventBlock 乐观 override', () => {
  const override = {
    startIso: new Date(START + 30 * 60_000).toISOString(),
    endIso: new Date(END + 30 * 60_000).toISOString()
  }

  test('显示时间用 override 而非缓存里的旧时间', () => {
    const r = renderBlock({ timeOverride: override })
    expect(r.block.querySelector('.e-time')?.textContent).toContain('10:30')
  })

  test('再拖一次以 override 为基准 (不是缓存里的旧时间)', () => {
    const r = renderBlock({ timeOverride: override })
    drag(r.block, 12)
    const next = r.onReschedule.mock.calls[0][0]
    expect(hhmm(next.startIso)).toBe('10:45')
    expect(hhmm(next.endIso)).toBe('11:45')
  })
})
