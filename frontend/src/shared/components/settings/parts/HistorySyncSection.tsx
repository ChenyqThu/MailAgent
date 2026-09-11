// 设置 → 同步「历史邮件」(task 09-11-history-mail-sync)。
//
// 一次性补回某个日期范围内收件箱 + 已发送里本地缺的邮件。任务在后端 async_jobs 里跑，
// 这里只负责发起、取消和展示。`GET /api/history-sync` 是唯一状态源：离开页面再回来、
// 重启 App 都靠它的 `job` 字段恢复进度。任务进行中每 3 秒轮询一次；Electron 另收
// SSE `job.*`，同一个 job_id 的事件到了就立即刷新（web 没有 SSE，只靠轮询）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import type { HistorySyncCounts, HistorySyncJob, HistorySyncState } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { toastError } from '@shared/state/toast'
import { Button } from '@shared/components/ui/button'
import { Input } from '@shared/components/ui/input'

import { Row } from './Row'
import { Section } from './Section'

const POLL_MS = 3000
const DAY_MS = 86_400_000

type ViewState = 'unsupported' | 'idle' | 'scanning' | 'syncing' | 'done' | 'problem' | 'cancelled'
type RangeError = 'required' | 'order' | 'future' | 'span'

const SUMMARY_FIELDS: ReadonlyArray<[keyof HistorySyncCounts, string]> = [
  ['scanned', 'settings.sync.history.summary.scanned'],
  ['existing', 'settings.sync.history.summary.existing'],
  ['added', 'settings.sync.history.summary.added'],
  ['notion_synced', 'settings.sync.history.summary.notionSynced'],
  ['local_only', 'settings.sync.history.summary.localOnly'],
  ['failed', 'settings.sync.history.summary.failed']
]

function isActive(job: HistorySyncJob | null): boolean {
  return job?.status === 'queued' || job?.status === 'running'
}

function viewStateOf(data: HistorySyncState): ViewState {
  if (!data.supported) return 'unsupported'
  const job = data.job
  if (!job) return 'idle'
  switch (job.status) {
    case 'queued':
      return 'scanning'
    case 'running':
      return job.phase === 'scanning' ? 'scanning' : 'syncing'
    case 'succeeded':
      // 截断视图没覆盖到起始日期：任务本身没出错，但不能显示成完整成功。
      return job.complete ? 'done' : 'problem'
    case 'aborted':
      return 'cancelled'
    default:
      return 'problem'
  }
}

/** `YYYY-MM-DD` → 自 epoch 起的天数；格式不对返回 null。只做日期差，不涉及时区。 */
function dayNumber(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS
}

