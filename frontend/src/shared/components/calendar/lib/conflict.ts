// task 08-27 P5 —— 日程时间冲突判定的**唯一口径**。
//
// 消费方四处 (日视图 / 周视图 = TimelineView 一份, 议程行, 事件详情抽屉) 一律
// 从这里取判据, 不许在各自文件里再写一遍 —— 三处口径分叉 = 同一场会在块上有标
// 在抽屉里没有。
//
// 判据 (已拍板, 不许在消费方放宽或收紧):
//   - **只算 mail↔mail**: 三源里只有邮箱日程是「时段」(endIso 非空); 事项截止
//     与 Agent 排程是时刻 (契约 calendar.ts:167 明写), 跟任何东西都只能同刻而
//     不能相交, 不参与。
//   - **严格半开区间相交**: a.start < b.end && a.end > b.start。贴边 (前一场
//     10:00 结束、后一场 10:00 开始) 不算冲突。
//   - **排除不占时间的**: 已取消 (status CANCELLED) 与自己已拒 (response_status
//     DECLINED) 都腾出了那段时间。暂定 (TENTATIVE) **算**冲突 —— 还没推掉就仍
//     然占着。
//   - **全天 / 跨天不参与**: 它跟当天一切都相交, 算进去等于每天都「冲突」。判据
//     与 splitTimelineEntries 的 bands 一致 (allDay || 跨本地日)。
//
// ⚠️ 邮件详情邀请卡的「当日冲突 chip」(MeetingInviteCard.tsx:188-199 的内联谓词)
// **没有**迁进这个单源, 它的判据比这里宽: 只排 CANCELLED, 不排 DECLINED, 也不排
// 全天 / 跨天。迁移记为后续项 —— 在那之前两处不是同一把尺子, 同一场会在邀请卡上
// 的 chip 与日程视图里的冲突标可能不一致。
//
// 纯函数 + 零 hooks import 链 (对齐 agendaLayout.ts / monthGrid.ts 惯例), node
// 环境直接单测。

import type { AgendaEntry, CalendarEventOccurrence } from '@shared/api/types'

import { localDay } from './monthGrid'
import { occurrenceKey } from './occurrence-key'

/** 参与冲突判定的一段时间。id 用消费方自己的 id 空间 (视图 = AgendaEntry.id,
 *  抽屉 = occurrenceKey), 同一次调用里不混用两种。 */
export interface ConflictCandidate {
  id: string
  title: string
  startMs: number
  endMs: number
}

/** 状态判据单源: 已取消 / 已拒的会不占时间, 暂定与待回复占。 */
function occupiesTime(
  status: string | null | undefined,
  responseStatus: string | null | undefined
): boolean {
  if ((status ?? '').toUpperCase() === 'CANCELLED') return false
  if ((responseStatus ?? '').toUpperCase() === 'DECLINED') return false
  return true
}

/** 跨本地日 (endMs-1: 结束恰为 00:00 时归前一日, 与 entryDayRange 同款技巧)。 */
function spansLocalDays(startMs: number, endMs: number): boolean {
  return localDay(startMs).getTime() !== localDay(Math.max(endMs - 1, startMs)).getTime()
}

/** 议程条目 → 候选。非 mail / 时刻 / 全天 / 跨天 / 不占时间的一律 null。
 *  occ = 同窗口缓存解析回来的 occurrence (状态字段只在它身上, AgendaEntry 不带);
 *  解析不到时按「占时间」处理 —— 拿不到状态就不该悄悄把一场会当不存在。 */
export function candidateFromEntry(
  entry: AgendaEntry,
  occ: CalendarEventOccurrence | null
): ConflictCandidate | null {
  if (entry.source !== 'mail' || !entry.endIso) return null
  if (entry.allDay || entry.multiDay) return null
  if (occ && !occupiesTime(occ.status, occ.response_status)) return null
  const startMs = Date.parse(entry.startIso)
  const endMs = Date.parse(entry.endIso)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { id: entry.id, title: entry.title, startMs, endMs }
}

/** occurrence → 候选 (抽屉侧: 那里只有 occurrence, 没有 AgendaEntry)。 */
export function candidateFromOccurrence(occ: CalendarEventOccurrence): ConflictCandidate | null {
  if (occ.is_all_day) return null
  if (!occupiesTime(occ.status, occ.response_status)) return null
  const startMs = Date.parse(occ.occurrence_start_iso)
  const endMs = Date.parse(occ.occurrence_end_iso)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  if (spansLocalDays(startMs, endMs)) return null
  return { id: occurrenceKey(occ), title: occ.summary, startMs, endMs }
}

/** 严格半开区间相交。 */
export function overlaps(a: ConflictCandidate, b: ConflictCandidate): boolean {
  return a.startMs < b.endMs && a.endMs > b.startMs
}

/** 与 target 相交的候选 (按 id 排除自身), 开始时间升序。抽屉列冲突对象用。 */
export function conflictsFor(
  target: ConflictCandidate,
  candidates: readonly ConflictCandidate[]
): ConflictCandidate[] {
  return candidates
    .filter((c) => c.id !== target.id && overlaps(target, c))
    .sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id))
}

/** 全量两两比较 → id → 冲突对手数 (视图打标用; 无冲突的不进表)。
 *  计数而不只是布尔, 是为了让标识的 tooltip 说得出「与几场重叠」。
 *  单日 / 14 天议程的事件量都很小, O(n²) 够用 —— 不建索引。 */
export function detectConflicts(candidates: readonly ConflictCandidate[]): Map<string, number> {
  const hit = new Map<string, number>()
  const bump = (id: string): void => {
    hit.set(id, (hit.get(id) ?? 0) + 1)
  }
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (overlaps(candidates[i], candidates[j])) {
        bump(candidates[i].id)
        bump(candidates[j].id)
      }
    }
  }
  return hit
}
