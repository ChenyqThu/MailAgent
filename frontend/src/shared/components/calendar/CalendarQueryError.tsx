// F21 — query 错误态共享 fallback (阶段 0.4). useCalendarEventsInWindow /
// recurring listQ reject (IPC/HTTP 失败, retry 耗尽) 时不再伪装成
// EmptyState「无日程」假空态, 渲染与空态视觉区分的错误屏 + [重试] refetch.
// CalendarErrorBoundary 只兜 render throw, query reject 走这里 —— 两层正好补上
// 中间最常见的失败面. 视觉沿用 ErrorBoundary fallback 语言: coral AlertCircle
// + .today-btn 重试.

import { AlertCircle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@shared/components/feedback/EmptyState'

interface Props {
  /** 点 [重试] 触发对应 query 的 refetch. */
  onRetry: () => void
}

export function CalendarQueryError({ onRetry }: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <EmptyState
      icon={<AlertCircle size={20} strokeWidth={1.75} className="text-coral" />}
      title={t('calendar.error.title', '日历数据加载失败')}
      hint={t('calendar.error.hint', '获取日程失败, 可能是后端服务暂不可用.')}
      action={
        <button type="button" className="today-btn" onClick={onRetry}>
          <RefreshCw size={13} strokeWidth={2} />
          {t('calendar.error.retry', '重试')}
        </button>
      }
    />
  )
}
