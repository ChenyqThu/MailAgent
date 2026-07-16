// harness-chat lane B — the streamed-turn STAGE machine (truth-driven status line).
//
// Root cause it replaces (see research/lane-b-status-shimmer.md §2): the old
// `AgentWorkingIndicator` (DotMatrix + ThinkingPhrases) took ZERO stream signal — it
// rotated 14 fixed phrases on a 4s interval and stopped ONLY on unmount/reduced-motion.
// assistant-ui renders a custom `Empty` slot UNCONDITIONALLY (MessageParts.tsx
// EmptyPartsImpl / ConditionalEmpty), so error / abort / approval-paused / tool-tail all
// kept the shimmer alive — the "永动" bug. This module derives the real stage from the
// message parts + status so the status line can (a) STOP on terminal/self-narrating stages
// and (b) show a phrase that matches what is actually happening.
//
// `deriveTurnStage` is a pure function (no React) so the whole truth-table is unit-tested
// without a runtime; `useTurnStage` wires it to the assistant-ui message store + a purely
// front-end stall watchdog (no gateway heartbeat — §8.2 备选 B).

import { useEffect, useMemo, useState } from 'react'
import { useAuiState } from '@assistant-ui/react'

export type TurnStage =
  | 'idle' // no in-flight turn (complete / aborted) → render nothing
  | 'connecting' // running, no meaningful part yet (pre-first-token)
  | 'thinking' // running, last meaningful part is reasoning OR a settled tool (model generating next step)
  | 'calling-tool' // running, last meaningful part is a tool still executing → "正在调用 {tool}"
  | 'awaiting-approval' // a tool sits at an approval gate → the approval card IS the status → render nothing
  | 'writing' // running, last meaningful part is streaming text → its own caret speaks → render nothing
  | 'stalled' // running but parts stopped changing ≥ STALL_1_MS → "仍在等待响应…"
  | 'error' // stream ended with an error → static (non-shimmer) error line

/** Minimal structural shape of an assistant-ui message part needed for stage derivation.
 *  Matches the CONVERTED ThreadMessage part (react-ai-sdk convertMessage): a tool-call part
 *  carries `result` / `isError` / `approval` / `status`, NOT the wire-level ai@7 `state`. */
export interface TurnStagePart {
  readonly type: string
  readonly text?: string | undefined
  readonly toolName?: string | undefined
  readonly result?: unknown
  readonly isError?: boolean | undefined
  readonly approval?: { readonly approved?: boolean; readonly resolution?: string } | undefined
  readonly status?: { readonly type?: string } | undefined
}

/** 0 = live, 1 = stalled ≥ STALL_1_MS, 2 = stalled ≥ STALL_2_MS. */
export type StallLevel = 0 | 1 | 2

export interface TurnStageInput {
  readonly parts: readonly TurnStagePart[]
  /** The message-level status (auto-status.ts): running / requires-action / complete / incomplete. */
  readonly status: { readonly type?: string; readonly reason?: string } | undefined
  readonly stallLevel: StallLevel
}

export interface TurnStageResult {
  readonly stage: TurnStage
  readonly toolName?: string | undefined
  readonly stallLevel: StallLevel
}

/** A tool-call part paused at an (unresolved) approval gate. Awaiting = an approval object
 *  exists, no decision recorded (`approved` undefined) and no terminal resolution. */
export function partAwaitsApproval(part: TurnStagePart): boolean {
  const approval = part.approval
  return !!approval && approval.approved === undefined && !approval.resolution
}

/** A tool-call part that has reached a terminal result (output-available / -error / -denied). */
function toolPartResolved(part: TurnStagePart): boolean {
  if (part.isError === true) return true
  const statusType = part.status?.type
  if (statusType === 'incomplete' || statusType === 'complete') return true
  return part.result !== undefined && part.result !== null
}

/** Trailing placeholders carry no stage signal: step-start, empty text/reasoning, data-* parts
 *  (the same placeholder philosophy as threadRunningGuard.ts). */
function isPlaceholderPart(part: TurnStagePart): boolean {
  if (part.type === 'step-start') return true
  if (part.type === 'data' || part.type.startsWith('data-')) return true
  if (part.type === 'text' || part.type === 'reasoning') {
    return typeof part.text === 'string' && part.text.trim().length === 0
  }
  return false
}

