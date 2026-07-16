// harness-chat lane A (B1/B2/B4 renderer glue, task 07-15) — detached-run awareness for a chat panel.
//
// With MAILAGENT_CHAT_DETACHED_RUNS the gateway keeps streaming a turn after the panel unmounts
// (session switch / popout close). A panel that (re)mounts a session therefore needs three things,
// bundled here so AiChatPanel and AgentConversation share one state machine:
//
//   1. TRUTH PROBE — GET /api/ai/run/active?sessionId=N (3s poll while active): is a run still
//      streaming for this session in the background? Drives the "AI 仍在后台输出…" placeholder.
//      `localRunning` (ThreadRunningBridge-fed) masks the panel's OWN attached stream — an own run
//      must never read as "background" (it registered in the same registry).
//   2. SETTLE TRANSITION — a WITNESSED background run going active→gone means its turn just
//      persisted (or aborted): fire onSettled() exactly once so the caller reloads the session rows
//      and remounts the seeded runtime. Both the broadcast (below) and the poll drive the same
//      transition — web (no IPC) degrades to poll-only.
//   3. BROADCAST GLUE — subscribe to 'chat:turn-persisted' (B2): any persist refreshes the history
//      lists (unread badges — updated_at just bumped); a persist for THIS session additionally marks
//      it read (the user is looking at it) and invalidates the run-active + pending-approval probes
//      so the placeholder clears / the in-panel approval card appears without waiting for the poll.
//
// 🔴 IPC 订阅必须用返回的 disposer 清理（fe0437e）；onTurnPersisted 是 optional（web HttpApi 缺省）→ ?.

import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'

/** Poll cadence while a background run is live (fallback for a missed broadcast + web parity). */
const ACTIVE_RUN_POLL_MS = 3_000

export interface UseBackgroundChatRunOptions {
  gatewayBaseUrl: string | null
  sessionId: number | null
  /** Master gate — mirrors the caller's "live ai-sdk surface" condition. */
  enabled: boolean
  /** Folded into the probe query key so a settle-driven remount re-probes deterministically. */
  refreshNonce: number
  /** True while THIS panel's own runtime is mid-stream (ThreadRunningBridge onRunningChange). */
  localRunning: boolean
  /** A WITNESSED background run settled (active→gone): reload the session rows + bump the remount
   *  nonce. Called at most once per witnessed run. */
  onSettled: () => void
  /** Optional: a turn persisted for ANY session — refresh a locally-held session list (the email
   *  panel's useEmailChat sessions state; the react-query allSessions family is invalidated here). */
  onSessionsTouched?: () => void
}

export function useBackgroundChatRun(opts: UseBackgroundChatRunOptions): {
  backgroundActive: boolean
} {
  const {
    gatewayBaseUrl,
    sessionId,
    enabled,
    refreshNonce,
    localRunning,
    onSettled,
    onSessionsTouched
  } = opts
  const mailApi = useMailApi()
  const qc = useQueryClient()

  const probeEnabled = enabled && gatewayBaseUrl != null && sessionId != null
  const runActiveQ = useQuery({
    queryKey: qk.aiGateway.runActive(gatewayBaseUrl, sessionId, refreshNonce),
    queryFn: async (): Promise<{ active: boolean }> => {
      try {
        const res = await fetch(`${gatewayBaseUrl}/api/ai/run/active?sessionId=${sessionId}`)
        if (!res.ok) return { active: false } // 404 = fail-closed truth (nothing running / flag off)
        const body = (await res.json()) as { active?: unknown }
        return { active: body.active === true }
      } catch {
        return { active: false }
      }
    },
    enabled: probeEnabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.active === true ? ACTIVE_RUN_POLL_MS : false)
  })
  const active = probeEnabled && runActiveQ.data?.active === true

  // Refs so the transition effect + subscription read the freshest values without re-subscribing.
  // Synced via effects (react-hooks/refs: never write refs during render); declared BEFORE their
  // consumers so the commit-order guarantee keeps them current when the consumers run.
  const localRunningRef = useRef(localRunning)
  const onSettledRef = useRef(onSettled)
  const onSessionsTouchedRef = useRef(onSessionsTouched)
  useEffect(() => {
    localRunningRef.current = localRunning
    onSettledRef.current = onSettled
    onSessionsTouchedRef.current = onSessionsTouched
  }, [localRunning, onSettled, onSessionsTouched])

  // Settle transition — witness a DETACHED run (active while our own runtime is idle), then fire
  // onSettled exactly once when it goes away. An own attached stream (localRunning) never sets the
  // witness, so a normal in-view turn completing never triggers a disruptive reload/remount.
  const witnessedRef = useRef(false)
  useEffect(() => {
    if (active && !localRunningRef.current) witnessedRef.current = true
    if (!active && witnessedRef.current) {
      witnessedRef.current = false
      onSettledRef.current()
    }
  }, [active])
  // A session switch invalidates the witness (the ref would otherwise leak a stale settle into the
  // next session's first probe miss).
  useEffect(() => {
    witnessedRef.current = false
  }, [sessionId])

  // B2 broadcast glue. Subscribed whenever the surface is live (not just while active — the panel
  // must also learn about OTHER sessions' persists for the unread badges).
  const activeSessionRef = useRef(sessionId)
  useEffect(() => {
    activeSessionRef.current = sessionId
  }, [sessionId])
  useEffect(() => {
    if (!enabled) return undefined
    const dispose = mailApi.chat.onTurnPersisted?.((payload) => {
      // Any persist bumped that session's updated_at → refresh the history lists (badge source).
      void qc.invalidateQueries({ queryKey: qk.chat.allSessions() })
      onSessionsTouchedRef.current?.()
      if (payload.sessionId !== activeSessionRef.current) return
      // The user is LOOKING at this session — keep it read (own turns must never self-badge).
      void mailApi.chat.markSessionRead(payload.sessionId)
      // Re-probe immediately instead of waiting for the poll: the placeholder clears (run gone) and
      // a 'paused' persist surfaces the in-panel approval card (B3). Prefix invalidation (nonce-less
      // slice) hits every nonce'd instance of both keys.
      void qc.invalidateQueries({
        queryKey: qk.aiGateway.runActive(gatewayBaseUrl, payload.sessionId, 0).slice(0, 4)
      })
      void qc.invalidateQueries({ queryKey: qk.agentApprovalPending(payload.sessionId) })
    })
    return dispose
  }, [enabled, mailApi, qc, gatewayBaseUrl])

  return { backgroundActive: active && !localRunning }
}
