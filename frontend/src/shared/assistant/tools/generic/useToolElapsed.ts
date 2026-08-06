// 阶段 0.5-① G3 — per-tool wall-clock, measured in the RENDERER.
//
// 🔴 Why not the runtime's own timing: assistant-ui exposes `part.timing` / `useToolCallElapsed`,
// but our gateway only attaches `messageMetadata` at the 'finish' step (ai-gateway/server.ts), so
// a tool part NEVER carries timing here — `useToolCallElapsed` returns undefined for every call.
// It is a false affordance; this hook is the real one. (Sending per-tool timing on the wire would
// mean touching messageMetadata = a gateway change = the agent_eval gate. Out of scope by design.)
//
// Contract, in order of importance:
//   1. NO START, NO NUMBER. A part first seen already settled (history replay / a reopened
//      session) never gets a start stamp and returns null forever — never a fabricated "0.0s".
//   2. The value FREEZES on settle: the live effect's CLEANUP takes the final reading, so even a
//      tool that finished between two ticks reports its real duration.
//   3. `prefers-reduced-motion` drops the ticking interval entirely — no live number while the
//      tool runs (a frozen "0.0s" would be a lie), and the exact total still lands on settle.
//
// The wall clock is read ONLY inside effects / timer callbacks, never during render (react-hooks
// treats `Date.now()` in a render body as an impure call, and it is).

import { useEffect, useRef, useState } from 'react'

import { useReducedMotion } from '@shared/hooks/useReducedMotion'

/** Re-render cadence while a tool runs.
 *
 *  08-06 owner dogfood ⑤: 200ms → 100ms. At 200ms the tenths digit advanced in steps of two
 *  (0.2 → 0.4 → 0.6), which is exactly the "跳不连贯" the owner reported; 100ms is the smallest
 *  cadence that still maps 1:1 onto the displayed precision (one decimal = 100ms), so every tick
 *  changes the reading by exactly one unit and no tick is wasted.
 *
 *  🔴 Doubling the cadence doubles how often every consumer re-renders, so the ticking hook is now
 *  isolated in leaf components (`ToolTraceCard`'s `ToolElapsedLabel`): the card's no-dependency
 *  scroll-follow layout effect must not be re-run by the clock. See ToolTraceCard's note on
 *  `stickToBottomRef` for why that effect is dangerous when re-run. */
const TICK_MS = 100

/** Elapsed ms → a compact, monospace-friendly label. Sub-minute keeps one decimal (a tool call is
 *  usually 0.3–20s, where the tenths digit is the信息); past a minute the decimal is noise. */
export function formatToolDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
}

/**
 * Elapsed milliseconds for one tool call, or `null` when there is no measurable start.
 *
 * @param live `true` while the call is unsettled (phase !== done/error). Flipping it to `false`
 *             runs the effect cleanup, which takes the final reading and freezes it.
 */
export function useToolElapsed(live: boolean): number | null {
  const reduce = useReducedMotion()
  const [elapsed, setElapsed] = useState<number | null>(null)
  // The start stamp is touched only inside the effect + its cleanup (never read during render),
  // and survives a reduced-motion flip mid-run so the reading stays continuous.
  const startedAtRef = useRef<number | null>(null)

  useEffect(() => {
    // Settled (including "settled before this card ever mounted") → no clock, no cleanup. The
    // frozen value, if any, was written by the previous run's cleanup.
    if (!live) return
    const start = startedAtRef.current ?? Date.now()
    startedAtRef.current = start
    const id = reduce ? null : window.setInterval(() => setElapsed(Date.now() - start), TICK_MS)
    return (): void => {
      if (id !== null) window.clearInterval(id)
      // Final reading on settle/unmount — deliberately in the CLEANUP, so a tool that finished
      // between two ticks (or before the first one) still reports its true duration.
      setElapsed(Date.now() - start)
    }
  }, [live, reduce])

  return elapsed
}
