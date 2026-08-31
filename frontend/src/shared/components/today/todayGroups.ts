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
  MatterAttentionKind,
  MatterAttentionSeverity,
  MatterAttentionSignal,
  MatterItemDispatch,
  MatterItemDispatchState,
  MatterPendingUpdatesEntry
} from '@shared/api/types/matter'

/** 纯函数只要 key + 插值；不引 i18next 的 TFunction 类型（同 `matterDayGroups`）。 */
export type Translate = (key: string, options?: Record<string, unknown>) => string

/** 组序 = 屏幕上自上而下。改这一行就是改产品语义。 */
export const TODAY_GROUP_IDS = ['waiting', 'inProgress', 'expired', 'attention', 'recent'] as const
export type TodayGroupId = (typeof TODAY_GROUP_IDS)[number]

export type TodayItemSource = 'run' | 'proposal' | 'signal' | 'dispatch'
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
  /** 信号种别，原样透传。P4c 起五节要按它把「临期」那三种分出去（`todaySections`
   *  的 `isDueSignalKind`）—— 判据是**后端的产生条件**，不是前端另定的标签。 */
  kind: MatterAttentionKind
  link: { matterPublicId: string; signalId: number }
}

/**
 * 一次行动项派发（L4 批次 3）。`state` 是**服务端 CAS 推进**的执行态，前端与 run 那条
 * 同一条纪律：只透传、永不自行推导。
 *
 * 进面的只有两态（分组表在 `dispatchGroupOf`）：`awaiting_input`（agent 在等你回答）与
 * `failed`（这一轮挂了）。`proposed` **有意不进面** —— 它已经由提案那条源覆盖，纳入会让
 * 同一件事出现两遍（同 `needs_review` 信号在提案在场时被去重的取向）。
 */
export interface TodayDispatchItem extends TodayItemBase {
  source: 'dispatch'
  state: MatterItemDispatchState
  /** 回答 / 取消都是 per-matter 的 REST 动作，所以三个标识缺一不可。 */
  link: { matterPublicId: string; itemId: number; dispatchId: number }
  /** 所属事项的标题 —— `title` 已经被行动项占了，而「哪件事」是这一行必须说清的另一半。 */
  matterTitle: string
  /** agent 的反问原文（`awaiting_input` 才有）—— 行内回答框的抬头。 */
  question: string | null
  /** 反问自带的备选项（agent 给了才有）。 */
  options: string[]
}

export type TodayItem = TodayRunItem | TodayProposalItem | TodaySignalItem | TodayDispatchItem

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

function assertNever(x: never, what: string): never {
  throw new Error(`unhandled ${what}: ${JSON.stringify(x)}`)
}

/** run 的 9 值读态 → 组。switch 无 default，漏一个值 tsc 当场红。 */
function runGroupOf(item: TodayRunItem, nowMs: number): TodayGroupId | null {
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
  return assertNever(state, 'AgentRunState')
}

/**
 * 派发的 7 值执行态 → 组。
 *
 * `queued` / `running` 不进面：例外面是**例外**，「agent 正在跑」不是例外（要看进度去事项
 * 详情，那里有 live badge）。`proposed` 也不进面 —— 那条提案已经由提案源渲染了一行，
 * 再出一行就是同一件事出现两遍（与 `needs_review` 信号在提案在场时被去重同一条取向）。
 * `done` / `canceled` 是终局，没有下一步动作。
 */
function dispatchGroupOf(state: MatterItemDispatchState): TodayGroupId | null {
  switch (state) {
    case 'awaiting_input':
      return 'waiting'
    case 'failed':
      return 'attention'
    case 'queued':
    case 'running':
    case 'proposed':
    case 'done':
    case 'canceled':
      return null
  }
  return assertNever(state, 'MatterItemDispatchState')
}

/**
 * 一条行归哪个组。`null` = 不进例外面（例：24h 之外的终态 run、还在跑的派发）。
 *
 * 🔴 **按 `source` 穷举**（批次 3 补上的闸）：批次 2 这里是 `if (item.source !== 'run')
 * return 'waiting'`，于是新加一条源会静默落进「等我处理」—— 一个不报错的错误。现在
 * switch 无 default，加 source 而不给它定组，tsc 当场红。
 *
 * 🔴 matter 跟进 run **不在这张表里**：它没有全局 list 端点，而且失败已由 `run_failed`
 * 信号覆盖、产出已由提案覆盖 —— 直接纳入只会让同一件事出现两遍（`warn` 那档还会被误
 * 归失败，0813 dogfood #17）。
 */
