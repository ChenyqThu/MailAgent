// harness-chat lane A B3 (task 07-15) — the SHARED in-panel approval card.
//
// Generalized from AgentRecordView's InRecordApprovalPanel (S6 W2) so the SAME actionable decide
// card serves all three surfaces: the agent-run record view (which wraps it, keeping its runState-
// derived expired notice), the email chat panel (AiChatPanel pendingSlot — replaces the old
// informational "act on the island" notice) and the general agent conversation (AgentConversation
// pendingSlot, new probe). 07-15 owner拍板: the in-panel card is the PRIMARY approval surface —
// island-independent (works with MAILAGENT_ISLAND_AGENT_ENABLED explicitly false) and the copy never
// points the user at the island.
//
// 纪律（unchanged from S6 W2）：
//  • pending 真值 = live 查 gateway ApprovalRunStash（fetchPendingApproval），命中渲染可决策卡，
//    miss → showExpiredState ? 诚实失效态 : 不渲染（manual 会话没有 run 读态可判"曾暂停"，miss
//    静默 —— 已知残留，见 lane 笔记）。
//  • 决策走既有 POST /api/ai/approval/decide（{approvalId} 形状，resumeToken 不出 gateway）；
//    not_found = 已被其它面处理（并发），静默失活。
//  • web PIN affordance 是数据驱动的（agentId 非空 + web_fetch）——只有 headless agent run 会命中，
//    manual 会话恒不显示（dead-config boundary，S6 W3-3）。

import { useState } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { qk } from '@shared/lib/queryKeys'
import { ageLabel } from '@shared/lib/ageLabel'
import { Checkbox } from '@shared/components/ui/checkbox'
import { ApprovalActions } from '@shared/assistant/tools/_cardShell'
import {
  fetchPendingApproval,
  postApprovalDecide,
  postRememberWebPolicy
} from '@shared/assistant/approvalRecordClient'
import { ReportIcon } from '@shared/components/agents/primitives'

/** The card's body copy: agent runs name the agent; manual sessions use the assistant phrasing. */
function approvalBody(t: TFunction, agentName: string | null, toolName: string): string {
  return agentName != null
    ? t('agents.custom.runs.approvalBody', { agent: agentName, tool: toolName })
    : t('chat.aiSdk.approvalBodyManual', { tool: toolName })
}

