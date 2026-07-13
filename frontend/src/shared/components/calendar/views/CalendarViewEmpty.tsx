// F23/S7 — Week/Day 空态三语义: 「无事件」/「从未同步」/「同步失败」.
//
// 与阶段 0 的 CalendarQueryError 区分: 那是 events 查询本身 reject; 这里是
// 查询成功返回空, 但同步链路状态决定空的含义 — 从未同步/同步失败时提示
// 「本周无日程」会误导用户以为没事件而不是系统没数据 (S7).
//
// 判定口径 (数据源 useCalendarSyncStatus):
//   1. 同步失败  — 健康优先选行 (find 无 last_error 的行 ?? [0], 与 Toolbar
//      sync-pill 同源判定, 避免 F19 孤儿行误报) 后 head.last_error 非空;
//   2. 从未同步  — syncStatus 已加载且 (无行 || 选中行 full/incremental 两个
//      同步时间戳均为 null);
//   3. 正常空    — 其余 (含 syncStatus 尚在加载/不可得: 不闪错误语义).

import { AlertTriangle, Calendar as CalendarIcon, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@shared/components/feedback/EmptyState'
import { pickSyncHead, useCalendarSyncStatus } from '../hooks/useCalendarEvents'

interface Props {
  /** 正常空态标题 (视图各自的「本周/本日无日程」). */
  emptyTitle: string
}

export function CalendarViewEmpty({ emptyTitle }: Props): React.ReactElement {
  const { t } = useTranslation()
  const { data: syncStatus, isLoading } = useCalendarSyncStatus()
  // F19/Q6 — 健康优先选行统一走 pickSyncHead (与 Toolbar sync-pill / Layout 同源).
  const head = pickSyncHead(syncStatus)
  const syncFailed = !!head?.last_error
  const neverSynced =
    !isLoading &&
    syncStatus !== undefined &&
    (!head || (!head.last_full_sync_at_iso && !head.last_incremental_sync_at_iso))

  if (syncFailed) {
    return (
      <EmptyState
        icon={<AlertTriangle size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
        title={t('calendar.empty.syncFailed', '日历同步失败')}
        hint={t('calendar.empty.syncFailedHint', '上次同步出错——悬停底部状态栏的 ℹ️ 查看错误详情')}
      />
    )
  }
  if (neverSynced) {
    return (
      <EmptyState
        icon={<RefreshCw size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
        title={t('calendar.empty.neverSynced', '日历尚未同步')}
        hint={t('calendar.empty.neverSyncedHint', '点击工具栏的同步按钮拉取日历事件')}
      />
    )
  }
  return (
    <EmptyState
      icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
      title={emptyTitle}
    />
  )
}
