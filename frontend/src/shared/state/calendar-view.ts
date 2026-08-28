// task 08-27 P3 —— 日历视图模块级 store：currentDate + 三源开关。
//
// currentDate 此前是 CalendarLayout 组件内 useState，小月历（CalendarMiniPanel）
// 因此接不上「主视图翻月 → 小月历跟随」的反向联动（正向联动经 calendar-focus
// store 的既有路径不动）。提升到这里后两侧读同一份。currentDate 是会话态，
// **不持久化**（重启回到今天）。
//
// 三源开关（邮箱 / 事项 / Agent）持久化 localStorage（形状校验 + 跨窗口
// storage 同步，抄 pinned-folders 范式）。开关是 client-side 过滤判据，
// 不进 react-query queryKey —— 切开关不重发请求（对齐 selectedCalendars 惯例）。
//
// 🔴 本文件不 import registry / router / hooks（HMR 失效链防御，仓内既有纪律）。

import { create } from 'zustand'

import type { AgendaSource } from '@shared/api/types'

const SOURCES_KEY = 'mailagent.calendar.sources.v1'

export type CalendarSourceToggles = Record<AgendaSource, boolean>

export const DEFAULT_SOURCE_TOGGLES: CalendarSourceToggles = {
  mail: true,
  matter: true,
  agent: true
}

function parseSources(raw: string | null): CalendarSourceToggles {
  if (!raw) return { ...DEFAULT_SOURCE_TOGGLES }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SOURCE_TOGGLES }
    const rec = parsed as Record<string, unknown>
    const pick = (k: AgendaSource): boolean =>
      typeof rec[k] === 'boolean' ? (rec[k] as boolean) : DEFAULT_SOURCE_TOGGLES[k]
    return { mail: pick('mail'), matter: pick('matter'), agent: pick('agent') }
  } catch {
    return { ...DEFAULT_SOURCE_TOGGLES }
  }
}

function readSources(): CalendarSourceToggles {
  if (typeof window === 'undefined') return { ...DEFAULT_SOURCE_TOGGLES }
  try {
    return parseSources(window.localStorage.getItem(SOURCES_KEY))
  } catch {
    return { ...DEFAULT_SOURCE_TOGGLES }
  }
}

function writeSources(next: CalendarSourceToggles): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SOURCES_KEY, JSON.stringify(next))
  } catch {
    /* quota / private mode —— 状态留在内存里 */
  }
}

interface CalendarViewState {
  /** 主视图当前锚定日期（月视图 = 该月，日/周视图 = 该日所在段）。 */
  currentDate: Date
  sources: CalendarSourceToggles
  setCurrentDate(d: Date): void
  toggleSource(s: AgendaSource): void
}

export const useCalendarView = create<CalendarViewState>((set, get) => ({
  currentDate: new Date(),
  sources: readSources(),
  setCurrentDate: (d) => set({ currentDate: d }),
  toggleSource: (s) => {
    const next = { ...get().sources, [s]: !get().sources[s] }
    writeSources(next)
    set({ sources: next })
  }
}))

// 跨窗口同步（弹出窗与主窗共用同一份开关）——同 pinned-folders / group-collapse 范式。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== SOURCES_KEY) return
    useCalendarView.setState({ sources: parseSources(e.newValue) })
  })
}
