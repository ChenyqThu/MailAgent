// 视觉复刻 mockup-calendar.html §toolbar (2026-05-23) —
// title + range-label + 日期 nav + view chips + sync btn + sync-pill (CSS hover tip).
//
// 接口不变 (view / onViewChange / currentDate / onDateChange), 只重做视觉。
// CalendarView 类型从 router-instance 复用 (单一来源, 避免 enum 漂移).
//
// 切到 mockup class (.nav-btn / .today-btn / .view-chip / .sync-pill),
// 不再用 Tailwind inline. sync tip CSS-only hover 触发, 移除 useState.

import { useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { EventFormModal } from './EventFormModal'
import {
  useCalendarSyncTrigger,
  useCalendarSyncStatus,
  startOfWeek,
  addDays,
  relativeTime,
  useNowTick
} from './hooks/useCalendarEvents'
import { cn } from '@shared/lib/cn'
import { type CalendarView } from '@shared/router-instance'

// 兼容旧 import — 历史代码 `import { type CalendarView } from './CalendarToolbar'`
export type { CalendarView }

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
  const { t } = useTranslation()
  const { trigger, isPending } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()
  // 30s tick — 让 sync-pill 的 "上次同步 N 秒前" 字串自然走时, 不靠 syncStatus
  // 数据引用变化也能刷.
  useNowTick()

  // Phase 2.2 — [+ 新建] 按钮 → 弹 EventFormModal (occurrence=null = create 语义)
  const [createModalOpen, setCreateModalOpen] = useState(false)

  const VIEW_LABELS: Record<CalendarView, string> = {
    today: t('calendar.toolbar.viewDay', '日'),
    week: t('calendar.toolbar.viewWeek', '周'),
    month: t('calendar.toolbar.viewMonth', '月'),
    agenda: t('calendar.toolbar.viewAgenda', 'Agenda'),
    recurring: t('calendar.toolbar.viewRecurring', '定期邀请')
  }

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
        <h1 className="text-subj font-semibold text-ink-fg tracking-tight">{t('calendar.toolbar.title', '日历')}</h1>
        <span className="text-lead text-ink-fg-1 font-mono tabular-nums whitespace-nowrap">
          {rangeLabel}
        </span>
      </div>

      {/* date nav — agenda/recurring 隐藏 */}
      {showDateNav && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="nav-btn"
            onClick={() => onDateChange(step(view, -1, currentDate))}
            aria-label={t('calendar.toolbar.prevAria', '上一段')}
            title={t('calendar.toolbar.prevTitle', '上一段 (←)')}
          >
            <ChevronLeft size={14} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            className="today-btn"
            onClick={() => onDateChange(new Date())}
            title={t('calendar.toolbar.todayTitle', '今天 (T)')}
          >
            {t('calendar.toolbar.today', '今天')}
          </button>
          <button
            type="button"
            className="nav-btn"
            onClick={() => onDateChange(step(view, 1, currentDate))}
            aria-label={t('calendar.toolbar.nextAria', '下一段')}
            title={t('calendar.toolbar.nextTitle', '下一段 (→)')}
          >
            <ChevronRight size={14} strokeWidth={2.2} />
          </button>
        </div>
      )}

      {/* view chips — push to right */}
      <div
        className="flex items-center gap-1 ml-auto p-0.5 rounded-lg bg-ink-2/40 border border-ink-border/50"
        role="tablist"
        aria-label={t('calendar.toolbar.viewAria', '视图切换')}
      >
        {(['today', 'week', 'month', 'agenda', 'recurring'] as CalendarView[]).map((v) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={v === view}
            onClick={() => onViewChange(v)}
            className={cn('view-chip', v === view && 'is-active')}
          >
            {VIEW_LABELS[v]}
          </button>
        ))}
      </div>

      {/* Phase 2.5 §11.1 — [+ 新建] coral primary (跟 mockup-event-form §toolbar 一致) */}
      <button
        type="button"
        className="btn-coral"
        onClick={() => setCreateModalOpen(true)}
        title={t('calendar.toolbar.newTitle', '新建事件 — 直接写到 Exchange (CalDAV PUT)')}
      >
        <Plus size={14} strokeWidth={2.4} />
        <span>{t('calendar.toolbar.newBtn', '新建')}</span>
      </button>

      {/* sync — nav-btn 拉宽 (mockup inline style) + sync-pill CSS-only hover tip */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="nav-btn"
          style={{ width: 'auto', padding: '0 11px', gap: 6, fontSize: 13 }}
          onClick={() => trigger({ full: true })}
          disabled={isPending}
          title={t('calendar.toolbar.syncTitle', '急刷 (⌘R) · 后台 worker 每 60s 自动同步, 此按钮触发立即全量拉取')}
        >
          <RefreshCw size={13} strokeWidth={2} className={cn(isPending && 'animate-spin')} />
          <span>{t('calendar.toolbar.syncBtn', '同步')}</span>
        </button>
        <div className="sync-pill" data-sync={hasErr ? 'err' : 'ok'}>
          <span className="sync-dot" aria-hidden />
          <span className="sync-label">
            {hasErr
              ? t('calendar.toolbar.syncPillErr', '同步失败 · [ERR]')
              : lastDate
                ? t('calendar.toolbar.syncPillOk', '上次同步 {time}', { time: relativeTime(lastDate) })
                : t('calendar.toolbar.syncPillNone', '尚未同步')}
          </span>
          <div className="sync-tip glass-pop">
            <div className="text-aux text-ink-fg font-medium mb-1">
              {hasErr ? t('calendar.toolbar.syncTipErr', 'DavMail · 同步失败') : t('calendar.toolbar.syncTipOk', 'DavMail · 已同步')}
            </div>
            <div className="text-meta text-ink-fg-2 font-mono leading-relaxed break-all">
              {hasErr && (lastError ?? t('calendar.toolbar.syncTipUnknownErr', '未知错误'))}
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
              {!head && t('calendar.toolbar.syncTipNoRecord', '尚无 sync_state 记录 — 启用 CALENDAR_CALDAV_SYNC_ENABLED 后等 60s')}
            </div>
          </div>
        </div>
      </div>

      {/* Phase 2.2 — create modal (occurrence=null = create 语义) */}
      <EventFormModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        occurrence={null}
      />
    </div>
  )
}
