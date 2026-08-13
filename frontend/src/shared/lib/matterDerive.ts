import type {
  Matter,
  MatterAttentionSignal,
  MatterItem,
  MatterPriority,
  MatterUpdateSummary
} from '@shared/api/types/matter'

export const MATTER_VIEWS = [
  'focus',
  'attention',
  'review',
  'active',
  'waiting',
  'blocked',
  'planned',
  'monitoring',
  'all',
  'completed',
  'archived',
  'trash'
] as const
export type MatterView = (typeof MATTER_VIEWS)[number]

const PRIORITY_RANK: Record<MatterPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 }

export function isLiveMatter(matter: Matter): boolean {
  return matter.archived_at === null && matter.deleted_at === null
}

export type MatterAttentionIndex = ReadonlyMap<string, readonly MatterAttentionSignal[]>
export type MatterUpdateIndex = ReadonlyMap<string, readonly MatterUpdateSummary[]>

export function openAttentionFor(
  matter: Matter,
  attention?: MatterAttentionIndex
): MatterAttentionSignal[] {
  return [...(attention?.get(matter.public_id) ?? matter.attention_signals ?? [])].filter(
    (signal) => signal.state === 'open'
  )
}

export function filterView(
  matters: readonly Matter[],
  view: MatterView,
  attention?: MatterAttentionIndex,
  updates?: MatterUpdateIndex
): Matter[] {
  if (view === 'trash') return matters.filter((matter) => matter.deleted_at !== null)
  if (view === 'archived') {
    return matters.filter((matter) => matter.archived_at !== null && matter.deleted_at === null)
  }

  const live = matters.filter(isLiveMatter)
  if (view === 'attention')
    return live.filter((matter) => openAttentionFor(matter, attention).length > 0)
  if (view === 'review')
    return live.filter(
      (matter) =>
        updates?.get(matter.public_id)?.some((update) => update.review_status === 'pending') ??
        false
    )
  if (view === 'all') {
    return live.filter((matter) => matter.status !== 'done' && matter.status !== 'canceled')
  }
  if (view === 'completed') {
    return live.filter((matter) => matter.status === 'done' || matter.status === 'canceled')
  }
  if (view === 'focus') {
    return live
  }
  return live.filter((matter) => matter.status === view)
}

export function rankOf(
  matter: Matter,
  attention?: MatterAttentionIndex
): readonly [number, number, number] {
  const openSignals = openAttentionFor(matter, attention)
  const attentionRank = openSignals.some((signal) => signal.severity === 'critical')
    ? 0
    : openSignals.length > 0
      ? 1
      : 2
  return [attentionRank, PRIORITY_RANK[matter.priority], matter.due_at ?? Number.MAX_SAFE_INTEGER]
}

export function compareMatterRank(
  left: Matter,
  right: Matter,
  attention?: MatterAttentionIndex
): number {
  const a = rankOf(left, attention)
  const b = rankOf(right, attention)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || right.updated_at - left.updated_at
}

/** 事项有没有一个明确的下一步。
 *
 * 🔴 判定与文案分离：`deriveFocusStats` 的「健康」以前是拿 `nextAction()` 的返回串
 * `.includes('缺少下一步')` 判的 —— 改一下那句措辞（或把它 i18n 化）就会让健康率**静默失效**，
 * 而且没有任何测试会红。语义单源放这里，文案只负责展示。 */
export function hasNextAction(
  matter: Matter,
  items: readonly MatterItem[] = matter.items ?? []
): boolean {
  const actions = items.filter((item) => item.kind === 'action' && item.deleted_at === null)
  if (actions.some((item) => item.status === 'open' || item.status === 'in_progress')) return true
  if (actions.some((item) => item.status === 'waiting')) return true
  if (
    items.some(
      (item) => item.kind === 'blocker' && item.deleted_at === null && item.status !== 'done'
    )
  )
    return true
  return matter.status === 'monitoring' || matter.status === 'done'
}

export type MatterNextActionKind =
  | 'action'
  | 'waiting'
  | 'blocker'
  | 'monitoring'
  | 'done'
  | 'missing'

/** 「下一步」的**结构化**结果：文案交给 i18n，色调照设计 `list.jsx::nextAction` 的 tone。
 *
 * 🔴 返回描述符而不是成品字符串 —— 四句中文原本硬编码在这里直接上屏（G-34），而 tone 又
 * 是设计要的第二个维度；把两者塞进一个字符串就等于逼调用方再解析一次。tone 的值域刻意写
 * 成 `MatterTone` 的子集字面量：`matterVocab` 住在 components/ 下，lib 不反向依赖它。 */
