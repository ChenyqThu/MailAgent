// Part B (island live-refresh) — the mid-stream guard's pure logic, split from
// ThreadRunningBridge.tsx so that file only exports its component
// (react-refresh/only-export-components). The bridge senses via
// threadMessagesAwaitApproval; the panel decides via makeSessionSettledHandler.

import { getExternalStoreMessages, type ThreadMessage } from '@assistant-ui/react'

/**
 * True when a thread message's most recent semantic ORIGINAL AI SDK UIMessage is PAUSED at an
 * approval gate. react-ai-sdk may merge adjacent assistant originals into one ThreadMessage, so the
 * scan runs newest-first and skips only empty/data placeholders before matching the ai@6
 * `approval-requested` state. A message without a bound original → false, so the guard degrades to
 * bare isRunning — never weaker than the pre-fix sensor.
 */
type OriginalMessageVerdict = 'approval' | 'placeholder' | 'semantic'

function originalMessageVerdict(original: unknown): OriginalMessageVerdict {
  const parts = (original as { parts?: unknown } | null)?.parts
  if (!Array.isArray(parts)) return 'semantic'
  for (const part of parts) {
    if (part == null || typeof part !== 'object') continue
    const candidate = part as { type?: unknown; state?: unknown }
    if (
      typeof candidate.type === 'string' &&
      candidate.type.startsWith('tool-') &&
      candidate.state === 'approval-requested'
    ) {
      return 'approval'
    }
  }
  const isPlaceholder = parts.every((part) => {
    if (part == null || typeof part !== 'object') return false
    const candidate = part as { type?: unknown; text?: unknown }
    if (candidate.type === 'step-start') return true
    if (candidate.type === 'text' || candidate.type === 'reasoning') {
      return typeof candidate.text === 'string' && candidate.text.trim().length === 0
    }
    return typeof candidate.type === 'string' && candidate.type.startsWith('data-')
  })
  return isPlaceholder ? 'placeholder' : 'semantic'
}

export function threadMessageAwaitsApproval(message: ThreadMessage | undefined): boolean {
  if (message == null || message.role !== 'assistant') return false
  const originals = getExternalStoreMessages<unknown>(message)
  for (let index = originals.length - 1; index >= 0; index -= 1) {
    const verdict = originalMessageVerdict(originals[index])
    if (verdict === 'approval') return true
    if (verdict === 'placeholder') continue
    return false
  }
  return false
}

/**
 * True when an assistant message is a non-turn placeholder that may trail the real paused turn.
 * Empty assistant messages and data-only follow-up/recommendation messages carry no generated
 * content or tool work, so they must not hide an earlier approval gate. Missing external-store
 * bindings fail closed (false): without the original AI SDK parts we cannot safely distinguish a
 * placeholder from a genuinely streaming message.
 */
function threadMessageIsTrailingPlaceholder(message: ThreadMessage): boolean {
  if (message.role !== 'assistant') return false
  const originals = getExternalStoreMessages<unknown>(message)
  if (originals.length === 0) return false
  return originals.every((original) => originalMessageVerdict(original) === 'placeholder')
}

/**
 * Find the most recent semantic thread message, skipping only known empty/data placeholders. A
 * pending approval there neutralizes assistant-ui's paused-state isRunning over-report. Any user,
 * system, meaningful assistant, or unbound message stops the scan so genuine streaming remains
 * guarded.
 */
export function threadMessagesAwaitApproval(messages: readonly ThreadMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message == null) continue
    if (threadMessageAwaitsApproval(message)) return true
    if (threadMessageIsTrailingPlaceholder(message)) continue
    return false
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
