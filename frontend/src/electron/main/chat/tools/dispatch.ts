// Sprint 19 PR-1b — Tool dispatch loop for the agent harness.
//
// Responsibilities:
//   1. Validate each LLM-proposed tool_use against the registry.
//   2. Run silent-tier tools IN PARALLEL via Promise.all (read tools have no
//      side-effect ordering; sequential would 3-5× latency for free).
//   3. Run preview/edit-tier tools SERIALLY (write tools may target the same
//      row — concurrent flag flips race the SQLite outbox).
//   4. Enforce per-tool timeoutMs by AbortController-racing the handler.
//   5. Surface tool errors as structured ToolDispatchResult so the LLM sees
//      them and self-corrects rather than crashing the harness.
//
// PR-1b scope: silent-tier only (the seven read tools). The preview/edit
// confirmation flow (ConfirmToolDialog round-trip via chat:confirmTool IPC)
// lands in PR-1d. For now, any preview/edit-tier tool short-circuits to an
// E_CONFIRMATION_NOT_WIRED error so we don't accidentally write data before
// the dialog plumbing is in place.

import type { ToolDef, ToolExecCtx, ToolRegistry } from './registry'

/** What the harness collects from a backend stream's tool_use events
 *  (one per Anthropic content_block with type='tool_use'). */
export interface ToolUseRequest {
  toolUseId: string
  name: string
  input: unknown
}

/** Per-tool dispatch outcome. The harness folds these back into the next
 *  iteration's history as Anthropic-shaped `tool_result` content blocks. */
export interface ToolDispatchResult {
  toolUseId: string
  status: 'ok' | 'error' | 'canceled'
  /** Set on `status='ok'`. Tool-specific shape (see each ToolDef.outputSchema). */
  output?: unknown
  errorMessage?: string
  durationMs: number
}

export interface DispatchContext {
  sessionId: number
  emailId: number | null
  /** Session-level AbortSignal. Propagated into every handler via ToolExecCtx.signal. */
  signal: AbortSignal
}

/** Dispatch a batch of LLM-proposed tool_use calls. Silent reads parallel,
 *  writes serial (post-confirmation). Returns one result per use (order may
 *  differ from input — caller indexes by toolUseId). */
export async function dispatchTools(
  uses: ToolUseRequest[],
  ctx: DispatchContext,
  registry: ToolRegistry
): Promise<ToolDispatchResult[]> {
  const buckets = partitionByTier(uses, registry)
  const results: ToolDispatchResult[] = []

  // Unknown tool names → immediate error (LLM hallucinated). Don't waste
  // dispatch slots running them.
  for (const use of buckets.unknown) {
    results.push({
      toolUseId: use.toolUseId,
      status: 'error',
      errorMessage:
        `Unknown tool "${use.name}". Available tools: ${registry.names().join(', ')}.`,
      durationMs: 0
    })
  }

  // Silent tier → parallel.
  if (buckets.silent.length > 0) {
    const silentResults = await Promise.all(
      buckets.silent.map(({ use, def }) => runSingleTool(use, def, ctx))
    )
    results.push(...silentResults)
  }

  // PR-1b stub: preview/edit short-circuit. PR-1d replaces this with the
  // actual confirmation dialog round-trip via chat:confirmTool IPC.
  for (const { use, def } of buckets.needsConfirm) {
    results.push({
      toolUseId: use.toolUseId,
      status: 'error',
      errorMessage:
        `Tool "${def.name}" requires user confirmation (tier=${def.confirmationTier}). ` +
        `Confirmation UI lands in PR-1d; tool is registered but not yet executable.`,
      durationMs: 0
    })
  }

  return results
}

interface Buckets {
  silent: Array<{ use: ToolUseRequest; def: ToolDef }>
  needsConfirm: Array<{ use: ToolUseRequest; def: ToolDef }>
  unknown: ToolUseRequest[]
}

function partitionByTier(uses: ToolUseRequest[], registry: ToolRegistry): Buckets {
  const out: Buckets = { silent: [], needsConfirm: [], unknown: [] }
  for (const use of uses) {
    const def = registry.get(use.name)
    if (!def) {
      out.unknown.push(use)
      continue
    }
    if (def.confirmationTier === 'silent') {
      out.silent.push({ use, def })
    } else {
      out.needsConfirm.push({ use, def })
    }
  }
  return out
}

/** Run one tool with timeout + signal propagation. NEVER throws — returns
 *  a structured error so the dispatch caller can pack the LLM-visible
 *  tool_result envelope uniformly. */
async function runSingleTool(
  use: ToolUseRequest,
  def: ToolDef,
  ctx: DispatchContext
): Promise<ToolDispatchResult> {
  const start = Date.now()

  // Compose timeout-able signal. AbortSignal.any is Node 20.3+ but Electron's
  // bundled Node may lag — implement it by hand to avoid version coupling.
  const timeoutMs = def.timeoutMs ?? 10000
  const timeoutCtrl = new AbortController()
  const timer = setTimeout(() => timeoutCtrl.abort('E_TIMEOUT'), timeoutMs)
  const combined = combineSignals([ctx.signal, timeoutCtrl.signal])

  const handlerCtx: ToolExecCtx = {
    sessionId: ctx.sessionId,
    emailId: ctx.emailId,
    signal: combined
  }

  try {
    const result = await def.handler(use.input, handlerCtx)
    clearTimeout(timer)
    const durationMs = Date.now() - start

    if (result.ok) {
      return {
        toolUseId: use.toolUseId,
        status: 'ok',
        output: result.output,
        durationMs
      }
    }
    return {
      toolUseId: use.toolUseId,
      status: 'error',
      errorMessage: `${result.code}: ${result.message}`,
      durationMs
    }
  } catch (err) {
    clearTimeout(timer)
    const durationMs = Date.now() - start
    if (ctx.signal.aborted) {
      return {
        toolUseId: use.toolUseId,
        status: 'canceled',
        errorMessage: 'aborted by user',
        durationMs
      }
    }
    if (timeoutCtrl.signal.aborted) {
      return {
        toolUseId: use.toolUseId,
        status: 'error',
        errorMessage: `E_TIMEOUT: tool "${def.name}" exceeded ${timeoutMs}ms`,
        durationMs
      }
    }
    return {
      toolUseId: use.toolUseId,
      status: 'error',
      errorMessage: `E_INTERNAL: ${err instanceof Error ? err.message : String(err)}`,
      durationMs
    }
  }
}

/** Hand-rolled AbortSignal.any equivalent. Returns a signal that aborts as
 *  soon as ANY input signal aborts (or immediately if any is already aborted). */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController()
  for (const sig of signals) {
    if (sig.aborted) {
      ctrl.abort(sig.reason)
      return ctrl.signal
    }
    sig.addEventListener('abort', () => ctrl.abort(sig.reason), { once: true })
  }
  return ctrl.signal
}
