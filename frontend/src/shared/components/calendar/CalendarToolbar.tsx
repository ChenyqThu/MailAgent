// 视觉复刻 mockup-calendar.html §toolbar (2026-05-23) —
// title + range-label + 日期 nav + view chips + sync btn + sync-pill (CSS hover tip).
//
// 接口不变 (view / onViewChange / currentDate / onDateChange), 只重做视觉。
// CalendarView 类型从 router-instance 复用 (单一来源, 避免 enum 漂移).
//
// 切到 mockup class (.nav-btn / .today-btn / .view-chip / .sync-pill),
// 不再用 Tailwind inline. sync tip CSS-only hover 触发, 移除 useState.

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ListFilter, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

import { EventFormModal } from './EventFormModal'
import { IS_WEB_BUILD } from './lib/capabilities'
import { weekdayLong } from './lib/weekdays'
import {
  useCalendarSyncTrigger,
  useCalendarSyncStatus,
  pickSyncHead,
  startOfWeek,
  stepViewDate,
  addDays,
  relativeTime,
  useNowTick
} from './hooks/useCalendarEvents'
import { cn } from '@shared/lib/cn'
import { type CalendarView } from '@shared/router-instance'

// 兼容旧 import — 历史代码 `import { type CalendarView } from './CalendarToolbar'`
export type { CalendarView }

// F26 (阶段1·1.7) — 硬编码中文 t() 化; 周几走 weekdayLong 单源 (lib/weekdays).
function fmtRangeLabel(t: TFunction, view: CalendarView, d: Date): string {
  if (view === 'today') return `${d.getMonth() + 1}/${d.getDate()} ${weekdayLong(t, d.getDay())}`
  if (view === 'week') {
    const start = startOfWeek(d)
    const end = addDays(start, 6)
    return `${start.getMonth() + 1}/${start.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`
  }
  if (view === 'month')
    return t('calendar.shared.yearMonth', '{y} 年 {m} 月', {
      y: d.getFullYear(),
      m: d.getMonth() + 1
    })
  if (view === 'agenda') return t('calendar.toolbar.range.agenda', '未来 14 天')
  return t('calendar.toolbar.range.recurring', '全部定期事件')
}

interface Props {
  view: CalendarView
  onViewChange: (v: CalendarView) => void
  currentDate: Date
  onDateChange: (d: Date) => void
  /** Phase 4·#1 — 全部 calendar 名 (来自 useCalendarNames). */
  calendars: string[]
  /** Phase 4·#1 — 当前选中的 calendar (空 = 全部). */
  selectedCalendars: string[]
  /** Phase 4·#1 — 选择变化回调. */
  onSelectedCalendarsChange: (next: string[]) => void
}