export function todayGroupOf(item: TodayItem, nowMs: number): TodayGroupId | null {
  switch (item.source) {
    case 'run':
      return runGroupOf(item, nowMs)
    case 'proposal':
    case 'signal':
      return 'waiting'
    case 'dispatch':
      return dispatchGroupOf(item.state)
  }
  return assertNever(item, 'TodayItemSource')
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
      kind: signal.kind,
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

/** 派发的 triage 说明：等我回答 → 反问原文；挂了 → 错误码/原因一句话。
 *  两者都拿不到时返空串（调用方按缺席渲染，不编一句话填上）。 */
function dispatchTriageLogic(dispatch: MatterItemDispatch, ctx: TodayBuildContext): string {
  if (dispatch.state === 'awaiting_input') {
    const question = dispatch.question?.question ?? ''
    return question.length > 0 ? question : ctx.t('today.triage.dispatchAsked')
  }
  // error 是服务端写的 `{code, message?}`（`fail_dispatch`）—— message 更像人话，优先它。
  const error = dispatch.error ?? {}
  const message = typeof error.message === 'string' ? error.message : ''
  if (message.length > 0) return message
  const code = typeof error.code === 'string' ? error.code : ''
  return code.length > 0 ? ctx.t('today.triage.dispatchFailed', { code }) : ''
}

function buildDispatchItems(
  dispatches: readonly MatterItemDispatch[],
  ctx: TodayBuildContext
): TodayDispatchItem[] {
  const items: TodayDispatchItem[] = []
  for (const dispatch of dispatches) {
    const publicId = dispatch.matter_public_id
    // 跨事项读面才带 `matter_public_id`（逐事项那条不带）。拿不到 = 这一行的回答 / 取消
    // 都点不动（两个端点都是 per-matter 的）—— 渲染一条按了没反应的行比不渲染更糟。
    if (publicId == null || publicId.length === 0) continue
    // `awaiting_since` 才是「等了多久」的起点；挂了那条用终止时刻。都缺席时回落 updated_at。
    const at =
      dispatch.state === 'awaiting_input'
        ? (dispatch.awaiting_since ?? dispatch.updated_at)
        : (dispatch.ended_at ?? dispatch.updated_at)
    items.push({
      id: `dispatch:${dispatch.id}`,
      source: 'dispatch',
      state: dispatch.state,
      // 标题 = 那条行动项（这一行要处理的东西）；事项名另占一格（`matterTitle`）。
      title: dispatch.item_title ?? dispatch.matter_title ?? publicId,
      matterTitle: dispatch.matter_title ?? publicId,
      triageLogic: dispatchTriageLogic(dispatch, ctx),
      at: epochToMs(at),
      // 「等人」与「挂了」都记 warn（与 run 的 paused_pending / failed 同口径）：两者的
      // **区分**靠组（waiting vs attention）与行内文案，不靠 severity 分档。
      severity: 'warn',
      link: { matterPublicId: publicId, itemId: dispatch.item_id, dispatchId: dispatch.id },
      question: dispatch.question?.question ?? null,
      options: dispatch.question?.options ?? []
    })
  }
  return items
}

export interface TodaySourceData {
  runs: readonly AgentRunHistoryItem[]
  proposals: readonly MatterPendingUpdatesEntry[]
  signals: readonly MatterAttentionSignal[]
  /** L4 批次 3 第四源。缺席 = 事项总闸关着 / 还没落地。 */
  dispatches?: readonly MatterItemDispatch[]
}

/** 四条源 → 一份统一行列表（未分组）。分组交给 `groupTodayItems`。 */
export function buildTodayItems(data: TodaySourceData, ctx: TodayBuildContext): TodayItem[] {
  const proposals = buildProposalItems(data.proposals, ctx)
  const mattersWithProposal = new Set(proposals.map((item) => item.link.matterPublicId))
  return [
    ...buildRunItems(data.runs, ctx),
    ...proposals,
    ...buildSignalItems(data.signals, mattersWithProposal, ctx),
    ...buildDispatchItems(data.dispatches ?? [], ctx)
  ]
}
