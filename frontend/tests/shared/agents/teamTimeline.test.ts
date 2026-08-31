// task 08-27 P4a（lane team-shell）— 记录列时间线纯函数（teamTimeline.ts）。
//
// 🔴 design §8.1 点名的恒绿陷阱：穿插排序用例必须构造「会话时间落在两次执行之间」的
// 数据 —— 输入顺序、按来源分块顺序都 ≠ 期望顺序，去掉 sort / 改成分块拼接必红。

import { describe, expect, test } from 'vitest'

import type {
  AgentRunHistoryItem,
  ChatSessionListItem,
  ProjectProgressRunItem,
  ReportListItem
} from '@shared/api/types'
import {
  epochMs,
  isMatterScopedAgentId,
  mergeMemberTimeline
} from '../../../src/shared/components/agents/team/teamTimeline'

function makeRun(over: Partial<AgentRunHistoryItem> = {}): AgentRunHistoryItem {
  return {
    jobId: 1,
    agentId: 'a1',
    state: 'completed',
    createdAt: 1_700_000_000_000,
    ...over
  } as AgentRunHistoryItem
}

function makeSession(over: Partial<ChatSessionListItem> = {}): ChatSessionListItem {
  return {
    id: 100,
    email_id: null,
    anchor_type: 'general',
    anchor_id: null,
    backend_kind: 'ai-sdk',
    backend_model: null,
    backend_agent_page_id: null,
    title: null,
    archived: false,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    origin: 'agent',
    agent_id: 'a1',
    first_user_message: null,
    message_count: 1,
    email_subject: null,
    email_sender: null,
    ...over
  } as ChatSessionListItem
}

describe('epochMs — 秒/毫秒容错', () => {
  test('秒时间戳 ×1000，毫秒原样，null → 0', () => {
    expect(epochMs(1_700_000_000)).toBe(1_700_000_000_000)
    expect(epochMs(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(epochMs(null)).toBe(0)
  })
})

describe('mergeMemberTimeline — 穿插排序', () => {
  test('会话按时间落在两次执行之间（不按来源分块）', () => {
    const t1 = 1_700_000_001_000
    const t2 = 1_700_000_002_000
    const t3 = 1_700_000_003_000
    // 输入顺序有意打乱：runs 给 [t1, t3]，session 在 t2 —— 分块拼接或不排序都得不到
    // [t3-run, t2-session, t1-run]。
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runs: [makeRun({ jobId: 1, createdAt: t1 }), makeRun({ jobId: 3, createdAt: t3 })],
      sessions: [makeSession({ id: 100, updated_at: t2 })]
    })
    expect(entries.map((e) => e.key)).toEqual(['run:3', 'session:100', 'run:1'])
  })
})

describe('mergeMemberTimeline — run/session 去重（run 行为准）', () => {
  test('run.sessionId 命中的会话行不再单独出现', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runs: [makeRun({ jobId: 7, sessionId: 100, createdAt: 1_700_000_003_000 })],
      sessions: [
        makeSession({ id: 100, updated_at: 1_700_000_003_500 }),
        makeSession({ id: 101, updated_at: 1_700_000_001_000 })
      ]
    })
    expect(entries.map((e) => e.key)).toEqual(['run:7', 'session:101'])
  })
})

describe('mergeMemberTimeline — 事项域命名空间显式排除', () => {
  test('matter:* / matter_item:* 会话永不进团队时间线（哪怕 agentId 精确相等）', () => {
    expect(isMatterScopedAgentId('matter:MAT-0001')).toBe(true)
    expect(isMatterScopedAgentId('matter_item:MAT-0001:5')).toBe(true)
    expect(isMatterScopedAgentId('contact_governance_agent')).toBe(false)
    const entries = mergeMemberTimeline({
      agentId: 'matter:MAT-0001',
      sessions: [makeSession({ agent_id: 'matter:MAT-0001' })]
    })
    expect(entries).toEqual([])
  })

  test('agent_id 不匹配的会话不进（exact match）', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      sessions: [makeSession({ agent_id: 'a2' })]
    })
    expect(entries).toEqual([])
  })
})

describe('mergeMemberTimeline — ⚡自动 标记', () => {
  test('run：有可信触发来源且非 manual 才标；session：origin=agent 标', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runs: [
        makeRun({ jobId: 1, triggerKind: 'schedule', createdAt: 4_000 }),
        makeRun({ jobId: 2, triggerKind: 'manual', createdAt: 3_000 }),
        makeRun({ jobId: 3, triggerKind: null, createdAt: 2_000 })
      ],
      sessions: [makeSession({ id: 100, origin: 'agent', updated_at: 1_000 })]
    })
    expect(entries.map((e) => [e.key, e.auto])).toEqual([
      ['run:1', true],
      ['run:2', false],
      ['run:3', false],
      ['session:100', true]
    ])
  })

  test('report 不硬标（分不出排程/手动）；progress 恒标（只有收信触发）', () => {
    const report = {
      id: 'r1',
      agent_id: 'a1',
      cadence: 'daily',
      report_date: '2026-08-30',
      status: 'ready',
      headline: 'x',
      created_at: 1_700_000_000,
      generated_at: 1_700_000_100
    } as ReportListItem
    const progress = {
      internalId: 9,
      status: 'completed',
      startedAt: 1_700_000_200
    } as ProjectProgressRunItem
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      reports: [report],
      progressRuns: [progress]
    })
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.auto]))
    expect(byKey['report:r1']).toBe(false)
    expect(byKey['progress:9']).toBe(true)
  })
})
