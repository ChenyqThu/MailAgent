// task 08-27 P3 —— 工具条压成单行 (r2 calbar): 今天 · 视图▾ · ‹ › · 期间标题
// … 源色点 (月视图) · 日历筛选 · 同步 · 新建日程。
//
// 相对旧版的三处收敛:
// - 大标题「日历」退役 —— 主标签面包屑已带「日历 / {年月}」(CalendarLayout 的
//   useMainBreadcrumb), 工具条只留期间标题。
// - view chips + GSAP 滑动 indicator → 下拉 (「月 ▾」), 单行放得下。
// - sync-pill (上次同步 N 秒前 hover tip) 退役 —— 同一信息在 cal-card 底部
//   statusbar 常驻, 工具条只留急刷按钮。
//
// 接口不变 (view / onViewChange / currentDate / onDateChange …)。
// CalendarView 类型从 router-instance 复用 (单一来源, 避免 enum 漂移)。

import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Plus,
  RefreshCw
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { CalendarStatusLegend } from './CalendarStatusLegend'
import { EventFormModal } from './EventFormModal'
import { calendarCapabilities } from './lib/capabilities'

const caps = calendarCapabilities()
import { weekdayLong } from './lib/weekdays'
import {
  useCalendarSyncTrigger,
  startOfWeek,
  stepViewDate,
  addDays
} from './hooks/useCalendarEvents'
import type { AgendaSource } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { type CalendarView } from '@shared/router-instance'
import { useCalendarView } from '@shared/state/calendar-view'

// 兼容旧 import — 历史代码 `import { type CalendarView } from './CalendarToolbar'`
export type { CalendarView }

// F26 (阶段1·1.7) — 硬编码中文 t() 化; 周几走 weekdayLong 单源 (lib/weekdays)。
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

const SOURCE_ORDER: readonly AgendaSource[] = ['mail', 'matter', 'agent']

interface Props {
  view: CalendarView
  onViewChange: (v: CalendarView) => void
  currentDate: Date
  onDateChange: (d: Date) => void
  /** Phase 4·#1 — 全部 calendar 名 (来自 useCalendarNames)。 */
  calendars: string[]
  /** Phase 4·#1 — 当前选中的 calendar (空 = 全部)。 */
  selectedCalendars: string[]
  /** Phase 4·#1 — 选择变化回调。 */
  onSelectedCalendarsChange: (next: string[]) => void
  /** 2.7 — create modal 状态上提到 Layout (n 快捷键与 [+ 新建] 按钮共用)。 */
  createOpen: boolean
  onCreateOpenChange: (open: boolean) => void
}

