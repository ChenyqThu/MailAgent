// Sprint 19 PR-1b/PR-1d.1 — Tool dispatch loop for the agent harness.
//
// Responsibilities:
//   1. Validate each LLM-proposed tool_use against the registry.
//   2. Run silent-tier tools IN PARALLEL via Promise.all (read tools have no
//      side-effect ordering; sequential would 3-5× latency for free).
//   3. For preview/edit-tier (write) tools, invoke the caller-supplied
//      `confirm` callback first. The callback is expected to forward a
//      PendingConfirmationEvent to the renderer and await the
//      chat:confirmTool IPC reply (via awaitConfirmation). Approved tools
//      then run SERIALLY (write tools may target the same row — concurrent
//      flag flips race the SQLite outbox). Cancelled tools short-circuit
//      with status='canceled' so the LLM sees a structured "user said no"
//      rather than a hard error.
//   4. Enforce per-tool timeoutMs by AbortController-racing the handler.
//   5. Surface tool errors as structured ToolDispatchResult so the LLM sees
//      them and self-corrects rather than crashing the harness.

import type { ToolDef, ToolExecCtx, ToolRegistry } from './registry'
import type { ConfirmationOutcome } from './confirmation'

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
  /** PR-1d.1 — true when the tool was preview/edit tier and the user edited
   *  the proposed input. Lets the renderer show "(edited)" badges and gives
   *  the LLM a hint via the tool_result content envelope. */
  userEdited?: boolean
}

export interface DispatchContext {
  sessionId: number
  emailId: number | null
  /** Session-level AbortSignal. Propagated into every handler via ToolExecCtx.signal. */
  signal: AbortSignal
  /** PR-1d.1 — async hook the harness uses to bridge preview/edit-tier
   *  tools through the ConfirmToolDialog. Called once per such tool BEFORE
   *  the handler runs. The implementation MUST forward a
   *  PendingConfirmationEvent to the renderer and resolve with the user's
   *  click outcome (approved + optional editedInput). Reject on abort.
   *
   *  When undefined, preview/edit-tier tools short-circuit to
   *  `E_CONFIRMATION_NOT_WIRED` — used by legacy tests that exercise the
   *  registry without the IPC/dialog stack. */
  confirm?: (use: ToolUseRequest, def: ToolDef) => Promise<ConfirmationOutcome>
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

  // Preview/edit tier → confirmation gate + serial execution.
  for (const { use, def } of buckets.needsConfirm) {
    if (ctx.signal.aborted) {
      results.push({
        toolUseId: use.toolUseId,
        status: 'canceled',
        errorMessage: 'aborted by user',
        durationMs: 0
      })
      continue
    }
    if (!ctx.confirm) {
      results.push({
        toolUseId: use.toolUseId,
        status: 'error',
        errorMessage:
          `Tool "${def.name}" requires user confirmation (tier=${def.confirmationTier}) ` +
          `but no confirm() handler is wired into this dispatch context.`,
        durationMs: 0
      })
      continue
    }
    let outcome: ConfirmationOutcome
    try {
      outcome = await ctx.confirm(use, def)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      // Aborted while awaiting confirmation — surface as 'canceled' so the
      // LLM treats it as "user said no" rather than as a tool failure.
      const isAbort = message === 'E_ABORTED' || ctx.signal.aborted
      results.push({
        toolUseId: use.toolUseId,
        status: 'canceled',
        errorMessage: isAbort ? 'aborted by user' : message,
        durationMs: 0
      })
      continue
    }
    if (!outcome.approved) {
      results.push({
        toolUseId: use.toolUseId,
        status: 'canceled',
        errorMessage: 'user declined the tool action',
        durationMs: 0
      })
      continue
    }
    const result = await runSingleTool(use, def, ctx, outcome.editedInput)
    if (outcome.editedInput !== undefined) result.userEdited = true
    results.push(result)
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
 *  tool_result envelope uniformly.
 *
 *  `userEditedInput` is set when the user edited the LLM's proposed input
 *  via the ConfirmToolDialog. The handler reads `ctx.userEditedInput` to
 *  decide whether to use the original or edited shape. */
async function runSingleTool(
  use: ToolUseRequest,
  def: ToolDef,
  ctx: DispatchContext,
  userEditedInput?: unknown
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
    signal: combined,
    userEditedInput
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
