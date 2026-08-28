// task 08-27 dogfood 轮 2 —— 日历源分组树的纯函数（成员聚合 + 组头三态）。
//
// 二级栏从「小月历 + 三组总开关」改成分组日历树后，组内每一条（邮箱日历名 /
// 事项 / 智能体）都能单独勾选。这里只放判据与聚合，零 hooks import 链（node
// 环境直接单测，对齐 monthGrid.ts / agendaLayout.ts 惯例）。
//
// 🔴 成员身份判据单源 = `agendaMemberId`。过滤（calendar-filter.filterAgendaByMembers）
// 与树渲染必须用同一把尺子，否则出现「树上勾掉了、网格还在画」这类静默劈叉。

import type { AgendaEntry, AgendaSource } from '@shared/api/types'

export interface CalendarSourceMember {
  /** 组内稳定 id：邮箱 = calendar 名，事项 = matter public_id，agent = agentId。 */
  id: string
  label: string
}

/** 条目归属的成员 id；null = 这条没有成员身份（只受组级开关管，恒显示）。 */
export function agendaMemberId(entry: AgendaEntry): string | null {
  if (entry.source === 'mail') return entry.calendarName ?? null
  if (entry.source === 'matter') return entry.matterId ?? null
  return entry.agentId ?? null
}

/** 窗口内 agenda 条目 → 某一组的成员清单（去重 + 按名排序）。
 *
 *  事项组：行动项（`itemId` 非空）归其**父事项** —— 后端 `matterId` 对事项条目
 *  与行动项条目恒是同一个 public_id（`agenda.py` 两处都写 `row['public_id']`）。
 *  名字优先取事项自己那条（截止日条目，标题 = 事项名）；一个事项在窗口里只有
 *  行动项时退而用行动项标题（除此之外没有别的名字可用，宁可显示行动项名也不
 *  显示一串 public_id）。
 *
 *  🔴 **邮箱组不走这里**：它的成员是 calendar 名，来自 `useCalendarNames()`
 *  （全量、与窗口无关），名字就是 id 本身 —— 从条目聚合只会拿到会议标题当日历名。 */
export function aggregateSourceMembers(
  entries: readonly AgendaEntry[],
  source: Exclude<AgendaSource, 'mail'>
): CalendarSourceMember[] {
  const byId = new Map<string, { label: string; primary: boolean }>()
  for (const entry of entries) {
    if (entry.source !== source) continue
    const id = agendaMemberId(entry)
    if (id === null) continue
    const primary = entry.itemId == null
    const label = entry.title.trim() || id
    const cur = byId.get(id)
    if (!cur) byId.set(id, { label, primary })
    else if (primary && !cur.primary) byId.set(id, { label, primary })
  }
  return [...byId.entries()]
    .map(([id, v]) => ({ id, label: v.label }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** 排除集 → 「按日历筛选」下拉要的**选中集**。
 *
 *  下拉的既有语义是「空数组 = 全部」（`filterOccurrencesByCalendars` 也是这么读的），
 *  排除集为空时就返回空数组，别返回全量清单 —— 那会在日历名还没加载完的一瞬间
 *  变成「一个都没选中」。反方向（选中集 → 排除集）在 store 的 `setSelectedMembers`。 */
export function selectionFromExclusions(
  allIds: readonly string[],
  excluded: ReadonlySet<string>
): string[] {
  if (excluded.size === 0) return []
  return allIds.filter((id) => !excluded.has(id))
}

export type GroupCheckState = 'on' | 'mixed' | 'off'

/** 组头勾选态。
 *
 *  🔴 `excludedCount` 只能数**当前成员里**被排除的条数，不能数整个排除集 ——
 *  持久化下来的陈旧 id（事项已完成、agent 已删）会把「一条没排除」误判成 mixed。 */
export function groupCheckState(
  on: boolean,
  excludedCount: number,
  memberCount: number
): GroupCheckState {
  if (!on) return 'off'
  if (excludedCount === 0) return 'on'
  // 成员一条不剩 = 视觉上就是整组不显示，勾成 off 才诚实。
  if (memberCount > 0 && excludedCount >= memberCount) return 'off'
  return 'mixed'
}
