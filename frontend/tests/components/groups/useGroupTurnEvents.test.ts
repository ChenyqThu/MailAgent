// @vitest-environment happy-dom
//
// L4 群聊 UX 批 — reduceGroupTurnEvents 纯 reducer + 两个 hook。
//
//   R1 queued 覆盖 queued[]；R2 start → inFlight{agentId, text:''}；R3 delta 覆盖 text（不是追加）；
//   R4 spoke → inFlight 清、overlay 项带 messageId；R5 silent/held_dup/skipped/failed → overlay 项 +
//   inFlight 清；R6 stopped → stoppedByRun 加 runId、queued 清；R7 useGroupTurnEvents 别群事件忽略；
//   R8 60s 无事件且无 inFlight → queued 清（假时钟）；R9 turn-persisted 后被落库覆盖的 spoke 项清除；
//   R10 useGroupLiveMap 两群各自成项、别群互不影响、enabled=false 空 Map 且不订阅。

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const mockOnGroupTurn = vi.fn()
vi.mock('@shared/hooks/useMailApi', () => ({
  useMailApi: () => ({ chat: { onGroupTurn: mockOnGroupTurn } })
}))

import type { GroupTurnEvent } from '../../../src/ai-gateway/groupTurnEvent'
import {
  GROUP_LIVE_TTL_MS,
  initialGroupLiveState,
  reduceGroupTurnEvents,
  useGroupLiveMap,
  useGroupTurnEvents,
  type GroupLiveState
} from '../../../src/shared/components/agents/groups/useGroupTurnEvents'

function ev(over: Partial<GroupTurnEvent> & { phase: GroupTurnEvent['phase'] }): GroupTurnEvent {
  return {
    v: 1,
    sessionId: 300,
    runId: 'r1',
    chainId: 1,
    seq: 1,
    agentId: 'a1',
    ts: 1_000,
    queued: [],
    chainProgress: { counted: 0, cap: 12 },
    ...over
  }
}

function apply(state: GroupLiveState, ...events: GroupTurnEvent[]): GroupLiveState {
  return events.reduce(
    (s, e) => reduceGroupTurnEvents(s, { type: 'event', event: e, now: e.ts }),
    state
  )
}

type Handler = (e: unknown) => void
let handlers: Handler[] = []

