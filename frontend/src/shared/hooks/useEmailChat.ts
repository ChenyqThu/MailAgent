// Sprint 4 §2.1 — per-email AI chat hook.
//
// The React side of the chat panel. Stays out of `vercel/ai` territory
// because (1) the transport is Electron IPC, not HTTP fetch, (2) the
// surface stays small enough that hand-rolling is shorter than wiring
// a custom transport into someone else's framework, (3) DESIGN.md §6
// + DESIGN.md §9.5 (⌘↩) are specific to MailAgent and the hook needs
// to coordinate with `useShortcut` directly.
//
// State machine:
//   emailId = null         → messages=[]; nothing in flight
//   emailId = N, no session → messages=[]; activeSessionId=null
//   emailId = N, sessions[0]
//                          → messages = listMessages(sessions[0].id)
//                            activeSessionId = sessions[0].id
//                            streamingMessageId set iff last assistant
//                            is still in 'streaming' or 'pending' state
//
//   send(...)              → chat.start → optimistic refresh +
//                            streamingMessageId set + stream events
//                            patch messages in place
//   stream chunk           → buffer-append the assistant message content
//   stream done            → mark complete + full refresh (SSoT) +
//                            clear streamingMessageId
//   stream error           → mark error + populate `error` slot +
//                            clear streamingMessageId
//   stream tool_call       → schedule refresh to pick up the new role=tool row
//
//   switch emailId         → useEffect cleanup fires chat.abort(prevSession)
//   unmount                → same path; stream stays correctly cancelled

import { useCallback, useEffect, useRef, useState } from 'react'

import { useMailApi } from './useMailApi'
import type { ChatBackendKind, ChatMessage, ChatStartResult } from '../api/types'

export interface SendChatInput {
  message: string
  backendKind: ChatBackendKind
  backendModel?: string | null
  backendAgentPageId?: string | null
}

export interface ChatError {
  code: string
  message: string
}

export interface UseEmailChatReturn {
  /** Messages of the active session, oldest-first. Empty when no session yet. */
  messages: ChatMessage[]
  /** The id of the assistant message currently being streamed, or null. */
  streamingMessageId: number | null
  /** Convenience: streamingMessageId !== null. */
  isStreaming: boolean
  /** Last surfaceable error from a backend stream or a dispatch failure. */
  error: ChatError | null
  /** Currently-displayed session id (latest by default). */
  activeSessionId: number | null
  /** Append a user message + kick the backend stream. */
  send: (input: SendChatInput) => Promise<ChatStartResult>
  /** Cancel the in-flight stream on the active session. */
  abortCurrent: () => void
  /** Dismiss the error banner. */
  clearError: () => void
  /** Sprint 5 §2.3 state-machine #3 — re-fire the last failed input, if any.
   *  Surfaces a `Retry` button next to network / upstream errors. Null when
   *  there's nothing retryable (initial render, after success, etc.). */
  retryLast: (() => Promise<void>) | null
  /** Sprint 5 §2.3 state-machine #4 — epoch millis when the upstream quota
   *  cooldown lifts, or null when not throttled. AIChatPanel disables
   *  `send` until this passes; Composer footer surfaces the remaining
   *  seconds via `useTimeUntil`. */
  quotaCooldownUntil: number | null
}

// Sprint 5 §2.3 state-machine #4: quota cooldown duration. The Anthropic
// `E_QUOTA` reflects either a per-minute or per-day cap upstream; 5 minutes
// is the conservative midpoint that lets the user keep working without
// hammering CRS while we wait. Sprint 6 SettingsPage may expose an override.
const QUOTA_COOLDOWN_MS = 5 * 60 * 1000

// Sprint 6 Day 1 (opus LOW carry-forward) — persist cooldown across reloads
// so an app restart inside the 5-min window doesn't unmute the user back
// into another upstream 429. Cosmetic fix; the in-memory path was already
// correct for the common case.
const QUOTA_COOLDOWN_STORAGE_KEY = 'mailagent.chat.quotaCooldownUntil'

