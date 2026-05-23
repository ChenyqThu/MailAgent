// 视觉复刻 mockup-calendar.html §recurring (2026-05-23) —
// Sprint 6 老的"运维型表格"视图, 改用 .rec-table / .rec-title / .rrule-code /
// .mono-num class. Toolbar 已接管标题, 这里只留范围 chip + 扫描按钮 + 表.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calendar as CalendarIcon, RefreshCw } from 'lucide-react'

import type { RecurringInviteItem } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SkeletonRow } from '@shared/components/feedback/LoadingSkeleton'
import { toastError, toastSuccess } from '@shared/state/toast'

const RANGES: Array<{ label: string; offsetDays: number }> = [
  { label: '30d', offsetDays: 30 },
  { label: '90d', offsetDays: 90 },
  { label: '180d', offsetDays: 180 },
  { label: '1y', offsetDays: 365 }
]

function offsetIsoDate(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fmtIso(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface RowProps {
  item: RecurringInviteItem
  onReplay: (id: number) => void
  pending: boolean
}

function Row({ item, onReplay, pending }: RowProps): React.ReactElement {
  const { t } = useTranslation()
  // Phase 1.5 caveat: caldav-only events internal_id=0 — Replay 无效, 灰
  const canReplay = item.internal_id > 0
  return (
    <tr>
      <td>
        <span className="rec-title" title={item.subject ?? ''}>
          {item.subject ?? '—'}
        </span>
      </td>
      <td className="font-mono text-[12px] text-ink-fg-2" title={item.organizer ?? ''}>
        {item.organizer ?? '—'}
      </td>
      <td>
        {item.rrule ? <span className="rrule-code">{item.rrule}</span> : <span className="empty-field">—</span>}
      </td>
      <td className="mono-num">{fmtIso(item.first_occurrence)}</td>
      <td className="mono-num">{fmtIso(item.last_occurrence)}</td>
      <td className="mono-num">{item.occurrence_count ?? '—'}</td>
      <td className="text-right">
        {/* mockup §recurring 操作列是静态弱化 span. 我们后端能 replay 时
            保留 click handler, 但视觉走 mockup 简洁 link 风格 (无 button
            border / 无 padding). caldav-only events (internal_id=0) 一律
            灰色 placeholder. */}
        {canReplay ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onReplay(item.internal_id)}
            className={cn(
              'inline-flex items-center gap-1 text-[12px] cursor-pointer',
              'text-coral hover:underline',
              'disabled:opacity-60 disabled:cursor-wait disabled:no-underline'
            )}
            title={t('calendar.replay')}
          >
            {pending && <RefreshCw size={11} strokeWidth={2} className="animate-spin" />}
            {t('calendar.replay')}
          </button>
        ) : (
          <span
            className="text-ink-fg-3 text-[12px]"
            title="Phase 1.5 后 caldav-only events 无邮件源, Replay 待 Phase 2 重做"
          >
            Replay
          </span>
        )}
      </td>
    </tr>
  )
}

export function CalendarPage(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const [days, setDays] = useState(90)
  const [pending, setPending] = useState<Set<number>>(new Set())

  const since = offsetIsoDate(days)
  // Phase 1.5 (706788d) 之后 discover_recurring 改读 SQLite calendar_event ~0.5s,
  // 不再 davmail 慢路径; 改主动 fetch. [扫描] 按钮保留作强制 refresh / 急刷.
  const listQ = useQuery({
    queryKey: ['calendar', 'recurring', since],
    queryFn: () => mailApi.calendar.recurringDiscover({ since }),
    staleTime: 5 * 60_000,        // 5min cache, recurring 列表变化慢
    refetchOnWindowFocus: false,  // 不靠 focus 刷
    refetchOnMount: 'always'      // 切到 recurring tab 主动刷
  })

  const replayMut = useMutation({
    mutationFn: (id: number) => mailApi.calendar.recurringReplay({ internalId: id }),
    onMutate: (id) => setPending((s) => new Set(s).add(id)),
    onSuccess: (_d, id) => {
      toastSuccess(t('calendar.replayOk', { id }))
      void qc.invalidateQueries({ queryKey: ['calendar', 'recurring'] })
    },
    onError: (err: unknown, id) => {
      const e = err as Error & { code?: string }
      toastError(t('calendar.replayFail', { id }), e.message)
    },
    onSettled: (_d, _e, id) => {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  })

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* mockup §recurring 顶部 row: range chips (.view-chip 复用 toolbar
          视觉规范) + ml-auto 扫描按钮 (.today-btn 灰底 + svg). 删去之前的
          'since {date}' 标签 (mockup 没有, 跟扫描动作信息冗余). */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-ink-2/40 border border-ink-border/50">
          {RANGES.map((r) => (
            <button
              key={r.offsetDays}
              type="button"
              onClick={() => setDays(r.offsetDays)}
              className={cn('view-chip', r.offsetDays === days && 'is-active')}
              title={`扫描最近 ${r.label}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void listQ.refetch()}
          disabled={listQ.isFetching}
          className="today-btn ml-auto"
          title="扫描邮件中带 RRULE 的会议邀请 (davmail 模式可能需要数分钟)"
        >
          <RefreshCw size={13} strokeWidth={2} className={cn(listQ.isFetching && 'animate-spin')} />
          {listQ.isFetching ? '扫描中…' : '扫描'}
        </button>
      </div>

      {/* table — sticky header via .rec-table th CSS */}
      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
        {listQ.isFetching && !listQ.data ? (
          // 首次挂载 fetch 中 — skeleton 占位; 已有 data 的后台 refetch 不闪屏
          <div className="p-3">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : !listQ.data || listQ.data.length === 0 ? (
          <EmptyState
            icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
            title={t('calendar.empty')}
            hint={t('calendar.emptyHint')}
          />
        ) : (
          <table className="rec-table">
            <thead>
              <tr>
                <th>{t('calendar.col.subject')}</th>
                <th>{t('calendar.col.organizer')}</th>
                <th>{t('calendar.col.rrule')}</th>
                <th>{t('calendar.col.firstOccur')}</th>
                <th>{t('calendar.col.lastOccur')}</th>
                <th>{t('calendar.col.count')}</th>
                <th className="text-right">{t('calendar.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {listQ.data.map((item) => (
                <Row
                  key={item.internal_id || `${item.organizer}-${item.rrule}`}
                  item={item}
                  onReplay={(id) => replayMut.mutate(id)}
                  pending={pending.has(item.internal_id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
