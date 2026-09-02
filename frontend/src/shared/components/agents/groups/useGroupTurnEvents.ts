// L4 群聊 UX 批 — `chat:group-turn` 事件的 renderer 侧状态（一个纯 reducer，两个 hook 共用）。
//
//   • useGroupTurnEvents(sessionId, enabled, initialLive?) — 群视图：只收本群，维护在场三元组 +
//     链进度 + overlay（turn 级留痕）+ 被停掉的 run；每条事件一次 state 更新（delta 只改
//     inFlight.text 一个字段，≤ 10 帧/秒的上限由 gateway 节流保证，这里不再节流）。
//   • useGroupLiveMap(enabled) — 群列表：不按 sessionId 过滤，每群只留在场三元组（不留
//     overlay / 正文），Workspace 订阅一次下发给列表脉冲与视图初值。
//
// 🔴 fail-closed 的 TTL：60s 无事件且无在写者 → 清排队态（事件源掉线时不留僵尸「排队中」）。
// 🔴 IPC 订阅必须用返回的 disposer 清理（useBackgroundChatRun 同一纪律）；`onGroupTurn` 在 web
//    （HttpApi）缺省 → `?.`，此时 live 恒空、群视图退回 turn-persisted + 探针。

import { useEffect, useMemo, useReducer, useState } from 'react'

import { useMailApi } from '@shared/hooks/useMailApi'

import { narrowGroupTurnEvent, type GroupTurnEvent } from '../../../../ai-gateway/groupTurnEvent'
import {
  turnKeyOf,
  type GroupLiveInFlight,
  type GroupLiveSnapshot,
  type GroupLiveTurn
} from './groupTimeline'

export const GROUP_LIVE_TTL_MS = 60_000
const TTL_TICK_MS = 15_000

export interface GroupLiveTriple {
  inFlight: string | null
  preparing: string | null
  queued: string[]
}

export interface GroupLiveState extends GroupLiveSnapshot {
  overlay: Map<string, GroupLiveTurn>
  stoppedByRun: Set<string>
  chainProgress: { counted: number; cap: number } | null
  lastEventAt: number | null
}

export type GroupLiveAction =
  | { type: 'event'; event: GroupTurnEvent; now: number }
  /** 落库行到达：已被落库覆盖的 spoke overlay 项清掉（时间线也会按 messageId 去重，这里是内存卫生）。 */
  | { type: 'persisted'; messageIds: ReadonlySet<number> }
  /** 台账刷新：已有同 turnKey 行的 overlay 项清掉。 */
  | { type: 'turnsLoaded'; turnKeys: ReadonlySet<string> }
  | { type: 'tick'; now: number }
  /** 探针 / 列表 Map 给的初值：只在还没收到过任何事件时生效（事件是更新的事实）。 */
  | { type: 'seed'; triple: GroupLiveTriple; now: number }

export function initialGroupLiveState(seed?: GroupLiveTriple | null): GroupLiveState {
  return {
    inFlight:
      seed?.inFlight != null
        ? { agentId: seed.inFlight, text: '', runId: null, seq: null, chainId: null, startedAt: 0 }
        : null,
    preparing: seed?.preparing ?? null,
    queued: seed?.queued ?? [],
    overlay: new Map(),
    stoppedByRun: new Set(),
    chainProgress: null,
    lastEventAt: null
  }
}

function liveTurnOf(e: GroupTurnEvent, turnKey: string): GroupLiveTurn {
  const turn: GroupLiveTurn = {
    turnKey,
    phase: e.phase,
    agentId: e.agentId,
    runId: e.runId,
    chainId: e.chainId,
    seq: e.seq,
    ts: e.ts
  }
  if (e.text != null) turn.text = e.text
  if (e.messageId != null) turn.messageId = e.messageId
  if (e.reason != null) turn.reason = e.reason
  if (e.error != null) turn.error = e.error
  if (e.usage != null) turn.usage = e.usage
  return turn
}

