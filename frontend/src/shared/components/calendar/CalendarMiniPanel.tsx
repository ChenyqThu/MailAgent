// 「日历」域的二级栏 —— 小月历 + 三组日历源开关（task 08-27-l4-tab-workspace P1/P3）。
//
// 形态抄原型 Main.dc.html 的日历二级栏段（.minical + srctree）：月标题 + 前后月
// 切换 + 「今天」回跳 + 7×6 月网格（有事件的格底部圆点取当天首个事件的源色）+
// 分隔线下三组日历源开关（邮箱 / 事项 / Agent）。
//
// 联动（P3 起双向）：
// - 正向（点日期 / 「今天」）经既有 useCalendarFocus store 写 pending target
//   （uid 空串 = 只跳日期不选中事件），CalendarLayout consume → setCurrentDate。
// - 反向（主视图翻月 → 小月历跟随）：CalendarLayout.currentDate 已提升为
//   calendar-view store，这里订阅它同步本地 month。本地翻月按钮仍只动小月历
//   （浏览别的月不打扰主视图，点日期才落）。
//
// 色点数据走三源聚合 useCalendarAgenda（月视图同款），关掉某源色点同步消失。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'

import type { AgendaSource } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useCalendarFocus } from '@shared/state/calendar-focus'
import { useCalendarView } from '@shared/state/calendar-view'

import { addDays, startOfMonth, startOfWeek, todayStartLocal } from './hooks/useCalendarEvents'
import { useCalendarAgenda } from './hooks/useCalendarAgenda'
import { agendaDayDotSources } from './lib/monthGrid'
import { ymd } from './lib/format'
import { weekdayMin } from './lib/weekdays'

const SOURCE_ORDER: readonly AgendaSource[] = ['mail', 'matter', 'agent']

export function CalendarMiniPanel(): React.ReactElement {
  const { t } = useTranslation()
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()))
  const currentDate = useCalendarView((s) => s.currentDate)
  const sources = useCalendarView((s) => s.sources)
  const toggleSource = useCalendarView((s) => s.toggleSource)

  // P3 反向联动 — 主视图翻月 / 跳日期时小月历跟随（用 ms 做依赖，Date 引用每次
  // set 都变但同一天不必重跑）。
  const currentMonthMs = startOfMonth(currentDate).getTime()
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 跨面单向跟随（store → 本地浏览态），非派生渲染值：本地 month 允许用户独立翻月浏览，只在主视图落点变化时拉回。
    setMonth(new Date(currentMonthMs))
  }, [currentMonthMs])

  const gridStart = startOfWeek(month)
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
  const gridEnd = addDays(gridStart, 42)

  // 色点 —— 三源聚合（与月视图共享同一窗口缓存族 qk.calendar.agenda）。
  const { data: entries } = useCalendarAgenda(
    { fromIso: gridStart.toISOString(), toIso: gridEnd.toISOString() },
    sources
  )
  const dotSources = agendaDayDotSources(entries ?? [])

  const todayKey = ymd(todayStartLocal())
  const currentMonth = month.getMonth()

  /** 点日期 → 主视图跳到那一天。uid 空串在 CalendarLayout 的 matchFocusTarget 永不
   *  命中 —— 效果就是只 setCurrentDate、不选中任何事件。 */
  const pickDate = (d: Date): void => {
    useCalendarFocus.getState().request({
      dateIso: d.toISOString(),
      icalUid: '',
      recurrenceId: null
    })
  }

  const goToday = (): void => {
    const today = todayStartLocal()
    setMonth(startOfMonth(today))
    pickDate(today)
  }

  const prevLabel = t('calendar.view.day.prevMonthAria', '上月')
  const nextLabel = t('calendar.view.day.nextMonthAria', '下月')

  const SOURCE_LABELS: Record<AgendaSource, string> = {
    mail: t('calendar.sources.mail', '邮箱日历'),
    matter: t('calendar.sources.matter', '事项日历'),
    agent: t('calendar.sources.agent', 'Agent 日历')
  }
  const SOURCE_HINTS: Record<AgendaSource, string> = {
    mail: t('calendar.sources.mailHint', '各账户 + 团队共享'),
    matter: t('calendar.sources.matterHint', '截止日 + 行动项排期'),
    agent: t('calendar.sources.agentHint', '智能体排程')
  }

  return (
    <div className="flex-1 overflow-y-auto scrollbar-thin px-3 pt-2.5 pb-2" data-calendar-mini>
      <div className="mm-head">
        <span className="mm-title">
          {t('calendar.shared.yearMonth', '{y} 年 {m} 月', {
            y: month.getFullYear(),
            m: month.getMonth() + 1
          })}
        </span>
        <div className="mm-nav">
          <button
            type="button"
            onClick={goToday}
            title={t('calendar.toolbar.today', '今天')}
            aria-label={t('calendar.toolbar.today', '今天')}
            className="!w-auto px-1.5 text-[11px] font-medium"
          >
            {t('calendar.toolbar.today', '今天')}
          </button>
          <button
            type="button"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            title={prevLabel}
            aria-label={prevLabel}
          >
            <ChevronLeft size={12} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            title={nextLabel}
            aria-label={nextLabel}
          >
            <ChevronRight size={12} strokeWidth={2.2} />
          </button>
        </div>
      </div>
      <div className="mm-grid">
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="mm-dow">
            {weekdayMin(t, i)}
          </div>
        ))}
        {cells.map((c, i) => {
          const key = ymd(c)
          const isOther = c.getMonth() !== currentMonth
          const isToday = key === todayKey
          const dotSrc = dotSources.get(key)
          return (
            <button
              key={i}
              type="button"
              className={cn(
                'mm-cell',
                isOther && 'is-other',
                !isOther && 'in-week',
                isToday && 'today'
              )}
              onClick={isOther ? undefined : () => pickDate(c)}
              disabled={isOther}
              aria-label={key}
            >
              {c.getDate()}
              {dotSrc && <span className="mm-dot" data-src={dotSrc} aria-hidden />}
            </button>
          )
        })}
      </div>

      {/* P3 — 三组日历源开关（srctree）。关掉一组，月网格 / 小月历色点 / 工具条
          源色点同步变（client-side 过滤，不重发请求）。 */}
      <div className="cal-srctree" role="group" aria-label={t('calendar.sources.legend', '日历源')}>
        <div className="cal-srctree-title">{t('calendar.sources.legend', '日历源')}</div>
        {SOURCE_ORDER.map((s) => {
          const on = sources[s]
          return (
            <button
              key={s}
              type="button"
              role="checkbox"
              aria-checked={on}
              className={cn('cal-src-row', !on && 'is-off')}
              onClick={() => toggleSource(s)}
            >
              <span className="cal-src-check" data-src={s} aria-hidden>
                {on && <Check size={10} strokeWidth={3} />}
              </span>
              <span className="cal-src-label">{SOURCE_LABELS[s]}</span>
              <span className="cal-src-hint">{SOURCE_HINTS[s]}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
