// task 08-27 P4a（lane team-shell）— 记录列时间线：会话 + 执行合并后按时间倒序穿插。
//
// design §8.1 的三条铁律在这里落地（纯函数，组件只渲染结果）：
//   🔴 不按来源分块 —— 手动会话与自动执行穿插排序（同一个成员干的事本来就是一条线）。
//   🔴 有 sessionId 的 run 与其 session 是同一件事，去重且 run 行为准（run 行带
//      state/triggerKind/耗时，比会话行信息多）。
//   🔴 `ai_chat_sessions.agent_id` 的 `matter:*` / `matter_item:*` 命名空间属事项域，
//      聚合显式排除（shared.ts TeamMemberRef 契约），不靠「exact match 查不到」侥幸。

import type {
  AgentRunHistoryItem,
  ChatSessionListItem,
  ProjectProgressRunItem,
  ReportListItem
} from '@shared/api/types'

export type TeamRecordEntry =
  | { kind: 'run'; key: string; at: number; auto: boolean; run: AgentRunHistoryItem }
  | { kind: 'session'; key: string; at: number; auto: boolean; session: ChatSessionListItem }
  | { kind: 'report'; key: string; at: number; auto: boolean; report: ReportListItem }
  | { kind: 'progress'; key: string; at: number; auto: boolean; progress: ProjectProgressRunItem }

/** epoch 秒/毫秒容错 → 毫秒（AgentRecordView.agoMs 同款判据）。 */
export function epochMs(ts: number | null | undefined): number {
  if (ts == null) return 0
  return ts < 1e12 ? ts * 1000 : ts
}

/** 事项域命名空间（run_spec.py 写 `matter:{public_id}`，行动项写 `matter_item:…`）。 */
export function isMatterScopedAgentId(agentId: string | null | undefined): boolean {
  return agentId != null && (agentId.startsWith('matter:') || agentId.startsWith('matter_item:'))
}

export function mergeMemberTimeline(input: {
  /** 成员 id（report_agent 行 id）。 */
  agentId: string
  /** 全量 agent-origin 会话（调用方不必预过滤，这里按 agent_id 精确匹配 + 显式排除事项域）。 */
  sessions?: readonly ChatSessionListItem[]
  runs?: readonly AgentRunHistoryItem[]
  reports?: readonly ReportListItem[]
  progressRuns?: readonly ProjectProgressRunItem[]
}): TeamRecordEntry[] {
  const { agentId } = input
  const runs = input.runs ?? []

  // run.sessionId 命中的会话行是同一件事 —— run 行为准。
  const runSessionIds = new Set<number>()
  for (const run of runs) {
    if (run.sessionId != null) runSessionIds.add(run.sessionId)
  }

  const entries: TeamRecordEntry[] = []

  for (const run of runs) {
    entries.push({
      kind: 'run',
      key: `run:${run.jobId}`,
      at: epochMs(run.createdAt),
      // ⚡自动 = 有可信触发来源且不是手动试跑；老行 triggerKind 缺失时不硬标（诚实优先）。
      auto: run.triggerKind != null && run.triggerKind !== 'manual',
      run
    })
  }

  for (const session of input.sessions ?? []) {
    if (session.agent_id !== agentId) continue
    // 契约要求的显式排除（exact match 已挡住，但不靠它侥幸）。
    if (isMatterScopedAgentId(session.agent_id)) continue
    if (runSessionIds.has(session.id)) continue
    entries.push({
      kind: 'session',
      key: `session:${session.id}`,
      at: epochMs(session.updated_at),
      // origin='agent' = headless run 产生的会话（run 台账还没接上它时的降级形态）。
      auto: session.origin === 'agent',
      session
    })
  }

  for (const report of input.reports ?? []) {
    entries.push({
      kind: 'report',
      key: `report:${report.id}`,
      at: epochMs(report.generated_at ?? report.created_at),
      // report 行分不出「排程生成」还是「手动 runNow」（无触发字段）→ 不硬标 ⚡。
      auto: false,
      report
    })
  }

  for (const progress of input.progressRuns ?? []) {
    entries.push({
      kind: 'progress',
      key: `progress:${progress.internalId}`,
      at: epochMs(progress.startedAt ?? progress.completedAt),
      // 项目周报同步只由「收信命中触发词」触发（确定性 runner，无 UI 手动跑面）。
      auto: true,
      progress
    })
  }

  // 时间倒序；同刻按 key 稳定排（避免 refetch 抖动）。
  return entries.sort((a, b) => (b.at !== a.at ? b.at - a.at : a.key.localeCompare(b.key)))
}