export function CalendarToolbar({
  view,
  onViewChange,
  currentDate,
  onDateChange,
  calendars,
  selectedCalendars,
  onSelectedCalendarsChange
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const { trigger, isPending } = useCalendarSyncTrigger()
  const { data: syncStatus } = useCalendarSyncStatus()
  // 30s tick — 让 sync-pill 的 "上次同步 N 秒前" 字串自然走时, 不靠 syncStatus
  // 数据引用变化也能刷.
  useNowTick()

  // Phase 2.2 — [+ 新建] 按钮 → 弹 EventFormModal (occurrence=null = create 语义)
  const [createModalOpen, setCreateModalOpen] = useState(false)

  // §8 滑动 indicator — 激活 view-chip 的 bg/border 移到一个绝对定位元素, 随 view
  // 变化 tween x/width (DUR.fast)。首次挂载 gsap.set 直接定位无动画, 之后才滑。
  // reduced-motion 短路成无动画定位。useGSAP({scope}) 自动 cleanup。
  const chipListRef = useRef<HTMLDivElement | null>(null)
  const chipIndicatorRef = useRef<HTMLSpanElement | null>(null)
  const chipMountedRef = useRef(false)
  const reduceMotion = useReducedMotion()
  useGSAP(
    () => {
      const list = chipListRef.current
      const indicator = chipIndicatorRef.current
      if (!list || !indicator) return
      const activeEl = list.querySelector<HTMLElement>('.view-chip.is-active')
      if (!activeEl) return
      // border/padding 偏移用 getBoundingClientRect 差值规避 (容器有 border)。
      const listRect = list.getBoundingClientRect()
      const activeRect = activeEl.getBoundingClientRect()
      const left = activeRect.left - listRect.left
      const width = activeRect.width
      if (!chipMountedRef.current || reduceMotion) {
        gsap.set(indicator, { x: left, width, autoAlpha: 1 })
        chipMountedRef.current = true
        return
      }
      gsap.to(indicator, { x: left, width, duration: DUR.fast, overwrite: 'auto' })
    },
    { dependencies: [view, reduceMotion], scope: chipListRef }
  )

  // Phase 4·#1 — calendar 多选筛选 dropdown (仅 >1 calendar 时显示).
  const [calFilterOpen, setCalFilterOpen] = useState(false)
  const calFilterRef = useRef<HTMLDivElement | null>(null)
  const toggleCalendar = (name: string): void => {
    const set = new Set(selectedCalendars)
    if (set.has(name)) set.delete(name)
    else set.add(name)
    onSelectedCalendarsChange(Array.from(set))
  }
  // click-outside + Esc 关闭 (参考 MonthView §F11 capture-phase mousedown).
  useEffect(() => {
    if (!calFilterOpen) return
    const onDown = (e: MouseEvent): void => {
      if (calFilterRef.current && !calFilterRef.current.contains(e.target as Node)) {
        setCalFilterOpen(false)
      }
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setCalFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onEsc)
    }
  }, [calFilterOpen])

  const VIEW_LABELS: Record<CalendarView, string> = {
    today: t('calendar.toolbar.viewDay', '日'),
    week: t('calendar.toolbar.viewWeek', '周'),
    month: t('calendar.toolbar.viewMonth', '月'),
    agenda: t('calendar.toolbar.viewAgenda', 'Agenda'),
    recurring: t('calendar.toolbar.viewRecurring', '定期邀请')
  }

  const showDateNav = view === 'today' || view === 'week' || view === 'month'
  // F19/Q6 — 健康优先选行统一走 pickSyncHead (与 Layout 副 status bar /
  // CalendarViewEmpty 同源, 孤儿行场景不再上绿下红).
  const head = pickSyncHead(syncStatus)
  const lastIso = head?.last_incremental_sync_at_iso ?? head?.last_full_sync_at_iso ?? null
  const lastDate = lastIso ? new Date(lastIso) : null
  const lastError = head?.last_error ?? null
  const hasErr = !!lastError
  const rangeLabel = fmtRangeLabel(t, view, currentDate)

  return (
    <div className="shrink-0 px-5 pt-4 pb-3 flex items-center gap-4 flex-wrap">
      {/* title + range */}
      <div className="flex items-baseline gap-3 min-w-0">
        <h1 className="text-subj font-semibold text-ink-fg tracking-tight">
          {t('calendar.toolbar.title', '日历')}
        </h1>
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
            onClick={() => onDateChange(stepViewDate(view, -1, currentDate))}
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
            onClick={() => onDateChange(stepViewDate(view, 1, currentDate))}
            aria-label={t('calendar.toolbar.nextAria', '下一段')}
            title={t('calendar.toolbar.nextTitle', '下一段 (→)')}
          >
            <ChevronRight size={14} strokeWidth={2.2} />
          </button>
        </div>
      )}

      {/* view chips — push to right */}
      <div
        ref={chipListRef}
        className="relative flex items-center gap-1 ml-auto p-0.5 rounded-lg bg-ink-2/40 border border-ink-border/50"
        role="tablist"
        aria-label={t('calendar.toolbar.viewAria', '视图切换')}
      >
        {/* §8 滑动 indicator — bg+border 跟随激活 chip 滑动 (JS 测量 + GSAP x/width)。 */}
        <span ref={chipIndicatorRef} className="view-chip-indicator" aria-hidden="true" />
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

      {/* Phase 4·#1 — calendar 多选筛选 (仅多 calendar 用户显示) */}
      {calendars.length > 1 && (
        <div className="relative" ref={calFilterRef}>
          <button
            type="button"
            className="nav-btn"
            style={{ width: 'auto', padding: '0 11px', gap: 6, fontSize: 13 }}
            onClick={() => setCalFilterOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={calFilterOpen}
            title={t('calendar.toolbar.calendarFilter.title', '按日历筛选')}
          >
            <ListFilter size={13} strokeWidth={2} />
            <span>
              {selectedCalendars.length === 0
                ? t('calendar.toolbar.calendarFilter.all', '全部日历')
                : t('calendar.toolbar.calendarFilter.selected', '{n} 个日历', {
                    n: selectedCalendars.length
                  })}
            </span>
          </button>
          {calFilterOpen && (
            <div
              // 主题 v3 C8/批 4: 紧凑菜单档 rounded-lg(8) → token 化 --r-ctl
              className="glass-pop absolute right-0 mt-1.5 z-30 min-w-[180px] max-w-[280px] p-1 rounded-[var(--r-ctl)]"
              role="menu"
              aria-label={t('calendar.toolbar.calendarFilter.ariaLabel', '日历筛选')}
            >
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={selectedCalendars.length === 0}
                onClick={() => onSelectedCalendarsChange([])}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-aux text-ink-fg hover:bg-ink-2/60 text-left"
              >
                <span className="w-3.5 inline-flex justify-center shrink-0 text-coral">
                  {selectedCalendars.length === 0 && <Check size={13} strokeWidth={2.4} />}
                </span>
                <span>{t('calendar.toolbar.calendarFilter.all', '全部日历')}</span>
              </button>
              {calendars.map((name) => {
                const checked = selectedCalendars.includes(name)
                return (
                  <button
                    key={name}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={checked}
                    onClick={() => toggleCalendar(name)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-aux text-ink-fg hover:bg-ink-2/60 text-left"
                  >
                    <span className="w-3.5 inline-flex justify-center shrink-0 text-coral">
                      {checked && <Check size={13} strokeWidth={2.4} />}
                    </span>
                    <span className="truncate">{name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Phase 2.5 §11.1 — [+ 新建] coral primary (跟 mockup-event-form §toolbar 一致)
          F14/Q9 — 远程 web 隐藏 (eventCreate 是 HttpApi stub); 阶段 3 能力表替换. */}
      {!IS_WEB_BUILD && (
        <button
          type="button"
          className="btn-coral"
          onClick={() => setCreateModalOpen(true)}
          title={t('calendar.toolbar.newTitle', '新建事件 — 直接写到 Exchange (CalDAV PUT)')}
        >
          <Plus size={14} strokeWidth={2.4} />
          <span>{t('calendar.toolbar.newBtn', '新建')}</span>
        </button>
      )}

      {/* sync — nav-btn 拉宽 (mockup inline style) + sync-pill CSS-only hover tip */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="nav-btn"
          style={{ width: 'auto', padding: '0 11px', gap: 6, fontSize: 13 }}
          onClick={() => trigger({ full: true })}
          disabled={isPending}
          title={t(
            'calendar.toolbar.syncTitle',
            '急刷 (⌘R) · 后台 worker 每 60s 自动同步, 此按钮触发立即全量拉取'
          )}
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
                ? t('calendar.toolbar.syncPillOk', '上次同步 {time}', {
                    time: relativeTime(lastDate)
                  })
                : t('calendar.toolbar.syncPillNone', '尚未同步')}
          </span>
          <div className="sync-tip glass-pop">
            <div className="text-aux text-ink-fg font-medium mb-1">
              {hasErr
                ? t('calendar.toolbar.syncTipErr', 'DavMail · 同步失败')
                : t('calendar.toolbar.syncTipOk', 'DavMail · 已同步')}
            </div>
            <div className="text-meta text-ink-fg-2 font-mono leading-relaxed break-all">
              {hasErr && (lastError ?? t('calendar.toolbar.syncTipUnknownErr', '未知错误'))}
              {!hasErr && head && (
                <>
                  {head.last_full_sync_at_iso && (
                    <>
                      last_full_sync {head.last_full_sync_at_iso.replace('T', ' ').slice(0, 19)}
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
              {!head && t('calendar.empty.syncHint')}
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
