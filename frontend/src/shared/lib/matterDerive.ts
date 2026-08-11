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

export function nextAction(
  matter: Matter,
  items: readonly MatterItem[] = matter.items ?? []
): string {
  const actions = items.filter((item) => item.kind === 'action' && item.deleted_at === null)
  const ready = actions.find((item) => item.status === 'open' || item.status === 'in_progress')
  if (ready) return ready.title

  const waiting = actions.find((item) => item.status === 'waiting')
  if (waiting) return `等 ${waiting.title}`

  const blocker = items.find(
    (item) => item.kind === 'blocker' && item.deleted_at === null && item.status !== 'done'
  )
  if (blocker) return blocker.title

  if (matter.status === 'monitoring') return '持续监控，等待新变化'
  if (matter.status === 'done') return '事项已完成'
  return '缺少下一步——需要你补一个行动或等待原因'
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
      matter.summary_at != null &&
      matter.summary_at >= now - 8 * DAY &&
      !nextAction(matter).includes('缺少下一步')
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
