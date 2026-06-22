// P3 (task 06-18-custom-ai-harness-agent Phase 3) — General Agent chat hook.
//
// The React side of the Cmd+O General Agent dialog. Deliberately SEPARATE from
// useEmailChat: that hook is a 1500-line minefield of per-(email,kind) scope
// memory + island envelopes + race guards tuned for the email surface, and the
// #1 P3 hard constraint is "邮件态 Custom AI 零回归" — so we do NOT touch it.
// This hook reuses the same ChatApi (mailApi.chat) but for the general anchor:
//
//   - anchor_type='general' (emailId always null — never a 0 sentinel)
//   - backend fixed to 'custom-api' (notion-agent is retired as a NEW-session
//     backend for the general surface; old notion-agent sessions stay readable)
//   - sessions via chat.listGeneralSessions() (never an email's sidebar)
//   - no island AIDraft envelopes (general is not an email-draft flow)
//
// The streaming / done-finalize / navigation race guards mirror useEmailChat's
// proven shape (terminalIdsRef + navGenerationRef) so a late refresh can't
// resurrect a cleared spinner or clobber a switched session.

import { useCallback, useEffect, useRef, useState } from 'react'

import { useMailApi } from './useMailApi'
import { applySkillMentions, useSkillActivation } from '../state/skill-activation'
import type { ChatMessage, ChatSession, ChatStartResult } from '../api/types'
import type { ChatError, EditChatInput, LiveToolCall, PendingConfirmation } from './useEmailChat'

// General agent is custom-api only (notion-agent retired for new sessions).
const GENERAL_BACKEND = 'custom-api' as const

export interface SendGeneralInput {
  message: string
  backendModel?: string | null
  /** task 06-08-chat 需求 5 — per-turn extended-thinking toggle (custom-api Claude). */
  thinking?: boolean
}

export interface UseGeneralChatReturn {
  messages: ChatMessage[]
  streamingMessageId: number | null
  isStreaming: boolean
  error: ChatError | null
  activeSessionId: number | null
  /** All general sessions, newest-first (history list). */
  sessions: ChatSession[]
  send: (input: SendGeneralInput) => Promise<ChatStartResult>
  abortCurrent: () => void
  clearError: () => void
  newSession: () => void
  selectSession: (sessionId: number) => Promise<void>
  deleteSession: (sessionId: number) => void
  editMessage: (input: EditChatInput) => Promise<ChatStartResult>
  pendingConfirmations: PendingConfirmation[]
  confirmTool: (
    toolUseId: string,
    approved: boolean,
    editedInput?: unknown
  ) => Promise<{ ok: true } | { ok: false; code: string; message: string }>
  liveToolCalls: Map<number, LiveToolCall[]>
  /** Re-pull the general sessions list (after delete / external change). */
  refreshSessions: () => Promise<void>
  /** R3 — per-scope @mention activation key for the active general session. The dialog
   *  passes it to Composer so ActiveSkillChips renders only THIS session's activations. */
  skillScopeKey: string
}

