// Matters MVP P3 (lane ③) — the Matter Chat context snapshot hook.
//
// Mirror of `assistant/context/useAgentContextSnapshot.ts` for the matter anchor: React Query
// pulls the ONE bounded projection endpoint (`GET /matters/{public_id}/context-snapshot`, D5) and
// hands it to the PURE `buildMatterContextSnapshot` (lane ②, contextSnapshot.ts — consumed, never
// edited here). The result rides the runtime request body exactly like the email snapshot does.
//
// 🔴 fail-soft (D10 验收): a failing / still-loading snapshot must never block the conversation.
// The hook then returns `snapshot: null` (context-light turn) and `chips: null` (the panel renders
// placeholder chips) — the composer stays live either way.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import type { MatterContextSnapshotPayload } from '@shared/api/matters'
import type {
  ActiveMatterContext,
  AgentContextSnapshot,
  CapabilityContext,
  ContextScope
} from '@shared/assistant/context/contextSnapshot'
import { buildMatterContextSnapshot } from '@shared/assistant/context/contextSnapshot'
import { qk } from '@shared/lib/queryKeys'

import { useMatterChatApi } from './hooks'

/** The five counts behind the「已注入的上下文」chips (design 附录 C). null while unavailable. */
export interface MatterContextChipCounts {
  openItems: number
  stakeholders: number
  pinnedResources: number
  changes: number
}

export interface UseMatterContextSnapshotInput {
  publicId: string
  scope: ContextScope
  capabilities: CapabilityContext
  /** false → no query runs and the snapshot is null (flag off / panel closed). */
  enabled: boolean
}

/** composer chip 行要渲染的置顶资料（design `chat.jsx:161` 每份置顶资料一颗可移除 chip）。 */
export interface MatterPinnedResourceChip {
  id: number
  /** wire 上就是自由字符串（`MatterContextSnapshotPayload`），图标解析处按值域兜底。 */
  kind: string
  title: string | null
}

export interface UseMatterContextSnapshotResult {
  snapshot: AgentContextSnapshot | null
  chips: MatterContextChipCounts | null
  /** 本轮**实际注入**的置顶资料（已剔除被移除的那些）。 */
  pinnedResources: MatterPinnedResourceChip[]
  hasContextGap: boolean
  isLoading: boolean
  isError: boolean
}

/** Browser-derived UI state — same three reads (locale / timezone / route) the email hook does. */
function readUiState(): {
  locale: string
  timezone: string
  route: string
  panelMode: 'dock'
} {
  let locale = 'en'
  let timezone = 'UTC'
  let route = ''
  try {
    locale = navigator.language || 'en'
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    route = window.location.hash || window.location.pathname || ''
  } catch {
    /* non-browser test env → defaults */
  }
  return { locale, timezone, route, panelMode: 'dock' }
}

/** Wire payload (snake_case, Python) → the typed ActiveMatterContext (camelCase, lane ②). */
export function toActiveMatterContext(payload: MatterContextSnapshotPayload): ActiveMatterContext {
  const matter = payload.matter
  return {
    id: matter.id,
    publicId: matter.public_id,
    title: matter.title,
    type: matter.type ?? null,
    tags: Array.isArray(matter.tags) ? matter.tags : [],
    status: matter.status,
    health: matter.health,
    priority: matter.priority,
    dueAt: matter.due_at ?? null,
    waitingContext: matter.waiting_context ?? null,
    description: matter.description ?? '',
    currentSummary: matter.current_summary ?? null,
    version: matter.version,
    summaryAcceptedAt: matter.summary_accepted_at ?? null,
    items: payload.items ?? [],
    stakeholders: payload.stakeholders ?? [],
    resources: (payload.resources ?? []).map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      provider: resource.provider,
      externalKey: resource.external_key,
      title: resource.title ?? null,
      canonicalUrl: resource.canonical_url ?? null,
      revision: resource.revision ?? null,
      accessPolicy: resource.access_policy,
      metadata: resource.metadata ?? {},
      excerpt: resource.excerpt ?? null
    })),
    events: (payload.events ?? []).map((event) => ({
      kind: event.kind,
      happenedAt: event.happened_at,
      actorKind: event.actor_kind,
      summary: event.summary
    }))
  }
}

