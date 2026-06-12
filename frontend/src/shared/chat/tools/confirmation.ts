// Sprint 19 PR-1d.1 — Confirmation gate.
//
// When a write/edit-tier tool surfaces inside the harness loop, dispatch.ts
// suspends execution on a per-toolUseId promise registered here. The
// renderer pops a ConfirmToolDialog and replies via the `chat:confirmTool`
// IPC handler (handlers/chat.ts); that handler calls `resolveConfirmation`
// to unblock the harness. Mid-flight session abort fires
// `cancelConfirmationsForSession` so the suspended promise rejects rather
// than hanging forever.
//
// Why a module-level map (rather than threading the resolver through the
// dispatch context): the renderer ↔ main IPC roundtrip happens through a
// global ipcMain.handle, so the receiving side has no callsite context.
// Keying by `toolUseId` (UNIQUE per ai_chat_messages row) is precise enough
// to avoid collisions across concurrent sessions.

/** Final user response (or auto-cancel via abort). */
export interface ConfirmationOutcome {
  approved: boolean
  /** Set when the user edited the proposed input via the dialog. Tier=edit
   *  tools should send the edited shape; tier=preview tools never set this. */
  editedInput?: unknown
}

interface PendingConfirmation {
  sessionId: number
  resolver: (outcome: ConfirmationOutcome) => void
}

const _pending = new Map<string, PendingConfirmation>()

/** Register a wait for a specific toolUseId. The returned promise resolves
 *  when the renderer calls `chat:confirmTool` (or rejects when the session
 *  aborts, propagated through `cancelConfirmationsForSession`). */
export function awaitConfirmation(
  toolUseId: string,
  sessionId: number,
  signal: AbortSignal
): Promise<ConfirmationOutcome> {
  if (_pending.has(toolUseId)) {
    // Same toolUseId twice in one harness run = a bug in our protocol code;
    // fail loud rather than silently shadow.
    throw new Error(`awaitConfirmation: duplicate toolUseId ${toolUseId} (session=${sessionId})`)
  }
  return new Promise<ConfirmationOutcome>((resolve, reject) => {
    const onAbort = (): void => {
      if (_pending.delete(toolUseId)) {
        reject(new Error('E_ABORTED'))
      }
    }
    if (signal.aborted) {
      reject(new Error('E_ABORTED'))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    _pending.set(toolUseId, {
      sessionId,
      resolver: (outcome) => {
        signal.removeEventListener('abort', onAbort)
        resolve(outcome)
      }
    })
  })
}

/** Called from the `chat:confirmTool` IPC handler when the user clicks
 *  Confirm or Cancel in the dialog. Returns true when a pending entry was
 *  resolved (renderer can show a toast on false — late click after abort). */
export function resolveConfirmation(toolUseId: string, outcome: ConfirmationOutcome): boolean {
  const entry = _pending.get(toolUseId)
  if (!entry) return false
  _pending.delete(toolUseId)
  entry.resolver(outcome)
  return true
}

/** Best-effort cancel everything pending for a given session. Used when
 *  the dispatcher aborts a session (user switched emails, closed panel).
 *  Each cancelled entry resolves with `{approved: false}` so the harness
 *  treats it as an E_USER_CANCELED tool_result rather than throwing —
 *  smoother for the LLM to recover from. */
export function cancelConfirmationsForSession(sessionId: number): number {
  let cancelled = 0
  for (const [toolUseId, entry] of [..._pending.entries()]) {
    if (entry.sessionId === sessionId) {
      _pending.delete(toolUseId)
      entry.resolver({ approved: false })
      cancelled++
    }
  }
  return cancelled
}

/** Diagnostic — number of currently-pending confirmations. */
export function pendingConfirmationCount(): number {
  return _pending.size
}

/** Test-only — clear everything between specs. */
export function __resetConfirmations(): void {
  _pending.clear()
}