function readPersistedQuotaCooldown(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null
    const v = localStorage.getItem(QUOTA_COOLDOWN_STORAGE_KEY)
    if (v === null) return null
    const ts = parseInt(v, 10)
    if (!Number.isFinite(ts)) {
      localStorage.removeItem(QUOTA_COOLDOWN_STORAGE_KEY)
      return null
    }
    // Lazy GC: stale entries clean themselves up on next read.
    if (ts <= Date.now()) {
      localStorage.removeItem(QUOTA_COOLDOWN_STORAGE_KEY)
      return null
    }
    return ts
  } catch {
    // localStorage unavailable (privacy mode, SSR, etc.) — in-memory fallback
    // still works for the current session.
    return null
  }
}

export function useEmailChat(emailId: number | null): UseEmailChatReturn {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeSessionId, setActiveSessionIdState] = useState<number | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [lastEmailId, setLastEmailId] = useState<number | null>(emailId)
  /** Sprint 5 state machine #3 — captures the last input that failed so a
   *  Retry button can re-fire it. Set on every send(); cleared on success
   *  done event. */
  const [lastFailedInput, setLastFailedInput] = useState<SendChatInput | null>(null)
  /** Sprint 5 state machine #4 — epoch millis when the quota cap lifts.
   *  Set on E_QUOTA error, naturally elapses via the useEffect timer below.
   *  Sprint 6 Day 1: lazy initializer reads from localStorage so an app
   *  restart inside the 5-min cooldown still respects the throttle. */
  const [quotaCooldownUntil, setQuotaCooldownUntil] = useState<number | null>(() =>
    readPersistedQuotaCooldown()
  )

  // Mirror the latest committed emailId into a ref so `send()` can detect
  // a switch that happened while `chat.start()` was in flight. The closure
  // captures the emailId at call time; the ref reflects the latest render's
  // value. Comparing the two at resolve catches stale-send (codex High
  // carry-forward). Ref is written from an effect, never during render
  // (react-hooks/refs lint rule).
  const emailIdRef = useRef(emailId)
  useEffect(() => {
    emailIdRef.current = emailId
  }, [emailId])

  // Track whether the component is still mounted so a `chat.start()` that
  // resolves after unmount can abort the stranded session and skip the
  // setState calls (the same React warning that motivated the stale-send
  // guard would log a "setState on unmounted component" otherwise).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // React 19 "Adjusting state on prop change" (react.dev/learn/you-might-not-need-an-effect).
  // When emailId switches, reset derived state synchronously inside
  // render rather than via an effect — keeps the renderer from showing
  // a frame of stale data, and avoids the `react-hooks/set-state-in-effect`
  // lint that would fire if we did the same work in useEffect.
  if (lastEmailId !== emailId) {
    setLastEmailId(emailId)
    setError(null)
    setMessages([])
    setActiveSessionIdState(null)
    setStreamingMessageId(null)
    setLastFailedInput(null)
    // NOTE: do NOT clear quotaCooldownUntil on email switch — the
    // upstream quota is global to the CRS account; switching emails
    // doesn't lift the cap. The cooldown timer below clears it on its
    // own schedule.
  }

  // Mirror activeSessionId into a ref so the email-switch cleanup can
  // read the session id that was active when the email last changed
  // (effect cleanups run BEFORE the next ref-update effect fires, so
  // the ref still holds the previous-commit value at cleanup time).
  const activeSessionRef = useRef<number | null>(null)
  // Sprint 9 §2.3 — throttle the AIDraftStream envelope to once / 500ms.
  // streamedCharsRef tracks the cumulative chunked length; lastStreamFireRef
  // remembers the wall-clock timestamp of the last island.aiDraftStream
  // emit so the ping-island peer doesn't get an envelope per token.
  const streamedCharsRef = useRef(0)
  const lastStreamFireRef = useRef(0)
  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  const refresh = useCallback(
    async (sessionId: number): Promise<void> => {
      const fresh = await mailApi.chat.listMessages(sessionId)
      setMessages(fresh)
      // If the freshest assistant message is still pending/streaming,
      // mark it as the streaming target — protects against a stream
      // event that arrived before `refresh()` resolved.
      const liveAssistant = [...fresh]
        .reverse()
        .find((m) => m.role === 'assistant' && (m.status === 'streaming' || m.status === 'pending'))
      setStreamingMessageId(liveAssistant ? liveAssistant.id : null)
    },
    [mailApi]
  )

  // --- 1) email switch / initial load --------------------------------------
  // Derived-state resets live in the "Adjusting on prop change" block
  // above; this effect only owns the async load side-effect.
  useEffect(() => {
    if (emailId === null) return undefined
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const sessions = await mailApi.chat.listSessions(emailId)
        if (cancelled) return
        if (sessions.length === 0) {
          setActiveSessionIdState(null)
          setMessages([])
          setStreamingMessageId(null)
          return
        }
        const latest = sessions[0]
        setActiveSessionIdState(latest.id)
        await refresh(latest.id)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [emailId, mailApi, refresh])

  // --- 2) stream subscription ----------------------------------------------
  useEffect(() => {
    const unsubscribe = mailApi.chat.onStream((envelope) => {
      const currentSession = activeSessionRef.current
      if (currentSession === null || envelope.sessionId !== currentSession) return
      const { messageId, event } = envelope

      // tool_call rows are appended in the main process — refetch
      // rather than maintain a parallel reducer for the side-effect
      // shape. The full message list stays the source of truth.
      if (event.type === 'tool_call') {
        void refresh(envelope.sessionId)
        return
      }

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) {
          // Streamed event arrived before our optimistic refresh —
          // schedule a refetch and let the next tick render.
          void refresh(envelope.sessionId)
          return prev
        }
        const next = [...prev]
        const updated: ChatMessage = { ...next[idx] }
        switch (event.type) {
          case 'chunk': {
            updated.content = updated.content + event.delta
            updated.status = 'streaming'
            // Sprint 9 §2.3 — throttled AIDraftStream envelope. Cumulative
            // char count is the simplest progress signal ping-island can
            // render in the Phase 1 pill (`…2.4k chars`) without us having
            // to thread a percent estimate through every backend.
            streamedCharsRef.current = updated.content.length
            const streamEmailId = emailIdRef.current
            if (streamEmailId !== null && Date.now() - lastStreamFireRef.current >= 500) {
              lastStreamFireRef.current = Date.now()
              mailApi.island.aiDraftStream({
                emailId: streamEmailId,
                streamedChars: streamedCharsRef.current
              })
            }
            break
          }
          case 'usage':
            updated.tokens_input = event.inputTokens
            updated.tokens_output = event.outputTokens
            updated.cost_usd = event.costUsd
            if (event.model !== null) updated.model = event.model
            break
          case 'done':
            updated.status = 'complete'
            if (event.finalContent && event.finalContent.length > 0) {
              updated.content = event.finalContent
            }
            if (event.model !== null) updated.model = event.model
            break
          case 'error':
            updated.status = 'error'
            updated.error_message = event.message
            break
        }
        next[idx] = updated
        return next
      })

      if (event.type === 'done') {
        setStreamingMessageId(null)
        // Sprint 5 #3 — clear the retry buffer once the turn finished cleanly.
        setLastFailedInput(null)
        // SSoT refresh (catch tool rows + token counts in one network query).
        void refresh(envelope.sessionId)
        // Sprint 9 §2.3 — AIDraftReady envelope. Preview is the first 240
        // chars of the final assistant message so the island can render a
        // glanceable summary before the user switches back to MailAgent.
        const readyEmailId = emailIdRef.current
        if (readyEmailId !== null) {
          const preview = (event.finalContent || '').slice(0, 240)
          mailApi.island.aiDraftReady({
            emailId: readyEmailId,
            senderName: null,
            subject: null,
            preview
          })
        }
      } else if (event.type === 'error') {
        setStreamingMessageId(null)
        setError({ code: event.code, message: event.message })
        // Sprint 5 state machine #4 — engage cooldown on quota cap.
        if (event.code === 'E_QUOTA') {
          setQuotaCooldownUntil(Date.now() + QUOTA_COOLDOWN_MS)
        }
      }
    })
    return unsubscribe
  }, [mailApi, refresh])

  // --- 2.5) quota cooldown self-clear timer --------------------------------
  // Single timer that wakes when the cooldown lifts; safe to schedule
  // because cooldown values are monotonically increasing and we only
  // store one at a time. We always go through setTimeout (even when the
  // delay is 0) so the state update lands on a fresh tick — calling
  // setState directly in the effect body trips `react-hooks/set-state-in-effect`.
  useEffect(() => {
    if (quotaCooldownUntil === null) return undefined
    const remaining = Math.max(0, quotaCooldownUntil - Date.now())
    const t = setTimeout(() => setQuotaCooldownUntil(null), remaining)
    return (): void => clearTimeout(t)
  }, [quotaCooldownUntil])

  // --- 2.6) quota cooldown localStorage sync (Sprint 6 Day 1) ---------------
  // Mirror the in-memory value into localStorage so a reload inside the
  // window restores the throttle. Read happens via the useState lazy
  // initializer above; this effect handles every subsequent update.
  //
  // Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — skip the first
  // mount. The lazy initializer already read from localStorage, so the
  // mount-time effect would just write back the same value (one redundant
  // `setItem` per hook lifetime). Trivial cost individually, but the panel
  // remounts on every email switch, so this is a per-click win.
  const firstCooldownEffectRef = useRef(true)
  useEffect(() => {
    if (firstCooldownEffectRef.current) {
      firstCooldownEffectRef.current = false
      return
    }
    try {
      if (typeof localStorage === 'undefined') return
      if (quotaCooldownUntil === null) {
        localStorage.removeItem(QUOTA_COOLDOWN_STORAGE_KEY)
      } else {
        localStorage.setItem(QUOTA_COOLDOWN_STORAGE_KEY, String(quotaCooldownUntil))
      }
    } catch {
      // localStorage unavailable — cooldown still works in-memory.
    }
  }, [quotaCooldownUntil])

  // --- 3) abort on email switch / unmount ----------------------------------
  // `activeSessionRef.current` may still be null at effect-run time (the
  // session id arrives from the async `listSessions` promise) — reading
  // the ref inside the cleanup closure gets the latest value at the
  // moment the email actually switches or the panel unmounts.
  useEffect(() => {
    return (): void => {
      const sid = activeSessionRef.current
      if (sid !== null) mailApi.chat.abort(sid)
    }
  }, [emailId, mailApi])

  // --- 4) public actions ---------------------------------------------------
  const send = useCallback(
    async (input: SendChatInput): Promise<ChatStartResult> => {
      if (emailId === null) {
        throw new Error('useEmailChat.send: no active email (emailId is null)')
      }
      setError(null)
      // Snapshot the email this turn targets BEFORE awaiting. If the user
      // switches emails (or the hook unmounts) while `chat.start()` is in
      // flight, the snapshot diverges from `emailIdRef.current` and we
      // know to abort the stranded session instead of touching state for
      // the wrong email (codex High carry-forward).
      const myEmail = emailId
      const result = await mailApi.chat.start({
        emailId,
        message: input.message,
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null
      })
      if (!mountedRef.current || emailIdRef.current !== myEmail) {
        // Email moved on (or hook unmounted) before the dispatcher returned.
        // Abort the stranded session and skip the state mutations — the
        // current email's panel must not flip to streaming on a sessionId
        // it didn't subscribe to.
        mailApi.chat.abort(result.sessionId)
        // Sprint 7 Day 1 (Sprint 6 review opus LOW carry-forward) — we no
        // longer set `lastFailedInput` BEFORE the stranded check (the
        // earlier Sprint 5 ordering had a tiny race window where a stranded
        // send would leave the closure-captured input visible to retryLast,
        // even though `error !== null` gating made it unreachable in
        // practice). After move + post-check return, lastFailedInput stays
        // at its prior value — null on first send, or the previous send's
        // input which is still the right thing to retry.
        return result
      }
      // Capture the input AFTER the stranded check so it only persists
      // when this send is committed to the active email. Cleared once we
      // observe a `done` event on the stream subscription (success) or
      // promoted to retry on a transient error.
      setLastFailedInput(input)
      setActiveSessionIdState(result.sessionId)
      activeSessionRef.current = result.sessionId
      setStreamingMessageId(result.assistantMessageId)
      // Sprint 9 §2.3 — fire AIDraftStart envelope. Reset throttle counters
      // before the first stream chunk arrives; the main side fails open if
      // ping-island isn't running.
      streamedCharsRef.current = 0
      lastStreamFireRef.current = 0
      mailApi.island.aiDraftStart({
        emailId: myEmail,
        senderName: null,
        subject: null,
        prompt: input.message
      })
      await refresh(result.sessionId)
      return result
    },
    [emailId, mailApi, refresh]
  )

  const abortCurrent = useCallback(() => {
    const sid = activeSessionRef.current
    if (sid === null) return
    mailApi.chat.abort(sid)
    // Sprint 4 review (codex M carry-forward): the IPC abort doesn't push a
    // `chat:stream` event back, so without a local update the panel would
    // stay in `isStreaming = true` until the next event lands (or never,
    // if the backend died). Clear the streaming id immediately and pull
    // the canonical `aborted` row off the SSoT so the UI reflects state.
    setStreamingMessageId(null)
    void refresh(sid)
  }, [mailApi, refresh])

  const clearError = useCallback(() => setError(null), [])

  // Sprint 5 #3 — Retry CTA. Only available when:
  //   1. we have a captured failed input (set in send())
  //   2. the error is "retriable" (network / upstream / agent timeout)
  // Other errors (E_NO_LLM_KEY / E_INVALID_ARG / E_MODEL_UNSUPPORTED) are
  // user-config issues that a blind retry won't fix — surfacing the button
  // there would mislead.
  const isRetriableError = error !== null && RETRIABLE_ERROR_CODES.has(error.code)
  const retryLast =
    isRetriableError && lastFailedInput !== null
      ? async (): Promise<void> => {
          try {
            await send(lastFailedInput)
          } catch {
            // send() captures errors via setError; nothing extra here.
          }
        }
      : null

  return {
    messages,
    streamingMessageId,
    isStreaming: streamingMessageId !== null,
    error,
    activeSessionId,
    send,
    abortCurrent,
    clearError,
    retryLast,
    quotaCooldownUntil
  }
}

// Sprint 5 #3 — retry surface only on transient upstream issues. The list
// matches the dispatcher's surfaceable network / upstream codes from
// custom_api + notion_agent backends. E_ABORTED is intentionally absent —
// aborts are user-initiated and shouldn't auto-re-fire.
//
// Sprint 6 Day 1 (opus LOW carry-forward) — broaden the set:
//   - E_NOTION_AGENT_FAIL: notion-agent CLI exited non-zero on a mid-stream
//     transient (Notion API rate, network blip). The dispatcher passes this
//     through unwrapped; retry usually succeeds on the next attempt.
//   - overloaded_error / rate_limit_error / api_error: raw Anthropic
//     mid-stream `error.type` strings that the custom_api backend can emit
//     verbatim when the upstream sends an SSE `error` chunk instead of a
//     graceful end. "Claude is overloaded" is the headline case — retry
//     typically clears within 30s.
const RETRIABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'E_NETWORK',
  'E_UPSTREAM',
  'E_NOTION_AGENT_NETWORK',
  'E_NOTION_AGENT_TIMEOUT',
  'E_NOTION_AGENT_FAIL',
  'E_BACKEND_CRASH',
  'overloaded_error',
  'rate_limit_error',
  'api_error'
])
