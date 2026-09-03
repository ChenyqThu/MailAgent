// task 08-27 P4a（lane team-shell）— 记录列时间线纯函数（teamTimeline.ts）。
//
// 🔴 design §8.1 点名的恒绿陷阱：穿插排序用例必须构造「会话时间落在两次执行之间」的
// 数据 —— 输入顺序、按来源分块顺序都 ≠ 期望顺序，去掉 sort / 改成分块拼接必红。

import { describe, expect, test } from 'vitest'

import type {
  AgentRunHistoryItem,
  AgentRunLogItem,
  ChatSessionListItem,
  ProjectProgressRunItem,
  ReportListItem
} from '@shared/api/types'
import {
  epochMs,
  isMatterScopedAgentId,
  isoMs,
  matterSessionTimeline,
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

function makeRunLog(over: Partial<AgentRunLogItem> = {}): AgentRunLogItem {
  return {
    kind: 'run_log',
    runLogId: 1,
    jobId: 1,
    agentId: 'a1',
    state: 'completed',
    createdAt: '2026-08-31T00:00:00Z',
    ...over
  } as AgentRunLogItem
}

function makeReport(over: Partial<ReportListItem> = {}): ReportListItem {
  return {
    id: 'r1',
    agent_id: 'a1',
    cadence: 'daily',
    report_date: '2026-08-30',
    status: 'ready',
    headline: 'x',
    created_at: 1_700_000_000,
    generated_at: 1_700_000_100,
    ...over
  } as ReportListItem
}

/** progress 台账行的时间是 Unix **秒**（run_log 是 ISO，run 行是毫秒 epoch）——
 *  三种时间制在这个文件里同屏出现，fixture 一律经这个换算写，别手抄裸数字。 */
function secs(iso: string): number {
  return Date.parse(iso) / 1000
}

function makeProgress(over: Partial<ProjectProgressRunItem> = {}): ProjectProgressRunItem {
  return {
    internalId: 9,
    status: 'completed',
    startedAt: secs('2026-08-31T03:00:00Z'),
    ...over
  } as ProjectProgressRunItem
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

// 09-02 misc05 —「事项跟进」成员的记录列（anchor 归属，与 agentId exact-match 无关）。
// anchor 收窄在 useMatterAnchoredSessions（组件级用例 TeamWorkspace.test 守）；这里守投影与排序。
describe('matterSessionTimeline — 倒序投影', () => {
  test('输入顺序打乱仍按时间倒序（不是「拿到什么顺序就渲染什么顺序」）', () => {
    const entries = matterSessionTimeline([
      makeSession({ id: 1, anchor_type: 'matter', anchor_id: 7, updated_at: 1_700_000_001_000 }),
      makeSession({ id: 4, anchor_type: 'matter', anchor_id: 8, updated_at: 1_700_000_003_000 }),
      makeSession({ id: 2, anchor_type: 'matter', anchor_id: 9, updated_at: 1_700_000_002_000 })
    ])
    expect(entries.map((e) => e.key)).toEqual(['session:4', 'session:2', 'session:1'])
  })

  test('🔴 事项会话的 agent_id 恒 NULL —— 它照样在列（归属靠 anchor 不靠身份）', () => {
    const entries = matterSessionTimeline([
      makeSession({
        id: 5,
        anchor_type: 'matter',
        anchor_id: 7,
        agent_id: null,
        origin: 'interactive'
      })
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0].kind).toBe('session')
    // 人开的会话 —— 不标 ⚡；⚡判据仍是 origin='agent'（与 mergeMemberTimeline 同一句）。
    expect(entries[0].auto).toBe(false)
    expect(
      matterSessionTimeline([makeSession({ id: 6, anchor_type: 'matter', origin: 'agent' })])[0]
        .auto
    ).toBe(true)
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

  test('runLog：判据与 run 行逐字一致（非 manual 且非 null 才标）', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runLogs: [
        makeRunLog({ runLogId: 1, createdAt: '2026-08-31T04:00:00Z', triggerKind: 'schedule' }),
        makeRunLog({ runLogId: 2, createdAt: '2026-08-31T03:00:00Z', triggerKind: 'manual' }),
        makeRunLog({ runLogId: 3, createdAt: '2026-08-31T02:00:00Z', triggerKind: null })
      ]
    })
    expect(entries.map((e) => [e.key, e.auto])).toEqual([
      ['runlog:1', true],
      ['runlog:2', false],
      ['runlog:3', false]
    ])
  })
})

describe('isoMs — ISO ↔ epoch 两套时间制', () => {
  test('可解析 ISO → 毫秒；空 / 不可解析 → 0（排序落末，不伪造「现在」）', () => {
    expect(isoMs('2026-08-31T04:00:00.000Z')).toBe(Date.parse('2026-08-31T04:00:00.000Z'))
    expect(isoMs(null)).toBe(0)
    expect(isoMs('not-a-date')).toBe(0)
  })
})

describe('mergeMemberTimeline — run_log 穿插进同一条时间线', () => {
  test('run_log 时刻落在会话与执行之间（分块拼接 / 不排序都得不到这个顺序）', () => {
    // t1 执行(job) < t2 会话 < t3 run_log < t4 会话 —— 三种来源交替，任何「按来源分块」
    // 的实现都排不出下面这串。
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runs: [makeRun({ jobId: 1, createdAt: Date.parse('2026-08-31T01:00:00Z') })],
      runLogs: [makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z' })],
      sessions: [
        makeSession({ id: 100, updated_at: Date.parse('2026-08-31T02:00:00Z') }),
        makeSession({ id: 101, updated_at: Date.parse('2026-08-31T04:00:00Z') })
      ]
    })
    expect(entries.map((e) => e.key)).toEqual(['session:101', 'runlog:5', 'session:100', 'run:1'])
  })

  test('两套台账 id 各自从 1 起：同号的 run 与 run_log 都在列，key 不撞', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runs: [makeRun({ jobId: 1, createdAt: Date.parse('2026-08-31T01:00:00Z') })],
      runLogs: [makeRunLog({ runLogId: 1, createdAt: '2026-08-31T02:00:00Z' })]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:1', 'run:1'])
  })
})

