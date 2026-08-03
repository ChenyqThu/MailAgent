// 阶段 0.5-① 「工具执行过程可见」 — a tool-call part's PHASE, single-sourced.
//
// Before this module three places independently re-derived "跑没跑完" from the converted part
// (toolGroupSummary.toolPartState / useTurnStage.toolPartResolved / ToolTraceCard's inline
// `running` boolean). They agreed by accident, not by construction. This is the one judge; the
// three callers now project from it (`isToolPhaseSettled` / `deriveToolPhase`).
//
// 🔴 Zero-dependency leaf ON PURPOSE: both `runtime/useTurnStage.ts` and `tools/generic/*` import
// it, so it must not pull React, i18n or either of them back (a cycle here would break the
// ToolGroup red lines in a way no unit test would show).
//
// Wire → props background (react-ai-sdk convertMessage): the ai@7 part `state`
// (input-streaming / input-available / output-available / -error / -denied) is NOT forwarded to
// the card. What we get is { args, argsText, result, isError, approval, status }, and the part
// `status` is the MESSAGE status (core message-runtime.toMessagePartStatus: a tool part with no
// result inherits message.status), so it cannot separate "参数还在流" from "已开始执行" either.
// The one signal that can: convertMessage runs `argsText.replace(/[}\]"]+$/, '')` ONLY while the
// part is `input-streaming`, so a live part's argsText is a TRUNCATED (unparseable) JSON prefix
// while it streams, and a complete `JSON.stringify(args)` from input-available onward.

/** The five display phases of a tool call. `streaming-args` = the model is still emitting the
 *  arguments; `executing` = arguments final, the tool is running; `awaiting` = paused at an
 *  approval gate; `done` / `error` are terminal. */
export type ToolPhase = 'streaming-args' | 'executing' | 'awaiting' | 'done' | 'error'

/** Structural minimum of a converted tool-call part. Deliberately loose (all optional, all
 *  widened) so BOTH shapes flow in unchanged: assistant-ui's `ToolCallMessagePartProps` and the
 *  `TurnStagePart` the stage machine reads off the message store. */
export interface ToolPhaseInput {
  readonly argsText?: string | undefined
  readonly result?: unknown
  readonly isError?: boolean | undefined
  readonly approval?:
    | { readonly approved?: boolean | undefined; readonly resolution?: string | undefined }
    | undefined
  readonly status?: { readonly type?: string | undefined } | undefined
}

/** A tool-call part paused at an (unresolved) approval gate. Awaiting = an approval object
 *  exists, no decision recorded (`approved` undefined) and no terminal resolution. */
export function partAwaitsApproval(part: ToolPhaseInput): boolean {
  const approval = part.approval
  return !!approval && approval.approved === undefined && !approval.resolution
}

/** True while the model is still streaming this call's arguments — see the module header for why
 *  a failed `JSON.parse` of `argsText` is the discriminator. No argsText (the stage machine's
 *  part shape, or a reloaded history part) → false: never claim "streaming" without evidence. */
function argsStillStreaming(argsText: string | undefined): boolean {
  if (typeof argsText !== 'string') return false
  const text = argsText.trim()
  if (text.length === 0) return false
  try {
    JSON.parse(text)
    return false
  } catch {
    return true
  }
}

/** parts → phase. The first four branches are the pre-existing `toolPartState` judgement VERBATIM
 *  (approval > error > result > complete): the ToolGroup red line ② (a group holding an approval
 *  or an errored tool can never fold it away) rides on those four, and `toolPhase.test.ts` pins
 *  the equivalence. Only the former catch-all `'running'` is split into two. */
export function deriveToolPhase(part: ToolPhaseInput): ToolPhase {
  if (partAwaitsApproval(part)) return 'awaiting'
  if (part.isError === true || part.status?.type === 'incomplete') return 'error'
  if (part.result !== undefined && part.result !== null) return 'done'
  if (part.status?.type === 'complete') return 'done'
  return argsStillStreaming(part.argsText) ? 'streaming-args' : 'executing'
}

/** Terminal phases. A part that never streamed through this client (history replay: only a
 *  result) lands here too — that is what keeps the replayed transcript free of live affordances. */
export function isToolPhaseSettled(phase: ToolPhase): boolean {
  return phase === 'done' || phase === 'error'
}

/** The user (or the host) refused this call rather than the tool failing: an `output-denied` part
 *  carries `approval.approved === false`, a cancelled/expired gate carries a `resolution`. Kept
 *  ORTHOGONAL to `deriveToolPhase` on purpose — folding it into the phase would move parts across
 *  the `hasError` boundary that red line ② is defined on. */
export function isToolDenied(part: ToolPhaseInput): boolean {
  const approval = part.approval
  if (!approval) return false
  return approval.approved === false || approval.resolution != null
}
