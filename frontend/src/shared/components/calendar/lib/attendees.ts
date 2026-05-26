// Phase 4·#4 — attendees update 决策 (数据安全: 防 update 静默清空 / partstat 退化).
// 抽成纯函数让 EventFormModal 提交逻辑可独立单测 (跟 lib/rrule / lib/calendar-filter 平行).
import type { EventAttendeeInput } from '@shared/api/types'

/**
 * 改整系列 update 时, 按"用户是否动过与会者 chips"决定传什么给后端:
 *
 * - **未 dirty** → 返回 `{}` (不传 attendees) → 后端 service 条件传 → writer `_UNSET`
 *   → 保留原与会者 + partstat. 关键: 防止编辑事件 (没碰与会者) 时把预填的
 *   `{email,name}` chips 当替换列表回传, 丢失 partstat → Exchange 把已 ACCEPTED
 *   打回 NEEDS-ACTION → 重发邀请.
 * - **dirty + 非空** → `{ attendees }` 替换原列表.
 * - **dirty + 删光** → `{ clearAttendees: true }` 显式清空. 因不传语义现在 = 保留,
 *   "删光 chips" 必须走显式清空信号 (后端 --clear-attendees → service `[]`).
 */
export function resolveAttendeesUpdate(
  attendeesDirty: boolean,
  chips: EventAttendeeInput[]
): { attendees?: EventAttendeeInput[]; clearAttendees?: boolean } {
  if (!attendeesDirty) return {}
  if (chips.length > 0) return { attendees: chips }
  return { clearAttendees: true }
}
