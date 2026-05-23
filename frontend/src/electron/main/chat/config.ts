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
