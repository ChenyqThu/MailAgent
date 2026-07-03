// P3 (task 06-18-custom-ai-harness-agent Phase 3) — General Agent session hook.
//
// S3 W2 (delete legacy harness) — like useEmailChat, this hook no longer drives
// chat turns (the embedded AI SDK Gateway owns the live stream). It remains the
// general-surface session facade shared by AgentViewLayout / AgentConversation /
// AssistantChatModal:
//
//   - anchor_type='general' session list (chat.listGeneralSessions)
//   - message history loading (reload seed + D6 read-only legacy rendering)
//   - selectSession / newSession / adoptSession / deleteSession + navEpoch
//     (the AI SDK runtime keys on navEpoch so "new chat" / "switch session"
//     remount the thread)

import { useCallback, useEffect, useRef, useState } from 'react'

import { useMailApi } from './useMailApi'
import type { ChatMessage, ChatSession } from '../api/types'
import type { ChatError } from './useEmailChat'

export interface UseGeneralChatReturn {
  messages: ChatMessage[]
  error: ChatError | null
  activeSessionId: number | null
  /** The session id `messages` currently reflect (set only after a load lands). Guards the AI SDK
   *  reload race: activeSessionId flips on select BEFORE refresh reloads, so the MailAgent view defers
   *  the runtime mount until messagesSessionId === activeSessionId. Mirror of useEmailChat. */
  messagesSessionId: number | null
  /** Monotonic thread-reset epoch — bumps on newSession / selectSession / deleteSession(active), NOT on
   *  the first-send adoptSession. The AI SDK agent view keys its runtime on this so "new chat" / "switch
   *  session" remount the thread (clearing / reloading it), while a brand-new chat getting its real id on
   *  the FIRST send does NOT remount mid-stream. */
  navEpoch: number
  /** All general sessions, newest-first (history list). */
  sessions: ChatSession[]
  clearError: () => void
  newSession: () => void
  selectSession: (sessionId: number) => Promise<void>
  /** Adopt an ai-sdk session created out-of-band (the MailAgent view's onEnsureSession) into the hook
   *  state — insert it, make it active, empty messages, point messagesSessionId at it. No IPC/refresh
   *  (the row is freshly created + empty; the gateway dual-write persists turns; a later refreshSessions
   *  reconciles). Mirror of useEmailChat.adoptSession. */
  adoptSession: (session: ChatSession) => void
  deleteSession: (sessionId: number) => void
  /** Re-pull the general sessions list (after delete / external change). */
  refreshSessions: () => Promise<void>
}

export function useGeneralChat(): UseGeneralChatReturn {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [messagesSessionId, setMessagesSessionId] = useState<number | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  // Reactive mirror of navGenerationRef for the AI SDK runtime key (see UseGeneralChatReturn.navEpoch).
  // A ref alone can't drive a React `key`; this state bumps in lock-step on every thread reset.
  const [navEpoch, setNavEpoch] = useState(0)

  const mountedRef = useRef(true)
  const activeSessionRef = useRef<number | null>(null)
  // Navigation generation — a listMessages/listGeneralSessions still in flight
  // for a session the user has left must not clobber the switched-to session.
  const navGenerationRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return (): void => {
      mountedRef.current = false
    }
  }, [])

  // Keep the active session ref in lock-step with state for async closures.
  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  const refresh = useCallback(
    async (sessionId: number): Promise<void> => {
      const gen = navGenerationRef.current
      const fresh = await mailApi.chat.listMessages(sessionId)
      if (!mountedRef.current || gen !== navGenerationRef.current) return
      setMessagesSessionId(sessionId)
      setMessages(fresh)
    },
    [mailApi]
  )

  const refreshSessions = useCallback(async (): Promise<void> => {
    const gen = navGenerationRef.current
    try {
      const fresh = await mailApi.chat.listGeneralSessions()
      if (!mountedRef.current || gen !== navGenerationRef.current) return
      setSessions(fresh)
    } catch {
      // History list is non-critical — swallow.
    }
  }, [mailApi])

  // --- initial load: general sessions list ONLY → default to a NEW empty chat -------------
  // ⌘O / ⌘J / clicking the MailAgent entry must open a FRESH chat, not resume the most recent
  // historical session. So we load the sessions list (history stays reachable via the left list /
  // title dropdown + it feeds per-session backend_kind routing) but DO NOT auto-select the latest one —
  // activeSessionId stays null (a brand-new chat). The activeSessionRef guard skips seeding the default
  // if a session was already selected out-of-band before this async settled.
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const fetched = await mailApi.chat.listGeneralSessions()
        if (cancelled || !mountedRef.current) return
        setSessions(fetched)
        if (activeSessionRef.current === null) {
          setActiveSessionId(null)
          setMessages([])
          setMessagesSessionId(null)
        }
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [mailApi])

  // --- public actions ------------------------------------------------------

  const clearError = useCallback(() => setError(null), [])

  const newSession = useCallback(() => {
    setActiveSessionId(null)
    activeSessionRef.current = null
    setMessages([])
    setMessagesSessionId(null)
    setError(null)
    navGenerationRef.current += 1
    setNavEpoch((n) => n + 1)
  }, [])

  const deleteSession = useCallback(
    (sessionId: number): void => {
      if (sessionId === activeSessionRef.current) {
        navGenerationRef.current += 1
        setNavEpoch((n) => n + 1)
        setActiveSessionId(null)
        activeSessionRef.current = null
        setMessages([])
        setMessagesSessionId(null)
        setError(null)
      }
      mailApi.chat.deleteSession(sessionId)
      setSessions((cur) => cur.filter((s) => s.id !== sessionId))
    },
    [mailApi]
  )

  // Adopt an ai-sdk session created out-of-band (the MailAgent view's onEnsureSession). No IPC/refresh
  // — the row is freshly created + empty; the gateway dual-write persists turns; messagesSessionId = id
  // makes the reload gate read "ready" without a listMessages round-trip. Mirror of useEmailChat.
  const adoptSession = useCallback((session: ChatSession): void => {
    setSessions((cur) => (cur.some((s) => s.id === session.id) ? cur : [session, ...cur]))
    setActiveSessionId(session.id)
    activeSessionRef.current = session.id
    setMessages([])
    setMessagesSessionId(session.id)
    setError(null)
  }, [])

  const selectSession = useCallback(
    async (sessionId: number): Promise<void> => {
      if (sessionId === activeSessionRef.current) return
      navGenerationRef.current += 1
      setNavEpoch((n) => n + 1)
      setError(null)
      setActiveSessionId(sessionId)
      activeSessionRef.current = sessionId
      try {
        await refresh(sessionId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    },
    [refresh]
  )

  return {
    messages,
    error,
    activeSessionId,
    messagesSessionId,
    navEpoch,
    sessions,
    clearError,
    newSession,
    selectSession,
    adoptSession,
    deleteSession,
    refreshSessions
  }
}
