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
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Database,
  RefreshCw,
  Send,
  Trash2
} from 'lucide-react'

import type { AdminStatsData, DeadLetterItem } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import { cn } from '@shared/lib/cn'
import { DavMailHealthCard } from '@shared/components/admin/DavMailHealthCard'
import { SystemHealthRow } from '@shared/components/admin/SystemHealthRow'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { Loader } from '@shared/components/ui/loader'
import { NumberTicker } from '@shared/components/ui/number-ticker'
import { Sparkline } from '@shared/components/ui/sparkline'
import { SkeletonRow } from '@shared/components/feedback/LoadingSkeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@shared/components/ui/dialog'
import { toastError, toastSuccess } from '@shared/state/toast'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const mb = bytes / 1024 / 1024
  if (mb < 1024) return `${mb.toFixed(1)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

// Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — route through
// i18n so zh-CN renders "X 秒前" instead of "Xs ago". ICU plurals would be
// overkill for these unit suffixes (zh has no plural form; en's "1s" vs
// "Xs" is acceptable as-is for a stats card), so we hand the count + unit
// to `t()` and let the locale's `admin.timeAgo.{seconds,minutes,hours,days}`
// template do the formatting.
//
// Accepts BOTH shapes flowing into this card:
//   - dead-letter `updated_at` — a raw float epoch **seconds** (the DB column
//     `email_metadata.updated_at = time.time()`, surfaced verbatim by both the
//     CLI list + serve-api). `Date.parse(number)` coerces to a string and yields
//     NaN → the old code printed the raw `1784081913.9` on screen (the bug).
//   - `last_sync_time` — an ISO string (`datetime.now().isoformat()`).
// So branch on the runtime type: number → ×1000 to ms; string → Date.parse.
function formatRelative(
  value: string | number | null,
  t: (key: string, vars?: Record<string, unknown>) => string
): string {
  if (value == null) return '—'
  const ts = typeof value === 'number' ? value * 1000 : Date.parse(value)
  if (Number.isNaN(ts)) return String(value)
  const delta = Date.now() - ts
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return t('admin.timeAgo.seconds', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('admin.timeAgo.minutes', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('admin.timeAgo.hours', { n: hours })
  const days = Math.floor(hours / 24)
  return t('admin.timeAgo.days', { n: days })
}

/** Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — cap native
 *  tooltip strings so a multi-MB Anthropic error blob doesn't OOM the
 *  browser's tooltip layer. The visible cell already truncates via
 *  `max-w-[...] truncate`; the title attribute was the un-bounded leak. */
function clampTitle(s: string | null | undefined, max = 500): string {
  if (!s) return ''
  return s.length <= max ? s : `${s.slice(0, max)}…`
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
    <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
      <div className="text-micro font-mono uppercase text-ink-fg-2 mb-1">{label}</div>
      <div className="text-lead text-ink-fg tabular-nums">
        {typeof value === 'number' ? (
          <NumberTicker value={value} format={(number) => number.toLocaleString('en-US')} />
        ) : (
          value
        )}
      </div>
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
      <div className="flex h-2 rounded overflow-hidden bg-ink-fg/10 mb-2">
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

/** 派发队列卡。三个量分别回答不同的问题：
 *  by_status = 队列里有什么；by_target = 卡在哪一端（mailapp / notion）；
 *  age_buckets = **pending 行**有多老（3 条卡了半小时比 30 条刚进队列糟得多）。 */
function OutboxCard({
  outbox
}: {
  outbox: NonNullable<AdminStatsData['outbox']>
}): React.ReactElement {
  const { t } = useTranslation()
  const byStatus = outbox.by_status ?? {}
  const byTarget = Object.entries(outbox.by_target ?? {})
  const ages = outbox.age_buckets ?? {}
  const AGE_ORDER = ['lt_1m', 'lt_5m', 'lt_30m', 'gt_30m'] as const
  const pending = byStatus['pending'] ?? 0
  const failed = byStatus['failed'] ?? 0
  const dead = byStatus['dead_letter'] ?? 0

  return (
    <section className="space-y-3" data-testid="admin-outbox">
      <h2 className="text-lead text-ink-fg font-medium flex items-center gap-2">
        <Send size={16} strokeWidth={1.75} className="text-coral" />
        {t('admin.outbox.title')}
      </h2>
      {outbox._source === 'error' ? (
        // 读失败要如实说 —— 画一排 0 会被当成「队列是空的」。
        <div className="rounded-md border border-warn/30 bg-warn/10 p-3 text-aux text-warn">
          {t('admin.outbox.unavailable')}
          <span className="text-meta font-mono text-ink-fg-2 ml-2">{outbox._error}</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={t('admin.outbox.pending')} value={pending} />
            <StatCard label={t('admin.outbox.processing')} value={byStatus['processing'] ?? 0} />
            <StatCard
              label={t('admin.outbox.failed')}
              value={failed}
              hint={failed > 0 ? t('admin.failureQueueHint') : undefined}
            />
            <StatCard label={t('admin.outbox.deadLetter')} value={dead} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
              <div className="text-micro font-mono uppercase text-ink-fg-2 mb-3">
                {t('admin.outbox.ageDist')}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-meta font-mono">
                {AGE_ORDER.map((k) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="text-ink-fg-1">{t(`admin.outboxAge.${k}`)}</span>
                    <span
                      className={cn(
                        'tabular-nums',
                        // 半小时还没派出去 = 该看一眼 FanoutWorker 是不是停了。
                        k === 'gt_30m' && (ages[k] ?? 0) > 0 ? 'text-fail' : 'text-ink-fg'
                      )}
                    >
                      {(ages[k] ?? 0).toLocaleString('en-US')}
                    </span>
                  </div>
                ))}
              </div>
              <div className="text-meta text-ink-fg-3 mt-2">{t('admin.outbox.ageHint')}</div>
            </div>
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
              <div className="text-micro font-mono uppercase text-ink-fg-2 mb-3">
                {t('admin.outbox.byTarget')}
              </div>
              <div className="space-y-1.5">
                {byTarget.length === 0 ? (
                  <div className="text-meta text-ink-fg-3">—</div>
                ) : (
                  byTarget.map(([target, n]) => (
                    <div key={target} className="flex items-center justify-between text-aux">
                      <span className="text-ink-fg-1">{target}</span>
                      <span className="font-mono tabular-nums text-ink-fg">
                        {n.toLocaleString('en-US')}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

/** v4 路由趋势：两条 sparkline（p99 与回落比例）+ 各自的最新值。
 *  `p99_ms` 是每小时桶内**最大**的窗口 p99（对 p99 求平均没有意义）。 */
function V4Trend({
  trend,
  hours
}: {
  trend: NonNullable<AdminStatsData['v4_rollout']>['trend']
  hours: number
}): React.ReactElement {
  const { t } = useTranslation()
  const points = trend ?? []
  // 一个点画不出趋势（一条竖线 / 一个孤点），如实说「快照还不够」。
  if (points.length < 2) {
    return (
      <div className="rounded-md border border-coral/30 bg-coral/5 p-3 text-aux text-ink-fg-3">
        {t('admin.v4TrendEmpty')}
      </div>
    )
  }
  const last = points[points.length - 1]
  return (
    <div
      className="rounded-md border border-coral/30 bg-coral/5 p-3 space-y-3"
      data-testid="v4-trend"
    >
      <div className="text-micro font-mono uppercase text-ink-fg-2">
        {t('admin.v4Trend', { n: hours })}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-aux">
            <span className="text-ink-fg-1">{t('admin.v4TrendP99')}</span>
            <span className="font-mono tabular-nums text-ink-fg">{last.p99_ms.toFixed(1)}ms</span>
          </div>
          <Sparkline points={points.map((p) => p.p99_ms)} className="text-coral" width={220} />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-aux">
            <span className="text-ink-fg-1">{t('admin.v4TrendFallback')}</span>
            <span
              className={cn(
                'font-mono tabular-nums',
                last.fallback_pct > 0 ? 'text-warn' : 'text-ink-fg'
              )}
            >
              {last.fallback_pct.toFixed(1)}%
            </span>
          </div>
          <Sparkline points={points.map((p) => p.fallback_pct)} className="text-warn" width={220} />
        </div>
      </div>
    </div>
  )
}

interface DeadLetterRowProps {
  item: DeadLetterItem
  onRetry: (id: number) => void
  onDelete: (item: DeadLetterItem) => void
  pending: boolean
  deleting: boolean
}

function DeadLetterRow({
  item,
  onRetry,
  onDelete,
  pending,
  deleting
}: DeadLetterRowProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <tr className="border-b border-ink-border-soft hover:bg-ink-2/60">
      <td className="px-3 py-2 text-aux font-mono text-ink-fg-1 tabular-nums">
        {item.internal_id}
      </td>
      <td
        className="px-3 py-2 text-aux text-ink-fg max-w-[280px] truncate"
        title={clampTitle(item.subject)}
      >
        {item.subject ?? '—'}
      </td>
      <td
        className="px-3 py-2 text-aux text-ink-fg-1 max-w-[200px] truncate"
        title={clampTitle(item.sender)}
      >
        {item.sender ?? '—'}
      </td>
      <td className="px-3 py-2 text-aux text-ink-fg-2">{item.mailbox ?? '—'}</td>
      <td className="px-3 py-2 text-aux font-mono text-ink-fg-2 tabular-nums">
        {item.retry_count}
      </td>
      <td
        className="px-3 py-2 text-aux text-fail max-w-[280px] truncate"
        title={clampTitle(item.sync_error)}
      >
        {item.sync_error ?? '—'}
      </td>
      <td className="px-3 py-2 text-aux text-ink-fg-2">{formatRelative(item.updated_at, t)}</td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1.5">
          <button
            type="button"
            disabled={pending || deleting}
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
          <button
            type="button"
            disabled={pending || deleting}
            onClick={(): void => onDelete(item)}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 rounded text-aux',
              'text-fail border border-fail/30 hover:bg-fail/10',
              'transition-colors duration-fast',
              'disabled:opacity-60 disabled:cursor-not-allowed'
            )}
          >
            <Trash2 size={12} strokeWidth={2} className={deleting ? 'animate-pulse' : undefined} />
            {t('admin.delete')}
          </button>
        </div>
      </td>
    </tr>
  )
}

interface DeleteDeadLetterDialogProps {
  item: DeadLetterItem | null
  pending: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** Dead-letter 单条删除二次确认 — 走 delete_email_full (CASCADE body/attachment/
 *  outbox + 删本地附件目录), 不可逆。仅在人工确认邮件已处置后清条目。 */
function DeleteDeadLetterDialog({
  item,
  pending,
  onConfirm,
  onCancel
}: DeleteDeadLetterDialogProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Dialog open={item !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div
              className={cn(
                'w-[42px] h-[42px] rounded-[11px] grid place-items-center shrink-0',
                'text-fail bg-fail/10 border border-fail/30'
              )}
            >
              <Trash2 size={20} strokeWidth={1.9} />
            </div>
            <div className="min-w-0">
              <DialogTitle>{t('admin.deleteConfirm.title')}</DialogTitle>
              <DialogDescription className="mt-1.5 leading-relaxed">
                {t('admin.deleteConfirm.body', {
                  subject: item?.subject || `#${item?.internal_id}`
                })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <DialogFooter>
          <button type="button" className="gbtn gbtn-bare" onClick={onCancel} disabled={pending}>
            {t('admin.deleteConfirm.cancel')}
          </button>
          <button
            type="button"
            className="gbtn gbtn-danger-solid"
            onClick={onConfirm}
            disabled={pending}
          >
            <Trash2 size={13} strokeWidth={2} />
            {t('admin.deleteConfirm.confirm')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function AdminPage(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const [retryPending, setRetryPending] = useState<Set<number>>(new Set())
  const [deletePending, setDeletePending] = useState<Set<number>>(new Set())
  // Row awaiting the delete confirm dialog (null = dialog closed).
  const [deleteTarget, setDeleteTarget] = useState<DeadLetterItem | null>(null)
  // 死信明细默认收起（正常态 0 条，展开只为排查）。
  const [deadLetterOpen, setDeadLetterOpen] = useState(false)

  const healthQ = useQuery({
    queryKey: qk.admin.health(),
    queryFn: () => mailApi.admin.health(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const statsQ = useQuery({
    queryKey: qk.admin.stats(),
    queryFn: () => mailApi.admin.stats(),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
  const dlQ = useQuery({
    queryKey: qk.admin.deadLetter(),
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
      void qc.invalidateQueries({ queryKey: qk.admin.deadLetter() })
      void qc.invalidateQueries({ queryKey: qk.admin.stats() })
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

  const deleteMut = useMutation({
    mutationFn: (id: number) => mailApi.admin.deadLetterDelete(id),
    onMutate: (id) => {
      setDeletePending((prev) => new Set(prev).add(id))
    },
    onSuccess: (_data, id) => {
      toastSuccess(t('admin.deleteOk', { id }))
      void qc.invalidateQueries({ queryKey: qk.admin.deadLetter() })
      void qc.invalidateQueries({ queryKey: qk.admin.stats() })
    },
    onError: (err: unknown, id) => {
      const e = err as Error & { code?: string }
      toastError(t('admin.deleteFail', { id }), e.message)
    },
    onSettled: (_data, _err, id) => {
      setDeletePending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  })

  const stats = statsQ.data?.sync_store
  const v4 = statsQ.data?.v4_rollout
  const outbox = statsQ.data?.outbox

  return (
    <div className="px-6 py-5 space-y-6 min-h-full">
      {/* Header row — title + health pill */}
      <header className="flex items-center justify-between">
        <h1 className="text-subj text-ink-fg font-semibold flex items-center gap-2">
          <Database size={20} strokeWidth={1.75} className="text-ink-fg-1" />
          {t('admin.title')}
        </h1>
        {healthQ.data && <HealthPill healthy={healthQ.data.healthy} />}
      </header>

      {/* 「健康一眼看」状态行 —— 与 /admin/llm 同一个组件同一份数据源（复用本页
          已有的 health / stats / davmailHealth query key，不新开轮询）。 */}
      <SystemHealthRow />

      {/* roadmap §4.5 — DavMail backend health (hidden when watchdog hasn't ticked) */}
      <DavMailHealthCard />

      {/* Health detail strip */}
      {healthQ.isLoading && (
        <div className="flex min-h-20 items-center justify-center text-ink-fg-3">
          <Loader variant="dots" size={20} label={t('admin.title')} />
        </div>
      )}
      {healthQ.data && (
        <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label={t('admin.dbVersion')}
            // db_version is `integer | null` in admin-health.schema.json — an unreadable DB
            // reports null, which used to render the literal "vnull".
            value={healthQ.data.db_version == null ? '—' : `v${healthQ.data.db_version}`}
            hint={`expected v${healthQ.data.db_version_expected}`}
          />
          <StatCard
            label={t('admin.tables')}
            value={healthQ.data.tables_present.length}
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

      {/* E4 diagnostic notes — crash-looped workers, an aging DavMail OAuth token. Both
          producers have computed these on every call since E4 WP1/WP2; nothing rendered them,
          so the one place that says "this worker is stopped until you restart" was dead weight
          on the wire. They are operator hints, not failures: `healthy` can still be true. */}
      {(healthQ.data?.notes?.length ?? 0) > 0 && (
        <section className="rounded-md border border-warn/30 bg-warn/10 p-3">
          <h2 className="text-aux font-medium text-warn">{t('admin.healthNotes')}</h2>
          <ul className="mt-1.5 space-y-1">
            {healthQ.data?.notes?.map((note) => (
              <li key={note} className="text-meta text-ink-fg-1">
                {note}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Sync store + DB size */}
      {stats && (
        <section className="space-y-3">
          <h2 className="text-lead text-ink-fg font-medium">{t('admin.syncStore')}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label={t('admin.totalEmails')} value={stats.total_emails} />
            <StatCard
              label={t('admin.failureQueue')}
              value={stats.failure_queue}
              hint={t('admin.failureQueueHint')}
            />
            <StatCard
              label={t('admin.dbSize')}
              value={formatBytes(stats.db_size_bytes)}
              hint={stats.last_sync_time ? formatRelative(stats.last_sync_time, t) : undefined}
            />
            <StatCard label={t('admin.lastRowId')} value={stats.last_max_row_id ?? '—'} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
              <div className="text-micro font-mono uppercase text-ink-fg-2 mb-3">
                {t('admin.statusDist')}
              </div>
              <StatusHistogram counts={stats.by_status} />
            </div>
            <div className="rounded-md border border-coral/30 bg-coral/5 p-3">
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

      {/* 派发队列 (outbox) —— 所有 mutating intent 的必经之路。数据一直在
          admin stats 的返回体里，只是此前前端类型没声明 → 队列积压在 UI 上完全不可见。 */}
      {outbox && <OutboxCard outbox={outbox} />}

      {/* v4 rollout — SQLite-SSoT routing performance */}
      {v4 && (v4.from_sqlite_hit > 0 || v4.fallback_miss > 0 || v4.fallback_error > 0) && (
        <section className="space-y-3">
          <h2 className="text-lead text-ink-fg font-medium flex items-center gap-2">
            <Activity size={16} strokeWidth={1.75} className="text-coral" />
            {t('admin.v4Rollout')}
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="from_sqlite_hit" value={v4.from_sqlite_hit} />
            <StatCard label="fallback_miss" value={v4.fallback_miss} />
            <StatCard label="fallback_error" value={v4.fallback_error} />
            <StatCard
              label="route_latency_p99_ms"
              value={`${v4.route_latency_p99_ms.toFixed(1)}ms`}
              hint={v4._staleness_seconds ? `staleness ${v4._staleness_seconds}s` : undefined}
            />
          </div>
          {/* 最新一条快照只是一个瞬时值，看不出「在变好还是变坏」；序列本来就在
              v4_rollout_stats 里（60s 窗口一行），此前从没读过。 */}
          <V4Trend trend={v4.trend ?? []} hours={v4.trend_hours ?? 24} />
        </section>
      )}

      {/* Dead-letter queue —— 50 行明细改「计数 + 展开」：正常态是 0 条，把一张
          可能 50 行的表铺在首屏挤掉上面所有指标，只为看一个多半是 0 的数。 */}
      <section className="space-y-3">
        <h2 className="text-lead text-ink-fg font-medium flex items-center gap-2">
          <AlertCircle
            size={16}
            strokeWidth={1.75}
            className={cn((dlQ.data?.length ?? 0) > 0 ? 'text-fail' : 'text-ok')}
          />
          {t('admin.deadLetter')}
          <span className="text-meta font-mono text-ink-fg-2">({dlQ.data?.length ?? 0})</span>
          {(dlQ.data?.length ?? 0) > 0 && (
            <button
              type="button"
              onClick={(): void => setDeadLetterOpen((v) => !v)}
              aria-expanded={deadLetterOpen}
              data-testid="dead-letter-toggle"
              className={cn(
                'ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-aux',
                'text-ink-fg-1 hover:text-ink-fg transition-colors duration-fast'
              )}
            >
              {deadLetterOpen ? (
                <ChevronUp size={13} strokeWidth={2} />
              ) : (
                <ChevronDown size={13} strokeWidth={2} />
              )}
              {t(deadLetterOpen ? 'admin.deadLetterCollapse' : 'admin.deadLetterExpand')}
            </button>
          )}
        </h2>
        <div className="rounded-md border border-coral/30 bg-coral/5 overflow-hidden">
          {dlQ.isLoading ? (
            <div>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </div>
          ) : (dlQ.data?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={20} strokeWidth={1.75} className="text-ok" />}
              title={t('admin.noDeadLetter')}
              hint={t('admin.noDeadLetterHint')}
            />
          ) : !deadLetterOpen ? (
            // 收起态仍然说清「有多少 / 最近一条多久前」—— 折叠的是明细，不是事实。
            <div className="px-3 py-2.5 text-aux text-ink-fg-1 flex items-center gap-2 flex-wrap">
              <span className="font-mono tabular-nums text-fail">{dlQ.data?.length ?? 0}</span>
              <span>{t('admin.deadLetter')}</span>
              {dlQ.data?.[0] && (
                <span className="text-meta text-ink-fg-3">
                  {t('admin.col.updated')} {formatRelative(dlQ.data[0].updated_at, t)}
                </span>
              )}
            </div>
          ) : (
            <table className="w-full text-aux">
              <thead className="bg-ink-fg/[0.06]">
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
                    onDelete={(row) => setDeleteTarget(row)}
                    pending={retryPending.has(item.internal_id)}
                    deleting={deletePending.has(item.internal_id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <DeleteDeadLetterDialog
        item={deleteTarget}
        pending={deleteTarget ? deletePending.has(deleteTarget.internal_id) : false}
        onConfirm={() => {
          if (!deleteTarget) return
          deleteMut.mutate(deleteTarget.internal_id)
          setDeleteTarget(null)
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
