// 视觉复刻 mockup-calendar.html §toolbar (2026-05-23) —
// title + range-label + 日期 nav + view chips + sync btn + sync-pill (hover tip).
//
// 接口不变 (view / onViewChange / currentDate / onDateChange), 只重做视觉。
// CalendarView 类型从 router-instance 复用 (单一来源, 避免 enum 漂移).

import { useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'

import {
  useCalendarSyncTrigger,
  useCalendarSyncStatus,
  startOfWeek,
  addDays
} from './hooks/useCalendarEvents'
import { cn } from '@shared/lib/cn'
import { type CalendarView } from '@shared/router-instance'

// 兼容旧 import — 历史代码 `import { type CalendarView } from './CalendarToolbar'`
export type { CalendarView }

const VIEW_LABELS: Record<CalendarView, string> = {
  today: '日',
  week: '周',
  month: '月',
  agenda: 'Agenda',
  recurring: '定期邀请'
}

const WEEK_CHAR = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function fmtRangeLabel(view: CalendarView, d: Date): string {
  if (view === 'today') return `${d.getMonth() + 1}/${d.getDate()} ${WEEK_CHAR[d.getDay()]}`
  if (view === 'week') {
    const start = startOfWeek(d)
    const end = addDays(start, 6)
    return `${start.getMonth() + 1}/${start.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`
  }
  if (view === 'month') return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
  if (view === 'agenda') return '未来 14 天'
  return '全部定期事件'
}

function step(view: CalendarView, dir: 1 | -1, base: Date): Date {
  const d = new Date(base)
  if (view === 'today') d.setDate(d.getDate() + dir)
  else if (view === 'week') d.setDate(d.getDate() + dir * 7)
  else if (view === 'month') d.setMonth(d.getMonth() + dir)
  return d
}

function relativeTime(d: Date): string {
  const secs = Math.floor((Date.now() - d.getTime()) / 1000)
  if (secs < 5) return '刚刚'
  if (secs < 60) return `${secs} 秒前`
  if (secs < 3600) return `${Math.floor(secs / 60)} 分钟前`
  if (secs < 86400) return `${Math.floor(secs / 3600)} 小时前`
  return `${Math.floor(secs / 86400)} 天前`
}

interface Props {
  view: CalendarView
  onViewChange: (v: CalendarView) => void
  currentDate: Date
  onDateChange: (d: Date) => void
}

export function CalendarToolbar({
  view,
  onViewChange,
  currentDate,
  onDateChange
}: Props): React.ReactElement {
  const { trigger, isPending } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()
  const [tipOpen, setTipOpen] = useState(false)

  const showDateNav = view === 'today' || view === 'week' || view === 'month'
  const head = syncStatus?.[0]
  const lastIso = head?.last_incremental_sync_at_iso ?? head?.last_full_sync_at_iso ?? null
  const lastDate = lastIso ? new Date(lastIso) : null
  const lastError = head?.last_error ?? null
  const hasErr = !!lastError
  const rangeLabel = fmtRangeLabel(view, currentDate)

  return (
    <div className="shrink-0 px-5 pt-4 pb-3 flex items-center gap-4 flex-wrap">
      {/* title + range */}
      <div className="flex items-baseline gap-3 min-w-0">
        <h1 className="text-subj font-semibold text-ink-fg tracking-tight">日历</h1>
        <span className="text-lead text-ink-fg-1 font-mono tabular-nums whitespace-nowrap">
          {rangeLabel}
        </span>
      </div>

      {/* date nav — agenda/recurring 隐藏 */}
      {showDateNav && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onDateChange(step(view, -1, currentDate))}
            className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-ink-border bg-ink-2/50 text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast"
            aria-label="上一段"
            title="上一段 (←)"
          >
            <ChevronLeft size={14} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            onClick={() => onDateChange(new Date())}
            className="h-7 px-3 text-aux text-ink-fg-1 hover:text-ink-fg border border-ink-border bg-ink-2/50 hover:bg-ink-3 rounded-md transition-colors duration-fast"
            title="今天 (T)"
          >
            今天
          </button>
          <button
            type="button"
            onClick={() => onDateChange(step(view, 1, currentDate))}
            className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-ink-border bg-ink-2/50 text-ink-fg-1 hover:bg-ink-3 hover:text-ink-fg transition-colors duration-fast"
            aria-label="下一段"
            title="下一段 (→)"
          >
            <ChevronRight size={14} strokeWidth={2.2} />
          </button>
        </div>
      )}

      {/* view chips — push to right */}
      <div
        className="flex items-center gap-0.5 ml-auto p-0.5 rounded-lg bg-ink-2/40 border border-ink-border/50"
        role="tablist"
        aria-label="视图切换"
      >
        {(['today', 'week', 'month', 'agenda', 'recurring'] as CalendarView[]).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={v === view}
            onClick={() => onViewChange(v)}
            className={cn(
              'px-3 py-1 text-aux rounded-md whitespace-nowrap transition-colors duration-fast',
              v === view
                ? 'bg-coral/15 text-coral border border-coral/30 font-medium'
                : 'border border-transparent text-ink-fg-1 hover:bg-ink-3/70 hover:text-ink-fg'
            )}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {/* sync — button + status pill (hover tip) */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => trigger({ full: true })}
          disabled={isPending}
          className="h-7 inline-flex items-center gap-1.5 px-3 text-aux text-ink-fg-1 hover:text-ink-fg border border-ink-border bg-ink-2/50 hover:bg-ink-3 rounded-md transition-colors duration-fast disabled:opacity-50 disabled:cursor-not-allowed"
          title="同步 (⌘R)"
        >
          <RefreshCw size={13} strokeWidth={2} className={cn(isPending && 'animate-spin')} />
          同步
        </button>
        <div
          className="relative inline-flex items-center gap-1.5 font-mono text-[11.5px] text-ink-fg-2 px-2 py-1 rounded-md hover:bg-ink-3/60 cursor-default"
          onMouseEnter={() => setTipOpen(true)}
          onMouseLeave={() => setTipOpen(false)}
        >
          <span
            className={cn(
              'w-[7px] h-[7px] rounded-full shrink-0',
              hasErr ? 'bg-fail animate-pulse-crit' : 'bg-ok'
            )}
            aria-hidden
          />
          <span className={cn(hasErr && 'text-fail')}>
            {hasErr
              ? '同步失败 · [ERR]'
              : lastDate
                ? `上次同步 ${relativeTime(lastDate)}`
                : '尚未同步'}
          </span>
          {tipOpen && (
            <div className="absolute top-[calc(100%+8px)] right-0 w-[290px] z-50 glass-pop rounded-md px-3 py-2 text-left pointer-events-none">
              <div className="text-aux text-ink-fg font-medium mb-1">
                {hasErr ? 'DavMail · 同步失败' : 'DavMail · 已同步'}
              </div>
              <div className="text-meta text-ink-fg-2 font-mono leading-relaxed break-all">
                {hasErr && (lastError ?? '未知错误')}
                {!hasErr && head && (
                  <>
                    {head.last_full_sync_at_iso && (
                      <>
                        last_full_sync{' '}
                        {head.last_full_sync_at_iso.replace('T', ' ').slice(0, 19)}
                        <br />
                      </>
                    )}
                    {head.ctag && (
                      <>
                        ctag {head.ctag.slice(0, 8)}
                        <br />
                      </>
                    )}
                    {head.calendar_name && <>calendar {head.calendar_name}</>}
                  </>
                )}
                {!head && '尚无 sync_state 记录 — 启用 CALENDAR_CALDAV_SYNC_ENABLED 后等 60s'}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
