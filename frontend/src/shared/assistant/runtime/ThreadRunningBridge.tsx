// Part B (island live-refresh) — mirror the thread's MID-STREAM state into a caller-held ref.
//
// AssistantUIChatPanel's onSessionUpdated handler lives OUTSIDE the runtime provider (useThread is
// unusable there), so this null-rendering bridge sits inside it and feeds the panel's mid-stream
// guard: a settle broadcast arriving while the renderer is MID-STREAM (e.g. the user approved
// in-app and that resume is still streaming when the island's /decide short-circuits to completed)
// must NOT remount the provider — unmount aborts the in-flight POST, the gateway's onFinish sees
// isAborted and skips persistTurn, and the turn is lost. Cleanup resets the ref so a remount gap
// never leaves a stale true.
//
// 🔴 Why not bare `useThread(t => t.isRunning)` (the original sensor, real-device regression): in
// the APPROVAL-PAUSED state (the run ended at `tool-approval-request`; the gateway already closed
// the stream — useChat.status is back to 'ready' — and persisted the redacted copy) assistant-ui's
// isRunning still reads TRUE (its derivation adds trailing unfinished-tool-call bookkeeping on top
// of the useChat status, visible on-device as a lingering loading indicator). The settle broadcast
// for an island-approved server-side resume therefore hit the `runningRef.current` early return and
// the reload/remount never ran — the guard killed its own main scenario. The correct signal is the
// AI SDK `useChat.status` ('submitted'/'streaming' only mid-flight), but that useChat instance is
// created inside @assistant-ui/react-ai-sdk's useChatRuntime and is not reachable from here.
// Equivalent derivation used instead: the thread is mid-stream ONLY when isRunning AND the last
// message is NOT paused at an approval gate — the paused state is exactly where isRunning
// over-reports, and nothing resumable is lost by a remount there (the paused turn is already
// persisted; the island stash survives in the gateway). Guard logic lives in threadRunningGuard.ts
// (this file exports only the component, per react-refresh/only-export-components).

import { useEffect } from 'react'
import { useThread } from '@assistant-ui/react'

import { threadMessageAwaitsApproval } from './threadRunningGuard'

export function ThreadRunningBridge({ runningRef }: { runningRef: { current: boolean } }): null {
  // Single boolean selector: re-renders only when the mid-stream verdict flips, not per delta.
  const isMidStream = useThread(
    (t) => t.isRunning && !threadMessageAwaitsApproval(t.messages[t.messages.length - 1])
  )
  useEffect(() => {
    runningRef.current = isMidStream
    return (): void => {
      runningRef.current = false
    }
  }, [isMidStream, runningRef])
  return null
}
