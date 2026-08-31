// task 08-27 P5 —— 三源条目点击分流 (月/日/周/日程共用, 原 MonthView 内联逻辑上提)。
//
// P4d 起**三源都先开详情抽屉**, 不再有「点一下就把人甩到另一个域」这档事:
//   mail   → 从同窗口 events 缓存解析 occurrence (零额外 IPC) 上抛给 Layout 开
//            EventDetailDrawer, 未命中兜底合成 (agendaLayout.resolveMailOccurrence);
//   matter → 投影槽位 (calendar-agenda-detail store), 抽屉里渲染事项形态 + 「去事项」;
//   agent  → 同上, 抽屉里渲染排程形态 + 「去 Agent」。
//
// 🔴 跳去源头的导航搬到抽屉里了 (MatterEntryDetail / AgentEntryDetail) —— 看一眼截止日
// 是什么就得先丢掉当前视图, 是原来那版最费事的一点。

import type { AgendaEntry, CalendarEventOccurrence } from '@shared/api/types'
import { useAgendaDetail } from '@shared/state/calendar-agenda-detail'

import { resolveMailOccurrence } from '../lib/agendaLayout'

export function useAgendaEntryClick(
  onSelect: (occ: CalendarEventOccurrence) => void,
  occs: CalendarEventOccurrence[] | undefined
): (entry: AgendaEntry) => void {
  return (entry: AgendaEntry): void => {
    if (entry.source === 'mail') {
      // 投影与 occurrence 是两个槽位, 投影在前 —— 换成邮件条目要把它让出来。
      useAgendaDetail.getState().close()
      onSelect(resolveMailOccurrence(entry, occs ?? []))
      return
    }
    useAgendaDetail.getState().open(entry)
  }
}
