// S3 W1 — headless agentic search on the embedded AI SDK Gateway.
//
// Replaces the legacy `shared/chat/search_agent.ts` runHarness loop (⌘K "AI 理解"
// palette entry) with a server-side generateText tool loop, so the LAST legacy-harness
// user path moves onto the one engine before W3 deletes the legacy runtime. The
// STRUCTURED RESULT CONTRACT is unchanged: candidate-pool ∩ present_results
// matched_internal_ids (anti-hallucination), mailbox hard-filter, best-effort fallback
// on a non-compliant model, and the same error codes the palette maps to copy
// (E_MAX_ITER / E_QUOTA / E_UPSTREAM / E_NO_OUTPUT / E_ABORTED).
//
// 🔴 Pure-ish (gateway core discipline): depends only on `ai` + zod + config + chatRun's
//    model factory + shared TYPES (erased). No node:http (the server handler feeds an
//    already-parsed body + AbortSignal), no electron / chat_db / keytar. The tool set
//    arrives via cfg.buildTools and is DEFENSIVELY narrowed to the four read tools —
//    a headless search run can never see a write/send tool, whatever the factory returns.
//
// 🔴 NOT a new gateway tool surface: present_results is a loop-private terminator
//    (exactly like the legacy version — it never registered in the shared registry
//    either), so it lives here, NOT in tools/ — it must not enter GATEWAY_*_TOOL_NAMES /
//    skill_gating sets / tool_catalog.json (the completeness gate scans those).

import { APICallError, generateText, hasToolCall, stepCountIs, tool, type ToolSet } from 'ai'
import { z } from 'zod'

import type { AiGatewayConfig } from './config'
import { resolveModelFactory } from './chatRun'
// HIGH-1 (batch1 review) — SDK-free typed credentials error from the registry resolver; mapped to
// the E_NO_LLM_KEY vocabulary in normalizeLoopError (the SSE is already open when resolve runs).
import { isProviderCredentialsError } from './providerRef'
// 发版终审 M3 — registry 语境下 normalizeLoopError 的 message 走固定形状脱敏（上游错误正文
// 可能回显凭证，会经 SSE result 帧进 renderer）；flag off 保持原 message 形状（字节级纪律）。
import { sanitizedUpstreamErrorMessage } from './upstreamError'
// Relative type-only import (erased) — same discipline as tools/email.ts's relative
// runtime import: the pure-Node poc harness (tsx) must be able to load this module.
import type { SearchAgentPhase, SearchHit } from '../shared/api/types'

// ── budgets (mirrors legacy G-A5: search is shorter than chat — retrieve → read top
//    2-3 bodies → present_results). The legacy loop took min(chat maxIter, 6); the
//    gateway has no /chat/config maxIter in scope, so the constant is the cap.
export const SEARCH_AGENT_MAX_ITER = 6
// legacy G-A3 — best-effort hit cap when the model never calls present_results.
export const SEARCH_BESTEFFORT_MAX = 20

// legacy G-A1 — the progressive-reading read-tool whitelist. The loop picks EXACTLY
// these from cfg.buildTools' output (defensive narrowing, not prompt trust).
export const SEARCH_AGENT_TOOL_NAMES = [
  'email_search_fulltext',
  'email_body',
  'email_get',
  'email_list_thread'
] as const

/** Request body of POST /api/ai/search-agent. The renderer client assembles the full
 *  first-user-message content (system prompt + query — the legacy loop also rode the
 *  prompt in the user message, never `system`) and passes the NORMALIZED (trimmed)
 *  mailbox so the prompt hint and the final hard filter share one value. */
export interface SearchAgentRunOpts {
  userContent: string
  /** Trimmed mailbox for the final hard filter (legacy G-A4); absent → no filter. */
  mailbox?: string
  /** Search-agent model override (agent config row); absent → cfg.model. */
  model?: string
}

/** The endpoint's terminal result — SearchAgentResult minus fallbackDsl (the nlToDsl
 *  fallback stays renderer-side where the serve-api reads live). */
export interface HeadlessSearchAgentResult {
  ok: boolean
  hits: SearchHit[]
  summary: string | null
  error?: { code: string; message: string }
}

interface PresentResultsPayload {
  matchedIds: number[]
  summary: string
}

