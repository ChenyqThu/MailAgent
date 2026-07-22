// chat-panel P4 Phase 06 (context injection) — renderer hook that builds the AgentContextSnapshot.
//
// Loads the same three reads the legacy panel runs (email detail / AI fields / thread sibling count)
// PLUS the full body markdown, then hands them to the pure buildAgentContextSnapshot. Query keys
// match useChatContextChips / the legacy panel so the React Query cache is shared (no double-fetch).
// Gated by `enabled` (the caller's context-injection condition): off → no queries, null snapshot,
// so the AI SDK path stays Phase-02 context-light and byte-identical.
//
// 🔴 Renderer-only (react + useMailApi). The assembly itself is pure (contextSnapshot.ts) — this
//    hook only wires the data. The body is fetched UNtruncated; the builder clips it to the §6
//    budget and records charsTotal, so ContextChips can show "12k/34k 已截断" accurately.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'

import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import type { EmailMeta } from '@shared/api/types'
import {
  buildAgentContextSnapshot,
  type AgentContextSnapshot,
  type AttachmentContext,
  type CapabilityContext,
  type ContextScope
} from './contextSnapshot'

export interface UseAgentContextSnapshotInput {
  activeInternalId: number | null
  scope: ContextScope
  capabilities: CapabilityContext
  panelMode: 'dock' | 'popout' | 'fullscreen'
  /** Flag gate — false → no queries run, snapshot is null (context-light, byte-identical). */
  enabled: boolean
}

export interface UseAgentContextSnapshotResult {
  snapshot: AgentContextSnapshot | null
  isLoading: boolean
}

/** Browser-derived UI state (locale / timezone / route) — cheap, no query. */
function readUiState(panelMode: 'dock' | 'popout' | 'fullscreen'): {
  locale: string
  timezone: string
  route: string
  panelMode: 'dock' | 'popout' | 'fullscreen'
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
  return { locale, timezone, route, panelMode }
}

export function useAgentContextSnapshot(
  input: UseAgentContextSnapshotInput
): UseAgentContextSnapshotResult {
  const { activeInternalId, scope, capabilities, panelMode, enabled } = input
  const mailApi = useMailApi()
  const active = enabled && activeInternalId !== null

  const detailQ = useQuery({
    queryKey: qk.email.detail(activeInternalId),
    queryFn: () => mailApi.email.get(activeInternalId as number),
    enabled: active,
    staleTime: 30_000
  })
  const threadId = detailQ.data?.thread_id ?? null

  const aiQ = useQuery({
    queryKey: qk.email.ai(activeInternalId),
    queryFn: () => mailApi.email.aiFields(activeInternalId as number),
    enabled: active,
    staleTime: 30_000
  })

  const threadQ = useQuery({
    queryKey: qk.email.threadCount(threadId),
    queryFn: () => mailApi.email.listByThread(threadId),
    enabled: active && threadId !== null,
    staleTime: 30_000,
    select: (rows: EmailMeta[]) => rows.length
  })

  // Full body markdown (untruncated) — same endpoint the legacy EmailContext loader uses, but we
  // let the builder clip to the §6 budget so charsTotal is accurate.
  const bodyQ = useQuery({
    queryKey: qk.email.body(activeInternalId, 'markdown'),
    queryFn: () => mailApi.email.body(activeInternalId as number, { format: 'markdown' }),
    enabled: active,
    staleTime: 30_000
  })

  // Active email attachment metadata (same lazy list ThreadAttachmentBar fans out) — injected as
  // metadata-only descriptors (no textExcerpt); the agent reads a specific attachment's text on
  // demand with the email_attachment_text tool. Never blocks the snapshot: a failed/loading query
  // resolves to [] (data undefined) so the snapshot still builds.
  const attachmentsQ = useQuery({
    queryKey: qk.attachment.list(activeInternalId as number),
    queryFn: () => mailApi.attachment.list(activeInternalId as number),
    enabled: active,
    staleTime: 30_000
  })

  // Map the attachment rows → AttachmentContext[]: inline attachments (is_inline=true — signature
  // images / embedded graphics) are dropped to reduce noise (the tool面 still surfaces them). No
  // textExcerpt is set, so the serializer emits only the descriptor (no UNTRUSTED_ATTACHMENT fence).
  const attachments = useMemo<AttachmentContext[]>(() => {
    const rows = attachmentsQ.data
    if (!Array.isArray(rows)) return []
    return rows
      .filter((a) => !a.is_inline)
      .map((a) => ({
        id: String(a.id),
        name: a.filename,
        contentType: a.content_type ?? null,
        sizeBytes: a.size_bytes ?? null,
        parseStatus: 'metadata-only' as const,
        trust: 'untrusted-user-content' as const
      }))
  }, [attachmentsQ.data])

  const snapshot = useMemo<AgentContextSnapshot | null>(() => {
    if (!enabled) return null
    const uiState = readUiState(panelMode)
    if (activeInternalId === null) {
      // general / no-email anchor — still emit a snapshot (UI state + capabilities), no activeEmail.
      return buildAgentContextSnapshot({
        scope,
        activeEmail: null,
        uiState,
        capabilities,
        createdAt: new Date().toISOString()
      })
    }
    const detail = detailQ.data ?? null
    const ai = aiQ.data ?? null
    const bodyContent = bodyQ.data?.content ?? null
    const hasBody = typeof bodyContent === 'string' && bodyContent.length > 0
    return buildAgentContextSnapshot({
      scope,
      activeEmail: {
        internalId: activeInternalId,
        subject: detail?.subject ?? null,
        senderName: detail?.sender_name ?? null,
        senderAddr: detail?.sender ?? null,
        dateIso: detail?.date_received ?? null,
        mailbox: detail?.mailbox ?? null,
        threadId,
        threadCount: threadQ.data ?? undefined,
        notionPageId: detail?.notion_page_id ?? null,
        ai: {
          priority: ai?.ai_priority ?? null,
          action: ai?.ai_action ?? null,
          processingStatus: ai?.processing_status ?? null,
          reviewStatus: ai?.ai_review_status ?? null
        },
        bodyMarkdown: hasBody ? bodyContent : null,
        bodySource: hasBody ? 'sqlite-body' : 'missing'
      },
      attachments,
      uiState,
      capabilities,
      createdAt: new Date().toISOString()
    })
  }, [
    enabled,
    activeInternalId,
    scope,
    capabilities,
    panelMode,
    detailQ.data,
    aiQ.data,
    threadQ.data,
    bodyQ.data,
    attachments,
    threadId
  ])

  return {
    snapshot,
    isLoading: active && (detailQ.isLoading || aiQ.isLoading || bodyQ.isLoading)
  }
}
