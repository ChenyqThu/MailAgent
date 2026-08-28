// task 08-27 P5 —— 三源条目点击分流 (月/日/周共用, 原 MonthView 内联逻辑上提)。
//
// mail  → 从同窗口 events 缓存解析 occurrence (零额外 IPC) 上抛给 Layout 开
//         EventDetailDrawer, 未命中兜底合成 (agendaLayout.resolveMailOccurrence);
// matter → 事项详情 (useMatterNavigation + registry 导航, 零路径字面量);
// agent  → 团队域 (registry 导航函数)。

import { useNavigate } from '@tanstack/react-router'

import type { AgendaEntry, CalendarEventOccurrence } from '@shared/api/types'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { navEntry, navigateToNavEntry } from '@shared/navigation/registry'

import { resolveMailOccurrence } from '../lib/agendaLayout'

export function useAgendaEntryClick(
  onSelect: (occ: CalendarEventOccurrence) => void,
  occs: CalendarEventOccurrence[] | undefined
): (entry: AgendaEntry) => void {
  const navigate = useNavigate()
  return (entry: AgendaEntry): void => {
    if (entry.source === 'mail') {
      onSelect(resolveMailOccurrence(entry, occs ?? []))
      return
    }
    if (entry.source === 'matter') {
      if (entry.matterId) useMatterNavigation.getState().open(entry.matterId)
      navigateToNavEntry(navigate, navEntry('matters'))
      return
    }
    navigateToNavEntry(navigate, navEntry('agents'))
  }
}
