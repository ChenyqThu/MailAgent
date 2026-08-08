// harness-chat lane A (B1/B2/B4 renderer glue, task 07-15) — detached-run awareness for a chat panel.
//
// With MAILAGENT_CHAT_DETACHED_RUNS the gateway keeps streaming a turn after the panel unmounts
// (session switch / popout close). A panel that (re)mounts a session therefore needs three things,
// bundled here so AiChatPanel and AgentConversation share one state machine:
//
//   1. TRUTH PROBE — GET /api/ai/run/active?sessionId=N (3s poll while active): is a run still
//      streaming for this session in the background? Drives the "AI 仍在后台输出…" placeholder.
//      `localRunning` (ThreadRunningBridge-fed) masks the panel's OWN attached stream — an own run
//      must never read as "background" (it registered in the same registry); the probe's runId is
//      additionally checked against the own-run set (ownRuns.ts) so a just-ended own run can't
//      flash the placeholder either.
//   2. SETTLE TRANSITION — a background run ending means its turn just persisted (or aborted):
//      fire onSettled() so the caller reloads the session rows and remounts the seeded runtime.
//      TWO observers drive the same settle door (fireSettle): the WITNESSED poll transition
//      (active→gone) and the same-session 'chat:turn-persisted' broadcast itself, which IS the
//      persisted truth (P1-4, codex r1: a run can persist+release BEFORE this panel's first probe
//      returns). codex r2 [C] — the door dedups by RUN ID (the broadcast payload + /run/active
//      both carry the gateway's ActiveRunRegistry runId): each distinct run settles exactly once,
//      two legit consecutive runs settle twice (the r1 time-window dedup could swallow the second),
//      and a settle without a runId is NEVER silently dropped. Own-run masking is likewise runId-
//      precise (recordOwnRun via the transport's response header) instead of a 2s grace window,
//      and (codex r3 P1) instance-scoped: only a runtime instance that is STILL MOUNTED masks its
//      runs — after a session switch unmounts it, the same run settles here like any background
//      run (the r2 renderer-permanent set leaked the mask across remounts → permanent stale seed).
//      Web (no IPC) degrades to poll-only.
//   3. BROADCAST GLUE — subscribe to 'chat:turn-persisted' (B2): any persist refreshes the history
//      lists (unread badges — updated_at just bumped); a persist for THIS session additionally marks
//      it read (the user is looking at it) and invalidates the run-active + pending-approval probes
//      so the placeholder clears / the in-panel approval card appears without waiting for the poll.
//
// 🔴 IPC 订阅必须用返回的 disposer 清理（fe0437e）；onTurnPersisted 是 optional（web HttpApi 缺省）→ ?.

