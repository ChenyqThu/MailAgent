// D2b — batch resync 长任务进度 watcher。
//
// BatchActionBar 点「重传 Notion」→ email.batchResync 起一个 async_jobs resync
// job (C1 后端) → 本 watcher 接管展示: 一个 sticky progress toast (Toast.ts 的
// long-task progress 机制, push({progress}) → 进度条 + sticky) + 两路进度源:
//   - SSE job.* (Electron: events_bridge 已转发 9200 的 job.progress/done/failed;
//     web: HttpApi.events.onEvent 是 no-op, 此路静默)
//   - GET /jobs/{id} 轮询 (两端兜底: web 无 SSE 靠它拿终态; Electron SSE 断线兜底)
// 终态 (succeeded/partial_failure/failed/aborted) → dismiss progress toast + 一条
// 终态 toast + 失效 ['emails'] 查询。
//
// 不依赖 React 组件生命周期: 闭包持 mailApi/queryClient/toast store, 用户起 job
// 后退出批量模式 / BatchActionBar unmount, watcher 仍跑到终态。SSE 与轮询谁先到
// 终态谁处理 (settled 闸防双处理 + 互相 cleanup)。

import type { QueryClient } from '@tanstack/react-query'

import type { JobRecord, MailApi, SseEvent } from '@shared/api/types'
import { useToastStore } from '@shared/state/toast'

/** i18next t 子集 (BatchActionBar 传入 useTranslation().t)。 */
export type TranslateFn = (key: string, params?: Record<string, unknown>) => string

const TERMINAL = new Set<string>(['succeeded', 'partial_failure', 'failed', 'aborted'])
const POLL_INTERVAL_MS = 1500
/** watcher 自毁兜底: job 永不终态 (worker 挂 / SSE+轮询都失联) 时不泄漏订阅 + toast。
 *  batch resync 几十封量级远不及此; 触发即静默停跟踪 (job 仍可能在后台跑)。 */
const MAX_WATCH_MS = 15 * 60 * 1000

export interface WatchResyncJobDeps {
  mailApi: MailApi
  queryClient: QueryClient
  t: TranslateFn
  jobId: number
  /** 选中封数 — SSE/轮询 total 缺失时的进度分母兜底。 */
  total: number
}

/** async_jobs 终态 summary 的相关字段 (LongTaskSummary.as_dict 子集)。 */
interface JobSummary {
  total?: number
  succeeded?: number
  failed?: number
  skipped?: number
}

/** 起一个 batch resync job 后调用 (fire-and-forget)。展示进度 + 终态, 自管生命周期。 */
export function watchResyncJob(deps: WatchResyncJobDeps): void {
  const { mailApi, queryClient, t, jobId, total } = deps
  const op = t('batchbar.resync')
  const toastId = useToastStore.getState().push({
    variant: 'info',
    title: op,
    progress: 0,
    ttlMs: 0 // sticky — 由 finish() dismiss
  })

  let settled = false
  let unsub: (() => void) | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let overallTimer: ReturnType<typeof setTimeout> | null = null

  function cleanup(): void {
    if (unsub) {
      unsub()
      unsub = null
    }
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
    if (overallTimer) {
      clearTimeout(overallTimer)
      overallTimer = null
    }
  }

  function pushProgress(done: number, tot: number): void {
    if (settled) return
    const denom = tot > 0 ? tot : total
    useToastStore.getState().setProgress(toastId, denom > 0 ? done / denom : 0)
  }

  function finish(status: string, summary: JobSummary | null, errorMsg?: string): void {
    if (settled) return
    settled = true
    cleanup()
    const toast = useToastStore.getState()
    toast.dismiss(toastId)

    const succeeded = summary?.succeeded ?? 0
    const failed = summary?.failed ?? 0
    const tot = summary?.total ?? total

    if (status === 'succeeded') {
      toast.push({ variant: 'success', title: t('batchToast.ok', { op, n: succeeded }) })
    } else if (status === 'aborted') {
      toast.push({
        variant: 'info',
        title: t('batchToast.cancelled', { op, done: succeeded, total: tot })
      })
    } else if (!summary) {
      // runner crash (job.failed 携 {error} 无 summary) — 整批失败, 无逐封统计。
      // 复用单封 resync 的通用失败文案 (本地化 zh/en), 具体错误进 detail。
      toast.push({
        variant: 'error',
        title: t('toolbarToast.resyncFailGeneric'),
        detail: errorMsg,
        ttlMs: 5000
      })
    } else {
      // partial_failure 或 failed(有 summary): 显示 done/total + failed 数。
      toast.push({
        variant: 'error',
        title: t('batchToast.partial', { op, done: succeeded, total: tot, failed }),
        ttlMs: 5000
      })
    }
    void queryClient.invalidateQueries({ queryKey: ['emails'] })
  }

  // ---- SSE job.* (Electron 实时; web onEvent → no-op unsub) ----
  unsub = mailApi.events.onEvent((ev: SseEvent) => {
    if (settled) return
    const type = ev.event_type
    if (typeof type !== 'string' || !type.startsWith('job.')) return
    const data = (ev.data ?? {}) as Record<string, unknown>
    if (data.job_id !== jobId) return
    if (type === 'job.progress') {
      pushProgress(Number(data.done) || 0, Number(data.total) || total)
    } else if (type === 'job.done') {
      finish(String(data.status ?? 'succeeded'), (data.summary as JobSummary) ?? null)
    } else if (type === 'job.failed') {
      // 两种形状: {job_id, error} (runner crash) | {job_id, status, summary}.
      if (data.summary) finish(String(data.status ?? 'failed'), data.summary as JobSummary)
      else finish('failed', null, data.error != null ? String(data.error) : undefined)
    }
  })

  // ---- GET /jobs/{id} 轮询兜底 (web 唯一进度源; Electron SSE 断线兜底) ----
  async function poll(): Promise<void> {
    if (settled) return
    try {
      const job: JobRecord = await mailApi.jobs.get(jobId)
      if (settled) return
      pushProgress(job.progress_done, job.progress_total)
      if (TERMINAL.has(job.status)) {
        finish(job.status, (job.result as JobSummary) ?? null, job.last_error ?? undefined)
        return
      }
    } catch {
      // 轮询失败 (daemon 临时不可达) — 不终结, 下个 tick 再试; 总超时兜底。
    }
    if (!settled) pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
  }
  pollTimer = setTimeout(() => void poll(), POLL_INTERVAL_MS)

  // ---- watcher 自毁兜底 (防 job 永不终态时泄漏) ----
  overallTimer = setTimeout(() => {
    if (settled) return
    settled = true
    cleanup()
    useToastStore.getState().dismiss(toastId)
  }, MAX_WATCH_MS)
}
