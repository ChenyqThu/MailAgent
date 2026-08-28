// task 08-27 P5 —— 周视图重做: 7 列时间轴 (TimelineView dayCount=7), 三源聚合
// 数据 + 月视图确立的源色语言。旧的按格 all-day chips 换成置顶条区色带
// (跨天条目横跨若干列, lane 堆叠), 结构细节见 TimelineView。

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { CalendarEventOccurrence } from '@shared/api/types'

import type { EventRescheduleInput } from '../EventBlock'
import { startOfWeek } from '../hooks/useCalendarEvents'
import { TimelineView } from './TimelineView'

interface Props {
  date?: Date
  /** F5 — Layout 持单一 active + Drawer, view 上提选中事件。 */
  onSelect: (occ: CalendarEventOccurrence) => void
  selectedKey?: string | null
  /** Lane C (#5) — 拖拽改期提交口 (Layout 持 mutation)。不传 = 只读。 */
  onReschedule?: (occ: CalendarEventOccurrence, next: EventRescheduleInput) => void
  userEmail?: string | null
}

export function WeekView({
  date,
  onSelect,
  selectedKey = null,
  onReschedule,
  userEmail = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const weekStart = useMemo(() => startOfWeek(date ?? new Date()), [date])

  return (
    <TimelineView
      gridStart={weekStart}
      dayCount={7}
      emptyTitle={t('calendar.empty.week', '本周无日程')}
      onSelect={onSelect}
      selectedKey={selectedKey}
      onReschedule={onReschedule}
      userEmail={userEmail}
    />
  )
}
