// L4 群聊 g3 — exportGroupReplay（groupReplay.ts）的列口径与排序契约。
//
// 纯数据：三个群的消息行 + turn 台账由测试直接注入（ReplaySource），不经调度器。
//   R1 三群消息 + turn 合并后按时间单调，并列时消息在前
//   R2 messageId 为空的 silent / held_dup / skipped / failed / stopped turn 各成一行
//   R3 game_over / group_stop 系统行标注；其它系统行不渲染
//   R4 空输入 → 只有表头
//   R5 titleOf 缺 → 用 agentId

import { describe, expect, test } from 'vitest'

import {
  exportGroupReplay,
  type ReplayHistoryRow,
  type ReplaySource
} from '../../src/ai-gateway/groupReplay'

type Turn = ReturnType<ReplaySource['listTurns']>[number]

function row(
  id: number,
  createdAt: number,
  role: 'user' | 'assistant' | 'system',
  content: string,
  speakerAgentId: string | null = null,
  extra: Partial<ReplayHistoryRow> = {}
): ReplayHistoryRow {
  return {
    id,
    role,
    content,
    speakerAgentId,
    status: 'complete',
    chainId: null,
    via: null,
    createdAt,
    ...extra
  }
}

function turn(
  startedAt: number,
  agentId: string,
  outcome: Turn['outcome'],
  messageId: number | null = null,
  error: string | null = null
): Turn {
  return { startedAt, agentId, outcome, messageId, error }
}

function source(
  history: Record<number, ReplayHistoryRow[]>,
  turns: Record<number, Turn[]>,
  titles: Record<string, string> = { a: '甲', b: '乙' }
): ReplaySource {
  return {
    listHistory: (sid) => history[sid] ?? [],
    listTurns: (sid) => turns[sid] ?? [],
    getTitle: (sid) => ({ 1: '主群', 2: '子群' })[sid] ?? null,
    titleOf: (agentId) => titles[agentId] ?? null
  }
}

/** 表体行（去掉两行表头），按列拆开。 */
function body(md: string): string[][] {
  return md
    .split('\n')
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split(' | ')
        .map((c) => c.trim())
    )
}

describe('exportGroupReplay', () => {
  test('R1 三群消息 + turn 合并后按时间单调，并列时消息在前', () => {
    const md = exportGroupReplay(
      [1, 2, 3],
      source(
        {
          1: [row(10, 3_000, 'user', '开场'), row(12, 5_000, 'assistant', '我说', 'a')],
          2: [row(11, 4_000, 'assistant', '子群里说', 'b')]
        },
        {
          1: [turn(5_000, 'a', 'spoke', 12)],
          2: [turn(4_000, 'a', 'silent')],
          3: [turn(1_000, 'b', 'skipped', null, 'monologue')]
        }
      )
    )
    const rows = body(md)
    const times = rows.map((r) => Date.parse(r[0]!))
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!)
    expect(rows.map((r) => r[3])).toEqual([
      '(跳过:monologue)',
      '开场',
      '子群里说',
      '(沉默)',
      '我说'
    ])
    // 4_000 并列：消息（子群里说）在 turn（沉默）之前
    expect(rows[2]![1]).toBe('子群')
    expect(rows[3]![1]).toBe('子群')
    // 无标题的群用 #id
    expect(rows[0]![1]).toBe('#3')
    // spoke turn 的 outcome 挂在消息行上
    expect(rows[4]).toEqual([new Date(5_000).toISOString(), '主群', '甲', '我说', 'spoke'])
  })

  test('R2 messageId 为空的五种 turn 各成一行且内容列标注正确', () => {
    const md = exportGroupReplay(
      [1],
      source(
        {},
        {
          1: [
            turn(1_000, 'a', 'silent'),
            turn(2_000, 'a', 'held_dup'),
            turn(3_000, 'a', 'skipped', null, 'no_new_messages'),
            turn(4_000, 'b', 'failed', null, 'E_SPEAK_EMPTY'),
            turn(5_000, 'b', 'stopped', null, 'chain_cap')
          ]
        }
      )
    )
    expect(body(md).map((r) => [r[2], r[3], r[4]])).toEqual([
      ['甲', '(沉默)', 'silent'],
      ['甲', '(重复折叠)', 'held_dup'],
      ['甲', '(跳过:no_new_messages)', 'skipped'],
      ['乙', '(失败)', 'failed'],
      ['乙', '(停止:chain_cap)', 'stopped']
    ])
  })

  test('R3 game_over / group_stop 系统行标注；judge_post / 脏 metadata 的系统行不渲染', () => {
    const md = exportGroupReplay(
      [1],
      source(
        {
          1: [
            row(1, 1_000, 'system', '', null, {
              metadata: JSON.stringify({ kind: 'judge_post', targetSessionId: 2 })
            }),
            row(2, 2_000, 'system', 'session_cap', null, {
              metadata: JSON.stringify({ kind: 'group_stop', reason: 'session_cap', runId: 'r' })
            }),
            row(3, 3_000, 'system', '', null, { metadata: '{not json' }),
            row(4, 4_000, 'system', '', null, {
              metadata: JSON.stringify({ kind: 'game_over', runId: 'r', chainId: 9 })
            })
          ]
        },
        {}
      )
    )
    expect(body(md).map((r) => r[3])).toEqual(['(停止:session_cap)', '(游戏结束)'])
  })

  test('R4 空输入 → 只有表头（非空字符串）', () => {
    const md = exportGroupReplay([], source({}, {}))
    expect(md.length).toBeGreaterThan(0)
    expect(md.split('\n')).toEqual([
      '| 时间 | 群 | 发言者 | 内容 | outcome |',
      '| --- | --- | --- | --- | --- |'
    ])
    expect(exportGroupReplay([1, 2], source({}, {}))).toBe(md)
  })

  test('R5 titleOf 缺 → 用 agentId；user 行标「用户」/ 主助理投递标「主助理」；内容里的 | 与换行被转义', () => {
    const md = exportGroupReplay(
      [1],
      source(
        {
          1: [
            row(1, 1_000, 'user', '第一行\n第二行 | 竖线'),
            row(2, 2_000, 'user', '主助理投递', null, { via: 'main_agent' }),
            row(3, 3_000, 'assistant', '我是 zzz', 'zzz')
          ]
        },
        { 1: [turn(4_000, 'zzz', 'silent')] },
        {}
      )
    )
    const rows = body(md)
    expect(rows.map((r) => r[2])).toEqual(['用户', '主助理', 'zzz', 'zzz'])
    expect(md).toContain('第一行 第二行 \\| 竖线')
  })
})