// 08-31 收敛批 — 产物行（report:xxx）与过程行（runlog:N）是同一件事，靠 run_log 的
// reportId **真实引用**去重（不是时间窗启发式）。runlog 行为准，报告入口改由它的详情
// 头「去报告」提供。
describe('mergeMemberTimeline — runLog.reportId 收敛产物行', () => {
  test('同窗口：reportId 命中的 report 行被去掉，只剩 runlog 一条入口', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runLogs: [
        makeRunLog({
          runLogId: 5,
          createdAt: '2026-08-31T03:00:00Z',
          reportId: 'rep-2026-08-31'
        })
      ],
      reports: [
        makeReport({ id: 'rep-2026-08-31', generated_at: Date.parse('2026-08-31T03:00:05Z') })
      ]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:5'])
  })

  test('🔴 跨窗口不误删：runlog 引用的是别的报告时，本窗口的 report 行原样在列', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runLogs: [
        makeRunLog({
          runLogId: 5,
          createdAt: '2026-08-31T03:00:00Z',
          // 这次执行产出的是 rep-新，窗口里那份 rep-旧 是更早一次执行的产物 ——
          // 时间上紧挨着（启发式去重会误删它），但引用对不上就不许动。
          reportId: 'rep-2026-08-31'
        })
      ],
      reports: [
        makeReport({ id: 'rep-2026-08-30', generated_at: Date.parse('2026-08-31T02:59:00Z') })
      ]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:5', 'report:rep-2026-08-30'])
  })

  test('reportId 为 null（画像 / 项目周报）：一条都不去重', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runLogs: [makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z', reportId: null })],
      reports: [
        makeReport({ id: 'rep-2026-08-31', generated_at: Date.parse('2026-08-31T02:00:00Z') })
      ]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:5', 'report:rep-2026-08-31'])
  })

  test('多条 runlog 各自引用各自的产物，一一对消', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runLogs: [
        makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z', reportId: 'rep-b' }),
        makeRunLog({ runLogId: 4, createdAt: '2026-08-30T03:00:00Z', reportId: 'rep-a' })
      ],
      reports: [
        makeReport({ id: 'rep-a', generated_at: Date.parse('2026-08-30T03:00:05Z') }),
        makeReport({ id: 'rep-b', generated_at: Date.parse('2026-08-31T03:00:05Z') }),
        makeReport({ id: 'rep-orphan', generated_at: Date.parse('2026-08-29T03:00:00Z') })
      ]
    })
    // 老数据（无 run_log 的 rep-orphan）照旧在列 —— 去重只作用于有引用的那些。
    expect(entries.map((e) => e.key)).toEqual(['runlog:5', 'runlog:4', 'report:rep-orphan'])
  })

  // empty（这段时间没有新邮件）那一档同样建了 status='empty' 的 report 行，worker 的
  // out 步骤也带 report_id ⇒ 走同一条去重，不该退化成两行。
  test('空报告：empty 状态的 runlog 与「空」report 行同窗口 → 产物行被吸收', () => {
    const entries = mergeMemberTimeline({
      agentId: 'a1',
      runLogs: [
        makeRunLog({
          runLogId: 9,
          createdAt: '2026-08-31T09:00:00Z',
          // 空窗那次 run 的台账状态是 skipped（活儿跑了，只是没内容可写）。
          state: 'skipped',
          summary: '这段时间没有新邮件 · 未生成报告',
          reportId: 'rep-empty'
        })
      ],
      reports: [
        makeReport({
          id: 'rep-empty',
          status: 'empty',
          headline: '这段时间没有新邮件',
          generated_at: Date.parse('2026-08-31T09:00:02Z')
        })
      ]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:9'])
  })
})