import { useCallback, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'

import { isOwnRun } from './ownRuns'

/** Poll cadence while a background run is live (fallback for a missed broadcast + web parity). */
const ACTIVE_RUN_POLL_MS = 3_000

/** codex r2 [C] — settled-run memory cap. Ids are UUIDs (no cross-session ambiguity), so the set
 *  only needs to outlive the broadcast↔poll double-observation of one run; FIFO-trim keeps it
 *  bounded (an evicted id would at worst re-fire one idempotent reload, never lose one). */
const MAX_SETTLED_RUN_IDS = 32

export interface UseBackgroundChatRunOptions {
  gatewayBaseUrl: string | null
  sessionId: number | null
  /** Master gate — mirrors the caller's "live ai-sdk surface" condition. */
  enabled: boolean
  /** Folded into the probe query key so a settle-driven remount re-probes deterministically. */
  refreshNonce: number
  /** True while THIS panel's own runtime is mid-stream (ThreadRunningBridge onRunningChange). */
  localRunning: boolean
  /** A background run settled (witnessed active→gone, or its persist broadcast): reload the session
   *  rows + bump the remount nonce. Deduped per runId — called at most once per settled run. */
  onSettled: () => void
  /** Optional: a turn persisted for ANY session — refresh a locally-held session list (the email
   *  panel's useEmailChat sessions state; the react-query allSessions family is invalidated here). */
  onSessionsTouched?: () => void
}

export function useBackgroundChatRun(opts: UseBackgroundChatRunOptions): {
  backgroundActive: boolean
  /** WP-14 — 后台 run 的回合起点（epoch ms），供 composer 上方运行条的秒表**接续**（切走再切回
   *  不清零）。`backgroundActive` 为假、或探针没给 `ageMs` 时为 null。 */
  backgroundStartedAt: number | null
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
    queryFn: async (): Promise<{
      active: boolean
      runId: string | null
      startedAt: number | null
    }> => {
      try {
        const res = await fetch(`${gatewayBaseUrl}/api/ai/run/active?sessionId=${sessionId}`)
        if (!res.ok) return { active: false, runId: null, startedAt: null } // 404 = fail-closed truth
        const body = (await res.json()) as { active?: unknown; runId?: unknown; ageMs?: unknown }
        // WP-14 — 服务端只给「已经跑了多久」（handleRunActive: Date.now() - entry.startedAt），
        // 在拿到响应的这一刻折算成本地 epoch 起点，之后由渲染器墙钟自己往上长。非有限/负数一律
        // 当没有（宁可不显示秒表，也不显示一个编出来的数）。
        const ageMs = body.ageMs
        const startedAt =
          typeof ageMs === 'number' && Number.isFinite(ageMs) && ageMs >= 0
            ? Date.now() - ageMs
            : null
        return {
          active: body.active === true,
          runId: typeof body.runId === 'string' ? body.runId : null,
          startedAt
        }
      } catch {
        return { active: false, runId: null, startedAt: null }
      }
    },
    enabled: probeEnabled,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => (query.state.data?.active === true ? ACTIVE_RUN_POLL_MS : false)
  })
  const probedRunId = runActiveQ.data?.runId ?? null
  const active = probeEnabled && runActiveQ.data?.active === true
  // codex r2 [C] — runId-precise own-run mask: a probe hit whose runId a LIVE runtime instance's
  // transport recorded is our own turn (mid-stream, or its release racing the poll) — never
  // "background". codex r3 P1 — ownership is instance-scoped (ownRuns.ts): once the runtime that
  // started the run unmounts (session switch), the same runId reads as background here, so a
  // switch-back witnesses it and the settle door can fire.
  const activeIsOwnRun = active && probedRunId != null && isOwnRun(probedRunId)

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

  // codex r2 [C] — the single settle door, deduped PER RUN (never by time window). Both observers
  // (witnessed poll transition below + same-session broadcast) route through here: whichever sees a
  // given run ending first wins, the other is a no-op for that SAME runId — while a different run
  // settling right after still fires (the r1 1.5s window swallowed it). A null runId (unleased
  // persist — headless agent run; or a pre-runId payload) always fires: never silently drop a
  // settle. Refs only → stable identity.
  const settledRunIdsRef = useRef<Set<string>>(new Set())
  const fireSettle = useCallback((runId: string | null): void => {
    if (runId != null) {
      const settled = settledRunIdsRef.current
      if (settled.has(runId)) return
      settled.add(runId)
      while (settled.size > MAX_SETTLED_RUN_IDS) {
        const oldest = settled.values().next().value
        if (oldest === undefined) break
        settled.delete(oldest)
      }
    }
    onSettledRef.current()
  }, [])

  // Settle transition — witness a DETACHED run (active while our own runtime is idle and the run
  // isn't ours by id), then fire onSettled when it goes away. An own attached stream never sets the
  // witness (localRunning mask + runId mask), so a normal in-view turn completing never triggers a
  // disruptive reload/remount. The witness stores the run's id (null = probe without one) and is
  // cleared ONLY at the gone-transition that consumes it — a broadcast settling the same run first
  // simply makes the later poll-fire a per-run dedup no-op (codex r2 [C]: never clear the witness
  // before an actual settle).
  const witnessedRunRef = useRef<string | null | undefined>(undefined)
  const pendingCompactRefreshRef = useRef(false)
  useEffect(() => {
    if (active && !localRunningRef.current && !activeIsOwnRun) {
      witnessedRunRef.current = probedRunId
    }
    if (!active && witnessedRunRef.current !== undefined) {
      const witnessed = witnessedRunRef.current
      witnessedRunRef.current = undefined
      fireSettle(witnessed)
    }
  }, [active, activeIsOwnRun, probedRunId, fireSettle])
  // A session switch invalidates the witness (it would otherwise leak a stale settle into the next
  // session's first probe). The settled-run set survives — runIds are globally unique.
  useEffect(() => {
    witnessedRunRef.current = undefined
    pendingCompactRefreshRef.current = false
  }, [sessionId])
  useEffect(() => {
    if (localRunning || !pendingCompactRefreshRef.current) return
    pendingCompactRefreshRef.current = false
    fireSettle(null)
  }, [fireSettle, localRunning])

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
      // P4 overflow recovery can append the Compact marker while this panel's original response is
      // still streaming. Remounting at that moment would tear down the retry stream, so remember the
      // DB-owned refresh and fire it immediately after localRunning falls. Threshold/manual Compact
      // broadcasts arrive while idle and settle immediately.
      if (payload.status === 'compacted') {
        if (localRunningRef.current) {
          pendingCompactRefreshRef.current = true
          return
        }
        fireSettle(null)
        return
      }
      // P1-4 (codex r1) — the same-session 'finished'/'paused' broadcast IS the persisted truth:
      // settle directly off it instead of requiring a prior witnessed active probe. codex r2 [C] —
      // own-run masking is runId-precise now: a broadcast whose runId a still-mounted runtime
      // instance recorded is our own attached turn (already rendered in full — a reload-remount
      // would be pure disruption), even when it lands after the localRunning→false commit (the
      // race the r1 2s grace papered over); a DIFFERENT run settling in that same moment (e.g.
      // another surface resuming an old approval) is not ours and settles normally. codex r3 P1 —
      // isOwnRun is instance-scoped: a run whose runtime unmounted (switch away → back) is NOT
      // masked here, its persist broadcast settles like any background run. The mid-stream
      // localRunning mask stays first and unconditional: under the session lease the only run that
      // can persist for this session while our own stream runs IS our own run (also covers a
      // payload whose runId we failed to record — a mid-stream remount must never happen).
      if (localRunningRef.current) return
      const runId = payload.runId ?? null
      if (runId != null && isOwnRun(runId)) return
      fireSettle(runId)
    })
    return dispose
  }, [enabled, mailApi, qc, gatewayBaseUrl, fireSettle])

  const backgroundActive = active && !localRunning && !activeIsOwnRun
  return {
    backgroundActive,
    backgroundStartedAt: backgroundActive ? (runActiveQ.data?.startedAt ?? null) : null
  }
}
