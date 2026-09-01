// 今日页右侧的「今天的时间线」列（task 08-27 P5，原型 `Main.dc.html` 的 `.tside` / `.tline`）。
//
// 形态照原型：一根竖线 + 每行「时刻 · 标题 · 副行」，圆点骑在线上；「现在」是一条 accent
// 横线，插在下一条还没到的条目之前。
//
// 🔴 **原型这一列没有点击语义**（`.tlrow` 既无 `onClick` 也无 `cursor: pointer`）—— 它是
// 一览，不是第二个入口。左边那一列的行才是能点的那个。所以这里不接 `useAgendaEntryClick`。
//
// 🔴 **窄窗整列隐藏**（拍板见交付报告）：左列恒 392，再减 292 的时间线列，主区在 1360 以下
// 会被压到 600 以内 —— 那时主区的行（标题 + 为什么是今天 + 动作钮）已经开始换行了。宁可
// 不要这一列。
//
// 数据来自 `useTodaySections` 的同一份 `sections`（`todayTimelineRows.ts` 的头注释写了为什么
// 不另开一条查询，以及那个文件名为什么不能叫 `todayTimeline.ts`）。

import { Fragment, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useNowTick } from '@shared/components/calendar/hooks/useCalendarEvents'
import { cn } from '@shared/lib/cn'

import { buildTodayTimeline } from './todayTimelineRows'
import type { TodaySectionView } from './todaySections'
import { localDayWindow } from './useTodaySections'

/** 30s 一跳：「现在」那条线最多落后一个半分钟档的一半，人眼看不出来，也不至于每秒重排。 */
const NOW_TICK_MS = 30_000

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function TodayTimeline({
  sections
}: {
  sections: readonly TodaySectionView[]
}): React.ReactElement {
  const { t } = useTranslation()
  // 🔴 这里**不复用** `useTodaySections().nowMs`：那一份是 react-query 的落地时刻，只在
  // refetch 时前进。「现在」那条线要自己走时，不然它会停在上次拉数据的位置。
  const nowMs = useNowTick(NOW_TICK_MS)
  const { rows, nowIndex } = useMemo(
    () => buildTodayTimeline(sections, localDayWindow(nowMs), nowMs),
    [sections, nowMs]
  )

  const nowLine = (
    <div className="-ml-[18px] my-2 flex items-center gap-2" data-testid="today-timeline-now">
      <span className="font-mono text-micro text-coral">
        {t('today.timeline.now', { time: clock(nowMs) })}
      </span>
      <span aria-hidden className="h-px flex-1 bg-coral/45" />
    </div>
  )

  return (
    <aside
      data-testid="today-timeline"
      aria-label={t('today.timeline.title')}
      className="hidden w-[292px] shrink-0 [@media(min-width:1360px)]:block"
    >
      <div className="mx-0.5 mb-2 mt-4 font-mono text-micro tracking-[0.08em] text-ink-fg-3">
        {t('today.timeline.title')}
      </div>
      {rows.length === 0 ? (
        // 空态说清是**为什么**空的：这一列只收今天有时刻的条目，不是「暂无数据」。
        <p className="mt-1 text-meta text-ink-fg-3">{t('today.timeline.empty')}</p>
      ) : (
        <div className="mt-1 border-l border-ink-border pl-3.5">
          {rows.map((row, index) => (
            <Fragment key={row.id}>
              {index === nowIndex && nowLine}
              <div className="relative flex gap-2.5 py-[7px]" data-testid="today-timeline-row">
                <span
                  aria-hidden
                  className={cn(
                    'absolute -left-[18px] top-[13px] size-[7px] rounded-full',
                    index === nowIndex
                      ? // 原型 `.tlrow.now::before`：满强度 accent 的 7px 圆点 + 22% 光晕。
                        // `/100` 是显式写法（同 `bg-coral` 的计算色），bare 形态过不了
                        // `no-coral-flood` 闸。
                        'bg-coral/100 shadow-[0_0_0_3px_rgb(var(--c-accent)/0.22)]'
                      : 'bg-ink-border'
                  )}
                />
                <span className="w-[42px] shrink-0 pt-px font-mono text-meta text-ink-fg-3">
                  {clock(row.atMs)}
                </span>
                <span className="min-w-0 text-[13px] leading-[18px] text-ink-fg-1">
                  <span className="block font-medium text-ink-fg">{row.title}</span>
                  {row.sub}
                </span>
              </div>
            </Fragment>
          ))}
          {/* 今天余下没有条目了 —— 线落在末尾，而不是干脆不画（不画就看不出「后面没了」）。 */}
          {nowIndex === rows.length && nowLine}
        </div>
      )}
    </aside>
  )
}
