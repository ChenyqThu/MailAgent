// issue #59 R7 — KOS 入库台账的只读统计面（LLM Dashboard「知识库入库」区）。
//
// 后端单源 = `src/kos/stats.py`，CLI (`mailagent kos stats`) 与 serve-api
// (`GET /api/kos/stats`) 只做各自的 envelope 包装，SQL 一份。前端两条传输：
// 桌面 IPC `kos:stats` → callCli；远程 web → HttpApi GET /kos/stats。

/** `sync_state` 的 `kos.health.*` 投影。🔴 从未探活过时整个对象为 null ——
 *  「未探测」不是「异常」，渲染侧必须分开处理。
 *
 *  ⚠️ 渲染侧**不要只判 `health == null`**：上游曾返回过「对象在、字段全 null」
 *  的形状，那样 `health.ok` 是 undefined → falsy → 误报「不可达」，受害面正是
 *  「刚升级、从未探活过」的所有机器。判据用 `typeof health?.ok === 'boolean'`
 *  收敛三态（见 KosIngestSection 的 healthOk）。 */
export interface KosHealthSnapshot {
  ok: boolean
  /** epoch 秒；上游未守约时可能为 null，格式化函数各自兜底。 */
  checked_at: number | null
  /** 契约外的附加字段（排查用，可选消费）：探活失败原因。 */
  detail?: string | null
  /** 契约外的附加字段：连续探活失败轮次。当前 UI 不消费。 */
  consecutive_failed_rounds?: number | null
}

/** 按天分桶的入库量，供 mini sparkline。date 为 'YYYY-MM-DD'。 */
export interface KosDailyBucket {
  date: string
  pushed: number
  failed: number
}

export interface KosStatsData {
  /** 🔴 producer 面是否激活 —— 判据**在后端算**，前端只读这个 bool。
   *
   *  = `MAILAGENT_KOS_INGEST_ENABLED` AND (`KOS_MCP_BASE` + `MAILAGENT_BULK_CLIENT_ID`
   *  + `MAILAGENT_BULK_CLIENT_SECRET` 三者非空)，即 `make_bulk_kos_client()`
   *  真正读的那套凭据。
   *
   *  ⚠️ 与 `/chat/config.kosConfigured`（`useKosGate`）**不是一回事** —— 后者判的是
   *  consumer 面（chat 读 KOS 用的 `KOS_OAUTH_CLIENT_*`）。两套凭据独立，用 consumer
   *  判据 gate producer 面会同时产生「能读不能写 → 显示恒空区」和反向漏显示。 */
  enabled: boolean
  /** 镜像请求的窗口宽度（-1 = 全量，同 llm stats）。 */
  days: number
  /** days<0（全量）时为 null。 */
  since_ts: number | null
  /** kos_ingest_log 状态直方图。🔴 键可能缺席，一律当 0 处理，别假设一定有。 */
  by_status: {
    pushed?: number
    failed?: number
    dead?: number
    skipped?: number
  }
  /** 仅失败行的错误码分布（E_KOS_NETWORK 等），可能是空对象。 */
  by_error_code: Record<string, number>
  /** 待重试积压（status='failed'）。 */
  pending_retry: number
  /** 需人工介入（重试已放弃）。 */
  dead_count: number
  /** 台账里最近一次 pushed 的时间（epoch 秒）；无记录 → null。
   *  ⚠️ 这个值可能很陈旧（producer 记账上线前的存量全是 bulk 写的），
   *  渲染侧必须让人一眼看出旧，不能画成新鲜时间戳。 */
  last_success_ts: number | null
  /** 从未探活过 → null（≠ 异常）。
   *  ⚠️ 非 null 也**不是实时状态** —— 后端无积压时不探活，这个快照可能很旧，
   *  故渲染侧必须把 `checked_at` 的相对时间摆出来。 */
  health: KosHealthSnapshot | null
  daily: KosDailyBucket[]
  /** `live_query` = 正常；`table_missing` = 没跑过 bulk 的机器上台账表不存在，
   *  后端返全零；`schema_stale` = 装了新版但后端还没重启跑 v41 迁移的窗口，
   *  **数据是真的**、只有 `by_error_code` 取不到（别说成「无数据」）。
   *  三种情况下 `enabled` 都仍可能为 true。 */
  _source?: 'live_query' | 'table_missing' | 'schema_stale' | (string & {})
}

export interface KosApi {
  /** 台账聚合统计（read-only, no auth）。 */
  stats(days?: number): Promise<KosStatsData>
}
