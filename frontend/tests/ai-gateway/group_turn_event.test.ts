// L4 群聊 UX 批 — `chat:group-turn` 事件叶子（groupTurnEvent.ts）的契约。
//
// 钉三件事：运行时窄化的松紧（必填形状不符丢整条 / 可选字段类型不符只丢字段）、词表包含关系
// （turn 台账的 outcome 都是事件 phase，renderer 用同一套 key 还原刷新后的 meta 行）、
// 叶子类型与 api/types/chat.ts 内联结构类型的兼容（后者零 import，靠这里防漂移）。

import { describe, expect, expectTypeOf, test } from 'vitest'

import type { ChatApi } from '../../src/shared/api/types/chat'
import { GROUP_TURN_OUTCOMES } from '../../src/ai-gateway/groupFloors'
import {
  GROUP_SKIP_REASONS,
  GROUP_TURN_PHASES,
  narrowGroupTurnEvent,
  type GroupTurnEvent
} from '../../src/ai-gateway/groupTurnEvent'

const MINIMAL = {
  v: 1,
  sessionId: 7,
  runId: 'run-1',
  chainId: 12,
  seq: null,
  agentId: null,
  phase: 'queued',
  ts: 1_000,
  queued: ['a', 'b'],
  chainProgress: { counted: 0, cap: 12 }
}

describe('narrowGroupTurnEvent', () => {
  test('E1 接受最小合法事件（可选字段缺省不补）', () => {
    const e = narrowGroupTurnEvent(MINIMAL)
    expect(e).toEqual(MINIMAL)
    expect(e && 'text' in e).toBe(false)
  })

  test('E2 phase 不在值域 / 必填字段形状不符 → null', () => {
    expect(narrowGroupTurnEvent({ ...MINIMAL, phase: 'typing' })).toBeNull()
    expect(narrowGroupTurnEvent({ ...MINIMAL, v: 2 })).toBeNull()
    expect(narrowGroupTurnEvent({ ...MINIMAL, sessionId: '7' })).toBeNull()
    expect(narrowGroupTurnEvent({ ...MINIMAL, queued: ['a', 3] })).toBeNull()
    expect(narrowGroupTurnEvent({ ...MINIMAL, chainProgress: { counted: 1 } })).toBeNull()
    expect(narrowGroupTurnEvent(null)).toBeNull()
    expect(narrowGroupTurnEvent('queued')).toBeNull()
  })

  test('E3 可选字段类型不符 → 丢字段不丢事件；合法的原样保留', () => {
    const bad = narrowGroupTurnEvent({
      ...MINIMAL,
      phase: 'spoke',
      text: 42,
      messageId: '9',
      reason: 5,
      error: {},
      usage: 'n/a'
    })
    expect(bad).not.toBeNull()
    expect(bad).toEqual({ ...MINIMAL, phase: 'spoke' })
    const good = narrowGroupTurnEvent({
      ...MINIMAL,
      phase: 'spoke',
      seq: 3,
      agentId: 'a',
      text: '正文',
      messageId: 9,
      usage: { model: 'm', tokensInput: 1, tokensOutput: 'x', costUsd: null }
    })
    expect(good).toMatchObject({
      seq: 3,
      agentId: 'a',
      text: '正文',
      messageId: 9,
      usage: { model: 'm', tokensInput: 1, tokensOutput: null, costUsd: null }
    })
  })

  test('E4 GROUP_TURN_OUTCOMES ⊆ GROUP_TURN_PHASES（台账 outcome 都是事件 phase）', () => {
    for (const outcome of GROUP_TURN_OUTCOMES) {
      expect(GROUP_TURN_PHASES).toContain(outcome)
    }
    expect(GROUP_SKIP_REASONS).toEqual(['monologue', 'no_new_messages', 'removed'])
  })

  test('E5 叶子 GroupTurnEvent 可赋值给 ChatApi.onGroupTurn 的 handler 参数', () => {
    type Handler = Parameters<NonNullable<ChatApi['onGroupTurn']>>[0]
    type HandlerEvent = Parameters<Handler>[0]
    expectTypeOf<GroupTurnEvent>().toMatchTypeOf<HandlerEvent>()
    // 运行时对照：窄化出的事件能直接交给按内联类型声明的 handler。
    const seen: HandlerEvent[] = []
    const handler: Handler = (event) => seen.push(event)
    const e = narrowGroupTurnEvent(MINIMAL)
    if (e) handler(e)
    expect(seen).toHaveLength(1)
  })
})
