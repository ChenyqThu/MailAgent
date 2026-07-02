// Part B (island live-refresh) — the mid-stream guard's pure logic, split from
// ThreadRunningBridge.tsx so that file only exports its component
// (react-refresh/only-export-components). The bridge senses via
// threadMessageAwaitsApproval; the panel decides via makeSessionSettledHandler.

import { getExternalStoreMessages, type ThreadMessage } from '@assistant-ui/react'

/**
 * True when a thread message is PAUSED at an approval gate: one of its ORIGINAL AI SDK UIMessages
 * (bound onto the ThreadMessage by the react-ai-sdk converter; retrieved via
 * getExternalStoreMessages) carries a tool part still in the ai@6 `approval-requested` state. Same
 * structural narrowing as the gateway's responseMessageAwaitsApproval (chatRun.ts), applied on the
 * renderer side. A message without a bound original (legacy adapter, optimistic placeholder) → []
 * → false, so the guard degrades to bare isRunning — never weaker than the pre-fix sensor.
 */
export function threadMessageAwaitsApproval(message: ThreadMessage | undefined): boolean {
  if (message == null || message.role !== 'assistant') return false
  for (const original of getExternalStoreMessages<unknown>(message)) {
    const parts = (original as { parts?: unknown } | null)?.parts
    if (!Array.isArray(parts)) continue
    for (const part of parts) {
      if (part == null || typeof part !== 'object') continue
      const p = part as { type?: unknown; state?: unknown }
      if (
        typeof p.type === 'string' &&
        p.type.startsWith('tool-') &&
        p.state === 'approval-requested'
      ) {
        return true
      }
    }
  }
  return false
}

/**
 * Build the panel's 'chat:session-updated' listener (island settle → live refresh). Extracted so
 * the guard DECISION is one testable unit shared by the panel and the regression tests: skip when
 * the settle is for another session; skip when the thread is genuinely mid-stream (runningRef, fed
 * by ThreadRunningBridge); otherwise reload the session rows and signal the caller to remount
 * (nonce bump) so the runtime re-seeds from the reloaded messages.
 */
export function makeSessionSettledHandler(opts: {
  runningRef: { current: boolean }
  activeSessionId: number | null
  reload: () => Promise<void>
  onReloaded: () => void
}): (payload: { sessionId: number }) => void {
  return (payload) => {
    if (payload.sessionId !== opts.activeSessionId) return
    // Mid-stream guard — the renderer's own run is streaming (typical: the user approved in-app
    // and the island click short-circuited /decide to completed). Remounting now would abort that
    // in-flight POST → gateway onFinish isAborted → persistTurn skipped → the turn is LOST. The
    // renderer stream finishes + persists on its own; this refresh would be redundant anyway.
    if (opts.runningRef.current) return
    void opts.reload().then(opts.onReloaded)
  }
}
