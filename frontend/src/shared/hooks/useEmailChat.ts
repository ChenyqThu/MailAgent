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
}

export function useEmailChat(emailId: number | null): UseEmailChatReturn {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeSessionId, setActiveSessionIdState] = useState<number | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [lastEmailId, setLastEmailId] = useState<number | null>(emailId)

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
  }

  // Mirror activeSessionId into a ref so the email-switch cleanup can
  // read the session id that was active when the email last changed
  // (effect cleanups run BEFORE the next ref-update effect fires, so
  // the ref still holds the previous-commit value at cleanup time).
  const activeSessionRef = useRef<number | null>(null)
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
          case 'chunk':
            updated.content = updated.content + event.delta
            updated.status = 'streaming'
            break
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
        // SSoT refresh (catch tool rows + token counts in one network query).
        void refresh(envelope.sessionId)
      } else if (event.type === 'error') {
        setStreamingMessageId(null)
        setError({ code: event.code, message: event.message })
      }
    })
    return unsubscribe
  }, [mailApi, refresh])

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
      const result = await mailApi.chat.start({
        emailId,
        message: input.message,
        backendKind: input.backendKind,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: input.backendAgentPageId ?? null
      })
      setActiveSessionIdState(result.sessionId)
      activeSessionRef.current = result.sessionId
      setStreamingMessageId(result.assistantMessageId)
      await refresh(result.sessionId)
      return result
    },
    [emailId, mailApi, refresh]
  )

  const abortCurrent = useCallback(() => {
    if (activeSessionRef.current !== null) mailApi.chat.abort(activeSessionRef.current)
  }, [mailApi])

  const clearError = useCallback(() => setError(null), [])

  return {
    messages,
    streamingMessageId,
    isStreaming: streamingMessageId !== null,
    error,
    activeSessionId,
    send,
    abortCurrent,
    clearError
  }
}