export function PendingApprovalPanel({
  sessionId,
  agentName = null,
  showExpiredState = false,
  refreshKey = 0,
  onDecided,
  onDecideBusyChange
}: {
  sessionId: number | null
  /** Custom-agent display name for the body copy; null → manual-chat copy. */
  agentName?: string | null
  /** Render the honest "已失效" notice on a probe miss (the record view derives it from the run's
   *  paused_* read state; manual surfaces have no such signal and pass false → miss renders null). */
  showExpiredState?: boolean
  /** Folded into the query key so a settle-driven remount/nonce re-probes deterministically. */
  refreshKey?: number
  onDecided: () => void
  /** P1-2 (codex r1) — decide-in-flight signal: /decide runs the server-side resume synchronously
   *  and holds the session lease for its whole duration, so the parent disables its composer while
   *  true (a send would 409 E_RUN_ACTIVE anyway — this makes the fence visible instead of an
   *  error). codex r2 [E] — carries the DECIDING session's id (captured at decide start) so the
   *  parent scopes the disable to that session only (useApprovalDecideBusy): switching sessions
   *  must not lock an unrelated composer. Optional: the record view has no composer. */
  onDecideBusyChange?: (busy: boolean, sessionId: number | null) => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // Prefix-shared with qk.agentApprovalPending(sessionId) so existing invalidations
  // (AgentRecordView's settle handler) still hit; refreshKey extends the key without breaking them.
  const pendingKey = [...qk.agentApprovalPending(sessionId), refreshKey] as const
  const q = useQuery({
    queryKey: pendingKey,
    queryFn: () => (sessionId == null ? Promise.resolve(null) : fetchPendingApproval(sessionId)),
    enabled: sessionId != null,
    // pending 是进程内存真值（重启即丢）→ 短 staleTime，不长轮询（打开/决策后手动 invalidate）。
    staleTime: 3_000,
    refetchOnWindowFocus: true
  })
  const pending = q.data ?? null
  // S6 W3-3 — the "总是允许该域名" web PIN affordance. ONLY for an agent-run web_fetch approval
  // (agentId present): a manual web_fetch never stashes / never runs policyEvaluate, so a per-agent
  // web rule built from a manual card would be a dead, misleading config. Gate the affordance on both.
  const isAgentWebFetch =
    pending != null && pending.agentId != null && pending.toolName === 'web_fetch'
  const [rememberDomain, setRememberDomain] = useState(false)

  const decide = async (decision: 'approve' | 'reject'): Promise<void> => {
    if (!pending) return
    // codex r2 [E] — capture the deciding session NOW: the prop can move to another session while
    // the resume is in flight (panel-level component, session switch re-renders it), and the finally
    // must clear the busy entry of the session that STARTED the decide, not the one now displayed.
    const decideSessionId = sessionId
    onDecideBusyChange?.(true, decideSessionId)
    try {
      // Best-effort PIN BEFORE /decide (peek is read-only; /decide claims + consumes the stash — so the
      // rule must derive from the still-live entry first). A rule-creation failure must not block the
      // approve the owner already made.
      if (decision === 'approve' && rememberDomain && isAgentWebFetch) {
        await postRememberWebPolicy(pending.approvalId)
      }
      const res = await postApprovalDecide({ approvalId: pending.approvalId, decision })
      // P2-1 (codex r1) — judge the result FIRST: a non-not_found failure (gateway unreachable /
      // 500 / resume tool error / P1-2's 409 lease miss) throws to ApprovalActions' inline error
      // state and the card STAYS live — the approval did NOT happen, and destroying the card (the
      // old invalidate+onDecided-before-check order) would hide exactly that. not_found = already
      // handled on another surface (concurrency) → benign deactivation.
      if (!res.ok && res.status !== 'not_found') {
        throw new Error(res.error ?? t('agents.custom.runs.decideFailed'))
      }
      // ok / not_found：card 失活（re-query → miss），并让父层 reload 消息 + 刷新计数/历史。
      await qc.invalidateQueries({ queryKey: qk.agentApprovalPending(sessionId) })
      onDecided()
    } finally {
      onDecideBusyChange?.(false, decideSessionId)
    }
  }

  if (pending) {
    const ago = ageLabel(t, pending.ageMs)
    return (
      <div
        data-in-record-approval-card
        className="mx-auto w-full max-w-[var(--thread-max-width)] rounded-xl border border-ai/30 bg-ink-2 px-3.5 py-3"
      >
        <div className="flex items-center gap-2">
          <ReportIcon name="bell" size={13} />
          <span className="text-aux font-medium text-ink-fg">
            {t('agents.custom.runs.approvalTitle')}
          </span>
          <span className="text-meta text-ink-fg-3 ml-auto">{ago}</span>
        </div>
        <div className="mt-1.5 text-meta text-ink-fg-2 leading-snug">
          {approvalBody(t, agentName, pending.toolName)}
        </div>
        <div className="mt-1.5 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-1.5 font-mono text-micro text-ink-fg-2 break-words">
          {pending.inputPreview}
        </div>
        {isAgentWebFetch && (
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-2">
            <Checkbox
              checked={rememberDomain}
              onCheckedChange={setRememberDomain}
              className="mt-0.5"
            />
            <span className="text-aux text-ink-fg-2">
              {t('agents.custom.runs.rememberDomain')}
              <span className="mt-0.5 block text-ink-fg-3">
                {t('agents.custom.runs.rememberDomainHint')}
              </span>
            </span>
          </label>
        )}
        <ApprovalActions
          approveLabel={t('agents.custom.runs.approveLabel')}
          onApprove={() => decide('approve')}
          // P2-1 — returned (not void'd) so ApprovalActions' shared machine awaits it: a reject
          // failure enters the same busy/error state instead of an unhandled rejection.
          onReject={() => decide('reject')}
        />
      </div>
    )
  }

  // miss：调用方能证明"曾在审批处暂停"（record view 的 paused_* 读态）→ 诚实失效态（非卡片，
  // 静态提示）；manual 会话无此信号 → 不渲染。
  if (showExpiredState) {
    return (
      <div
        data-in-record-approval-expired
        className="mx-auto w-full max-w-[var(--thread-max-width)] rounded-lg border border-ink-border bg-ink-3/70 px-3 py-2 text-meta text-ink-fg-2"
      >
        {t('agents.custom.runs.approvalExpired')}
      </div>
    )
  }
  return null
}
