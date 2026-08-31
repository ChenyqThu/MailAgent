// 页头下的「下一个硬时间点」条（design §十）—— 整页唯一需要「现在就看」的一行。
//
// 四段：几点 · 是什么 · 还剩多久 · 在那之前有几件必须拍板。
//
// 🔴 **「硬」没有字段**。`AgendaEntry` 没有 required/optional 标记，`calendar_event.status`
// 说的是会议状态不是「硬不硬」。后端用「今天剩下的最早一条日程」近似，这里如实呈现
// ——文案不写「必须到场」这类它给不出保证的话。
//
// 没有下一条时**整条不渲染**：留一条写着「今天没有硬时间点」的空条，每天都在那儿占位，
// 反而把这一行的「现在就看」磨没了。

import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import type { AgendaEntry } from '@shared/api/types'

import { remainingLabel } from './todaySections'

export function TodayNextHardPoint({
  entry,
  nowMs,
  pendingDecisions,
  onOpen
}: {
  entry: AgendaEntry | null
  nowMs: number
  pendingDecisions: number
  onOpen(): void
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (entry === null) return null
  const startMs = Date.parse(entry.startIso)
  if (!Number.isFinite(startMs)) return null

  const time = entry.allDay
    ? t('today.meet.allDay')
    : new Date(startMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const remaining = remainingLabel(t, startMs - nowMs)

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="today-next-hard-point"
      className={cn(
        'mb-4 flex w-full items-baseline gap-2.5 rounded-[var(--r-ctl)] px-3 py-2.5 text-left',
        'border border-[rgb(var(--c-accent))]/30 bg-[rgb(var(--c-accent))]/[0.08]',
        'transition-colors duration-fast hover:bg-[rgb(var(--c-accent))]/[0.12]'
      )}
    >
      <span className="shrink-0 font-mono text-[15px] font-semibold text-[rgb(var(--c-accent))]">
        {time}
      </span>
      <span className="min-w-0 flex-1 truncate text-aux text-ink-fg">
        {entry.title || t('today.meet.untitled')}
      </span>
      <span className="shrink-0 text-meta text-ink-fg-3">
        {/* 剩余时长算不出（已经开始了）→ 说「已经开始」，不写一个负数。 */}
        {remaining.length > 0 ? remaining : t('today.next.started')}
        {pendingDecisions > 0 && ` · ${t('today.next.pendingBefore', { count: pendingDecisions })}`}
      </span>
    </button>
  )
}
