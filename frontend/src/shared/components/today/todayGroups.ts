/**
 * 例外面的行模型与分组（L4 批次 2 设计 §4.2 / §4.3）—— **纯模块**：不 import react /
 * react-query / i18next，只吃三条既有读端点的响应形状，吐一份统一的行列表。
 *
 * 为什么是「固定表驱动组序」而不是排序算法：组的顺序是产品语义（等我处理恒在最上），
 * 不是数据算出来的。分桶只按「源实体读态」查表，组内才排序。
 *
 * 🔴 三条红线钉在这一层：
 *  ① run 的组只认后端 `state`（`derive_agent_run_state` 的 9 值读态）。前端**永不**从
 *    outcome / approvalState 自己推导 —— `succeeded + paused_handoff` 渲染成「成功完成」
 *    正是这么来的。switch 无 default，漏一个值 tsc 当场红。
 *  ② `paused_expired` 单列一组，不混进「等我处理」：它点不动了，混在一起等于骗人。
 *  ③ 时间戳单位分裂：`async_jobs` 是**秒 float**，`matter_*` 是**毫秒 int**。行模型的
 *    `at` 恒毫秒，跨源比较前先折算（`epochToMs`）。
 */

import type { AgentRunHistoryItem, AgentRunState } from '@shared/api/types'
import type {
  MatterAttentionSeverity,
  MatterAttentionSignal,
  MatterPendingUpdatesEntry
} from '@shared/api/types/matter'

/** 纯函数只要 key + 插值；不引 i18next 的 TFunction 类型（同 `matterDayGroups`）。 */
export type Translate = (key: string, options?: Record<string, unknown>) => string

/** 组序 = 屏幕上自上而下。改这一行就是改产品语义。 */
export const TODAY_GROUP_IDS = ['waiting', 'inProgress', 'expired', 'attention', 'recent'] as const
export type TodayGroupId = (typeof TODAY_GROUP_IDS)[number]

export type TodayItemSource = 'run' | 'proposal' | 'signal'
export type TodaySeverity = MatterAttentionSeverity

interface TodayItemBase {
  /** 跨源唯一（`{source}:{源实体主键}`）—— 条目身份 = 源实体，不是事件。 */
  id: string
  title: string
  /** 一等字段：**为什么进队列**。空串 = 组装不出（调用方按缺席渲染，不编一句话填上）。 */
  triageLogic: string
  /** 🔴 恒毫秒。run 来自秒 float，这里已折算。 */
  at: number
  severity?: TodaySeverity
}

export interface TodayRunItem extends TodayItemBase {
  source: 'run'
  /** 后端 9 值读态，原样透传。 */
  state: AgentRunState
  link: { jobId: number; agentId: string; sessionId: number | null }
}

export interface TodayProposalItem extends TodayItemBase {
  source: 'proposal'
  state: 'pending'
  link: { matterPublicId: string; updateId: number }
}

export interface TodaySignalItem extends TodayItemBase {
  source: 'signal'
  state: 'open'
  link: { matterPublicId: string; signalId: number }
}

export type TodayItem = TodayRunItem | TodayProposalItem | TodaySignalItem

export interface TodayGroup {
  id: TodayGroupId
  items: TodayItem[]
}

/** 「最近结果」的回看窗与条数上限：这一组是回顾用的，不是待办 —— 不封顶会把真正等人的
 *  条目挤到屏幕外。 */
export const TODAY_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000
export const TODAY_RECENT_LIMIT = 20

/** epoch → 毫秒。async_jobs 投影是秒 float，但同一个字段在别处（matter / notification）
 *  是毫秒整数 —— 用量级判别而不是「相信调用方传对了」（同 RunHistorySection::fmtTime）。 */
export function epochToMs(ts: number | null | undefined): number {
  if (ts == null || !Number.isFinite(ts)) return 0
  return ts < 1e12 ? Math.round(ts * 1000) : Math.round(ts)
}

const SEVERITY_RANK: Record<TodaySeverity, number> = { critical: 3, warn: 2, info: 1 }

function severityRank(severity: TodaySeverity | undefined): number {
  return severity === undefined ? 0 : SEVERITY_RANK[severity]
}

function assertNever(x: never): never {
  throw new Error(`unhandled AgentRunState: ${String(x)}`)
}