// 项目周报同款收敛：过程行 runlog:N 与台账行 progress:{internalId} 是同一次执行，
// 靠 run_log 的 progressEmailId（首条 trig 步骤 payload.internal_id）真实引用去重。
describe('mergeMemberTimeline — runLog.progressEmailId 收敛周报台账行', () => {
  test('同窗口：progressEmailId 命中的 progress 行被去掉，只剩 runlog 一条入口', () => {
    const entries = mergeMemberTimeline({
      agentId: 'project_progress_sync',
      runLogs: [
        makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z', progressEmailId: 4321 })
      ],
      progressRuns: [makeProgress({ internalId: 4321, startedAt: secs('2026-08-31T03:00:02Z') })]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:5'])
  })

  test('🔴 跨窗口不误删：runlog 引用的是别封邮件时，本窗口的 progress 行原样在列', () => {
    const entries = mergeMemberTimeline({
      agentId: 'project_progress_sync',
      runLogs: [
        // 这次跑的是 4321；窗口里那条 9999 是更早一次同步（时间紧挨着，启发式会误删）。
        makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z', progressEmailId: 4321 })
      ],
      progressRuns: [makeProgress({ internalId: 9999, startedAt: secs('2026-08-31T02:59:00Z') })]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:5', 'progress:9999'])
  })

  test('progressEmailId 为 null（别的成员 / 坏 payload）：一条都不去重', () => {
    const entries = mergeMemberTimeline({
      agentId: 'project_progress_sync',
      runLogs: [
        makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z', progressEmailId: null })
      ],
      progressRuns: [makeProgress({ internalId: 4321, startedAt: secs('2026-08-31T02:59:00Z') })]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:5', 'progress:4321'])
  })

  test('多条各自对消；无 run_log 的老同步行照旧在列', () => {
    const entries = mergeMemberTimeline({
      agentId: 'project_progress_sync',
      runLogs: [
        makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z', progressEmailId: 4321 }),
        makeRunLog({ runLogId: 4, createdAt: '2026-08-30T03:00:00Z', progressEmailId: 4300 })
      ],
      progressRuns: [
        makeProgress({ internalId: 4321, startedAt: secs('2026-08-31T03:00:02Z') }),
        makeProgress({ internalId: 4300, startedAt: secs('2026-08-30T03:00:02Z') }),
        makeProgress({ internalId: 1000, startedAt: secs('2026-08-29T03:00:00Z') })
      ]
    })
    expect(entries.map((e) => e.key)).toEqual(['runlog:5', 'runlog:4', 'progress:1000'])
  })

  test('🔴 两套 id 各自独立：progressEmailId 不去重同号的 report 行', () => {
    const entries = mergeMemberTimeline({
      agentId: 'project_progress_sync',
      runLogs: [
        makeRunLog({ runLogId: 5, createdAt: '2026-08-31T03:00:00Z', progressEmailId: 4321 })
      ],
      reports: [makeReport({ id: '4321', generated_at: Date.parse('2026-08-31T03:00:05Z') })]
    })
    expect(entries.map((e) => e.key)).toEqual(['report:4321', 'runlog:5'])
  })
})
