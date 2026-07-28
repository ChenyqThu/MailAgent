// `calendar_event.source` 三态的**前端单源**（issue #68）。
//
// 收编 `MeetingInviteCard.tsx` 与 `EventDetailDrawer.tsx` 各自持有的一份 `_VALID_SOURCES`
// + `narrowSource`（两处逐字相同，前者的注释就写着「待收敛 … 阶段 2 收尾抽 shared helper」）。
//
// 🔴 值域的**编译期**真源是 `CalendarEventSource` 联合类型：下面的 `satisfies` 挡住多写/写错的
// 成员，`_Exhaustive` 挡住漏写的成员 —— 加第四个 source 时联合类型一改，这里不补就编译不过。
// 比测试更早、更硬。跨语言那一侧（Python `SOURCES_TRY_ORDER` / SQL CHECK / gateway zod）由
// `tests/calendar/test_event_source_parity.py` 对撞。

import type { CalendarEventSource } from '@shared/api/types/calendar'

export const VALID_CALENDAR_SOURCES = [
  'caldav',
  'email_ics',
  'legacy_calendar_app'
] as const satisfies readonly CalendarEventSource[]

// 漏成员则 Exclude<> 不为 never，`true` 赋不进 `never`，编译期红。
type _Exhaustive =
  Exclude<CalendarEventSource, (typeof VALID_CALENDAR_SOURCES)[number]> extends never ? true : never
const _exhaustive: _Exhaustive = true
void _exhaustive

const SOURCE_SET: ReadonlySet<string> = new Set(VALID_CALENDAR_SOURCES)

/**
 * 运行期把 DB 里的 `occurrence.source`（string）收窄成 `CalendarEventSource`。
 *
 * legacy row 可能带未知 source 值，`as CalendarEventSource` 强转会 silent mismatch；
 * 这里走白名单，未知值 → `undefined` + 一次 warn，调用方把 undefined 传给 CLI，让
 * Python 侧的 `SOURCES_TRY_ORDER` 自动 fallback 查找。
 */
export function narrowCalendarSource(
  s: string | null | undefined
): CalendarEventSource | undefined {
  if (!s) return undefined
  if (SOURCE_SET.has(s)) return s as CalendarEventSource
  console.warn(`[calendar] unknown event source=${JSON.stringify(s)}, falling back`)
  return undefined
}
