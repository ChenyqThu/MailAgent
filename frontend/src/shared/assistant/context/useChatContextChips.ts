// chat-panel P4 Phase 01 — context-chips data for the assistant-ui shell.
//
// Packages the same three React Query reads the legacy AIChatPanel runs (email
// detail, AI fields, thread sibling count) into the props ContextChips needs,
// plus the email detail the panel reuses for the send envelope (senderName /
// subject). New-shell-only — the legacy panel keeps its own inline queries, so
// flag-off stays byte-identical. Query keys match the legacy ones, so both
// panels share the React Query cache (no double-fetch on the same email).

import { useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'

import type { AIFields, EmailDetail, EmailMeta } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'

/** Count the AI fields ContextChips surfaces (mirror of AIChatPanel's helper):
 *  Action / Priority / Review / Sentiment / ProcessingStatus / Mailbox +
 *  is_read + is_flagged (booleans always count). */
function countNonNullAiFields(f: AIFields): number {
  let n = 0
  if (f.ai_action) n++
  if (f.ai_priority) n++
  if (f.ai_review_status) n++
  if (f.sentiment) n++
  if (f.processing_status) n++
  if (f.mailbox) n++
  n += 2
  return n
}

export interface ChatContextChips {
  hasEmailBody: boolean
  aiFieldsCount: number
  threadCount: number
  /** Active email detail (for the send envelope: sender_name / subject). */
  detail: EmailDetail | null
}

export function useChatContextChips(activeInternalId: number | null): ChatContextChips {
  const mailApi = useMailApi()

  const detailQ = useQuery({
    queryKey: qk.email.detail(activeInternalId),
    queryFn: () => mailApi.email.get(activeInternalId as number),
    enabled: activeInternalId !== null,
    staleTime: 30_000
  })
  const threadId = detailQ.data?.thread_id ?? null

  const aiQ = useQuery({
    queryKey: qk.email.ai(activeInternalId),
    queryFn: () => mailApi.email.aiFields(activeInternalId as number),
    enabled: activeInternalId !== null,
    staleTime: 30_000
  })

  const threadQ = useQuery({
    queryKey: qk.email.threadCount(threadId),
    queryFn: () => mailApi.email.listByThread(threadId),
    enabled: threadId !== null,
    staleTime: 30_000,
    select: (rows: EmailMeta[]) => rows.length
  })

  return {
    hasEmailBody: activeInternalId !== null,
    aiFieldsCount: aiQ.data ? countNonNullAiFields(aiQ.data) : 0,
    threadCount: threadQ.data ?? 0,
    detail: detailQ.data ?? null
  }
}
