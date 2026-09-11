// ---- 同步历史邮件（task 09-11-history-mail-sync）--------------------------
//
// serve-api `GET/POST /api/history-sync` + `POST /api/history-sync/cancel`。字段名与
// 后端 JSON 逐字一致（snake_case），契约见任务 design.md §5。任务本体是 async_jobs 的
// `history_sync` 维护任务，进度另存 sync_state，经 GET 的 `job` 字段恢复。

import type { JobStatus } from './jobs'

/** 任务阶段：先扫描邮箱找缺失，再逐批交给同步流水线处理。 */
export type HistorySyncPhase = 'scanning' | 'syncing' | 'done'

export interface HistorySyncCounts {
  scanned: number
  existing: number
  added: number
  processed: number
  notion_synced: number
  local_only: number
  failed: number
  empty_msgid: number
}

export interface HistorySyncJob {
  job_id: number
  status: JobStatus
  phase: HistorySyncPhase
  /** 本地日期 `YYYY-MM-DD`，含两端。 */
  since: string
  until: string
  counts: HistorySyncCounts
  progress_done: number
  progress_total: number
  /** false = davmail 截断视图没覆盖到起始日期，此时 `covered_from` 是实际覆盖到的日期。 */
  complete: boolean
  /** 本地日期 `YYYY-MM-DD`；覆盖完整时为 null。 */
  covered_from: string | null
  cancel_requested: boolean
  started_at: number
  finished_at: number | null
  updated_at: number
  last_error: string | null
}

export interface HistorySyncState {
  supported: boolean
  /** 不支持的原因码；目前只有 `backend_applescript`。 */
  unsupported_reason: string | null
  backend: string
  defaults: { since: string; until: string }
  max_days: number
  notion_enabled: boolean
  /** 当前生效的 Notion 同步起始日期（`YYYY-MM-DD`）；未配置为 null。 */
  notion_floor: string | null
  /** 进行中的任务；没有则为最近一次结束的；从未运行过为 null。 */
  job: HistorySyncJob | null
}

export interface HistorySyncStartResult {
  job_id: number
  /** false = 已有进行中的任务，返回的是它。 */
  was_created: boolean
}

export interface HistorySyncCancelResult {
  job_id: number
  cancel_requested: true
}

export interface HistorySyncApi {
  get(): Promise<HistorySyncState>
  start(range: { since: string; until: string }): Promise<HistorySyncStartResult>
  /** 没有进行中的任务时抛 Error & {code:'E_NOT_FOUND'}。 */
  cancel(): Promise<HistorySyncCancelResult>
}