/** The chip counts are derived from the SAME payload the model gets — the numbers on screen and
 *  the numbers in the prompt can never drift (that is the whole point of the chip row). */
export function toChipCounts(payload: MatterContextSnapshotPayload): MatterContextChipCounts {
  return {
    // The endpoint already filters items to the open set (done/canceled excluded server-side).
    openItems: payload.items?.length ?? 0,
    stakeholders: payload.stakeholders?.length ?? 0,
    // The endpoint returns pinned resources only (≤10).
    pinnedResources: payload.resources?.length ?? 0,
    changes: payload.events?.length ?? 0
  }
}

/** 「这个事项真的缺上下文吗」——判据只看**真实关联数**，不看 `resources` 那个投影。
 *
 * 🔴 `payload.resources` 只含 pinned 或未确认的 agent 建议：「已确认但没 pin」的资料根本
 * 不进。旧判据 `resources.length === 0` 于是构成自噬循环 —— agent 挂 3 条建议（可见 3、
 * 不弹卡）→ 用户把 3 条都确认（可见 0）→ **弹「缺上下文」**→ 点外扩 → 灌一批垃圾（可见
 * 10、卡片消失）。用户越配合越被灌垃圾。现在改看后端另发的 `resource_counts`（修法 5）。
 *
 * `waiting_context` 那半边**保留**：它是「这个事项在等外部输入」的显式声明，与资料多少
 * 正交（等得到东西才叫等），是这张卡最原始的语义。活库里恒 NULL 只说明 owner 没用过
 * 那个字段，不是判据本身错。旧后端不发 `resource_counts` ⇒ 退回旧投影判据（fail-soft）。
 */
export function hasContextGap(payload: MatterContextSnapshotPayload): boolean {
  if (payload.matter.waiting_context !== null) return true
  const counts = payload.resource_counts
  if (counts == null) return (payload.resources?.length ?? 0) === 0
  return counts.linked_resources === 0
}

export function useMatterContextSnapshot(
  input: UseMatterContextSnapshotInput
): UseMatterContextSnapshotResult {
  const { publicId, scope, capabilities, enabled } = input
  const api = useMatterChatApi()

  const query = useQuery({
    queryKey: qk.matters.contextSnapshot(publicId),
    queryFn: () => api.contextSnapshot(publicId),
    enabled: enabled && publicId.length > 0,
    staleTime: 15_000,
    retry: false
  })

  // 🔴 snapshot / chips / chip 行三条路都从**这一份** payload 派生 —— 别在任何一条下游
  // 单独过滤，那就是三份真相（「屏幕上说带了 3 份」与「prompt 里真的有 3 份」会劈叉）。
  const payload = query.data ?? null

  const snapshot = useMemo<AgentContextSnapshot | null>(() => {
    if (!enabled || payload === null) return null
    return buildMatterContextSnapshot({
      scope,
      activeMatter: toActiveMatterContext(payload),
      uiState: readUiState(),
      capabilities,
      createdAt: new Date().toISOString()
    })
  }, [enabled, payload, scope, capabilities])

  const chips = useMemo<MatterContextChipCounts | null>(
    () => (payload === null ? null : toChipCounts(payload)),
    [payload]
  )

  const pinnedResources = useMemo<MatterPinnedResourceChip[]>(
    () =>
      (payload?.resources ?? []).map((resource) => ({
        id: resource.id,
        kind: resource.kind,
        title: resource.title ?? null
      })),
    [payload]
  )

  return {
    snapshot,
    chips,
    pinnedResources,
    // 缺口判据看的是事项**真实**的关联数（`resource_counts`），不是这份投影里摆了几条。
    hasContextGap: enabled && payload !== null && hasContextGap(payload),
    isLoading: enabled && query.isLoading,
    isError: enabled && query.isError
  }
}
