import type { Matter, MatterItem, MatterPriority } from '@shared/api/types/matter'

export const MATTER_VIEWS = [
  'focus',
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

export function filterView(matters: readonly Matter[], view: MatterView): Matter[] {
  if (view === 'trash') return matters.filter((matter) => matter.deleted_at !== null)
  if (view === 'archived') {
    return matters.filter((matter) => matter.archived_at !== null && matter.deleted_at === null)
  }

  const live = matters.filter(isLiveMatter)
  if (view === 'all') {
    return live.filter((matter) => matter.status !== 'done' && matter.status !== 'canceled')
  }
  if (view === 'completed') {
    return live.filter((matter) => matter.status === 'done' || matter.status === 'canceled')
  }
  if (view === 'focus') {
    return live.filter(
      (matter) =>
        matter.due_at !== null ||
        matter.next_attention_at !== null ||
        (matter.attention_signals?.some((signal) => signal.state === 'open') ?? false)
    )
  }
  return live.filter((matter) => matter.status === view)
}

export function rankOf(matter: Matter): readonly [number, number, number] {
  const openSignals = matter.attention_signals?.filter((signal) => signal.state === 'open') ?? []
  const attentionRank = openSignals.some((signal) => signal.severity === 'critical')
    ? 0
    : openSignals.length > 0
      ? 1
      : 2
  return [attentionRank, PRIORITY_RANK[matter.priority], matter.due_at ?? Number.MAX_SAFE_INTEGER]
}

export function compareMatterRank(left: Matter, right: Matter): number {
  const a = rankOf(left)
  const b = rankOf(right)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || right.updated_at - left.updated_at
}

export function nextAction(matter: Matter, items: readonly MatterItem[] = matter.items ?? []): string {
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