/** Tolerant extraction (legacy parity): drop non-integer ids, coerce + clip summary to
 *  500 (the schema is advisory — the model may exceed it). */
export function extractPresentResults(input: unknown): PresentResultsPayload {
  const i = (input ?? {}) as Record<string, unknown>
  const rawIds = Array.isArray(i.matched_internal_ids) ? i.matched_internal_ids : []
  const matchedIds = rawIds.filter((x): x is number => Number.isInteger(x))
  const summary = String(i.summary ?? '').slice(0, 500)
  return { matchedIds, summary }
}

/** Merge one email_search_fulltext output's items into the candidate pool (ordered,
 *  first-seen wins — legacy parity). Tolerant of any non-conforming output shape. */
export function mergeSearchHits(pool: Map<number, SearchHit>, output: unknown): void {
  const items = (output as { items?: unknown } | undefined)?.items
  if (!Array.isArray(items)) return
  for (const raw of items) {
    const hit = raw as SearchHit
    if (hit && Number.isInteger(hit.internal_id) && !pool.has(hit.internal_id)) {
      pool.set(hit.internal_id, hit)
    }
  }
}

/** Narrow the full gateway ToolSet to the search-agent read whitelist. Exported for the
 *  defensive-narrowing test (a write tool in the factory output must never reach the
 *  loop). */
export function pickSearchAgentTools(all: ToolSet): ToolSet {
  const picked: ToolSet = {}
  for (const name of SEARCH_AGENT_TOOL_NAMES) {
    const t = all[name]
    if (t) picked[name] = t
  }
  return picked
}

/** Map a loop failure to the legacy harness error vocabulary the palette already
 *  formats: HTTP 429 → E_QUOTA, other upstream API errors → E_UPSTREAM, anything
 *  else → E_AGENT. M3 — `sanitizeUpstream`（= cfg.providerRegistryEnabled）时 message 走
 *  固定形状脱敏（凭证错误除外——那是我们自己构造的 typed 文案，安全）；off 字节级不动。 */
function normalizeLoopError(
  err: unknown,
  sanitizeUpstream: boolean
): { code: string; message: string } {
  // HIGH-1 — registry-path credential failure keeps the gateway-wide E_NO_LLM_KEY code (the
  // renderer client already maps it, see searchAgentClient.ts).
  if (isProviderCredentialsError(err)) {
    return { code: 'E_NO_LLM_KEY', message: err.message }
  }
  if (APICallError.isInstance(err)) {
    const code = err.statusCode === 429 ? 'E_QUOTA' : 'E_UPSTREAM'
    return { code, message: sanitizeUpstream ? sanitizedUpstreamErrorMessage(err) : err.message }
  }
  return {
    code: 'E_AGENT',
    message: sanitizeUpstream
      ? sanitizedUpstreamErrorMessage(err)
      : err instanceof Error
        ? err.message
        : String(err)
  }
}

/**
 * Run one headless search-agent loop: generateText with the four read tools + the
 * loop-private present_results terminator, then assemble the structured result from
 * the candidate pool (legacy runSearchAgentInner steps d-g, minus the renderer-side
 * nlToDsl fallback). Never throws — every failure normalizes into { ok:false, error }.
 */
