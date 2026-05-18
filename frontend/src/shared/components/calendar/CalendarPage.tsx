// Sprint 6 §2.2 — /calendar (recurring meetings) page.
//
// Lists recurring invites discovered by `mailagent calendar recurring discover`.
// Each row exposes "Replay" (write+auth) which re-runs the expansion for the
// invite's RRULE so the Notion calendar pages stay in sync after a manual
// reschedule on the host side.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calendar as CalendarIcon, Play, RefreshCw } from 'lucide-react'

import type { RecurringInviteItem } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { toastError, toastSuccess } from '@shared/state/toast'

const RANGES: Array<{ label: string; offsetDays: number }> = [
  { label: '30d', offsetDays: 30 },
  { label: '90d', offsetDays: 90 },
  { label: '180d', offsetDays: 180 },
  { label: '1y', offsetDays: 365 }
]

function offsetIsoDate(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function fmtIso(iso: string | null): string {
  if (!iso) return '—'
  // Show date + HH:MM in local TZ for organizer columns; RRULE column shows raw.
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
  return (
    <tr className="border-b border-ink-border-soft hover:bg-ink-2/60">
      <td className="px-3 py-2 text-aux font-mono text-ink-fg-2 tabular-nums">
        {item.internal_id}
      </td>
      <td
        className="px-3 py-2 text-aux text-ink-fg max-w-[320px] truncate"
        title={item.subject ?? ''}
      >
        {item.subject ?? '—'}
      </td>
      <td
        className="px-3 py-2 text-aux text-ink-fg-1 max-w-[180px] truncate"
        title={item.organizer ?? ''}
      >
        {item.organizer ?? '—'}
      </td>
      <td
        className="px-3 py-2 text-meta font-mono text-ink-fg-2 max-w-[260px] truncate"
        title={item.rrule ?? ''}
      >
        {item.rrule ?? '—'}
      </td>
      <td className="px-3 py-2 text-aux text-ink-fg-1">{fmtIso(item.first_occurrence)}</td>
      <td className="px-3 py-2 text-aux text-ink-fg-1">{fmtIso(item.last_occurrence)}</td>
      <td className="px-3 py-2 text-aux font-mono text-ink-fg-2 tabular-nums">
        {item.occurrence_count ?? '—'}
      </td>
      <td className="px-3 py-2 text-right">
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
  const listQ = useQuery({
    queryKey: ['calendar', 'recurring', since],
    queryFn: () => mailApi.calendar.recurringDiscover({ since }),
    staleTime: 30_000
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
    <div className="px-6 py-5 space-y-6 min-h-full">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-display text-ink-fg font-semibold flex items-center gap-2">
          <CalendarIcon size={20} strokeWidth={1.75} className="text-ink-fg-1" />
          {t('calendar.title')}
        </h1>
        <div className="inline-flex rounded-md border border-ink-border bg-ink-2 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.offsetDays}
              type="button"
              onClick={() => setDays(r.offsetDays)}
              className={cn(
                'px-2 py-1 text-aux rounded transition-colors duration-fast',
                r.offsetDays === days
                  ? 'bg-coral/15 text-coral font-medium'
                  : 'text-ink-fg-1 hover:text-ink-fg'
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <p className="text-aux text-ink-fg-2">{t('calendar.subtitle', { since })}</p>

      <section className="rounded-md border border-ink-border bg-ink-2 overflow-hidden">
        {listQ.isLoading ? (
          <div className="px-3 py-6 text-aux text-ink-fg-2 text-center">
            {t('calendar.loading')}
          </div>
        ) : (listQ.data?.length ?? 0) === 0 ? (
          <div className="px-3 py-6 text-aux text-ink-fg-2 text-center">{t('calendar.empty')}</div>
        ) : (
          <table className="w-full text-aux">
            <thead className="bg-ink-3">
              <tr className="text-micro font-mono uppercase text-ink-fg-2 text-left">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">{t('calendar.col.subject')}</th>
                <th className="px-3 py-2">{t('calendar.col.organizer')}</th>
                <th className="px-3 py-2">{t('calendar.col.rrule')}</th>
                <th className="px-3 py-2">{t('calendar.col.firstOccur')}</th>
                <th className="px-3 py-2">{t('calendar.col.lastOccur')}</th>
                <th className="px-3 py-2">{t('calendar.col.count')}</th>
                <th className="px-3 py-2 text-right">{t('calendar.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {listQ.data?.map((item) => (
                <Row
                  key={item.internal_id}
                  item={item}
                  onReplay={(id) => replayMut.mutate(id)}
                  pending={pending.has(item.internal_id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
