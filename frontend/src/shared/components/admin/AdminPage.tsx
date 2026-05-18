// Sprint 6 §2.2 — /admin dashboard.
//
// Three blocks vertically:
//   1. Health pill (db_accessible + schema_ok + table check)
//   2. Sync store stats (status histogram + mailbox split + DB size +
//      v4 rollout) rendered as compact cards
//   3. Dead-letter queue table with per-row "Retry" + cleanup CTA
//
// All data is read-only via `admin:*` IPC; no auth required for reads.
// Dead-letter retry goes through write+auth and shows a toast on success.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, AlertCircle, CheckCircle2, Database, RefreshCw } from 'lucide-react'

import type { DeadLetterItem } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { toastError, toastSuccess } from '@shared/state/toast'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const delta = Date.now() - ts
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function HealthPill({ healthy }: { healthy: boolean }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-aux font-medium',
        healthy
          ? 'bg-ok/15 text-ok border border-ok/30'
          : 'bg-fail/15 text-fail border border-fail/30'
      )}
    >
      {healthy ? (
        <CheckCircle2 size={13} strokeWidth={2} />
      ) : (
        <AlertCircle size={13} strokeWidth={2} />
      )}
      {t(healthy ? 'admin.healthy' : 'admin.unhealthy')}
    </span>
  )
}

function StatCard({
  label,
  value,
  hint
}: {
  label: string
  value: React.ReactNode
  hint?: string
}): React.ReactElement {
  return (
    <div className="rounded-md border border-ink-border bg-ink-2 p-3">
      <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1">{label}</div>
      <div className="text-lead text-ink-fg tabular-nums">{value}</div>
      {hint && <div className="text-meta text-ink-fg-3 mt-1">{hint}</div>}
    </div>
  )
}

