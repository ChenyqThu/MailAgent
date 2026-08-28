// task 08-27 P5 —— 日视图重做: 单列时间轴 (TimelineView dayCount=1), 三源聚合
// 数据 + 月视图确立的源色语言。
//
// 旧版的 250px rail (mini-month + dr-list) 整体移除: 日程列表与时间轴同屏两处
// 是重复; 小月历随 dogfood 轮 2 一并退役 (二级栏那份也删了) —— 跳日期只留工具条
// ‹ › / 「今天」一处, 原 onDateChange prop 随 rail 退役。

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { CalendarEventOccurrence } from '@shared/api/types'

import type { EventRescheduleInput } from '../EventBlock'
import { todayStartLocal } from '../hooks/useCalendarEvents'
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

export function DayView({
  date,
  onSelect,
  selectedKey = null,
  onReschedule,
  userEmail = null
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const dayStart = useMemo(() => {
    const d = new Date(date ?? todayStartLocal())
    d.setHours(0, 0, 0, 0)
    return d
  }, [date])

  return (
    <TimelineView
      gridStart={dayStart}
      dayCount={1}
      emptyTitle={t('calendar.empty.day', '本日无日程')}
      onSelect={onSelect}
      selectedKey={selectedKey}
      onReschedule={onReschedule}
      userEmail={userEmail}
    />
  )
}
