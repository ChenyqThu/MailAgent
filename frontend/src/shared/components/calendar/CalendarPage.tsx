// 视觉复刻 mockup-calendar.html §recurring (2026-05-23) —
// Sprint 6 老的"运维型表格"视图, 改用 .rec-table / .rec-title / .rrule-code /
// .mono-num class. Toolbar 已接管标题, 这里只留范围 chip + 扫描按钮 + 表.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calendar as CalendarIcon, Play, RefreshCw } from 'lucide-react'

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
      <td className="mono-num">#{item.internal_id || '—'}</td>
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
        {canReplay ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onReplay(item.internal_id)}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded text-aux',
              'text-coral border border-coral/30 hover:bg-coral/10',
              'transition-colors duration-fast',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            {pending ? (
              <RefreshCw size={12} strokeWidth={2} className="animate-spin" />
            ) : (
              <Play size={12} strokeWidth={2} />
            )}
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
  // davmail 模式 discover_recurring 慢 → lazy: 不自动跑, 用户点扫描.
  const listQ = useQuery({
    queryKey: ['calendar', 'recurring', since],
    queryFn: () => mailApi.calendar.recurringDiscover({ since }),
    enabled: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: false
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
      {/* range chip + 扫描按钮 — 跟 mockup §recurring 顶部 row 一致 */}
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-ink-2/40 border border-ink-border/50">
          {RANGES.map((r) => (
            <button
              key={r.offsetDays}
              type="button"
              onClick={() => setDays(r.offsetDays)}
              className={cn(
                'px-3 py-1 text-aux rounded-md transition-colors duration-fast',
                r.offsetDays === days
                  ? 'bg-coral/15 text-coral border border-coral/30 font-medium'
                  : 'border border-transparent text-ink-fg-1 hover:bg-ink-3/70 hover:text-ink-fg'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="text-meta text-ink-fg-2 font-mono tabular-nums ml-1">
          since {since}
        </span>
        <button
          type="button"
          onClick={() => void listQ.refetch()}
          disabled={listQ.isFetching}
          className={cn(
            'h-7 inline-flex items-center gap-1.5 px-3 text-aux rounded-md ml-auto',
            'border border-coral/40 text-coral hover:bg-coral/10',
            'disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-fast'
          )}
          title="扫描邮件中带 RRULE 的会议邀请 (davmail 模式可能需要数分钟)"
        >
          <RefreshCw size={12} strokeWidth={2} className={cn(listQ.isFetching && 'animate-spin')} />
          {listQ.isFetching ? '扫描中…' : '扫描'}
        </button>
      </div>

      {/* table — sticky header via .rec-table th CSS */}
      <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
        {listQ.isFetching ? (
          <div className="p-3">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : listQ.data === undefined ? (
          <EmptyState
            icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
            title="未扫描"
            hint="点击右上角 [扫描] 拉取邮件中带 RRULE 的会议邀请 (davmail 模式可能需要数分钟)"
          />
        ) : listQ.data.length === 0 ? (
          <EmptyState
            icon={<CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
            title={t('calendar.empty')}
            hint={t('calendar.emptyHint')}
          />
        ) : (
          <table className="rec-table">
            <thead>
              <tr>
                <th>ID</th>
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