export function CalendarToolbar({
  view,
  onViewChange,
  currentDate,
  onDateChange,
  calendars,
  selectedCalendars,
  onSelectedCalendarsChange,
  createOpen,
  onCreateOpenChange
}: Props): React.ReactElement {
  const { t } = useTranslation()
  const { trigger, isPending } = useCalendarSyncTrigger()
  // P3 — 三源开关 (calendar-view store): 月视图工具条右簇的源色点与月网格同步变。
  const sources = useCalendarView((s) => s.sources)

  const VIEW_LABELS: Record<CalendarView, string> = {
    today: t('calendar.toolbar.viewDay', '日'),
    week: t('calendar.toolbar.viewWeek', '周'),
    month: t('calendar.toolbar.viewMonth', '月'),
    agenda: t('calendar.toolbar.viewAgenda', 'Agenda'),
    recurring: t('calendar.toolbar.viewRecurring', '定期邀请')
  }
  const SOURCE_LABELS: Record<AgendaSource, string> = {
    mail: t('calendar.sources.mail', '邮箱日历'),
    matter: t('calendar.sources.matter', '事项日历'),
    agent: t('calendar.sources.agent', 'Agent 日历')
  }

  // 视图下拉 (「月 ▾」) — click-outside + Esc 关闭 (capture-phase mousedown,
  // 参考旧 calendar filter 同款)。
  const [viewMenuOpen, setViewMenuOpen] = useState(false)
  const viewMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!viewMenuOpen) return
    const onDown = (e: MouseEvent): void => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) {
        setViewMenuOpen(false)
      }
    }
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setViewMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onEsc)
    }
  }, [viewMenuOpen])

  // Phase 4·#1 — calendar 多选筛选 dropdown (仅 >1 calendar 时显示)。
  const [calFilterOpen, setCalFilterOpen] = useState(false)
  const calFilterRef = useRef<HTMLDivElement | null>(null)
  const toggleCalendar = (name: string): void => {
    const set = new Set(selectedCalendars)
    if (set.has(name)) set.delete(name)
    else set.add(name)
    onSelectedCalendarsChange(Array.from(set))
  }
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

  const showDateNav = view === 'today' || view === 'week' || view === 'month'
  const rangeLabel = fmtRangeLabel(t, view, currentDate)
  const enabledSources = SOURCE_ORDER.filter((s) => sources[s])

  return (
    <div className="shrink-0 px-5 pt-3 pb-2.5 flex items-center gap-2 min-w-0">
      <button
        type="button"
        className="today-btn"
        onClick={() => onDateChange(new Date())}
        title={t('calendar.toolbar.todayTitle', '今天 (T)')}
      >
        {t('calendar.toolbar.today', '今天')}
      </button>

      {/* 视图下拉 — 「月 ▾」 */}
      <div className="relative" ref={viewMenuRef}>
        <button
          type="button"
          className="nav-btn"
          style={{ width: 'auto', padding: '0 9px', gap: 4, fontSize: 13 }}
          onClick={() => setViewMenuOpen((v) => !v)}
          aria-haspopup="true"
          aria-expanded={viewMenuOpen}
          title={t('calendar.toolbar.viewAria', '视图切换')}
        >
          <span>{VIEW_LABELS[view]}</span>
          <ChevronDown size={12} strokeWidth={2.2} />
        </button>
        {viewMenuOpen && (
          <div
            className="glass-pop absolute left-0 mt-1.5 z-30 min-w-[132px] p-1 rounded-[var(--r-ctl)]"
            role="menu"
            aria-label={t('calendar.toolbar.viewAria', '视图切换')}
          >
            {(['today', 'week', 'month', 'agenda', 'recurring'] as CalendarView[]).map((v) => (
              <button
                key={v}
                type="button"
                role="menuitemradio"
                aria-checked={v === view}
                onClick={() => {
                  onViewChange(v)
                  setViewMenuOpen(false)
                }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-aux text-ink-fg hover:bg-ink-2/60 text-left"
              >
                <span className="w-3.5 inline-flex justify-center shrink-0 text-coral">
                  {v === view && <Check size={13} strokeWidth={2.4} />}
                </span>
                <span>{VIEW_LABELS[v]}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* date nav — agenda/recurring 隐藏 */}
      {showDateNav && (
        <div className="flex items-center gap-1">
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
            className="nav-btn"
            onClick={() => onDateChange(stepViewDate(view, 1, currentDate))}
            aria-label={t('calendar.toolbar.nextAria', '下一段')}
            title={t('calendar.toolbar.nextTitle', '下一段 (→)')}
          >
            <ChevronRight size={14} strokeWidth={2.2} />
          </button>
        </div>
      )}

      {/* 期间标题 */}
      <span className="text-lead text-ink-fg-1 font-mono tabular-nums whitespace-nowrap truncate min-w-0">
        {rangeLabel}
      </span>

      {/* 右簇 */}
      <div className="flex items-center gap-2 ml-auto shrink-0">
        {/* 源色点 — 仅月视图 (三源聚合只接月视图); 关掉一组这里同步消失 */}
        {view === 'month' && enabledSources.length > 0 && (
          <span className="cal-src-dots" aria-hidden>
            {enabledSources.map((s) => (
              <span key={s} className="cal-src-dot" data-src={s} title={SOURCE_LABELS[s]} />
            ))}
          </span>
        )}

        {/* Phase 4·#1 — calendar 多选筛选 (仅多 calendar 用户显示)。月视图不渲染:
            它走三源聚合数据 (AgendaEntry 无 calendar_name), 筛选对它不生效。 */}
        {view !== 'month' && calendars.length > 1 && (
          <div className="relative" ref={calFilterRef}>
            <button
              type="button"
              className="nav-btn"
              style={{ width: 'auto', padding: '0 9px', gap: 5, fontSize: 13 }}
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

        {/* sync — icon-only 急刷; 上次同步/错误态常驻在底部 statusbar */}
        <button
          type="button"
          className="nav-btn"
          onClick={() => trigger({ full: true })}
          disabled={isPending}
          aria-label={t('calendar.toolbar.syncBtn', '同步')}
          title={t(
            'calendar.toolbar.syncTitle',
            '急刷 (⌘R) · 后台 worker 每 60s 自动同步, 此按钮触发立即全量拉取'
          )}
        >
          <RefreshCw size={13} strokeWidth={2} className={cn(isPending && 'animate-spin')} />
        </button>

        {/* F3 (阶段2·2.6) — 状态形态图例入口 (hover/focus 显示 tip) */}
        <CalendarStatusLegend />

        {/* 阶段 3 (#11) — caps.write 门控 (serve-api 写端点就绪后两端可用)。 */}
        {caps.write && (
          <button
            type="button"
            className="btn-coral"
            onClick={() => onCreateOpenChange(true)}
            title={t('calendar.toolbar.newTitle', '新建事件 — 直接写到 Exchange (CalDAV PUT)')}
          >
            <Plus size={14} strokeWidth={2.4} />
            <span>{t('calendar.toolbar.newBtn', '新建日程')}</span>
          </button>
        )}
      </div>

      {/* Phase 2.2 — create modal (occurrence=null = create 语义); 2.7 状态上提
          Layout (n 快捷键与按钮共用入口)。 */}
      <EventFormModal
        open={createOpen}
        onClose={() => onCreateOpenChange(false)}
        occurrence={null}
      />
    </div>
  )
}
