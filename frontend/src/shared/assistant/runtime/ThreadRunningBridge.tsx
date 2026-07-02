// Part B (island live-refresh) — mirror the assistant-ui thread's isRunning into a caller-held ref.
//
// AssistantUIChatPanel's onSessionUpdated handler lives OUTSIDE the runtime provider (useThread is
// unusable there), so this null-rendering bridge sits inside it and feeds the panel's mid-stream
// guard: a settle broadcast arriving while the renderer is MID-STREAM (e.g. the user approved
// in-app and that resume is still streaming when the island's /decide short-circuits to completed)
// must NOT remount the provider — unmount aborts the in-flight POST, the gateway's onFinish sees
// isAborted and skips persistTurn, and the turn is lost. Cleanup resets the ref so a remount gap
// never leaves a stale true.

import { useEffect } from 'react'
import { useThread } from '@assistant-ui/react'

export function ThreadRunningBridge({ runningRef }: { runningRef: { current: boolean } }): null {
  const isRunning = useThread((t) => t.isRunning)
  useEffect(() => {
    runningRef.current = isRunning
    return (): void => {
      runningRef.current = false
    }
  }, [isRunning, runningRef])
  return null
}
