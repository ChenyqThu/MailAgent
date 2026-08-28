// 「日历」域的二级栏 —— 分组日历树（task 08-27 dogfood 轮 2）。
//
// owner 反馈定形：左侧条 = 分组呈现的日历，可整组勾选，组内每个 agent / 每个事项
// 也各占一条可单独勾选。三组：邮箱日历 / 事项日历 / Agent 日历。
//
// 小月历（`.mm-*` 网格）随本批退役 —— 跳日期只留工具条 ‹ › / 「今天」一处
// （日视图内的重复小月历刚在日/周重做批删掉，理由链一致）。calendar-focus 的
// 正向腿（会议卡「在日历中查看」→ 定位）不依赖小月历，原样保留在 MeetingInviteCard
// 与 CalendarLayout。
//
// 成员来源：
//   - 邮箱 = `useCalendarNames()`（全部 calendar 名，与窗口无关：这个月没日程的
//     日历也是一个真实的日历，得能勾）；
//   - 事项 / Agent = 当前**月窗口** agenda 数据聚合（`matterId` / `agentId` 去重，
//     行动项归其父事项）。刻意固定用月窗口而不跟随日/周视图 —— 换成跟随的话，
//     日视图下翻一天树就整列换一批，勾选面会跳。窗口与月视图一致 ⇒ 命中同一份
//     react-query 缓存，零额外请求。
//
// 树只读**未过滤**的 agenda（不传 sources / excluded）：勾掉的那条必须留在树上，
// 否则取消勾选后就再也点不回来了。

import { useTranslation } from 'react-i18next'
import { Check, Minus } from 'lucide-react'

import type { AgendaSource } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useCalendarView } from '@shared/state/calendar-view'

import { addDays, startOfMonth, startOfWeek, useCalendarNames } from './hooks/useCalendarEvents'
import { useCalendarAgenda } from './hooks/useCalendarAgenda'
import { MONTH_WEEK_COUNT } from './lib/monthGrid'
import {
  aggregateSourceMembers,
  groupCheckState,
  type CalendarSourceMember,
  type GroupCheckState
} from './lib/sourceTree'

const SOURCE_ORDER: readonly AgendaSource[] = ['mail', 'matter', 'agent']

function SourceGroup({
  source,
  label,
  hint,
  emptyText,
  members
}: {
  source: AgendaSource
  label: string
  hint: string
  emptyText: string
  members: CalendarSourceMember[]
}): React.ReactElement {
  const on = useCalendarView((s) => s.sources[source])
  const excluded = useCalendarView((s) => s.excluded[source])
  const setGroupAll = useCalendarView((s) => s.setGroupAll)
  const toggleMember = useCalendarView((s) => s.toggleMember)

  const memberIds = members.map((m) => m.id)
  const excludedHere = memberIds.filter((id) => excluded.has(id)).length
  const state: GroupCheckState = groupCheckState(on, excludedHere, members.length)

  return (
    <div className="cal-srcgroup">
      <button
        type="button"
        role="checkbox"
        aria-checked={state === 'mixed' ? 'mixed' : state === 'on'}
        className={cn('cal-src-row is-group', state === 'off' && 'is-off')}
        onClick={() => setGroupAll(source, state !== 'on')}
      >
        <span className="cal-src-check" data-src={source} aria-hidden>
          {state === 'on' && <Check size={10} strokeWidth={3} />}
          {state === 'mixed' && <Minus size={10} strokeWidth={3} />}
        </span>
        <span className="cal-src-label">{label}</span>
        <span className="cal-src-hint">{hint}</span>
      </button>

      {members.length === 0 ? (
        <div className="cal-src-empty">{emptyText}</div>
      ) : (
        members.map((m) => {
          const checked = on && !excluded.has(m.id)
          return (
            <button
              key={m.id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              className={cn('cal-src-row is-member', !checked && 'is-off')}
              onClick={() => toggleMember(source, m.id, memberIds)}
              title={m.label}
            >
              <span className="cal-src-check" data-src={source} aria-hidden>
                {checked && <Check size={10} strokeWidth={3} />}
              </span>
              <span className="cal-src-label">{m.label}</span>
            </button>
          )
        })
      )}
    </div>
  )
}

export function CalendarSourcePanel(): React.ReactElement {
  const { t } = useTranslation()
  const currentDate = useCalendarView((s) => s.currentDate)

  // 成员聚合窗口 = 当前月网格（与 MonthView 同一算法 ⇒ 同 queryKey ⇒ 同缓存）。
  const gridStart = startOfWeek(startOfMonth(currentDate))
  const gridEnd = addDays(gridStart, MONTH_WEEK_COUNT * 7)
  const { data: entries } = useCalendarAgenda({
    fromIso: gridStart.toISOString(),
    toIso: gridEnd.toISOString()
  })
  const { data: calendarNames } = useCalendarNames()

  const all = entries ?? []
  const membersOf: Record<AgendaSource, CalendarSourceMember[]> = {
    mail: (calendarNames ?? []).map((name) => ({ id: name, label: name })),
    matter: aggregateSourceMembers(all, 'matter'),
    agent: aggregateSourceMembers(all, 'agent')
  }

  const LABELS: Record<AgendaSource, string> = {
    mail: t('calendar.sources.mail', '邮箱日历'),
    matter: t('calendar.sources.matter', '事项日历'),
    agent: t('calendar.sources.agent', 'Agent 日历')
  }
  const HINTS: Record<AgendaSource, string> = {
    mail: t('calendar.sources.mailHint', '各账户 + 团队共享'),
    matter: t('calendar.sources.matterHint', '截止日 + 行动项排期'),
    agent: t('calendar.sources.agentHint', '智能体排程')
  }
  // 空态说清为什么空（是「没有」还是「这个月没有」），不是一句「暂无」。
  const EMPTY: Record<AgendaSource, string> = {
    mail: t('calendar.sources.emptyMail', '还没有同步到任何邮箱日历'),
    matter: t('calendar.sources.emptyMatter', '本月没有事项排期'),
    agent: t('calendar.sources.emptyAgent', '本月没有智能体排程')
  }

  return (
    <div
      className="cal-srctree flex-1 overflow-y-auto scrollbar-thin px-1.5 pt-1.5 pb-2"
      role="group"
      aria-label={t('calendar.sources.legend', '日历源')}
      data-calendar-sources
    >
      {SOURCE_ORDER.map((s) => (
        <SourceGroup
          key={s}
          source={s}
          label={LABELS[s]}
          hint={HINTS[s]}
          emptyText={EMPTY[s]}
          members={membersOf[s]}
        />
      ))}
    </div>
  )
}
