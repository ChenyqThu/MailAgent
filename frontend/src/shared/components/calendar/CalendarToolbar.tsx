// Phase 3 §3.2 — 顶部工具栏: 视图切换 + 日期导航 + sync trigger.

import { Calendar as CalendarIcon, ChevronLeft, ChevronRight, RefreshCw, RotateCcw } from 'lucide-react'

import { useCalendarSyncTrigger, useCalendarSyncStatus } from './hooks/useCalendarEvents'
import { cn } from '@shared/lib/cn'

export type CalendarView = 'today' | 'week' | 'month' | 'agenda' | 'recurring'

const VIEW_LABELS: Record<CalendarView, string> = {
  today: '今日',
  week: '周',
  month: '月',
  agenda: 'Agenda',
  recurring: '定期邀请'
}

interface Props {
  view: CalendarView
  onViewChange: (v: CalendarView) => void
  /** 当前日期 (day/week/month 视图导航锚点). agenda/recurring 忽略. */
  currentDate: Date
  onDateChange: (d: Date) => void
}

function fmtDate(d: Date, view: CalendarView): string {
  if (view === 'today') {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${days[d.getDay()]}`
  }
  if (view === 'week') {
    // 显示周一-周日范围
    const start = new Date(d)
    const day = start.getDay() || 7
    if (day !== 1) start.setDate(start.getDate() - (day - 1))
    const end = new Date(start)
    end.setDate(end.getDate() + 6)
    return `${start.getMonth() + 1}/${start.getDate()} - ${end.getMonth() + 1}/${end.getDate()}`
  }
  if (view === 'month') {
    return `${d.getFullYear()}年 ${d.getMonth() + 1}月`
  }
  return ''
}

function step(view: CalendarView, dir: 1 | -1, base: Date): Date {
  const d = new Date(base)
  if (view === 'today') d.setDate(d.getDate() + dir)
  else if (view === 'week') d.setDate(d.getDate() + dir * 7)
  else if (view === 'month') d.setMonth(d.getMonth() + dir)
  return d
}

export function CalendarToolbar({
  view,
  onViewChange,
  currentDate,
  onDateChange
}: Props): React.ReactElement {
  const { trigger, isPending } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()

  const lastSync = syncStatus?.[0]?.last_incremental_sync_at_iso
  const lastSyncTxt = lastSync ? relativeTime(new Date(lastSync)) : '—'

  const showDateNav = view === 'today' || view === 'week' || view === 'month'

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-3">
        <h1 className="text-display text-ink-fg font-semibold flex items-center gap-2">
          <CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-1" />
          日历
        </h1>
        {showDateNav && (
          <div className="inline-flex items-center gap-1 ml-2">
            <button
              type="button"
              onClick={() => onDateChange(step(view, -1, currentDate))}
              className="p-1 text-ink-fg-2 hover:text-ink-fg rounded hover:bg-ink-3"
              aria-label="上一段"
            >
              <ChevronLeft size={16} strokeWidth={2} />
            </button>
            <button
              type="button"
              onClick={() => onDateChange(new Date())}
              className="px-2 py-1 text-aux text-ink-fg-1 hover:text-ink-fg border border-ink-border rounded"
            >
              今天
            </button>
            <button
              type="button"
              onClick={() => onDateChange(step(view, 1, currentDate))}
              className="p-1 text-ink-fg-2 hover:text-ink-fg rounded hover:bg-ink-3"
              aria-label="下一段"
            >
              <ChevronRight size={16} strokeWidth={2} />
            </button>
            <span className="text-aux text-ink-fg-1 ml-2 tabular-nums">
              {fmtDate(currentDate, view)}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {/* 视图切换 */}
        <div className="inline-flex rounded-md border border-ink-border bg-ink-2 p-0.5">
          {(['today', 'week', 'month', 'agenda', 'recurring'] as CalendarView[]).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onViewChange(v)}
              className={cn(
                'px-2 py-1 text-aux rounded transition-colors duration-fast',
                v === view
                  ? 'bg-coral/15 text-coral font-medium'
                  : 'text-ink-fg-1 hover:text-ink-fg'
              )}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>

        {/* sync trigger + last sync */}
        <span className="text-meta text-ink-fg-2 tabular-nums ml-2">
          上次同步: {lastSyncTxt}
        </span>
        <button
          type="button"
          onClick={() => trigger({ full: true })}
          disabled={isPending}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 text-aux rounded',
            'border border-ink-border text-ink-fg-1 hover:text-ink-fg hover:bg-ink-3',
            'disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-fast'
          )}
          title="手动触发一次 CalDAV → SQLite sync"
        >
          {isPending ? (
            <RefreshCw size={12} strokeWidth={2} className="animate-spin" />
          ) : (
            <RotateCcw size={12} strokeWidth={2} />
          )}
          同步
        </button>
      </div>
    </header>
  )
}

function relativeTime(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000)
  if (secs < 60) return `${secs}秒前`
  if (secs < 3600) return `${Math.floor(secs / 60)}分钟前`
  if (secs < 86400) return `${Math.floor(secs / 3600)}小时前`
  return `${Math.floor(secs / 86400)}天前`
}