function todayLocal(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 与 serve-api 同一套校验：先后顺序、不晚于今天、跨度（until − since）不超过 maxDays。 */
function validateRange(
  since: string,
  until: string,
  today: string,
  maxDays: number
): RangeError | null {
  const a = dayNumber(since)
  const b = dayNumber(until)
  if (a === null || b === null) return 'required'
  if (a > b) return 'order'
  if (until > today) return 'future'
  if (b - a > maxDays) return 'span'
  return null
}

interface RateSample {
  jobId: number
  done: number
  at: number
}

/** 剩余秒数 = 剩余封数 ÷ 本页面观察到的处理速率；样本不足时返回 null。 */
function estimateEtaSeconds(first: RateSample, job: HistorySyncJob, now: number): number | null {
  const doneDelta = job.progress_done - first.done
  const elapsed = now - first.at
  const remaining = job.progress_total - job.progress_done
  if (doneDelta <= 0 || elapsed <= 0 || remaining <= 0) return null
  return (remaining / doneDelta) * (elapsed / 1000)
}

function ProgressBar({ done, total }: { done: number; total: number }): React.ReactElement {
  const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="w-[260px] h-2 rounded-full bg-ink-3 overflow-hidden"
    >
      <div
        className="h-full bg-coral/100 transition-[width] duration-base ease-standard"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

export function HistorySyncSection(): React.ReactElement {
  const { t } = useTranslation()
  const api = useMailApi()
  const qc = useQueryClient()

  const query = useQuery<HistorySyncState>({
    queryKey: qk.historySync(),
    queryFn: () => api.historySync.get(),
    refetchInterval: (q) => (isActive(q.state.data?.job ?? null) ? POLL_MS : false)
  })
  const data = query.data
  const job = data?.job ?? null
  const jobId = job?.job_id ?? null

  const [sinceInput, setSinceInput] = React.useState<string | null>(null)
  const [untilInput, setUntilInput] = React.useState<string | null>(null)
  const [rangeError, setRangeError] = React.useState<RangeError | null>(null)
  const [starting, setStarting] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)

  // ETA 的速率基准：本页面第一次看到这个任务处于同步阶段时的进度和取数时刻。
  // 用 react-query 的 dataUpdatedAt 而不是 Date.now()，保持 render 纯净。
  const [firstSample, setFirstSample] = React.useState<RateSample | null>(null)
  const syncingJob = job && job.status === 'running' && job.phase !== 'scanning' ? job : null
  if (syncingJob && (firstSample === null || firstSample.jobId !== syncingJob.job_id)) {
    setFirstSample({
      jobId: syncingJob.job_id,
      done: syncingJob.progress_done,
      at: query.dataUpdatedAt
    })
  }

  React.useEffect(() => {
    if (jobId === null) return
    return api.events.onEvent((ev) => {
      if (typeof ev.event_type !== 'string' || !ev.event_type.startsWith('job.')) return
      if (ev.data?.job_id !== jobId) return
      void qc.invalidateQueries({ queryKey: qk.historySync() })
    })
  }, [api, qc, jobId])

  const title = t('settings.sync.history.title')

  if (!data) {
    return (
      <Section title={title}>
        <div className="px-4 py-3.5 text-aux text-ink-fg-2">
          {query.isError ? (
            t('settings.sync.history.loadError')
          ) : (
            <Loader2 className="size-4 animate-spin text-ink-fg-3" aria-label="loading" />
          )}
        </div>
      </Section>
    )
  }

  const helper = (
    <>
      {t('settings.sync.history.helper')}
      {data.notion_enabled && data.notion_floor ? (
        <span className="block">
          {t('settings.sync.history.notionFloor', { date: data.notion_floor })}
        </span>
      ) : null}
    </>
  )

  const view = viewStateOf(data)

  if (view === 'unsupported') {
    return (
      <Section title={title} helper={helper}>
        <div data-testid="history-sync-unsupported" className="px-4 py-3.5 text-aux text-ink-fg-2">
          {data.unsupported_reason === 'backend_applescript'
            ? t('settings.sync.history.unsupported.backend_applescript')
            : t('settings.sync.history.unsupported.generic')}
        </div>
      </Section>
    )
  }

  const active = isActive(job)
  const since = active && job ? job.since : (sinceInput ?? data.defaults.since)
  const until = active && job ? job.until : (untilInput ?? data.defaults.until)

  async function handleStart(): Promise<void> {
    const err = validateRange(since, until, todayLocal(), data?.max_days ?? 0)
    setRangeError(err)
    if (err) return
    setStarting(true)
    try {
      await api.historySync.start({ since, until })
      await qc.invalidateQueries({ queryKey: qk.historySync() })
    } catch (e) {
      toastError(t('settings.sync.history.startError'), errorMessage(e))
    } finally {
      setStarting(false)
    }
  }

  async function handleCancel(): Promise<void> {
    setCancelling(true)
    try {
      await api.historySync.cancel()
      await qc.invalidateQueries({ queryKey: qk.historySync() })
    } catch (e) {
      toastError(t('settings.sync.history.cancelError'), errorMessage(e))
    } finally {
      setCancelling(false)
    }
  }

  let headline: string
  let headlineClass = ''
  switch (view) {
    case 'scanning':
      headline = t(
        job?.status === 'queued'
          ? 'settings.sync.history.status.queued'
          : 'settings.sync.history.status.scanning'
      )
      break
    case 'syncing':
      headline = t('settings.sync.history.status.syncing')
      break
    case 'done':
      headline = t('settings.sync.history.status.done')
      break
    case 'cancelled':
      headline = t('settings.sync.history.status.cancelled')
      break
    case 'problem':
      if (job?.status === 'failed') {
        headline = t('settings.sync.history.status.failed')
        headlineClass = 'text-fail'
      } else if (job?.status === 'partial_failure') {
        headline = t('settings.sync.history.status.partial')
        headlineClass = 'text-warn'
      } else {
        headline = t('settings.sync.history.status.incomplete', {
          date: job?.covered_from ?? job?.since ?? ''
        })
        headlineClass = 'text-warn'
      }
      break
    default:
      headline = t('settings.sync.history.status.idle')
  }

  const statusHelper: React.ReactNode = rangeError ? (
    <span className="text-fail">
      {t(`settings.sync.history.validation.${rangeError}`, { days: data.max_days })}
    </span>
  ) : job ? (
    t('settings.sync.history.range', { since: job.since, until: job.until })
  ) : null

  let etaText: string | null = null
  if (view === 'syncing' && syncingJob && firstSample?.jobId === syncingJob.job_id) {
    const eta = estimateEtaSeconds(firstSample, syncingJob, query.dataUpdatedAt)
    if (eta !== null) {
      etaText =
        eta < 60
          ? t('settings.sync.history.etaUnderMinute')
          : t('settings.sync.history.eta', { minutes: Math.ceil(eta / 60) })
    }
  }

  return (
    <Section title={title} helper={helper}>
      <Row label={t('settings.sync.history.since')}>
        <Input
          type="date"
          value={since}
          onChange={(e) => {
            setSinceInput(e.target.value)
            setRangeError(null)
          }}
          disabled={active || starting}
          aria-label={t('settings.sync.history.since')}
          className="w-[180px]"
        />
      </Row>
      <Row label={t('settings.sync.history.until')}>
        <Input
          type="date"
          value={until}
          onChange={(e) => {
            setUntilInput(e.target.value)
            setRangeError(null)
          }}
          disabled={active || starting}
          aria-label={t('settings.sync.history.until')}
          className="w-[180px]"
        />
      </Row>
      <Row
        label={
          <span data-testid="history-sync-status" data-state={view} className={headlineClass}>
            {headline}
          </span>
        }
        helper={statusHelper}
      >
        <div className="flex items-center gap-1.5">
          {active && job ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleCancel()}
              disabled={cancelling || job.cancel_requested}
            >
              {job.cancel_requested
                ? t('settings.sync.history.cancelling')
                : t('settings.sync.history.cancel')}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleStart()}
            disabled={active || starting}
          >
            {starting ? <Loader2 className="size-3 animate-spin" /> : null}
            {t('settings.sync.history.start')}
          </Button>
        </div>
      </Row>
      {view === 'syncing' && job ? (
        <Row
          label={t('settings.sync.history.progress', {
            done: job.progress_done,
            total: job.progress_total
          })}
          helper={etaText}
        >
          <ProgressBar done={job.progress_done} total={job.progress_total} />
        </Row>
      ) : null}
      {job && !active ? (
        <div data-testid="history-sync-summary" className="px-4 py-3.5 space-y-2">
          <dl className="grid grid-cols-3 gap-x-6 gap-y-1.5 text-meta">
            {SUMMARY_FIELDS.map(([field, labelKey]) => (
              <div key={field} className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-fg-2">{t(labelKey)}</dt>
                <dd className="font-mono text-ink-fg" data-field={field}>
                  {job.counts[field]}
                </dd>
              </div>
            ))}
          </dl>
          {!job.complete ? (
            <p className="text-meta text-warn">
              {t('settings.sync.history.incompleteHint', { date: job.covered_from ?? '' })}
            </p>
          ) : null}
          {job.last_error ? (
            <p className="text-meta text-fail">
              {t('settings.sync.history.error', { message: job.last_error })}
            </p>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}
