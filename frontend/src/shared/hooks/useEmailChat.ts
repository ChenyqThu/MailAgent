// Sprint 4 §2.1 — per-email AI chat hook (session READ facade).
//
// S3 W2 (delete legacy harness) — this hook no longer drives chat turns. The
// embedded AI SDK Gateway owns the live stream (useChatRuntime in the panel);
// what remains here is the session-state facade the ai-sdk panel consumes:
//
//   - sessions of the active (email, kind) scope + per-scope restore memory
//   - message history loading (reload seed for the AI SDK runtime + the D6
//     read-only rendering of legacy backend_kind sessions)
//   - selectSession / newSession / adoptSession / deleteSession navigation
//
// The legacy drive surface (send / editMessage / confirmTool / onStream
// subscription / live tool calls / quota cooldown / retryLast / abortCurrent /
// streaming state) was deleted with the legacy runtime — turns never flow
// through IPC chat.start anymore, so none of those races can occur. The
// navigation-generation guard stays: listMessages is still async, so a load
// resolving after the user navigated away must not clobber the new scope.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useMailApi } from './useMailApi'
import { errorMessage } from '@shared/lib/ipcErrors'
import type { ChatBackendKind, ChatMessage, ChatSession } from '../api/types'
import { toastError } from '../state/toast'
import i18n from '../i18n'

export interface ChatError {
  code: string
  message: string
}

export interface UseEmailChatReturn {
  /** Messages of the active session, oldest-first. Empty when no session yet. */
  messages: ChatMessage[]
  /** The session id `messages` reflects (set after a load lands, even for a
   *  0-row session; null when none loaded / reset). The AI SDK reload gate uses
   *  it to tell a loaded-empty session from a still-loading stale array. */
  messagesSessionId: number | null
  /** Last surfaceable load error (listSessions / listMessages). */
  error: ChatError | null
  /** Currently-displayed session id (latest by default). */
  activeSessionId: number | null
  /** Dismiss the error banner. */
  clearError: () => void
  /** "+ New conversation" — clears renderer-side session state so the panel
   *  starts a fresh thread. The ai-sdk runtime creates the actual session row
   *  lazily on the first send (onEnsureSession → adoptSession). */
  newSession: () => void
  /** Sessions for the current (email, kind) scope, updated_at DESC. */
  sessions: ChatSession[]
  /** Switch the renderer to a different session (history popover click). */
  selectSession: (sessionId: number) => Promise<void>
  /** Part B (island live-refresh) — re-load the ACTIVE session's messages from ai_chat.db.
   *  selectSession short-circuits on the same id, so this is the path for "the rows changed
   *  underneath us" (an island-approved HITL turn the gateway resumed server-side). Reuses the
   *  same refresh() the session-switch load uses; no-op when no session is active. Best-effort:
   *  a load failure surfaces via `error` like any other refresh. */
  reloadActiveSession: () => Promise<void>
  /** Fold a session the AI SDK path created out-of-band (renderer IPC,
   *  backend_kind='ai-sdk') into the hook state: prepend it to `sessions`,
   *  point `activeSessionId` + `messagesSessionId` at it, and reset messages
   *  to empty (the AI SDK runtime owns the live turns; the row persists via
   *  the gateway's dual-write once the first turn finishes). No IPC / refresh. */
  adoptSession: (session: ChatSession) => void
  /** Delete a session row (+ its messages via the chat_db FK). */
  deleteSession: (sessionId: number) => void
}

// 交付文档 §3.1 (用户清单 Bug 4) — per-scope key. The chat surface is scoped
// to BOTH the email AND the backend kind (an old custom-api history session
// re-scopes the panel onto its own kind for the D6 read-only rendering).
// `${emailId}:${backendKind}` keys the all-sessions filter, the latest-session
// pick, and the per-scope activeSessionId memory below.
function scopeKey(emailId: number | null, backendKind: ChatBackendKind): string {
  return `${emailId ?? 'null'}:${backendKind}`
}