export function useGeneralChat(): UseGeneralChatReturn {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [streamingMessageId, setStreamingMessageId] = useState<number | null>(null)
  const [error, setError] = useState<ChatError | null>(null)
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([])
  const [liveToolCalls, setLiveToolCalls] = useState<Map<number, LiveToolCall[]>>(new Map())

  const mountedRef = useRef(true)
  const activeSessionRef = useRef<number | null>(null)
  const forceNewSessionRef = useRef(false)
  // Mirrors useEmailChat: terminal ids guard the done/finalize PATCH race; the
  // navigation generation guards a late refresh from clobbering a switched session.
  const terminalIdsRef = useRef<Set<number>>(new Set())
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
    async (sessionId: number, syncStreaming = true): Promise<void> => {
      const gen = navGenerationRef.current
      const fresh = await mailApi.chat.listMessages(sessionId)
      if (!mountedRef.current || gen !== navGenerationRef.current) return
      const terminal = terminalIdsRef.current
      setMessages((prev) => {
        if (terminal.size === 0) return fresh
        return fresh.map((row) => {
          if (!terminal.has(row.id)) return row
          const isStaleLive = row.status === 'streaming' || row.status === 'pending'
          if (!isStaleLive) return row
          return prev.find((m) => m.id === row.id) ?? row
        })
      })
      if (syncStreaming) {
        const liveAssistant = [...fresh]
          .reverse()
          .find(
            (m) =>
              m.role === 'assistant' &&
              (m.status === 'streaming' || m.status === 'pending') &&
              !terminal.has(m.id)
          )
        setStreamingMessageId(liveAssistant ? liveAssistant.id : null)
      }
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

  // --- initial load: general sessions + latest conversation ----------------
  useEffect(() => {
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const fetched = await mailApi.chat.listGeneralSessions()
        if (cancelled || !mountedRef.current) return
        setSessions(fetched)
        const latest = fetched.length > 0 ? fetched[0].id : null
        if (latest === null) {
          setActiveSessionId(null)
          setMessages([])
          setStreamingMessageId(null)
          return
        }
        setActiveSessionId(latest)
        await refresh(latest)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [mailApi, refresh])

  // --- stream subscription -------------------------------------------------
  useEffect(() => {
    const unsubscribe = mailApi.chat.onStream((envelope) => {
      const currentSession = activeSessionRef.current
      if (currentSession === null || envelope.sessionId !== currentSession) return
      const { messageId, event } = envelope

      if (event.type === 'tool_call') {
        void refresh(envelope.sessionId)
        return
      }
      if (event.type === 'tool_use') {
        setLiveToolCalls((prev) => {
          const next = new Map(prev)
          const existing = next.get(messageId) ?? []
          if (existing.some((c) => c.toolUseId === event.toolUseId)) return prev
          next.set(messageId, [
            ...existing,
            {
              toolUseId: event.toolUseId,
              name: event.name,
              input: event.input,
              status: 'running',
              durationMs: null
            }
          ])
          return next
        })
        return
      }
      if (event.type === 'tool_result') {
        setLiveToolCalls((prev) => {
          const existing = prev.get(messageId)
          if (!existing) return prev
          const idx = existing.findIndex((c) => c.toolUseId === event.toolUseId)
          if (idx === -1) return prev
          const next = new Map(prev)
          const arr = [...existing]
          arr[idx] = {
            ...arr[idx],
            status: event.status,
            output: event.output,
            errorMessage: event.errorMessage,
            durationMs: event.durationMs
          }
          next.set(messageId, arr)
          return next
        })
        return
      }
      if (event.type === 'pending_confirmation') {
        setPendingConfirmations((prev) => {
          if (prev.some((p) => p.toolUseId === event.toolUseId)) return prev
          return [
            ...prev,
            {
              sessionId: envelope.sessionId,
              messageId: envelope.messageId,
              toolUseId: event.toolUseId,
              toolName: event.toolName,
              input: event.input,
              preview: event.preview,
              tier: event.tier
            }
          ]
        })
        return
      }

      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId)
        if (idx === -1) {
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
          case 'thinking':
            updated.thinking = (updated.thinking ?? '') + event.delta
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
        terminalIdsRef.current.add(messageId)
        setStreamingMessageId(null)
        void refresh(envelope.sessionId, false)
      } else if (event.type === 'error') {
        terminalIdsRef.current.add(messageId)
        setStreamingMessageId(null)
        setError({ code: event.code, message: event.message })
      }
    })
    return unsubscribe
  }, [mailApi, refresh])

  // --- abort in-flight stream on unmount -----------------------------------
  useEffect(() => {
    return (): void => {
      const sid = activeSessionRef.current
      if (sid !== null) mailApi.chat.abort(sid)
    }
  }, [mailApi])

  // --- public actions ------------------------------------------------------
  const send = useCallback(
    async (input: SendGeneralInput): Promise<ChatStartResult> => {
      setError(null)
      const myGen = navGenerationRef.current
      if (forceNewSessionRef.current) {
        forceNewSessionRef.current = false
        const newSess = await mailApi.chat.newSession({
          anchorType: 'general',
          backendKind: GENERAL_BACKEND,
          backendModel: input.backendModel ?? null
        })
        if (!mountedRef.current || myGen !== navGenerationRef.current) {
          return { sessionId: newSess.id, userMessageId: 0, assistantMessageId: 0 }
        }
        activeSessionRef.current = newSess.id
        setActiveSessionId(newSess.id)
      }
      // R3 — @mention: force-activate any @skill for THIS general session's scope (keyed
      // by session id, resolved AFTER the forceNew block so a brand-new session uses its
      // real id), then thread the scope's activation list into start(). Scope-keyed so a
      // mention in general session A never leaks into session B or the Email surface.
      const skillScope = `general:${activeSessionRef.current ?? 'new'}`
      const activatedSkills = applySkillMentions(skillScope, input.message)
      const result = await mailApi.chat.start({
        anchorType: 'general',
        emailId: null,
        message: input.message,
        backendKind: GENERAL_BACKEND,
        backendModel: input.backendModel ?? null,
        sessionId: activeSessionRef.current,
        thinking: input.thinking,
        activatedSkills
      })
      if (!mountedRef.current || myGen !== navGenerationRef.current) {
        mailApi.chat.abort(result.sessionId)
        return result
      }
      setActiveSessionId(result.sessionId)
      activeSessionRef.current = result.sessionId
      setStreamingMessageId(result.assistantMessageId)
      await refresh(result.sessionId)
      void refreshSessions()
      return result
    },
    [mailApi, refresh, refreshSessions]
  )

  const abortCurrent = useCallback(() => {
    const sid = activeSessionRef.current
    if (sid === null) return
    mailApi.chat.abort(sid)
    setStreamingMessageId((prev) => {
      if (prev !== null) terminalIdsRef.current.add(prev)
      return null
    })
    void refresh(sid)
  }, [mailApi, refresh])

  const clearError = useCallback(() => setError(null), [])

  const newSession = useCallback(() => {
    const sid = activeSessionRef.current
    if (sid !== null) mailApi.chat.abort(sid)
    setActiveSessionId(null)
    activeSessionRef.current = null
    setMessages([])
    setStreamingMessageId(null)
    setError(null)
    setLiveToolCalls(new Map())
    terminalIdsRef.current.clear()
    navGenerationRef.current += 1
    setPendingConfirmations([])
    forceNewSessionRef.current = true
    // R3 — drop @mention activations for the session being left (scope-keyed by id).
    useSkillActivation.getState().clearScope(`general:${sid ?? 'new'}`)
  }, [mailApi])

  const confirmTool = useCallback(
    async (
      toolUseId: string,
      approved: boolean,
      editedInput?: unknown
    ): Promise<{ ok: true } | { ok: false; code: string; message: string }> => {
      const result = await mailApi.chat.confirmTool(toolUseId, approved, editedInput)
      if (result.ok) {
        setPendingConfirmations((prev) =>
          prev.map((p) =>
            p.toolUseId === toolUseId ? { ...p, resolved: approved ? 'confirmed' : 'rejected' } : p
          )
        )
        setTimeout(() => {
          setPendingConfirmations((prev) => prev.filter((p) => p.toolUseId !== toolUseId))
        }, 1300)
      }
      return result
    },
    [mailApi]
  )

  const editMessage = useCallback(
    async (input: EditChatInput): Promise<ChatStartResult> => {
      if (activeSessionId === null) {
        throw new Error('useGeneralChat.editMessage: no active session')
      }
      setError(null)
      const myGen = navGenerationRef.current
      // R3 — re-apply @mention activation from the edited content into this scope.
      const skillScope = `general:${activeSessionId ?? 'new'}`
      const activatedSkills = applySkillMentions(skillScope, input.newContent)
      const result = await mailApi.chat.editMessage({
        sessionId: activeSessionId,
        editingMessageId: input.messageId,
        newContent: input.newContent,
        backendKind: GENERAL_BACKEND,
        backendModel: input.backendModel ?? null,
        backendAgentPageId: null,
        thinking: input.thinking,
        activatedSkills
      })
      if (!mountedRef.current || myGen !== navGenerationRef.current) {
        mailApi.chat.abort(result.sessionId)
        return result
      }
      setStreamingMessageId(result.assistantMessageId)
      activeSessionRef.current = result.sessionId
      await refresh(result.sessionId)
      return result
    },
    [activeSessionId, mailApi, refresh]
  )

  const deleteSession = useCallback(
    (sessionId: number): void => {
      if (sessionId === activeSessionRef.current) {
        mailApi.chat.abort(sessionId)
        navGenerationRef.current += 1
        setActiveSessionId(null)
        activeSessionRef.current = null
        setMessages([])
        setStreamingMessageId(null)
        setError(null)
        setLiveToolCalls(new Map())
      }
      mailApi.chat.deleteSession(sessionId)
      setSessions((cur) => cur.filter((s) => s.id !== sessionId))
    },
    [mailApi]
  )

  const selectSession = useCallback(
    async (sessionId: number): Promise<void> => {
      if (sessionId === activeSessionRef.current) return
      const prev = activeSessionRef.current
      if (prev !== null) mailApi.chat.abort(prev)
      navGenerationRef.current += 1
      setError(null)
      setStreamingMessageId(null)
      setLiveToolCalls(new Map())
      setPendingConfirmations([])
      // A switched-to session is no longer "force new" — drop a pending flag so
      // the next send lands in this session, not a freshly-inserted one.
      forceNewSessionRef.current = false
      setActiveSessionId(sessionId)
      activeSessionRef.current = sessionId
      try {
        await refresh(sessionId)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError({ code: 'E_LOAD', message })
      }
    },
    [mailApi, refresh]
  )

  return {
    messages,
    streamingMessageId,
    isStreaming: streamingMessageId !== null,
    error,
    activeSessionId,
    sessions,
    send,
    abortCurrent,
    clearError,
    newSession,
    selectSession,
    deleteSession,
    editMessage,
    pendingConfirmations,
    confirmTool,
    liveToolCalls,
    refreshSessions,
    skillScopeKey: `general:${activeSessionId ?? 'new'}`
  }
}