/** The newest non-placeholder part = the current stage's anchor. */
function lastMeaningfulPart(parts: readonly TurnStagePart[]): TurnStagePart | undefined {
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part == null) continue
    if (isPlaceholderPart(part)) continue
    return part
  }
  return undefined
}

/** Pure stage derivation — parts + message status + stall level → stage. Order matters:
 *  terminal error first, then the approval gate (highest UI priority), then non-running, then
 *  the running sub-states (stall wins over the part-derived stage). */
export function deriveTurnStage(input: TurnStageInput): TurnStageResult {
  const { parts, status, stallLevel } = input
  const statusType = status?.type

  // Terminal: the stream ended. Only reason 'error' surfaces a line; cancel/length/etc. go quiet.
  if (statusType === 'incomplete') {
    return { stage: status?.reason === 'error' ? 'error' : 'idle', stallLevel }
  }

  const last = lastMeaningfulPart(parts)

  // Approval gate has the highest priority: the rich approval card IS the status, so the
  // status line must go silent next to it (this is the "shimmer beside the approval card"
  // fix). Checked via the part regardless of message status.
  if (last?.type === 'tool-call' && partAwaitsApproval(last)) {
    return { stage: 'awaiting-approval', stallLevel }
  }
  if (statusType === 'requires-action') {
    return { stage: 'awaiting-approval', stallLevel }
  }

  // Not running (complete / undefined) → nothing in flight.
  if (statusType !== 'running') {
    return { stage: 'idle', stallLevel }
  }

  // Running sub-states.
  if (stallLevel > 0) return { stage: 'stalled', stallLevel }
  if (last == null) return { stage: 'connecting', stallLevel }
  if (last.type === 'reasoning') return { stage: 'thinking', stallLevel }
  if (last.type === 'text') return { stage: 'writing', stallLevel }
  if (last.type === 'tool-call') {
    // A settled tool with the turn still running = the model is generating its next step.
    if (toolPartResolved(last)) return { stage: 'thinking', stallLevel }
    return { stage: 'calling-tool', toolName: last.toolName, stallLevel }
  }
  return { stage: 'connecting', stallLevel }
}

export const STALL_1_MS = 15_000
export const STALL_2_MS = 30_000

/** Front-end stall watchdog: escalate 0 → 1 (≥15s) → 2 (≥30s) while `active`, resetting to 0
 *  whenever `resetKey` changes referentially (the parts array gets a fresh ref on every stream
 *  delta) or `active` flips. Deliberately renderer-only — no gateway heartbeat (§8.2). */
export function useStallLevel(resetKey: unknown, active: boolean): StallLevel {
  const [level, setLevel] = useState<StallLevel>(0)
  // Adjust-on-prop-change (react.dev): the reset lives in render, not the effect (avoids
  // set-state-in-effect cascades) — a fresh parts ref (stream delta) or `active` flip zeroes the
  // escalation; the effect only arms the timers.
  const [prevKey, setPrevKey] = useState(resetKey)
  const [prevActive, setPrevActive] = useState(active)
  if (prevKey !== resetKey || prevActive !== active) {
    setPrevKey(resetKey)
    setPrevActive(active)
    if (level !== 0) setLevel(0)
  }
  useEffect(() => {
    if (!active) return
    const t1 = window.setTimeout(() => setLevel(1), STALL_1_MS)
    const t2 = window.setTimeout(() => setLevel(2), STALL_2_MS)
    return (): void => {
      window.clearTimeout(t1)
      window.clearTimeout(t2)
    }
  }, [resetKey, active])
  return level
}

/** The message-scoped hook: reads the live parts + status from the assistant-ui store, runs the
 *  stall watchdog, and returns the derived stage. Must be called inside a message scope (Empty
 *  slot / part renderer). */
export function useTurnStage(): TurnStageResult {
  const parts = useAuiState((s) => s.message.parts) as readonly TurnStagePart[]
  const status = useAuiState((s) => s.message.status) as
    | { type?: string; reason?: string }
    | undefined
  const active = status?.type === 'running'
  // The parts array ref changes on every delta → watchdog resets; a genuine stall (no delta)
  // lets the timers fire.
  const stallLevel = useStallLevel(parts, active)
  return useMemo(() => deriveTurnStage({ parts, status, stallLevel }), [parts, status, stallLevel])
}
