// task 07-15 (v1.11.0 前修) — RSVP 渲染门控单源。
// EventDetailDrawer 与 MeetingInviteCard 此前各持一份 normalizeEmail 副本
// (invite card 顶部原有「待收敛」注记); 空 organizer 时两处都按 attendee
// 渲染 RSVP 三键, 点击必失败 (后端无收件人)。抽到这里两组件 import 同一实现。

/** Normalize organizer/userEmail for case-insensitive compare; strips
 *  "mailto:" prefix CalDAV ICS 出 organizer 时常带. */
export function normalizeEmail(s: string | null | undefined): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, '')
}

/** RSVP 渲染门控: organizer 非空且不是自己才允许 RSVP。
 *  空 organizer = owner 自建事件经 Exchange 回读被吃掉 organizer 的形态,
 *  按组织者对待 (编辑/删除照常, 无 RSVP); organizer === userEmail 同理。 */
export function canRsvpFor(
  organizer: string | null | undefined,
  userEmail: string | null | undefined
): boolean {
  const org = normalizeEmail(organizer)
  return !!org && org !== normalizeEmail(userEmail)
}
