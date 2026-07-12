import type { SearchHit } from './core'

// ---- F2 — agentic 搜索（runSearchAgent）契约 ------------------------------
//
// S3 后实现 = gateway headless run：renderer 客户端 @shared/assistant/searchAgentClient
// （runGatewaySearchAgent）→ gateway /api/ai/search-agent（ai-gateway/searchAgentRun.ts）。
// types.ts 只承载这两个契约类型 + phase 给消费方。

export type SearchAgentPhase = 'searching' | 'summarizing'

export interface SearchAgentInput {
  /** 用户自然语言查询。 */
  query: string
  /** 可选 mailbox 限定（透传给 prompt 作上下文提示）。 */
  mailbox?: string
  /** 外部取消信号（与内部 AbortController 联动）。 */
  signal?: AbortSignal
  /** 可选阶段回调：第一个 email_search_fulltext → 'searching'；present_results → 'summarizing'。 */
  onPhase?: (phase: SearchAgentPhase) => void
}

export interface SearchAgentResult {
  ok: boolean
  /** 候选池 ∩ matched_internal_ids，保序、带 snippet。 */
  hits: SearchHit[]
  /** present_results.summary；无输出时 null。 */
  summary: string | null
  /** 结构化错误码；ok=true 时省略。 */
  error?: { code: string; message: string }
  /** agent 无有效输出时，nlToDsl 兜底产物（前端可填回输入框走普通搜索）。 */
  fallbackDsl?: string
}
