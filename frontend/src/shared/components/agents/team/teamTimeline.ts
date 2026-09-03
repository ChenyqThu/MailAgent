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
  AgentRunLogItem,
  ChatSessionListItem,
  ProjectProgressRunItem,
  ReportListItem
} from '@shared/api/types'

export type TeamRecordEntry =
  | { kind: 'run'; key: string; at: number; auto: boolean; run: AgentRunHistoryItem }
  | { kind: 'runLog'; key: string; at: number; auto: boolean; runLog: AgentRunLogItem }
  | { kind: 'session'; key: string; at: number; auto: boolean; session: ChatSessionListItem }
  | { kind: 'report'; key: string; at: number; auto: boolean; report: ReportListItem }
  | { kind: 'progress'; key: string; at: number; auto: boolean; progress: ProjectProgressRunItem }

/** epoch 秒/毫秒容错 → 毫秒（AgentRecordView.agoMs 同款判据）。 */
export function epochMs(ts: number | null | undefined): number {
  if (ts == null) return 0
  return ts < 1e12 ? ts * 1000 : ts
}

/** ISO 字符串 → 毫秒（run_log 台账的时间是 ISO，run 行是 epoch 数 —— 换算只在这一处）。
 *  不可解析 / 缺失恒 0：排序里落到最末，不伪造一个「现在」。 */
export function isoMs(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
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
  /** 08-31 — agent_run_log 台账行（报告 / 画像 / 项目周报的过程记录）。与 run / 会话
   *  同一条时间线穿插，不另开一栏。 */
  runLogs?: readonly AgentRunLogItem[]
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

  // 同理：runLog.reportId 命中的产物行与这次执行是同一件事 —— runlog 行为准（它带过程
  // transcript + 状态 / 用时，产物行只有结果）。产物的入口不丢：runlog 详情头有「去报告」。
  // 🔴 判据是**真实引用**（后端从 out 步骤 payload.report_id 抽出），不是时间窗重叠 ——
  // 后者会在一次执行产两份报告 / 补跑覆盖时误删。reportId 为 null（画像 / 项目周报——
  // 后者走下面那条 progressEmailId）或对应 report 行不在本窗口时，两侧行为都原样不变。
  const runLogReportIds = new Set<string>()
  // 项目周报同款：runLog.progressEmailId 命中的 project_progress_sync 台账行
  // （`progress:{internalId}`）与这次执行是同一件事。后端已在 API 边界加了成员语义门
  // （只对项目周报投影），前端不再二次判成员。
  const runLogProgressEmailIds = new Set<number>()
  for (const runLog of input.runLogs ?? []) {
    if (runLog.reportId) runLogReportIds.add(runLog.reportId)
    if (runLog.progressEmailId != null) runLogProgressEmailIds.add(runLog.progressEmailId)
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

  for (const runLog of input.runLogs ?? []) {
    entries.push({
      kind: 'runLog',
      // 🔴 与 `run:${jobId}` 不同前缀：两套台账的自增 id 各自从 1 起，同号必撞。
      key: `runlog:${runLog.runLogId}`,
      at: isoMs(runLog.createdAt),
      // ⚡自动的判据与 run 行逐字一致（有可信触发来源且不是手动试跑）。
      auto: runLog.triggerKind != null && runLog.triggerKind !== 'manual',
      runLog
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
    if (runLogReportIds.has(report.id)) continue
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
    if (runLogProgressEmailIds.has(progress.internalId)) continue
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

/** 09-02 misc05 —「事项跟进」成员的记录列：事项会话（`anchor_type='matter'`）排成时间线。
 *  入参已由 `useMatterAnchoredSessions` 按 anchor 收窄 —— 这里不重复判一次。
 *
 *  🔴 与 mergeMemberTimeline 的口径不相交，所以是独立一条：事项会话的 `agent_id` 恒 NULL
 *  （归属靠 anchor 而不是 agent 身份），拿它去 exact-match 成员 id 永远是空集。
 *  🔴 只有会话没有执行行：跟进 run 的台账是逐事项的（`GET /matters/{id}/runs`），跨事项
 *  的聚合面不存在 —— 这里不去 N 次请求拼一个，缺口如实写在记录面的说明里。 */
export function matterSessionTimeline(sessions: readonly ChatSessionListItem[]): TeamRecordEntry[] {
  return sessions
    .map((session) => ({
      kind: 'session' as const,
      key: `session:${session.id}`,
      at: epochMs(session.updated_at),
      // ⚡判据与 mergeMemberTimeline 逐字一致。调用方只喂 interactive 行（人开的会话，
      // 恒 false），但判据不写死 —— 来源换了这里不该跟着撒谎。
      auto: session.origin === 'agent',
      session
    }))
    .sort((a, b) => (b.at !== a.at ? b.at - a.at : a.key.localeCompare(b.key)))
}