function reduceEvent(state: GroupLiveState, e: GroupTurnEvent, now: number): GroupLiveState {
  const next: GroupLiveState = {
    ...state,
    queued: e.queued,
    chainProgress: e.chainProgress,
    lastEventAt: now
  }
  switch (e.phase) {
    case 'queued':
      return next
    case 'no_candidates': {
      const overlay = new Map(state.overlay)
      overlay.set(`nc:${e.chainId}`, liveTurnOf(e, `nc:${e.chainId}`))
      return { ...next, overlay }
    }
    case 'start':
      if (e.agentId == null) return next
      return {
        ...next,
        preparing: null,
        inFlight: {
          agentId: e.agentId,
          text: '',
          runId: e.runId,
          seq: e.seq,
          chainId: e.chainId,
          startedAt: e.ts
        }
      }
    case 'delta': {
      if (e.agentId == null) return next
      const text = e.text ?? ''
      const inFlight: GroupLiveInFlight =
        state.inFlight != null && state.inFlight.agentId === e.agentId
          ? { ...state.inFlight, text }
          : {
              agentId: e.agentId,
              text,
              runId: e.runId,
              seq: e.seq,
              chainId: e.chainId,
              startedAt: e.ts
            }
      return { ...next, preparing: null, inFlight }
    }
    case 'spoke':
    case 'silent':
    case 'held_dup':
    case 'skipped':
    case 'failed': {
      const turnKey = turnKeyOf(e.runId, e.seq)
      const overlay = new Map(state.overlay)
      overlay.set(turnKey, liveTurnOf(e, turnKey))
      const clearsInFlight = state.inFlight != null && state.inFlight.agentId === e.agentId
      return {
        ...next,
        overlay,
        preparing: state.preparing === e.agentId ? null : state.preparing,
        inFlight: clearsInFlight ? null : state.inFlight
      }
    }
    case 'stopped': {
      const overlay = new Map(state.overlay)
      const stoppedByRun = new Set(state.stoppedByRun)
      if (e.runId != null) {
        stoppedByRun.add(e.runId)
        overlay.set(`stop:${e.runId}`, liveTurnOf(e, `stop:${e.runId}`))
      }
      return { ...next, overlay, stoppedByRun, queued: [], inFlight: null, preparing: null }
    }
    default:
      return next
  }
}

export function reduceGroupTurnEvents(
  state: GroupLiveState,
  action: GroupLiveAction
): GroupLiveState {
  switch (action.type) {
    case 'event':
      return reduceEvent(state, action.event, action.now)
    case 'persisted': {
      let overlay: Map<string, GroupLiveTurn> | null = null
      for (const [key, turn] of state.overlay) {
        if (
          turn.phase === 'spoke' &&
          turn.messageId != null &&
          action.messageIds.has(turn.messageId)
        ) {
          overlay ??= new Map(state.overlay)
          overlay.delete(key)
        }
      }
      return overlay == null ? state : { ...state, overlay }
    }
    case 'turnsLoaded': {
      let overlay: Map<string, GroupLiveTurn> | null = null
      for (const key of state.overlay.keys()) {
        if (action.turnKeys.has(key)) {
          overlay ??= new Map(state.overlay)
          overlay.delete(key)
        }
      }
      return overlay == null ? state : { ...state, overlay }
    }
    case 'tick': {
      const idle = state.inFlight == null && (state.queued.length > 0 || state.preparing != null)
      if (
        !idle ||
        state.lastEventAt == null ||
        action.now - state.lastEventAt < GROUP_LIVE_TTL_MS
      ) {
        return state
      }
      return { ...state, queued: [], preparing: null }
    }
    case 'seed': {
      if (state.lastEventAt != null) return state
      const seeded = initialGroupLiveState(action.triple)
      return {
        ...state,
        inFlight: seeded.inFlight,
        preparing: seeded.preparing,
        queued: seeded.queued,
        lastEventAt: action.now
      }
    }
    default:
      return state
  }
}

