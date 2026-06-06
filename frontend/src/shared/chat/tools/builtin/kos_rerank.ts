// V2.1 阶段 3 — 3b-4：KOS query 命中的 client-side time-decay rerank（纯逻辑，
// 从 electron `kos/client.ts` 逐字下沉 shared，供 createKosTools 的 kos_query gate 用）。
//
// KOS bm25 排序无时间维度, 老 hit 跟新 hit 同权重命中. 给 chat agent 的 kos_query
// tool, 拿到 hits 后乘 exponential decay factor 让新 hit 优先. 实施在 client-side
// 因为 KOS server 没现成 time decay param (Lucien sync 后可上 server-side, P2 design
// doc §3.3 B).
//
// 公式: factor = 0.5 ^ (Δt_days / halfLifeDays)
//   - halfLifeDays=14 (D5 user-approved): score 在 14d 时降一半, 28d 1/4, 56d 1/16.
//     适合邮件回复节奏 (周/月级).
//   - hit 无 timestamp → factor=1.0 不调整 (保持 bm25 原序)
//
// 注意: 跟 src/kos/client.py 1:1 镜像不对齐 — Python 端 KOS 消费者只有 producer
// 路径 (推 email 不 query), chat agent 仅 TS 路径需 rerank.
//
// 自包含 QueryHit（开放 shape，与 main `kos/client.ts` 的同名结构兼容）—— shared 不引
// main 文件（不变式 1）；rerank 只读 score + 时间字段，开放索引签名足够。

export interface QueryHit {
  slug: string
  title?: string
  type?: string
  page_id?: number
  chunk_text?: string
  score?: number
  /** Open shape — KOS server may add fields like updated_at / mtime_ns /
   *  created_at. rerankByRecency() reads these via extractHitTimestampMs. */
  [k: string]: unknown
}

const DEFAULT_HALF_LIFE_DAYS = 14

/**
 * Extract a timestamp (ms since epoch) from a KOS hit's open metadata.
 * KOS server 字段名不固定 (gbrain wiki_pages 用 updated_at 或 mtime_ns),
 * 这里按 priority 取第一个找到的有效值. null = 不能 rerank.
 */
export function extractHitTimestampMs(hit: QueryHit): number | null {
  // updated_at: ms epoch (gbrain wiki_pages convention).
  if (typeof hit.updated_at === 'number' && hit.updated_at > 0) {
    return hit.updated_at
  }
  // mtime_ns: ns epoch (gbrain internal). Convert to ms.
  if (typeof hit.mtime_ns === 'number' && hit.mtime_ns > 0) {
    return Math.floor(hit.mtime_ns / 1_000_000)
  }
  // created_at fallback.
  if (typeof hit.created_at === 'number' && hit.created_at > 0) {
    return hit.created_at
  }
  return null
}

export interface RerankOptions {
  /** Half-life in days. Default 14 (D5). */
  halfLifeDays?: number
  /** Override now() for deterministic tests. Default Date.now(). */
  nowMs?: number
}

/**
 * Rerank KOS query hits by exponential time decay. Returns a NEW array
 * sorted by adjusted score (DESC). Original hits NOT mutated.
 *
 * Behaviour:
 *   - hit with extractable timestamp → score *= 0.5^(Δt_days / halfLife)
 *   - hit without timestamp → factor=1.0 (rank by original bm25 score)
 *   - hit without score → treated as 0 (sorts to bottom)
 *   - 添加 `_recency_factor` + `_original_score` 字段在新 hit 上方便 caller
 *     debug / 渲染 explanation
 */
export function rerankByRecency(hits: ReadonlyArray<QueryHit>, opts?: RerankOptions): QueryHit[] {
  const halfLifeDays = opts?.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS
  const now = opts?.nowMs ?? Date.now()
  const dayMs = 86_400_000

  const adjusted: QueryHit[] = hits.map((hit) => {
    const tsMs = extractHitTimestampMs(hit)
    const originalScore = typeof hit.score === 'number' ? hit.score : 0
    let factor = 1.0
    if (tsMs !== null) {
      const deltaDays = Math.max(0, (now - tsMs) / dayMs)
      factor = Math.pow(0.5, deltaDays / halfLifeDays)
    }
    const newScore = originalScore * factor
    return {
      ...hit,
      score: newScore,
      _recency_factor: factor,
      _original_score: originalScore
    }
  })

  // Stable sort by adjusted score DESC. Array.prototype.sort is stable in
  // modern V8/JavaScriptCore.
  adjusted.sort((a, b) => {
    const sa = typeof a.score === 'number' ? a.score : 0
    const sb = typeof b.score === 'number' ? b.score : 0
    return sb - sa
  })
  return adjusted
}
