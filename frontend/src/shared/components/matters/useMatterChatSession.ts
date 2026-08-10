// Matters MVP P3 (lane ③) — matter-anchored chat session facade.
//
// Same fold as `useGeneralChat` (active session + seeded messages + a navEpoch that remounts the
// runtime), scoped to ONE matter's anchor and trimmed to what the panel actually needs — the design
// gives the panel a 新会话 button and no history list, so there is no session-list surface here.
//
// Two deliberate differences from the email/general hooks, both forced by what exists:
//
//  1. 🔴 There is no HTTP face for `listSessionsForMatter` (lane ① added it to the main-process
//     chat_db only; serve-api exposes `/chat/sessions?emailId=`, `/chat/sessions/general` and
//     `/chat/sessions/all`). So the matter's sessions are derived from
//     `listAllSessions({origin:'interactive'})` filtered on `anchor_type==='matter' &&
//     anchor_id===<matter.id>` — the rows already carry both columns, and `origin='interactive'`
//     is the same filter D3 prescribes for the getOrCreate reuse lookup (never adopt an
//     origin='agent' run's session).
//  2. Reuse ≠ eager create: opening the panel SELECTS the newest existing interactive session for
//     this matter; when there is none the thread starts fresh and the row is created lazily on the
//     first send (`onEnsureSession`), exactly like the email panel. No empty session rows leak.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { ChatMessage, ChatSession } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'

export interface UseMatterChatSessionResult {
  messages: ChatMessage[]
  activeSessionId: number | null
  /** The session id `messages` reflect — the runtime mount gate (mirror of useEmailChat). */
  messagesSessionId: number | null
  /** Monotonic thread-reset epoch; bumps on newSession, NOT on adoptSession (which happens
   *  mid-first-send and must not remount the provider). */
  navEpoch: number
  /** 新会话 — drop back to a fresh thread; the row is created on the next send. */
  newSession(): void
  /** Fold an out-of-band created session (onEnsureSession) into state. */
  adoptSession(session: ChatSession): void
}

/** Newest-first interactive sessions anchored on this matter. Exported for the unit test. */
export function selectMatterSessions(
  rows: readonly ChatSession[],
  matterInternalId: number
): ChatSession[] {
  return rows
    .filter(
      (row) =>
        row.anchor_type === 'matter' &&
        row.anchor_id === matterInternalId &&
        (row.origin ?? 'interactive') === 'interactive'
    )
    .slice()
    .sort((a, b) => b.updated_at - a.updated_at)
}

export function useMatterChatSession(matterInternalId: number): UseMatterChatSessionResult {
  const mailApi = useMailApi()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null)
  const [messagesSessionId, setMessagesSessionId] = useState<number | null>(null)
  const [navEpoch, setNavEpoch] = useState(0)

  const mountedRef = useRef(true)
  const activeSessionRef = useRef<number | null>(null)
  const navGenerationRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return (): void => {
      mountedRef.current = false
    }
  }, [])

  // Mount / matter switch — reuse the newest interactive session for this matter (D3 getOrCreate
  // semantics); none → stay on a fresh thread. Both reads degrade to empty rather than throwing
  // (createChatRuntime contract), and the generation guard drops a load the user has navigated away
  // from before it landed.
  useEffect(() => {
    let cancelled = false
    const generation = navGenerationRef.current
    void (async (): Promise<void> => {
      try {
        const rows = await mailApi.chat.listAllSessions({ origin: 'interactive' })
        const newest = selectMatterSessions(rows, matterInternalId)[0] ?? null
        if (cancelled || !mountedRef.current || generation !== navGenerationRef.current) return
        if (newest === null) return
        setActiveSessionId(newest.id)
        activeSessionRef.current = newest.id
        const history = await mailApi.chat.listMessages(newest.id)
        if (cancelled || !mountedRef.current || generation !== navGenerationRef.current) return
        setMessages(history)
        setMessagesSessionId(newest.id)
      } catch {
        // History is a convenience: a failed read leaves the panel on a fresh thread rather than
        // blocking the conversation.
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [mailApi, matterInternalId])

  const newSession = useCallback((): void => {
    setActiveSessionId(null)
    activeSessionRef.current = null
    setMessages([])
    setMessagesSessionId(null)
    navGenerationRef.current += 1
    setNavEpoch((n) => n + 1)
  }, [])

  const adoptSession = useCallback((session: ChatSession): void => {
    setActiveSessionId(session.id)
    activeSessionRef.current = session.id
    setMessages([])
    setMessagesSessionId(session.id)
  }, [])

  return { messages, activeSessionId, messagesSessionId, navEpoch, newSession, adoptSession }
}
