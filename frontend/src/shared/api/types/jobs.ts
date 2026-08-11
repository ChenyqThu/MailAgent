// ---- D2b — async_jobs 长任务子系统 (C1 后端 POST /api/jobs + GET /api/jobs/{id}) --
//
// batch resync (选中多封重传 Notion) 走 async_jobs: enqueue 立即返 job_id
// (queued), serve 进程 JobWorker 串行执行, 进度经 SSE job.* + GET 轮询。前端经
// daemon_api.daemonRequest (Electron) / http_client (web SPA) 起任务 + 查进度;
// 进度展示 + 终态 toast 由 shared/state/resyncJob.ts::watchResyncJob 编排。

/** async_jobs.job_type — 与后端 src/sync/job_runners.py JOB_TYPES 对齐。 */
export type JobType = 'resync' | 'backfill_body' | 'backfill_metadata'

/** async_jobs.status 状态机 (queued → running → 终态)。 */
export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial_failure'
  | 'failed'
  | 'aborted'

/** POST /api/jobs 的 data — enqueue 结果 (立即返回, status 恒 'queued')。 */
export interface JobEnqueueResult {
  job_id: number
  status: 'queued'
  /** false ⇒ 命中既有 idempotencyKey (弱网重发去重, 返既有 job)。batch resync
   *  不传 idempotencyKey, 故恒 true。 */
  was_created: boolean
  job_type: string
  target_kind: string
  target_key: string
}

/** GET /api/jobs/{id} 的 data — 镜像后端 async_jobs 行 (jobs.py::_job_to_dict)。 */
export interface JobRecord {
  job_id: number
  job_type: string
  target_kind: string
  target_key: string
  status: JobStatus
  progress_done: number
  progress_total: number
  checkpoint_internal_id: number | null
  /** 终态 summary (LongTaskSummary.as_dict: total/succeeded/failed/skipped/…);
   *  非终态为 null。 */
  result: Record<string, unknown> | null
  last_error: string | null
  created_at: number
  updated_at: number
  started_at: number | null
  finished_at: number | null
}

export interface JobsApi {
  /** 查 job 状态 / 进度 / 终态 summary (轮询兜底: SSE 断线 / web 无 SSE 时拿终态)。
   *  E_NOT_FOUND 抛 Error & {code}。 */
  get(jobId: number): Promise<JobRecord>
}