/**
 * 一条行归哪个组。`null` = 不进例外面（例：24h 之外的终态 run）。
 *
 * 🔴 matter 跟进 run **不在这张表里**：它没有全局 list 端点，而且失败已由 `run_failed`
 * 信号覆盖、产出已由提案覆盖 —— 直接纳入只会让同一件事出现两遍（`warn` 那档还会被误
 * 归失败，0813 dogfood #17）。
 */
export function todayGroupOf(item: TodayItem, nowMs: number): TodayGroupId | null {
  if (item.source !== 'run') return 'waiting'
  const state: AgentRunState = item.state
  switch (state) {
    case 'paused_pending':
      return 'waiting'
    case 'queued':
    case 'running':
      return 'inProgress'
    case 'paused_expired':
      return 'expired'
    case 'failed':
      return 'attention'
    case 'completed':
    case 'skipped':
    case 'paused_approved':
    case 'paused_rejected':
      return nowMs - item.at <= TODAY_RECENT_WINDOW_MS ? 'recent' : null
  }
  return assertNever(state)
}

/** 组内排序。「等我处理」按 severity 降序 + 等龄降序（等得最久的在前）；其余组按发生
 *  时刻降序（最新的在前）。 */
function compareInGroup(groupId: TodayGroupId, a: TodayItem, b: TodayItem): number {
  if (groupId === 'waiting') {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity)
    if (bySeverity !== 0) return bySeverity
    // 等龄降序 = 时刻升序（老的在前）。
    if (a.at !== b.at) return a.at - b.at
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
  if (a.at !== b.at) return b.at - a.at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 分桶 + 组内排序 + 「最近结果」封顶。空组不返回（渲染面因此不需要判空）。 */
export function groupTodayItems(items: readonly TodayItem[], nowMs: number): TodayGroup[] {
  const buckets = new Map<TodayGroupId, TodayItem[]>()
  for (const item of items) {
    const groupId = todayGroupOf(item, nowMs)
    if (groupId === null) continue
    const bucket = buckets.get(groupId)
    if (bucket) bucket.push(item)
    else buckets.set(groupId, [item])
  }
  const groups: TodayGroup[] = []
  for (const id of TODAY_GROUP_IDS) {
    const bucket = buckets.get(id)
    if (!bucket || bucket.length === 0) continue
    bucket.sort((a, b) => compareInGroup(id, a, b))
    groups.push({ id, items: id === 'recent' ? bucket.slice(0, TODAY_RECENT_LIMIT) : bucket })
  }
  return groups
}

// ── 行装配（三条源各一份） ──────────────────────────────────────────────────

/** 已知触发方式 → 文案 key。值域与 `ChatSessionTriggerKind` / `run_worker.py::_run_title`
 *  的映射同源；认不出的 kind **原样显示**（编一个「未知触发」比显示 `foo_bar` 更没用）。 */
const TRIGGER_LABEL_KEY: Readonly<Record<string, string>> = {
  manual: 'today.trigger.manual',
  cron: 'today.trigger.cron',
  schedule: 'today.trigger.schedule',
  email_filter: 'today.trigger.emailFilter',
  calendar_event_change: 'today.trigger.calendarChange',
  calendar_before_start: 'today.trigger.calendarBefore'
}

export interface TodayBuildContext {
  t: Translate
  /** agentId → 显示名。缺席回落 agentId（run 投影本身不带 agent 标题）。 */
  agentTitles: ReadonlyMap<string, string>
  /** ISO → 本地时间串。locale 相关，注入进来让本模块保持纯（也让测试可断言）。 */
  formatDateTime: (iso: string) => string
}

/** run 的 triage 说明 = 触发方式（+ 触发时刻）。等我处理那一组另有服务端审批 preview，
 *  由渲染层 live 查 `/approval/pending` 后补一行 —— 那是进程内存真值，取不到时必须
 *  诚实降级，不能预先编进这里。 */
function runTriageLogic(run: AgentRunHistoryItem, ctx: TodayBuildContext): string {
  const kind = run.triggerKind
  if (kind == null || kind.length === 0) return ''
  const labelKey = TRIGGER_LABEL_KEY[kind]
  const trigger = labelKey === undefined ? kind : ctx.t(labelKey)
  const iso = run.triggerFiredAtIso
  // 时刻认不出（缺席 / 畸形 ISO）→ 只报触发方式，不显示 "Invalid Date"。
  const at = iso == null || iso.length === 0 ? '' : ctx.formatDateTime(iso)
  return at.length === 0
    ? ctx.t('today.triage.runTrigger', { trigger })
    : ctx.t('today.triage.runTriggerAt', { trigger, at })
}

function buildRunItems(
  runs: readonly AgentRunHistoryItem[],
  ctx: TodayBuildContext
): TodayRunItem[] {
  return runs.map((run) => ({
    id: `run:${run.jobId}`,
    source: 'run' as const,
    state: run.state,
    // 标题读 agent 名；投影里没有 agent 标题（那是单条端点才有的 `agentTitle`）。
    title: ctx.agentTitles.get(run.agentId) ?? run.agentId,
    triageLogic: runTriageLogic(run, ctx),
    at: epochToMs(run.finishedAt ?? run.createdAt),
    // severity 只喂「等我处理」的组内排序与色调：等审批 / 失败与通知中心同口径记 warn，
    // 其余读态不着色。
    ...(run.state === 'paused_pending' || run.state === 'failed'
      ? { severity: 'warn' as const }
      : {}),
    link: { jobId: run.jobId, agentId: run.agentId, sessionId: run.sessionId ?? null }
  }))
}

function buildProposalItems(
  entries: readonly MatterPendingUpdatesEntry[],
  ctx: TodayBuildContext
): TodayProposalItem[] {
  const items: TodayProposalItem[] = []
  for (const entry of entries) {
    for (const update of entry.updates) {
      // 🔴 `is_stale` 与 `review_status` 是**正交**两轴：事项版本前进后那条提案还挂着
      // pending，但它锚定的已经不是当前状态了 —— 让人去评审一份过期提案是浪费。
      if (update.review_status !== 'pending' || update.is_stale) continue
      const parts: string[] = []
      if (update.summary != null && update.summary.length > 0) parts.push(update.summary)
      parts.push(ctx.t('today.triage.proposalChanges', { count: update.change_count }))
      if (update.confidence != null) {
        parts.push(
          ctx.t('today.triage.proposalConfidence', {
            percent: Math.round(update.confidence * 100)
          })
        )
      }
      items.push({
        id: `proposal:${update.id}`,
        source: 'proposal',
        state: 'pending',
        title: ctx.t('today.item.proposalTitle'),
        triageLogic: parts.join(' · '),
        at: update.created_at,
        severity: 'info',
        link: { matterPublicId: entry.matter_public_id, updateId: update.id }
      })
    }
  }
  return items
}

function buildSignalItems(
  signals: readonly MatterAttentionSignal[],
  mattersWithProposal: ReadonlySet<string>,
  ctx: TodayBuildContext
): TodaySignalItem[] {
  const items: TodaySignalItem[] = []
  for (const signal of signals) {
    const publicId = signal.matter?.public_id
    // 拿不到事项主键 / 信号主键 = 这一条点不动（triage 端点是 per-matter 的）——
    // 渲染一条按了没反应的行比不渲染更糟。
    if (signal.id == null || publicId == null || publicId.length === 0) continue
    if (signal.state !== 'open') continue
    // 🔴 与 `AttnBand` 同一条去重：提案落库时**同事务**开一条 `needs_review` 信号，
    // 两者说的是同一件事。提案在场时只留提案（它才是能评审的那一条）。
    if (signal.kind === 'needs_review' && mattersWithProposal.has(publicId)) continue
    items.push({
      id: `signal:${signal.id}`,
      source: 'signal',
      state: 'open',
      title: signal.matter?.title ?? publicId,
      // `why` 是后端写好的中文一句话 —— 例外面的 triage 说明最强的一份现成素材。
      triageLogic:
        signal.why != null && signal.why.length > 0
          ? signal.why
          : ctx.t(`matters.attention.kind.${signal.kind}`),
      at: signal.first_opened_at ?? signal.last_observed_at ?? 0,
      severity: signal.severity ?? 'info',
      link: { matterPublicId: publicId, signalId: signal.id }
    })
  }
  return items
}

export interface TodaySourceData {
  runs: readonly AgentRunHistoryItem[]
  proposals: readonly MatterPendingUpdatesEntry[]
  signals: readonly MatterAttentionSignal[]
}

/** 三条源 → 一份统一行列表（未分组）。分组交给 `groupTodayItems`。 */
export function buildTodayItems(data: TodaySourceData, ctx: TodayBuildContext): TodayItem[] {
  const proposals = buildProposalItems(data.proposals, ctx)
  const mattersWithProposal = new Set(proposals.map((item) => item.link.matterPublicId))
  return [
    ...buildRunItems(data.runs, ctx),
    ...proposals,
    ...buildSignalItems(data.signals, mattersWithProposal, ctx)
  ]
}
