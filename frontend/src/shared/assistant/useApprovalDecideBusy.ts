// codex r2 [E] (task 07-15 harness-chat) — SESSION-SCOPED approval-decide busy state.
//
// An in-panel approval decide runs the server-side resume synchronously and holds THAT session's
// run lease, so the composer of that session should be disabled for the duration (a send would 409
// E_RUN_ACTIVE). The r1 wiring kept a panel-level boolean, which after a session switch kept the
// NEW session's composer disabled until the old session's HTTP resume returned — with a long-hung
// upstream that read as an infinite lock on a session the server never fenced.
//
// This hook keys the busy state by the session that initiated the decide and only reports disabled
// while that session IS the active one: switching away unlocks the current UI immediately (the
// original request settles on its own and clears its entry); switching back re-applies the fence
// (the lease really is still held there). Multiple in-flight decides (switch A→B, decide again in
// B while A resumes) are tracked as a set, and a settle only clears its own session — B's fence
// never drops when A settles.
//
// Shared by AiChatPanel and AgentConversation (their PendingApprovalPanel wiring is identical).

import { useCallback, useState } from 'react'

export interface ApprovalDecideBusyState {
  /** True only when the ACTIVE session has a decide → server-side resume in flight. */
  sendDisabled: boolean
  /** Wire to PendingApprovalPanel.onDecideBusyChange — carries the deciding card's sessionId. */
  onDecideBusyChange: (busy: boolean, sessionId: number | null) => void
}

export function useApprovalDecideBusy(activeSessionId: number | null): ApprovalDecideBusyState {
  const [busySessionIds, setBusySessionIds] = useState<ReadonlySet<number>>(() => new Set())
  const onDecideBusyChange = useCallback((busy: boolean, sessionId: number | null): void => {
    if (sessionId == null) return // a decide can only exist for a persisted session
    setBusySessionIds((cur) => {
      if (busy === cur.has(sessionId)) return cur
      const next = new Set(cur)
      if (busy) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [])
  return {
    sendDisabled: activeSessionId != null && busySessionIds.has(activeSessionId),
    onDecideBusyChange
  }
}