beforeEach(() => {
  handlers = []
  mockOnGroupTurn.mockReset()
  mockOnGroupTurn.mockImplementation((h: Handler) => {
    handlers.push(h)
    return () => {
      handlers = handlers.filter((x) => x !== h)
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('reduceGroupTurnEvents', () => {
  test('R1 queued 覆盖 queued[]（全量语义，不累加）', () => {
    const s1 = apply(
      initialGroupLiveState(),
      ev({ phase: 'queued', agentId: null, queued: ['a1', 'a2'] })
    )
    expect(s1.queued).toEqual(['a1', 'a2'])
    const s2 = apply(s1, ev({ phase: 'queued', agentId: null, queued: ['a2'] }))
    expect(s2.queued).toEqual(['a2'])
    expect(s2.chainProgress).toEqual({ counted: 0, cap: 12 })
  })

  test('R2 start → inFlight{agentId, text:""}，preparing 清', () => {
    const s = apply(
      { ...initialGroupLiveState(), preparing: 'a1' },
      ev({ phase: 'start', queued: ['a2'] })
    )
    expect(s.inFlight).toMatchObject({ agentId: 'a1', text: '', runId: 'r1', seq: 1 })
    expect(s.preparing).toBeNull()
    expect(s.queued).toEqual(['a2'])
  })

  test('R3 delta 覆盖 text（累计正文，不是追加）', () => {
    const s = apply(
      initialGroupLiveState(),
      ev({ phase: 'start' }),
      ev({ phase: 'delta', text: '你好' }),
      ev({ phase: 'delta', text: '你好，世界' })
    )
    expect(s.inFlight?.text).toBe('你好，世界')
  })

  test('R4 spoke → inFlight 清、overlay 项带 messageId 与全文', () => {
    const s = apply(
      initialGroupLiveState(),
      ev({ phase: 'start' }),
      ev({ phase: 'delta', text: '半' }),
      ev({ phase: 'spoke', text: '半句话', messageId: 42 })
    )
    expect(s.inFlight).toBeNull()
    expect(s.overlay.get('r1:1')).toMatchObject({ phase: 'spoke', messageId: 42, text: '半句话' })
  })

  test('R5 silent / held_dup / skipped / failed → overlay 项 + inFlight 清', () => {
    for (const phase of ['silent', 'held_dup', 'skipped', 'failed'] as const) {
      const s = apply(
        initialGroupLiveState(),
        ev({ phase: 'start' }),
        ev({ phase, reason: 'monologue' })
      )
      expect(s.inFlight, phase).toBeNull()
      expect(s.overlay.get('r1:1')?.phase, phase).toBe(phase)
    }
  })

  test('R6 stopped → stoppedByRun 加 runId、queued 清、inFlight 清', () => {
    const s = apply(
      initialGroupLiveState(),
      ev({ phase: 'start', queued: ['a2'] }),
      ev({ phase: 'stopped', agentId: null, seq: null, reason: 'chain_cap', queued: [] })
    )
    expect(s.stoppedByRun.has('r1')).toBe(true)
    expect(s.queued).toEqual([])
    expect(s.inFlight).toBeNull()
    expect(s.overlay.get('stop:r1')?.reason).toBe('chain_cap')
  })

  test('R9 turn-persisted 后 overlay 中已被落库覆盖的 spoke 项清除', () => {
    const s = apply(initialGroupLiveState(), ev({ phase: 'spoke', messageId: 42, text: 'x' }))
    const kept = reduceGroupTurnEvents(s, { type: 'persisted', messageIds: new Set([1]) })
    expect(kept.overlay.has('r1:1')).toBe(true)
    const cleared = reduceGroupTurnEvents(s, { type: 'persisted', messageIds: new Set([42]) })
    expect(cleared.overlay.has('r1:1')).toBe(false)
  })
})

describe('useGroupTurnEvents', () => {
  test('R7 别群事件忽略；本群事件进 state；卸载后反订阅', () => {
    const { result, unmount } = renderHook(() => useGroupTurnEvents(300, true))
    expect(mockOnGroupTurn).toHaveBeenCalledTimes(1)
    act(() => handlers[0](ev({ phase: 'queued', sessionId: 999, agentId: null, queued: ['a9'] })))
    expect(result.current.live.queued).toEqual([])
    act(() => handlers[0](ev({ phase: 'queued', agentId: null, queued: ['a1'] })))
    expect(result.current.live.queued).toEqual(['a1'])
    unmount()
    expect(handlers).toHaveLength(0)
  })

  test('R8 60s 无事件且无 inFlight → queued 清（假时钟）', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useGroupTurnEvents(300, true))
    act(() => handlers[0](ev({ phase: 'queued', agentId: null, queued: ['a1'] })))
    expect(result.current.live.queued).toEqual(['a1'])
    act(() => {
      vi.advanceTimersByTime(GROUP_LIVE_TTL_MS / 2)
    })
    expect(result.current.live.queued).toEqual(['a1'])
    act(() => {
      vi.advanceTimersByTime(GROUP_LIVE_TTL_MS)
    })
    expect(result.current.live.queued).toEqual([])
  })

  test('R7b enabled=false → 不订阅', () => {
    renderHook(() => useGroupTurnEvents(300, false))
    expect(mockOnGroupTurn).not.toHaveBeenCalled()
  })
})

describe('useGroupLiveMap', () => {
  test('R10 两群事件各自成项、别群互不影响；enabled=false 返回空 Map 且不订阅', () => {
    const { result } = renderHook(() => useGroupLiveMap(true))
    expect(result.current.size).toBe(0)
    act(() => handlers[0](ev({ phase: 'queued', sessionId: 300, agentId: null, queued: ['a1'] })))
    act(() => handlers[0](ev({ phase: 'start', sessionId: 301, agentId: 'b1' })))
    expect(result.current.get(300)).toEqual({ inFlight: null, preparing: null, queued: ['a1'] })
    expect(result.current.get(301)).toEqual({ inFlight: 'b1', preparing: null, queued: [] })
    // 301 结束不影响 300。
    act(() => handlers[0](ev({ phase: 'spoke', sessionId: 301, agentId: 'b1', messageId: 7 })))
    expect(result.current.has(301)).toBe(false)
    expect(result.current.get(300)?.queued).toEqual(['a1'])

    mockOnGroupTurn.mockClear()
    const off = renderHook(() => useGroupLiveMap(false))
    expect(off.result.current.size).toBe(0)
    expect(mockOnGroupTurn).not.toHaveBeenCalled()
  })
})