/** 探针 / 列表 Map 给的初值：只在还没收到过任何事件时生效（事件是更新的事实）。派生用，
 *  不进 reducer —— 视图在 render 里按「事件未到」判据套用，不需要 effect。 */
export function withSeed(state: GroupLiveState, triple: GroupLiveTriple | null): GroupLiveState {
  if (triple == null || state.lastEventAt != null) return state
  const seeded = initialGroupLiveState(triple)
  return { ...state, inFlight: seeded.inFlight, preparing: seeded.preparing, queued: seeded.queued }
}

/** 每 tickMs 强制 re-render，让「刚刚 / n 分钟前」自然走时（照 calendar hooks 的 useNowTick；
 *  lazy init 把 Date.now() 移出 render body）。 */
export function useNowTick(tickMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs)
    return () => clearInterval(id)
  }, [tickMs])
  return now
}

function needsTtl(state: GroupLiveState): boolean {
  return state.inFlight == null && (state.queued.length > 0 || state.preparing != null)
}

export function useGroupTurnEvents(
  sessionId: number,
  enabled: boolean,
  initialLive?: GroupLiveTriple | null
): { live: GroupLiveState; dispatch: React.Dispatch<GroupLiveAction> } {
  const mailApi = useMailApi()
  const [live, dispatch] = useReducer(
    reduceGroupTurnEvents,
    initialLive ?? null,
    initialGroupLiveState
  )

  useEffect(() => {
    if (!enabled) return undefined
    return mailApi.chat.onGroupTurn?.((raw) => {
      const event = narrowGroupTurnEvent(raw)
      if (event == null || event.sessionId !== sessionId) return
      dispatch({ type: 'event', event, now: Date.now() })
    })
  }, [enabled, mailApi, sessionId])

  const ticking = enabled && needsTtl(live)
  useEffect(() => {
    if (!ticking) return undefined
    const id = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), TTL_TICK_MS)
    return () => clearInterval(id)
  }, [ticking])

  return { live, dispatch }
}

/** 列表级在场态：每群一份三元组，别群互不影响；enabled=false → 空 Map 且不订阅。 */
export function useGroupLiveMap(enabled: boolean): Map<number, GroupLiveTriple> {
  const mailApi = useMailApi()
  const [states, setStates] = useState<Map<number, GroupLiveState>>(() => new Map())

  useEffect(() => {
    if (!enabled) return undefined
    return mailApi.chat.onGroupTurn?.((raw) => {
      const event = narrowGroupTurnEvent(raw)
      if (event == null) return
      setStates((prev) => {
        const next = new Map(prev)
        const reduced = reduceGroupTurnEvents(
          prev.get(event.sessionId) ?? initialGroupLiveState(),
          {
            type: 'event',
            event,
            now: Date.now()
          }
        )
        // 列表不需要正文与留痕：只留三元组，Map 不随事件量增长。
        next.set(event.sessionId, {
          ...reduced,
          overlay: new Map(),
          inFlight: reduced.inFlight != null ? { ...reduced.inFlight, text: '' } : null
        })
        return next
      })
    })
  }, [enabled, mailApi])

  const ticking = enabled && [...states.values()].some(needsTtl)
  useEffect(() => {
    if (!ticking) return undefined
    const id = setInterval(() => {
      const now = Date.now()
      setStates((prev) => {
        let next: Map<number, GroupLiveState> | null = null
        for (const [id, state] of prev) {
          const ticked = reduceGroupTurnEvents(state, { type: 'tick', now })
          if (ticked !== state) {
            next ??= new Map(prev)
            next.set(id, ticked)
          }
        }
        return next ?? prev
      })
    }, TTL_TICK_MS)
    return () => clearInterval(id)
  }, [ticking])

  return useMemo(() => {
    const map = new Map<number, GroupLiveTriple>()
    for (const [id, state] of states) {
      if (state.inFlight == null && state.preparing == null && state.queued.length === 0) continue
      map.set(id, {
        inFlight: state.inFlight?.agentId ?? null,
        preparing: state.preparing,
        queued: state.queued
      })
    }
    return map
  }, [states])
}