export function useEmailChat(
  emailId: number | null,
  backendKind: ChatBackendKind
): UseEmailChatReturn {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesSessionId, setMessagesSessionId] = useState<number | null>(null)
  const [activeSessionId, setActiveSessionIdState] = useState<number | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  // Track the LAST committed scope (email + kind) so the "Adjusting state on
  // prop change" block can reset derived state synchronously when EITHER the
  // email OR the backend kind changes.
  const [lastScope, setLastScope] = useState<string>(scopeKey(emailId, backendKind))
  const [lastEmailId, setLastEmailId] = useState<number | null>(emailId)
  // `allSessions` holds the WHOLE email's sessions (every backend kind);
  // `sessions` (the public field) is the current-kind subset. Keeping the raw
  // list lets a kind switch re-filter without a redundant listSessions IPC.
  const [allSessions, setAllSessions] = useState<ChatSession[]>([])

  // Mirror the latest committed emailId/kind into refs so async continuations
  // and the activeByScope write can read the values active at call time.
  const emailIdRef = useRef(emailId)
  useEffect(() => {
    emailIdRef.current = emailId
  }, [emailId])
  const backendKindRef = useRef(backendKind)
  useEffect(() => {
    backendKindRef.current = backendKind
  }, [backendKind])

  // 交付文档 §3.1 — per-(email, kind) activeSessionId memory. When the user
  // switches scope we restore the session they last had open in the TARGET
  // scope rather than always falling back to "latest".
  const activeByScopeRef = useRef<Map<string, number | null>>(new Map())

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Navigation generation counter — a listMessages/listSessions already in
  // flight for a scope the user has left must not clobber the freshly-loaded
  // new scope. Bumped synchronously at every navigation switch point; async
  // loads snapshot it on entry and discard their setState if it moved.
  const navGenerationRef = useRef(0)

  // Set by the navigation layout effect to the activeSessionId the incoming
  // scope was last on (undefined = no memory → fall back to latest).
  const pendingScopeRestoreRef = useRef<number | null | undefined>(undefined)

  // Scope switch is prop-driven, so the bump must ride the synchronous-commit
  // useLayoutEffect path — it fires before any passive effect AND before the
  // .then continuation of an in-flight load, so a stale load necessarily reads
  // the bumped gen and is discarded.
  useLayoutEffect(() => {
    navGenerationRef.current += 1
    // Snapshot the session this scope was last on BEFORE the activeSessionId
    // sync effect (passive) can clobber it with the reset-to-null value.
    pendingScopeRestoreRef.current = activeByScopeRef.current.get(scopeKey(emailId, backendKind))
  }, [emailId, backendKind])

  // React 19 "Adjusting state on prop change" — reset derived state
  // synchronously inside render on a scope switch so the panel never shows the
  // other scope's messages for a frame.
  const currentScope = scopeKey(emailId, backendKind)
  if (lastScope !== currentScope) {
    const emailChanged = lastEmailId !== emailId
    setLastScope(currentScope)
    setLastEmailId(emailId)
    setError(null)
    setMessages([])
    setMessagesSessionId(null)
    setActiveSessionIdState(null)
    // Only an EMAIL change invalidates the whole-email list; a kind-only
    // switch re-filters the SAME cached list.
    if (emailChanged) setAllSessions([])
  }

  // Mirror activeSessionId into a ref so navigation callbacks can read the
  // latest value without widening their dep arrays.
  const activeSessionRef = useRef<number | null>(null)
  // Remember the active session for the CURRENT scope so a later switch back
  // restores this exact conversation. `null` is meaningful ("user is on a
  // blank new-session for this scope"), so we store it too.
  useEffect(() => {
    activeSessionRef.current = activeSessionId
    activeByScopeRef.current.set(
      scopeKey(emailIdRef.current, backendKindRef.current),
      activeSessionId
    )
  }, [activeSessionId])

  const refresh = useCallback(
    async (sessionId: number): Promise<void> => {
      const gen = navGenerationRef.current
      const fresh = await mailApi.chat.listMessages(sessionId)
      // Bail before ANY setState if we unmounted or navigated away mid-flight.
      if (!mountedRef.current || gen !== navGenerationRef.current) return
      setMessages(fresh)
      // `messages` now reflect `sessionId` (even when `fresh` is empty: a
      // loaded 0-row session). The AI SDK reload gate mounts the runtime only
      // once the active session's load has actually landed.
      setMessagesSessionId(sessionId)
    },
    [mailApi]
  )

  // Tracks which email `allSessions` currently holds, so a kind-only switch
  // reuses the cached rows instead of a redundant listSessions round-trip.
  const allSessionsEmailRef = useRef<number | null>(null)

  // --- scope switch (email OR kind) / initial load ----------------------
  useEffect(() => {
    if (emailId === null) {
      allSessionsEmailRef.current = null
      return undefined
    }
    let cancelled = false
    const restoreTarget = pendingScopeRestoreRef.current
    pendingScopeRestoreRef.current = undefined

    const pickTarget = (kindSessions: ChatSession[]): number | null => {
      if (typeof restoreTarget === 'number' && kindSessions.some((s) => s.id === restoreTarget)) {
        return restoreTarget
      }
      return kindSessions.length > 0 ? kindSessions[0].id : null
    }

    const applyTarget = async (kindSessions: ChatSession[]): Promise<void> => {
      const target = pickTarget(kindSessions)
      if (target === null) {
        setActiveSessionIdState(null)
        setMessages([])
        setMessagesSessionId(null)
        return
      }
      setActiveSessionIdState(target)
      await refresh(target)
    }

    void (async (): Promise<void> => {
      try {
        // Reuse the cached list iff it's for THIS email (kind-only switch);
        // otherwise fetch. allSessions is updated_at DESC from the DB query.
        const fetched =
          allSessionsEmailRef.current === emailId
            ? allSessions
            : await mailApi.chat.listSessions(emailId)
        if (cancelled) return
        if (allSessionsEmailRef.current !== emailId) {
          allSessionsEmailRef.current = emailId
          setAllSessions(fetched)
        }
        const kindSessions = fetched.filter((s) => s.backend_kind === backendKind)
        await applyTarget(kindSessions)
      } catch (err) {
        if (cancelled) return
        const message = errorMessage(err)
        setError({ code: 'E_LOAD', message })
      }
    })()
    return (): void => {
      cancelled = true
    }
    // `allSessions` is intentionally NOT a dep: it's read only on the kind-only
    // branch (where the ref already matches emailId so we read the freshest
    // committed value), and adding it would re-run the effect on every
    // setAllSessions, reloading messages spuriously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [emailId, backendKind, mailApi, refresh])

  // The PUBLIC sessions list is the current-kind subset of the whole-email
  // `allSessions` (updated_at DESC order is preserved — filter is order-stable).
  const sessions = useMemo(
    () => allSessions.filter((s) => s.backend_kind === backendKind),
    [allSessions, backendKind]
  )

  // --- public actions ---------------------------------------------------

  const clearError = useCallback(() => setError(null), [])

  // "+ New conversation" — clears renderer-side session state. The ai-sdk
  // runtime creates the actual row on the first send (onEnsureSession →
  // adoptSession), so there is no forceNew bookkeeping here anymore.
  const newSession = useCallback(() => {
    navGenerationRef.current += 1
    setActiveSessionIdState(null)
    activeSessionRef.current = null
    setMessages([])
    setMessagesSessionId(null)
    setError(null)
  }, [])

  const deleteSession = useCallback(
    (sessionId: number): void => {
      if (sessionId === activeSessionRef.current) {
        // Deleting the ACTIVE session is a navigation event — discard any
        // in-flight load and reset to the blank new-session state.
        navGenerationRef.current += 1
        setActiveSessionIdState(null)
        activeSessionRef.current = null
        setMessages([])
        setMessagesSessionId(null)
        setError(null)
      }
      setAllSessions((cur) => cur.filter((s) => s.id !== sessionId))
      // P2-4 — deleteSession is now Promise<void> (was void). On failure the optimistic
      // removal above is wrong, so re-fetch this email's sessions to restore the row and
      // surface the failure to the user (mirrors the toastError usage elsewhere in
      // components consuming this hook's errors).
      mailApi.chat.deleteSession(sessionId).catch((err) => {
        const message = errorMessage(err)
        toastError(
          i18n.t('chat.session.deleteFailed', { defaultValue: 'Delete conversation failed' }),
          message
        )
        const emailId = emailIdRef.current
        if (emailId === null) return
        mailApi.chat
          .listSessions(emailId)
          .then((fetched) => {
            if (mountedRef.current) setAllSessions(fetched)
          })
          .catch(() => undefined)
      })
    },
    [mailApi]
  )

  const selectSession = useCallback(
    async (sessionId: number): Promise<void> => {
      if (emailId === null) return
      if (sessionId === activeSessionRef.current) return
      // Switching sessions is a navigation event: bump BEFORE this callback's
      // own refresh (which captures the post-bump gen and is allowed through)
      // so a load still resolving for the session we just left can't overwrite
      // the incoming session's messages.
      navGenerationRef.current += 1
      setError(null)
      setActiveSessionIdState(sessionId)
      activeSessionRef.current = sessionId
      try {
        await refresh(sessionId)
      } catch (err) {
        const message = errorMessage(err)
        setError({ code: 'E_LOAD', message })
      }
    },
    [emailId, refresh]
  )

  // Part B (island live-refresh) — reload the ACTIVE session's rows in place. selectSession
  // short-circuits on the same id (its contract is "switch"), so the panel calls this when an
  // island-driven server-side resume changed the session's ai_chat.db rows underneath the open
  // panel ('chat:session-updated' IPC). Reuses refresh() — the exact session-switch load path
  // (nav-generation guarded, sets messagesSessionId) — so the AI SDK reload gate + mapping stay
  // single-sourced.
  const reloadActiveSession = useCallback(async (): Promise<void> => {
    const sid = activeSessionRef.current
    if (sid === null) return
    try {
      await refresh(sid)
    } catch (err) {
      const message = errorMessage(err)
      setError({ code: 'E_LOAD', message })
    }
  }, [refresh])

  // Adopt an ai-sdk session the panel created out-of-band (renderer IPC,
  // backend_kind='ai-sdk'). No IPC / refresh: the session is freshly created +
  // empty (0 rows) and the AI SDK runtime owns the live turns;
  // messagesSessionId = id makes the reload gate read "ready" without a
  // listMessages round-trip.
  const adoptSession = useCallback((session: ChatSession): void => {
    setAllSessions((cur) => (cur.some((s) => s.id === session.id) ? cur : [session, ...cur]))
    setActiveSessionIdState(session.id)
    activeSessionRef.current = session.id
    setMessages([])
    setMessagesSessionId(session.id)
    setError(null)
  }, [])

  return {
    messages,
    messagesSessionId,
    error,
    activeSessionId,
    clearError,
    newSession,
    sessions,
    selectSession,
    reloadActiveSession,
    adoptSession,
    deleteSession
  }
}
