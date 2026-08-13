// 状态表一致性闸：五张表（GROUPS/POOLS/EXPR_CADENCE/BLINK/AMBIENT）键集合互等 +
// 池索引不越界 + MailAgent 映射穷尽。表是手抄数据 —— 加/删状态时漏改任何一张表，
// 运行时是 undefined cadence 静默炸，这里编译期/测试期就红。

import { describe, expect, test } from 'vitest'

import { EXPRESSIONS } from '../../../src/shared/bot-avatar/expressions'
import {
  AMBIENT,
  BLINK,
  BOT_STATES,
  EXPR_CADENCE,
  GROUPS,
  POOLS,
  runStateToBotState,
  turnStageToBotState
} from '../../../src/shared/bot-avatar/states'
import type { BotState } from '../../../src/shared/bot-avatar/states'

const stateSet = new Set<string>(BOT_STATES)

describe('bot-avatar states 五张表', () => {
  test('GROUPS 展平 = 39 个不重复状态', () => {
    expect(BOT_STATES).toHaveLength(39)
    expect(stateSet.size).toBe(39)
    // 组规模钉死：生命周期 7 / 反应 16 / agent 形态 3 / 产品周期 13
    expect(GROUPS.lifecycle).toHaveLength(7)
    expect(GROUPS.reactions).toHaveLength(16)
    expect(GROUPS.agentMorphs).toHaveLength(3)
    expect(GROUPS.productCycle).toHaveLength(13)
  })

  test('POOLS / EXPR_CADENCE / BLINK / AMBIENT 键集合 = GROUPS 展平集', () => {
    for (const table of [POOLS, EXPR_CADENCE, BLINK, AMBIENT]) {
      const keys = Object.keys(table)
      expect(keys).toHaveLength(39)
      for (const key of keys) expect(stateSet.has(key)).toBe(true)
    }
  })

  test('每个池非空，索引全部落在表情数据范围内', () => {
    for (const state of BOT_STATES) {
      const pool = POOLS[state]
      expect(pool.length).toBeGreaterThan(0)
      for (const index of pool) {
        expect(Number.isInteger(index)).toBe(true)
        expect(index).toBeGreaterThanOrEqual(0)
        expect(index).toBeLessThan(EXPRESSIONS.length)
      }
    }
  })

  test('studio 新增两表情（25/26）已归池且可达（0813 拍板：25→angry / 26→scared）', () => {
    // 27 表全量搬进后 25/26 不许成孤儿数据 —— 归池即「加上」的产品语义落点。
    expect(POOLS.angry).toContain(25)
    expect(POOLS.scared).toContain(26)
    const referenced = new Set(BOT_STATES.flatMap((state) => [...POOLS[state]]))
    expect(referenced.has(25)).toBe(true)
    expect(referenced.has(26)).toBe(true)
  })

  test('节奏区间合法：0 < min ≤ max；眨眼时长档 ∈ [180, 500]ms（v2 分档）', () => {
    for (const state of BOT_STATES) {
      const cadence = EXPR_CADENCE[state]
      expect(cadence[0]).toBeGreaterThan(0)
      expect(cadence[1]).toBeGreaterThanOrEqual(cadence[0])
      const blink = BLINK[state]
      if (blink !== null) {
        expect(blink[0]).toBeGreaterThan(0)
        expect(blink[1]).toBeGreaterThanOrEqual(blink[0])
        // 第三元 = 眨眼时长（calm 慢 / reactive 快），越出这个带 = 大概率手滑
        expect(blink[2]).toBeGreaterThanOrEqual(180)
        expect(blink[2]).toBeLessThanOrEqual(500)
      }
    }
  })

  test('AMBIENT 值域合法；抽查产品语义（idle 缓漂 / thinking 微扫视 / scared 抖）', () => {
    for (const state of BOT_STATES) {
      const ambient = AMBIENT[state]
      expect(['none', 'microSaccades', 'shake']).toContain(ambient.eyes)
      expect(['none', 'slowDrift', 'shake']).toContain(ambient.body)
    }
    expect(AMBIENT.idle).toEqual({ eyes: 'none', body: 'slowDrift' })
    expect(AMBIENT.thinking.eyes).toBe('microSaccades')
    expect(AMBIENT.scared).toEqual({ eyes: 'shake', body: 'shake' })
    // 完全静止态存在（waking/spawning/powering-down）——引擎 settle 语义依赖它
    expect(AMBIENT.waking).toEqual({ eyes: 'none', body: 'none' })
    expect(AMBIENT['powering-down']).toEqual({ eyes: 'none', body: 'none' })
  })
})

describe('MailAgent 状态映射（prd §6.4）', () => {
  test('turnStageToBotState：8 个 TurnStage 全映射到合法引擎状态', () => {
    // 字面量数组过函数签名的 TurnStage union —— 上游加值时这里编译期红
    const stages = [
      'idle',
      'connecting',
      'thinking',
      'calling-tool',
      'writing',
      'awaiting-approval',
      'stalled',
      'error'
    ] as const
    expect(stages).toHaveLength(8)
    for (const stage of stages) {
      const mapped: BotState = turnStageToBotState(stage)
      expect(stateSet.has(mapped)).toBe(true)
    }
    // 语义抽查（prd 表逐行）
    expect(turnStageToBotState('connecting')).toBe('waking')
    expect(turnStageToBotState('calling-tool')).toBe('searching')
    expect(turnStageToBotState('awaiting-approval')).toBe('notifying')
    expect(turnStageToBotState('stalled')).toBe('drowsy')
    expect(turnStageToBotState('error')).toBe('sad')
  })

  test('runStateToBotState：6 个投影态全映射到合法引擎状态', () => {
    const statuses = [
      'queued',
      'running',
      'waiting_approval',
      'completed',
      'failed',
      'stopped'
    ] as const
    expect(statuses).toHaveLength(6)
    for (const status of statuses) {
      const mapped: BotState = runStateToBotState(status)
      expect(stateSet.has(mapped)).toBe(true)
    }
    expect(runStateToBotState('queued')).toBe('loading')
    expect(runStateToBotState('running')).toBe('working')
    expect(runStateToBotState('stopped')).toBe('powering-down')
  })
})