export interface MatterNextActionDescriptor {
  kind: MatterNextActionKind
  /** 条目标题（用户内容，永不翻译）；派生句式时为 null。 */
  title: string | null
  tone: 'neutral' | 'warn' | 'critical'
}

export function nextAction(
  matter: Matter,
  items: readonly MatterItem[] = matter.items ?? []
): MatterNextActionDescriptor {
  const actions = items.filter((item) => item.kind === 'action' && item.deleted_at === null)
  const ready = actions.find((item) => item.status === 'open' || item.status === 'in_progress')
  if (ready) return { kind: 'action', title: ready.title, tone: 'neutral' }

  const waiting = actions.find((item) => item.status === 'waiting')
  if (waiting) return { kind: 'waiting', title: waiting.title, tone: 'warn' }

  const blocker = items.find(
    (item) => item.kind === 'blocker' && item.deleted_at === null && item.status !== 'done'
  )
  if (blocker) return { kind: 'blocker', title: blocker.title, tone: 'critical' }

  if (matter.status === 'monitoring') return { kind: 'monitoring', title: null, tone: 'neutral' }
  if (matter.status === 'done') return { kind: 'done', title: null, tone: 'neutral' }
  return { kind: 'missing', title: null, tone: 'warn' }
}

/** 相对时间（设计 `helpers.jsx::fmtAgo`）。走 Intl 而不是手写中文串 —— 组件里不硬编码文案。
 *
 * 住在 lib 而非 MatterDetail.tsx：清单行的「更新时间」与详情头的「创建于」要的是同一份
 * 口径，抄第二份就会漂（CLAUDE.md「跨边界手抄常量」同理，这里能消灭镜像就不建闸）。 */
export function formatMatterAgo(at: number, now: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minutes = Math.round((at - now) / 60_000)
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 30) return rtf.format(days, 'day')
  return rtf.format(Math.round(days / 30), 'month')
}

/** 到期日的相对说法（设计 `helpers.jsx::fmtDue` 的短文案位）。整天粒度，与 `matterDueTone`
 *  的判据同一个「按自然日取整」口径，免得色和字对不上。 */
export function formatMatterDueRelative(dueAt: number, now: number, locale: string): string {
  const startOfDay = (value: number): number => {
    const date = new Date(value)
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY)
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day')
}

export function trashDaysRemaining(matter: Matter, now = Date.now()): number | null {
  if (matter.deleted_at === null) return null
  const purgeAt = matter.purge_after ?? matter.deleted_at + 30 * 24 * 60 * 60 * 1000
  return Math.max(0, Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000)))
}

const DAY = 86_400_000

export interface FocusStats {
  openCount: number
  attentionCount: number
  reviewCount: number
  dueSoonCount: number
  healthyRate: number | null
}

/** Focus 页四指标（design-handoff 附录 E）：到期窗 14 天、健康活跃 = 8 天内有已接受状态
 *  且有明确下一步。住在 lib 而非 MatterFocus.tsx —— 组件文件只能导出组件（react-refresh）。 */
export function deriveFocusStats(
  matters: readonly Matter[],
  signals: readonly MatterAttentionSignal[],
  updates: ReadonlyMap<string, readonly MatterUpdateSummary[]>,
  now: number
): FocusStats {
  const live = matters.filter(isLiveMatter)
  const open = live.filter((matter) => matter.status !== 'done' && matter.status !== 'canceled')
  const dueSoonCount = open.filter(
    (matter) => matter.due_at != null && matter.due_at >= now && matter.due_at <= now + 14 * DAY
  ).length
  const healthy = open.filter(
    (matter) =>
      matter.summary_at != null && matter.summary_at >= now - 8 * DAY && hasNextAction(matter)
  ).length
  return {
    openCount: open.length,
    attentionCount: signals.filter((signal) => signal.state === 'open').length,
    reviewCount: [...updates.values()].reduce(
      (count, items) => count + items.filter((item) => item.review_status === 'pending').length,
      0
    ),
    dueSoonCount,
    healthyRate: open.length === 0 ? null : Math.round((healthy / open.length) * 100)
  }
}
