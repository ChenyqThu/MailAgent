// T2 lane P — `groupTurnStage` 的真值表（群在场三元组 + turn 留痕 → AI Chat 那套 TurnStage）。
//
//   S1 只有 preparing / 排队 → connecting；S2 在写者尚无正文 → connecting；S3 有正文 → writing；
//   S4 静默升级 15s / 30s → stalled 1 / 2（且压过 writing）；S5 没有事件源不算静默；
//   S6 收尾：最后一条留痕 failed 且新鲜 → error，陈旧 / 非 failed / 无留痕 → idle；
//   S7 只产 connecting / writing / stalled / error / idle —— thinking 与 calling-tool 恒不出现。
//
// 门槛按参数传（单源是 useTurnStage.ts 的 STALL_1_MS / STALL_2_MS，叶子里不手抄 15s / 30s）。

import { describe, expect, test } from 'vitest'

import {
  groupTurnStage,
  type GroupTurnStageResult,
  type GroupTurnStageView
} from '../../../src/shared/components/agents/groups/groupPresentation'

const STALL = { level1Ms: 15_000, level2Ms: 30_000 }
const NOW = 1_700_000_000_000

function view(over: Partial<GroupTurnStageView> = {}): GroupTurnStageView {
  return {
    inFlight: null,
    preparing: null,
    queued: [],
    overlay: new Map(),
    lastEventAt: null,
    ...over
  }
}

function inFlight(text: string): GroupTurnStageView['inFlight'] {
  return { agentId: 'a1', text, startedAt: NOW - 5_000 }
}

function overlay(
  entries: readonly { key: string; phase: string; ts: number }[]
): GroupTurnStageView['overlay'] {
  return new Map(entries.map((e) => [e.key, { phase: e.phase, agentId: 'a1', ts: e.ts }]))
}

describe('groupTurnStage — 五分支真值表', () => {
  const cases: readonly { name: string; view: GroupTurnStageView; want: GroupTurnStageResult }[] = [
    {
      name: 'S1a 只有排队（无在写者）→ connecting',
      view: view({ queued: ['a2'], lastEventAt: NOW - 1_000 }),
      want: { stage: 'connecting', stallLevel: 0 }
    },
    {
      name: 'S1b 只有 preparing（探针）→ connecting',
      view: view({ preparing: 'a2' }),
      want: { stage: 'connecting', stallLevel: 0 }
    },
    {
      name: 'S2 在写者尚无正文 → connecting',
      view: view({ inFlight: inFlight(''), lastEventAt: NOW - 1_000 }),
      want: { stage: 'connecting', stallLevel: 0 }
    },
    {
      name: 'S3 在写者有正文 → writing',
      view: view({ inFlight: inFlight('调研进'), lastEventAt: NOW - 1_000 }),
      want: { stage: 'writing', stallLevel: 0 }
    },
    {
      name: 'S4a 静默 15s（含边界）→ stalled 1，压过 writing',
      view: view({ inFlight: inFlight('半句'), lastEventAt: NOW - 15_000 }),
      want: { stage: 'stalled', stallLevel: 1 }
    },
    {
      name: 'S4b 静默 30s（含边界）→ stalled 2',
      view: view({ inFlight: inFlight('半句'), lastEventAt: NOW - 30_000 }),
      want: { stage: 'stalled', stallLevel: 2 }
    },
    {
      name: 'S4c 静默但只剩排队 → 一样 stalled（在写者不是前提）',
      view: view({ queued: ['a2'], lastEventAt: NOW - 31_000 }),
      want: { stage: 'stalled', stallLevel: 2 }
    },
    {
      name: 'S4d 静默 14.999s → 还没到门槛',
      view: view({ inFlight: inFlight('半句'), lastEventAt: NOW - 14_999 }),
      want: { stage: 'writing', stallLevel: 0 }
    },
    {
      name: 'S5 只有探针种子（从未收到事件）→ 不算静默',
      view: view({ inFlight: inFlight(''), lastEventAt: null }),
      want: { stage: 'connecting', stallLevel: 0 }
    },
    {
      name: 'S6a 收尾 + 最后一条留痕 failed 且新鲜 → error',
      view: view({ overlay: overlay([{ key: 'r1:0', phase: 'failed', ts: NOW - 3_000 }]) }),
      want: { stage: 'error', stallLevel: 0 }
    },
    {
      name: 'S6b failed 已过新鲜期 → idle（失败的长期载体是时间线那条重试行）',
      view: view({ overlay: overlay([{ key: 'r1:0', phase: 'failed', ts: NOW - 15_000 }]) }),
      want: { stage: 'idle', stallLevel: 0 }
    },
    {
      name: 'S6c failed 之后又来了更新的 spoke → idle（只看最后发生的那件事）',
      view: view({
        overlay: overlay([
          { key: 'r1:0', phase: 'failed', ts: NOW - 3_000 },
          { key: 'r1:1', phase: 'spoke', ts: NOW - 1_000 }
        ])
      }),
      want: { stage: 'idle', stallLevel: 0 }
    },
    {
      name: 'S6d 停止（stopped 留痕）→ idle，不当失败报',
      view: view({ overlay: overlay([{ key: 'stop:r1', phase: 'stopped', ts: NOW - 1_000 }]) }),
      want: { stage: 'idle', stallLevel: 0 }
    },
    {
      name: 'S6e 三元组空且无留痕 → idle',
      view: view(),
      want: { stage: 'idle', stallLevel: 0 }
    },
    {
      name: 'S6f 失败留痕还新鲜但链还在跑 → 按在跑算（下一位已在排队）',
      view: view({
        queued: ['a2'],
        lastEventAt: NOW - 1_000,
        overlay: overlay([{ key: 'r1:0', phase: 'failed', ts: NOW - 1_000 }])
      }),
      want: { stage: 'connecting', stallLevel: 0 }
    }
  ]

  for (const c of cases) {
    test(c.name, () => {
      expect(groupTurnStage(c.view, NOW, STALL)).toEqual(c.want)
    })
  }

  test('S7 thinking / calling-tool 恒不出现（事件通道只带文本，不伪造工具相位）', () => {
    const produced = new Set(cases.map((c) => groupTurnStage(c.view, NOW, STALL).stage))
    expect(produced.has('thinking')).toBe(false)
    expect(produced.has('calling-tool')).toBe(false)
    expect(produced.has('awaiting-approval')).toBe(false)
    // 反向：五个该出现的态本表都覆盖到了（少一个 = 表在缩水而不是实现变好）。
    expect([...produced].sort()).toEqual(['connecting', 'error', 'idle', 'stalled', 'writing'])
  })
})
