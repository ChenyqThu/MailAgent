// ---- Immersive translate (DB v12) ------------------------------------------
//
// 翻译路径双轨制：
//   - Path A (LLM 分类顺带): src/llm_agent/runner.py 在 LLM 分类时同步返回
//     translation_segments, 写 email_translation 表 (source='llm_agent').
//   - Path B (用户按 "翻译"): translateBatch IPC, html-extractor 抽块级 →
//     pLimit(2) batches of 10 → 写 email_translation 表 (source='on_demand').
//
// Renderer 不在乎是哪条路径写的, 拿到 segments 后让 EmailBodyFrame 通过
// iframe.contentDocument 用 textContent.includes(src) fuzzy 配对 DOM 节点
// 注入译文。

export type TargetLang = 'zh' | 'en'

export interface TranslationSegment {
  /** Source paragraph plaintext, verbatim substring of the email body
   *  paragraph. Used to fuzzy-match DOM nodes in the iframe via
   *  `textContent.includes(src)`. */
  src: string
  /** Translation of the segment (Simplified Chinese, mainland usage). */
  tgt: string
}

/** Cached translation envelope (returned by AiApi.getCached and AiApi.translateBatch). */
export interface TranslationCache {
  internalId: number
  targetLang: TargetLang
  segments: TranslationSegment[]
  /** Provenance — 'llm_agent' (Path A) | 'on_demand' (Path B). null on
   *  ad-hoc results before they're persisted. */
  source: string | null
  /** Model that produced the translation; empty string if empty cache. */
  model: string | null
  /** Unix seconds when the cache row was written; null for un-persisted result. */
  fetchedAt: number | null
}

/** Result of translateBatch — TranslationCache + batch run statistics. */
export interface TranslateBatchResult extends TranslationCache {
  latencyMs: number
  /** Number of batches that failed (LLM error / JSON parse / abort). When 0,
   *  the translation is complete. Renderer shows a partial-failure banner
   *  when this is > 0 but segments.length > 0. */
  failedBatches: number
  totalBatches: number
  /** true when a shorter fresh result was returned but an existing richer cache
   *  row was kept to avoid downgrading coverage. */
  cacheKept?: boolean
}

export interface AiApi {
  /**
   * Run an on-demand batch translation of an email's body (Path B). Extracts
   * block-level paragraphs from body_html in the main process, batches them
   * (≤10 segments and ≤3000 chars per request, 2 concurrent), calls the LLM
   * gateway, and writes the result to email_translation (DB v12). Returns the
   * full TranslateBatchResult including failedBatches for partial-failure UX.
   *
   * API key + endpoint stay in the main process (REVIEW-LOG C-04). Errors
   * carry `code`: E_NO_BODY / E_NO_LLM_KEY / E_INVALID_ARG / E_UPSTREAM.
   */
  translateBatch(internalId: number, targetLang?: TargetLang): Promise<TranslateBatchResult>
  /** Read cached translation segments from email_translation table. Returns
   *  null on cache miss. Used to render the immersive translation on email
   *  open without re-running the LLM. */
  getCached(internalId: number, targetLang?: TargetLang): Promise<TranslationCache | null>
  /** Delete the cached translation row. Renderer fires this before
   *  re-translation so the new run overwrites cleanly. */
  deleteCached(internalId: number, targetLang?: TargetLang): Promise<boolean>
  /** Abort all in-flight batches for `internalId`. Renderer fires this when
   *  switching emails so stale batches don't keep CRS slots wedged. */
  abortTranslate(internalId: number): void
}