function StatusHistogram({ counts }: { counts: Record<string, number> }): React.ReactElement {
  const total = Object.values(counts).reduce((s, n) => s + n, 0)
  // Mockup-faithful colors: synced → ok, pending/fetch_failed/failed →
  // warn/fail bands; everything else dim.
  const STATUS_COLOR: Record<string, string> = {
    synced: 'bg-ok',
    pending: 'bg-warn',
    fetch_failed: 'bg-warn',
    failed: 'bg-fail',
    dead_letter: 'bg-fail',
    skipped: 'bg-ink-fg-3',
    deleted: 'bg-ink-fg-3'
  }
  const order = ['synced', 'pending', 'fetch_failed', 'failed', 'dead_letter', 'skipped', 'deleted']
  const sorted = order
    .filter((k) => counts[k] !== undefined && counts[k] > 0)
    .concat(Object.keys(counts).filter((k) => !order.includes(k) && counts[k] > 0))

  if (total === 0) {
    return <div className="text-meta text-ink-fg-3">—</div>
  }
  return (
    <div>
      <div className="flex h-2 rounded overflow-hidden bg-ink-3 mb-2">
        {sorted.map((k) => (
          <div
            key={k}
            title={`${k}: ${counts[k]}`}
            className={cn(STATUS_COLOR[k] ?? 'bg-ink-fg-3')}
            style={{ width: `${(counts[k] / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-meta font-mono">
        {sorted.map((k) => (
          <div key={k} className="flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <span className={cn('w-1.5 h-1.5 rounded-sm', STATUS_COLOR[k] ?? 'bg-ink-fg-3')} />
              <span className="text-ink-fg-1">{k}</span>
            </span>
            <span className="text-ink-fg tabular-nums">{counts[k].toLocaleString('en-US')}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface DeadLetterRowProps {
  item: DeadLetterItem
  onRetry: (id: number) => void
  pending: boolean
}

function DeadLetterRow({ item, onRetry, pending }: DeadLetterRowProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <tr className="border-b border-ink-border-soft hover:bg-ink-2/60">
      <td className="px-3 py-2 text-aux font-mono text-ink-fg-1 tabular-nums">
        {item.internal_id}
      </td>
      <td
        className="px-3 py-2 text-aux text-ink-fg max-w-[280px] truncate"
        title={item.subject ?? ''}
      >
        {item.subject ?? '—'}
      </td>
      <td
        className="px-3 py-2 text-aux text-ink-fg-1 max-w-[200px] truncate"
        title={item.sender ?? ''}
      >
        {item.sender ?? '—'}
      </td>
      <td className="px-3 py-2 text-aux text-ink-fg-2">{item.mailbox ?? '—'}</td>
      <td className="px-3 py-2 text-aux font-mono text-ink-fg-2 tabular-nums">
        {item.retry_count}
      </td>
      <td
        className="px-3 py-2 text-aux text-fail max-w-[280px] truncate"
        title={item.sync_error ?? ''}
      >
        {item.sync_error ?? '—'}
      </td>
      <td className="px-3 py-2 text-aux text-ink-fg-2">{formatRelative(item.updated_at)}</td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          disabled={pending}
          onClick={(): void => onRetry(item.internal_id)}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-1 rounded text-aux',
            'text-coral border border-coral/30 hover:bg-coral/10',
            'transition-colors duration-fast',
            'disabled:opacity-60 disabled:cursor-not-allowed'
          )}
        >
          <RefreshCw size={12} strokeWidth={2} className={pending ? 'animate-spin' : undefined} />
          {t('admin.retry')}
        </button>
      </td>
    </tr>
  )
}

export function AdminPage(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const [retryPending, setRetryPending] = useState<Set<number>>(new Set())

  const healthQ = useQuery({
    queryKey: ['admin', 'health'],
    queryFn: () => mailApi.admin.health(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const statsQ = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => mailApi.admin.stats(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const dlQ = useQuery({
    queryKey: ['admin', 'deadLetter'],
    queryFn: () => mailApi.admin.deadLetterList({ limit: 50 }),
    staleTime: 10_000
  })

  const retryMut = useMutation({
    mutationFn: (id: number) => mailApi.admin.deadLetterRetry(id),
    onMutate: (id) => {
      setRetryPending((prev) => new Set(prev).add(id))
    },
    onSuccess: (_data, id) => {
      toastSuccess(t('admin.retryOk', { id }))
      void qc.invalidateQueries({ queryKey: ['admin', 'deadLetter'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'stats'] })
    },
    onError: (err: unknown, id) => {
      const e = err as Error & { code?: string }
      toastError(t('admin.retryFail', { id }), e.message)
    },
    onSettled: (_data, _err, id) => {
      setRetryPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  })

  const stats = statsQ.data?.sync_store
  const v4 = statsQ.data?.v4_rollout

  return (
    <div className="px-6 py-5 space-y-6 min-h-full">
      {/* Header row — title + health pill */}
      <header className="flex items-center justify-between">
        <h1 className="text-display text-ink-fg font-semibold flex items-center gap-2">
          <Database size={20} strokeWidth={1.75} className="text-ink-fg-1" />
          {t('admin.title')}
        </h1>
        {healthQ.data && <HealthPill healthy={healthQ.data.healthy} />}
      </header>

      {/* Health detail strip */}
      {healthQ.data && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label={t('admin.dbVersion')}
            value={`v${healthQ.data.db_version}`}
            hint={`expected v${healthQ.data.db_version_expected}`}
          />
          <StatCard
            label={t('admin.tables')}
            value={`${healthQ.data.tables_present.length}`}
            hint={
              healthQ.data.tables_missing.length === 0
                ? t('admin.allTablesPresent')
                : t('admin.missingTables', { n: healthQ.data.tables_missing.length })
            }
          />
          <StatCard
            label={t('admin.dbAccessible')}
            value={healthQ.data.db_accessible ? '✓' : '✗'}
            hint={healthQ.data.db_path}
          />
          <StatCard label={t('admin.schemaOk')} value={healthQ.data.schema_ok ? '✓' : '✗'} />
        </section>
      )}

      {/* Sync store + DB size */}
      {stats && (
        <section className="space-y-3">
          <h2 className="text-lead text-ink-fg font-medium">{t('admin.syncStore')}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label={t('admin.totalEmails')}
              value={stats.total_emails.toLocaleString('en-US')}
            />
            <StatCard
              label={t('admin.failureQueue')}
              value={stats.failure_queue}
              hint={t('admin.failureQueueHint')}
            />
            <StatCard
              label={t('admin.dbSize')}
              value={formatBytes(stats.db_size_bytes)}
              hint={stats.last_sync_time ? formatRelative(stats.last_sync_time) : undefined}
            />
            <StatCard label={t('admin.lastRowId')} value={stats.last_max_row_id ?? '—'} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-md border border-ink-border bg-ink-2 p-3">
              <div className="text-micro font-mono uppercase text-ink-fg-2 mb-3">
                {t('admin.statusDist')}
              </div>
              <StatusHistogram counts={stats.by_status} />
            </div>
            <div className="rounded-md border border-ink-border bg-ink-2 p-3">
              <div className="text-micro font-mono uppercase text-ink-fg-2 mb-3">
                {t('admin.byMailbox')}
              </div>
              <div className="space-y-1.5">
                {Object.entries(stats.by_mailbox).map(([mb, n]) => (
                  <div key={mb} className="flex items-center justify-between text-aux">
                    <span className="text-ink-fg-1">{mb}</span>
                    <span className="font-mono tabular-nums text-ink-fg">
                      {n.toLocaleString('en-US')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* v4 rollout — SQLite-SSoT routing performance */}
      {v4 && (v4.from_sqlite_hit > 0 || v4.fallback_miss > 0 || v4.fallback_error > 0) && (
        <section className="space-y-3">
          <h2 className="text-lead text-ink-fg font-medium flex items-center gap-2">
            <Activity size={16} strokeWidth={1.75} className="text-coral" />
            {t('admin.v4Rollout')}
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="from_sqlite_hit" value={v4.from_sqlite_hit.toLocaleString('en-US')} />
            <StatCard label="fallback_miss" value={v4.fallback_miss.toLocaleString('en-US')} />
            <StatCard label="fallback_error" value={v4.fallback_error.toLocaleString('en-US')} />
            <StatCard
              label="route_latency_p99_ms"
              value={`${v4.route_latency_p99_ms.toFixed(1)}ms`}
              hint={v4._staleness_seconds ? `staleness ${v4._staleness_seconds}s` : undefined}
            />
          </div>
        </section>
      )}

      {/* Dead-letter queue */}
      <section className="space-y-3">
        <h2 className="text-lead text-ink-fg font-medium flex items-center gap-2">
          <AlertCircle
            size={16}
            strokeWidth={1.75}
            className={cn((dlQ.data?.length ?? 0) > 0 ? 'text-fail' : 'text-ok')}
          />
          {t('admin.deadLetter')}
          <span className="text-meta font-mono text-ink-fg-2">({dlQ.data?.length ?? 0})</span>
        </h2>
        <div className="rounded-md border border-ink-border bg-ink-2 overflow-hidden">
          {dlQ.isLoading ? (
            <div className="px-3 py-6 text-aux text-ink-fg-2 text-center">{t('admin.loading')}</div>
          ) : (dlQ.data?.length ?? 0) === 0 ? (
            <div className="px-3 py-6 text-aux text-ink-fg-2 text-center">
              {t('admin.noDeadLetter')}
            </div>
          ) : (
            <table className="w-full text-aux">
              <thead className="bg-ink-3">
                <tr className="text-micro font-mono uppercase text-ink-fg-2 text-left">
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">{t('admin.col.subject')}</th>
                  <th className="px-3 py-2">{t('admin.col.sender')}</th>
                  <th className="px-3 py-2">{t('admin.col.mailbox')}</th>
                  <th className="px-3 py-2">{t('admin.col.retries')}</th>
                  <th className="px-3 py-2">{t('admin.col.error')}</th>
                  <th className="px-3 py-2">{t('admin.col.updated')}</th>
                  <th className="px-3 py-2 text-right">{t('admin.col.action')}</th>
                </tr>
              </thead>
              <tbody>
                {dlQ.data?.map((item) => (
                  <DeadLetterRow
                    key={item.internal_id}
                    item={item}
                    onRetry={(id) => retryMut.mutate(id)}
                    pending={retryPending.has(item.internal_id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  )
}
