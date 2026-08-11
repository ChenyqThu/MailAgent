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

export type MatterChatScope = 'matter' | 'global'

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
  chatScope: MatterChatScope
  capabilities: CapabilityContext
  /** false → no query runs and the snapshot is null (flag off / panel closed). */
  enabled: boolean
}

export interface UseMatterContextSnapshotResult {
  snapshot: AgentContextSnapshot | null
  chips: MatterContextChipCounts | null
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
export function toActiveMatterContext(
  payload: MatterContextSnapshotPayload,
  chatScope: MatterChatScope
): ActiveMatterContext {
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
    scope: chatScope,
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

export function useMatterContextSnapshot(
  input: UseMatterContextSnapshotInput
): UseMatterContextSnapshotResult {
  const { publicId, scope, chatScope, capabilities, enabled } = input
  const api = useMatterChatApi()

  const query = useQuery({
    queryKey: qk.matters.contextSnapshot(publicId),
    queryFn: () => api.contextSnapshot(publicId),
    enabled: enabled && publicId.length > 0,
    staleTime: 15_000,
    retry: false
  })

  const payload = query.data ?? null
  const snapshot = useMemo<AgentContextSnapshot | null>(() => {
    if (!enabled || payload === null) return null
    return buildMatterContextSnapshot({
      scope,
      activeMatter: toActiveMatterContext(payload, chatScope),
      uiState: readUiState(),
      capabilities,
      createdAt: new Date().toISOString()
    })
  }, [enabled, payload, scope, chatScope, capabilities])

  const chips = useMemo<MatterContextChipCounts | null>(
    () => (payload === null ? null : toChipCounts(payload)),
    [payload]
  )

  return {
    snapshot,
    chips,
    hasContextGap:
      enabled &&
      payload !== null &&
      (payload.matter.waiting_context !== null || (payload.resources?.length ?? 0) === 0),
    isLoading: enabled && query.isLoading,
    isError: enabled && query.isError
  }
}