export async function runHeadlessSearchAgent(
  cfg: AiGatewayConfig,
  opts: SearchAgentRunOpts,
  abortSignal: AbortSignal,
  onPhase?: (phase: SearchAgentPhase) => void
): Promise<HeadlessSearchAgentResult> {
  const pool = new Map<number, SearchHit>()
  let presented: PresentResultsPayload | null = null
  let sawSearchPhase = false

  // present_results — loop-private terminator. The model-facing schema mirrors the
  // legacy JSON schema (same fields / required / caps in the description); execute
  // records the payload tolerantly (legacy read the tool_use input, not the handler)
  // and stopWhen ends the loop right after this step.
  const present_results = tool({
    description:
      '必须且仅一次在最后调用；声明命中的邮件 + 摘要。matched_internal_ids 只能来自' +
      '此前 email_search_fulltext 返回的 internal_id，严禁编造。',
    inputSchema: z.object({
      matched_internal_ids: z.array(z.number()).max(50),
      summary: z.string(),
      query_interpretation: z.string().optional()
    }),
    execute: async (input) => {
      if (!presented) presented = extractPresentResults(input)
      onPhase?.('summarizing')
      // Placeholder output (legacy parity — the handler returned ok({})); the loop
      // stops via stopWhen before the model ever reads it.
      return {}
    }
  })

  // Defensive narrowing: whatever cfg.buildTools returns (write/send/self-mount when
  // their flags are on), only the four read tools enter the loop. The audit collector
  // is deliberately discarded — the legacy headless run persisted no chat_tool_call
  // rows either (no session, no chat-db write).
  const all = cfg.buildTools?.([], 'always', 'manual_chat') ?? {}
  const tools: ToolSet = { ...pickSearchAgentTools(all), present_results }

  let steps = 0
  try {
    const resolvedModel = await resolveModelFactory(cfg)(
      opts.model && opts.model.length > 0 ? opts.model : cfg.model
    )
    const result = await generateText({
      model: resolvedModel.model,
      messages: [{ role: 'user', content: opts.userContent }],
      tools,
      stopWhen: [stepCountIs(SEARCH_AGENT_MAX_ITER), hasToolCall('present_results')],
      abortSignal,
      onStepFinish: (step) => {
        for (const tr of step.toolResults) {
          if (tr.toolName === 'email_search_fulltext') mergeSearchHits(pool, tr.output)
        }
        if (!sawSearchPhase && step.toolCalls.some((c) => c.toolName === 'email_search_fulltext')) {
          sawSearchPhase = true
          onPhase?.('searching')
        }
      }
    })
    steps = result.steps.length
  } catch (err) {
    // User cancel (client disconnect → req close → abort): the caller can't write to a
    // closed response anyway; the code mirrors the legacy f-bis contract.
    if (abortSignal.aborted && !presented) {
      return {
        ok: false,
        hits: [],
        summary: null,
        error: { code: 'E_ABORTED', message: 'cancelled' }
      }
    }
    // Upstream/loop failure with hits already pooled → best-effort (legacy f-ter served
    // the pool even after a harness error); empty pool → normalized error code.
    if (!presented) {
      const bestEffort = assembleBestEffort(pool, opts.mailbox)
      if (bestEffort.length > 0) return { ok: true, hits: bestEffort, summary: null }
      const { code, message } = normalizeLoopError(err, cfg.providerRegistryEnabled === true)
      return { ok: false, hits: [], summary: null, error: { code, message } }
    }
  }

  // legacy G-A4 — mailbox hard filter on the FINAL hits (the prompt hint is advisory;
  // this guarantees a mailbox-scoped search never leaks cross-mailbox hits).
  const filterByMailbox = (candidates: SearchHit[]): SearchHit[] =>
    opts.mailbox ? candidates.filter((h) => h.mailbox === opts.mailbox) : candidates

  // legacy f — present_results seen: pool ∩ matched ids (ordered, anti-hallucination).
  if (presented) {
    const p: PresentResultsPayload = presented
    const validIds = p.matchedIds.filter((id) => pool.has(id))
    const hits = filterByMailbox(
      validIds.map((id) => pool.get(id)).filter((h): h is SearchHit => h !== undefined)
    )
    return { ok: true, hits, summary: p.summary }
  }

  // legacy f-ter — natural end without present_results but with pooled hits → best-effort.
  const bestEffort = assembleBestEffort(pool, opts.mailbox)
  if (bestEffort.length > 0) {
    return { ok: true, hits: bestEffort, summary: null }
  }

  // legacy g — empty-handed. Budget exhaustion keeps its legacy code; anything else is
  // "the model produced no usable output" (the renderer client then tries nlToDsl).
  const code = steps >= SEARCH_AGENT_MAX_ITER ? 'E_MAX_ITER' : 'E_NO_OUTPUT'
  return {
    ok: false,
    hits: [],
    summary: null,
    error: { code, message: 'search agent produced no results' }
  }
}

function assembleBestEffort(pool: Map<number, SearchHit>, mailbox?: string): SearchHit[] {
  const candidates = [...pool.values()]
  const filtered = mailbox ? candidates.filter((h) => h.mailbox === mailbox) : candidates
  return filtered.slice(0, SEARCH_BESTEFFORT_MAX)
}
