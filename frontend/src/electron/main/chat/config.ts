// Sprint 19 PR-1d.1 — Agent harness feature flag inventory.
//
// Centralizes env reads so swapping the kill-switches in tests is one
// `process.env.X = '...'` away. Defaults are conservative: every harness
// surface ships OFF until the eval gate at each phase passes.
//
// See docs/agent-harness-design.md §8 for the rollout table.

function readEnvBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  return raw === '1' || raw.toLowerCase() === 'true'
}

function readEnvNumber(name: string, defaultValue: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return defaultValue
  const n = Number(raw)
  return Number.isFinite(n) ? n : defaultValue
}

/** P1 — multi-turn harness loop master switch. OFF → dispatcher.runStream
 *  walks the legacy single-pass path identical to Sprint 18 behaviour. */
export function isHarnessEnabled(): boolean {
  return readEnvBool('MAILAGENT_AGENT_HARNESS', false)
}

/** P2 — Wiki context block injection + wiki_* tools exposed. */
export function isWikiEnabled(): boolean {
  return readEnvBool('MAILAGENT_AGENT_WIKI', false)
}

/** M3 — embedding RRF hybrid retrieval (only after eval gate passes). */
export function isVectorEnabled(): boolean {
  return readEnvBool('MAILAGENT_AGENT_VECTOR', false)
}

/** P3 — let LLM-driven wiki_write commit changes without user dialog
 *  per write (overrides ConfirmationTier=preview for trusted scopes). */
export function isAgentMemoryAutowriteEnabled(): boolean {
  return readEnvBool('AGENT_MEMORY_AUTOWRITE', false)
}

/** M2 — PDF/docx/xlsx text extraction worker queue + email_attachment_fts. */
export function isAttachmentFtsEnabled(): boolean {
  return readEnvBool('AGENT_ATTACHMENT_FTS', false)
}

/** M2 PR-2e — KOS consumer chat tools (kos_query / kos_digest) registered.
 *  OFF (default) → tools 不暴露给 LLM, chat agent 只用本地 FTS5 路径
 *  (PR-2a/b). ON → LLM 可调 KOS 跨域检索. 需 PR-2c 的 KOS_MCP_BASE +
 *  KOS_OAUTH_CLIENT_ID + KOS_OAUTH_CLIENT_SECRET 配齐才有意义. */
export function isKosConsumerEnabled(): boolean {
  return readEnvBool('MAILAGENT_KOS_CONSUMER_ENABLED', false)
}

/** M2 PR-2f — L1 hot block KOS sender digest injection into system prompt.
 *  OFF (default) → system blocks 单 STATIC + emailContext, 无 KOS context.
 *  ON → chat start 时按 emailContext.senderAddr 异步预 fetch
 *  `people/<slug>` digest, buildSystemBlocks 同步读 cache 注入 L1 hot
 *  block (放在 STATIC 后, emailContext 前, 仍保 cache_control 在 stable
 *  prefix 末). 需 PR-2c env + KOS 可达; cache miss 时优雅退化无注入. */
export function isKosL1HotBlockEnabled(): boolean {
  return readEnvBool('MAILAGENT_KOS_L1_HOT_BLOCK_ENABLED', false)
}

/** Sprint 19 P1-B — client-side time-decay rerank for KOS query hits.
 *  Default ON (Todo 1 design doc D4 user-approved): wrap kos_query hits
 *  with exponential 14d-half-life decay so newer KOS pages outrank older
 *  ones for the chat agent. .env override to false reverts to pure bm25
 *  server-side order (useful for A/B comparison or debugging recency
 *  misranking — e.g. older but high-bm25 hit being demoted past 30d). */
export function isKosTimeDecayEnabled(): boolean {
  return readEnvBool('MAILAGENT_KOS_TIME_DECAY_ENABLED', true)
}

/** Per-turn iteration cap. Hard ceiling on how many backend.stream() calls
 *  the harness will make for a single user message; exceeding emits
 *  E_MAX_ITER so the LLM doesn't infinite-loop on a flaky tool. */
export function getMaxIter(): number {
  return Math.max(1, Math.floor(readEnvNumber('AGENT_MAX_ITER', 8)))
}

/** Per-turn cost cap in USD. Sums every `usage.costUsd` event the backend
 *  emits; exceeding emits E_COST_BUDGET. */
export function getMaxCostUsd(): number {
  const n = readEnvNumber('AGENT_MAX_COST_USD', 0.5)
  return n > 0 ? n : 0.5
}

/** Determines whether a backend supports the Anthropic tool_use protocol
 *  end-to-end. Drives the harness vs legacy gate in dispatcher.runStream.
 *  notion-agent CLI is a black-box one-shot — no tool_use loop possible. */
export function backendSupportsTools(kind: 'notion-agent' | 'custom-api'): boolean {
  return kind === 'custom-api'
}
