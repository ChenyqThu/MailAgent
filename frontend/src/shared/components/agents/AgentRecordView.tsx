// S6 W2（PRD P1/P3/P4）— custom-agent 执行记录视图。打开某次 run 的真实 session（origin='agent'，
// CHAT_DB v19），read-mostly：顶部 agent-run banner + composer 禁用（AgentThread readOnly）+ 消息流末
// in-record 审批卡（headless run 无活跃 useChat 流 → 决策走 /decide 服务端 resume，非 respondToApproval）。
//
// 纪律：
//  • pending 真值 = live 查 gateway ApprovalRunStash（fetchPendingApproval），非 run 读态：命中渲染
//    可决策卡，miss（重启/超时）→ 诚实失效态。derive_agent_run_state 语义不动（banner 只展示）。
//  • 决策后 live-refresh：invalidate pending 查询 + reloadActiveSession + 重挂 seed（远程 web 无 IPC
//    广播 → 决策返回后手动 reload 兜底；桌面额外经 chat:session-updated 广播覆盖岛侧并发决策）。
//  • banner/卡视觉复用既有先例（RunStateBadge / _cardShell ApprovalActions），oklch token。
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import type { AgentRunState, ChatSessionListItem } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
import { ApprovalActions } from '@shared/assistant/tools/_cardShell'
import {
  fetchPendingApproval,
  postApprovalDecide,
  postRememberWebPolicy
} from '@shared/assistant/approvalRecordClient'

import { AgentThread } from './AgentThread'
import { RunStateBadge } from './CustomAgentDrawer'
import { ReportIcon } from './primitives'
import { useAgentRuns, useReportConfig } from './hooks'

/** ms → "刚刚 / N 分钟前 / N 小时前 / N 天前"。审批卡 ageMs / banner 触发时间共用。 */
function ageLabel(t: (k: string, o?: Record<string, unknown>) => string, ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60000))
  if (mins < 1) return t('agents.custom.runs.ageJustNow')
  if (mins < 60) return t('agents.custom.runs.ageMinutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('agents.custom.runs.ageHours', { n: hours })
  return t('agents.custom.runs.ageDays', { n: Math.floor(hours / 24) })
}

/** epoch（秒或毫秒容错）→ 距今 ms。 */
function agoMs(ts: number | null | undefined): number | null {
  if (ts == null) return null
  const at = ts < 1e12 ? ts * 1000 : ts
  return Date.now() - at
}

/** 顶部 agent-run context banner（纯 props，便于测试）：agent 名 + run 状态徽标 + 触发时间 + P4 说明。 */
export function AgentRunRecordBanner({
  agentName,
  runState,
  triggeredAt
}: {
  agentName: string
  runState: AgentRunState | null
  triggeredAt: number | null
}): React.ReactElement {
  const { t } = useTranslation()
  const ms = agoMs(triggeredAt)
  return (
    <div
      data-agent-record-banner
      className="mx-3 my-2 rounded-lg border border-ai/30 bg-ai/10 px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <ReportIcon name="zap" size={13} />
        <span className="text-aux font-medium text-ink-fg truncate">{agentName}</span>
        {runState && <RunStateBadge state={runState} />}
        {ms != null && (
          <span className="text-meta text-ink-fg-3 ml-auto shrink-0">
            {t('agents.custom.runs.triggeredAgo', { ago: ageLabel(t, ms) })}
          </span>
        )}
      </div>
      <div className="mt-1.5 text-meta text-ink-fg-3 leading-snug">
        {t('agents.custom.runs.recordBanner')}
      </div>
    </div>
  )
}

/** in-record 审批面板（消息流末 pendingSlot）：live 查 pending → 命中渲染 decide 卡；miss 且 run 处于
 *  paused 态 → 诚实失效态；否则不渲染。决策走 /decide（approvalId 形状，token 不出 gateway）。 */
export function InRecordApprovalPanel({
  sessionId,
  runState,
  agentName,
  onDecided
}: {
  sessionId: number | null
  runState: AgentRunState | null
  agentName: string
  onDecided: () => void
}): React.ReactElement | null {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const pendingKey = qk.agentApprovalPending(sessionId)
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
    // Best-effort PIN BEFORE /decide (peek is read-only; /decide claims + consumes the stash — so the
    // rule must derive from the still-live entry first). A rule-creation failure must not block the
    // approve the owner already made.
    if (decision === 'approve' && rememberDomain && isAgentWebFetch) {
      await postRememberWebPolicy(pending.approvalId)
    }
    const res = await postApprovalDecide({ approvalId: pending.approvalId, decision })
    // 决策后：card 立即失活（re-query → miss），并让父层 reload 消息 + 刷新计数/历史。
    await qc.invalidateQueries({ queryKey: pendingKey })
    onDecided()
    if (!res.ok && res.status !== 'not_found') {
      // 非 not_found 的失败（gateway 不可达等）→ 抛给 ApprovalActions 展示。not_found = 已被
      // 其它面处理（岛/并发），静默失活即可。
      throw new Error(res.error ?? t('agents.custom.runs.decideFailed'))
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
          {t('agents.custom.runs.approvalBody', { agent: agentName, tool: pending.toolName })}
        </div>
        <div className="mt-1.5 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-1.5 font-mono text-micro text-ink-fg-2 break-words">
          {pending.inputPreview}
        </div>
        {isAgentWebFetch && (
          <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-md border border-ink-border-soft bg-ink-1/60 px-2.5 py-2">
            <input
              type="checkbox"
              checked={rememberDomain}
              onChange={(e) => setRememberDomain(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[rgb(var(--c-accent))]"
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
          onReject={() => void decide('reject')}
        />
      </div>
    )
  }

  // miss：run 已在审批处暂停（读态 paused_*）但 stash 无 live 可批项 → 诚实失效态（非卡片，静态提示）。
  // 其它读态（completed/failed/…）无审批 → 不渲染。
  if (runState === 'paused_pending' || runState === 'paused_expired') {
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

/** 记录视图会话壳：banner + 只读 seed 的 ai-sdk 运行时 + composer 禁用 thread + 审批 pendingSlot。
 *  AgentConversation 在 activeItem.origin==='agent' 时早退委托到此。 */
export function AgentRecordConversation({
  chat,
  activeItem,
  gatewayBaseUrl,
  reloadMessagesReady
}: {
  chat: UseGeneralChatReturn
  activeItem: ChatSessionListItem
  gatewayBaseUrl: string | null
  reloadMessagesReady: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const mailApi = useMailApi()
  const agentId = activeItem.agent_id ?? null
  const jobId = activeItem.agent_job_id != null ? Number(activeItem.agent_job_id) : null

  // banner 数据：名 = report config 缓存；run 态 + 触发时间 = 该 agent 的 run 历史里 jobId 命中行。
  const { agents } = useReportConfig()
  const agentName =
    agents.find((a) => a.id === agentId)?.title ?? agentId ?? t('agents.custom.runs.unknownAgent')
  const { runs } = useAgentRuns(agentId)
  const run = useMemo(
    () => (jobId != null ? (runs.find((r) => r.jobId === jobId) ?? null) : null),
    [runs, jobId]
  )
  const runState = run?.state ?? null
  const triggeredAt = run?.createdAt ?? null

  // 决策 / 会话变更 → reload 消息 + 重挂 seed + 刷新计数/历史。
  const [refreshNonce, setRefreshNonce] = useState(0)
  const onDecided = (): void => {
    void chat.reloadActiveSession()
    setRefreshNonce((n) => n + 1)
    void qc.invalidateQueries({ queryKey: qk.agentRuns.all() })
  }

  // 桌面：岛/并发决策也会改这个 session 的 rows → 订阅 chat:session-updated 覆盖非本面发起的结算。
  // 远程 web（HttpApi）无此 IPC → onSessionUpdated undefined → 纯靠上面 onDecided 手动兜底。
  const activeSessionId = chat.activeSessionId
  const reloadActiveSession = chat.reloadActiveSession
  useEffect(() => {
    const dispose = mailApi.chat.onSessionUpdated?.((payload) => {
      if (payload.sessionId !== activeSessionId) return
      void reloadActiveSession()
      setRefreshNonce((n) => n + 1)
      void qc.invalidateQueries({ queryKey: qk.agentApprovalPending(activeSessionId) })
      void qc.invalidateQueries({ queryKey: qk.agentRuns.all() })
    })
    return dispose
  }, [mailApi, activeSessionId, reloadActiveSession, qc])

  const initialMessages = reloadMessagesReady
    ? chat.messages.map(chatMessageToUIMessage)
    : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AgentRunRecordBanner agentName={agentName} runState={runState} triggeredAt={triggeredAt} />
      {initialMessages === undefined ? (
        <div className="flex flex-1 items-center justify-center" />
      ) : (
        <AiSdkRuntimeProvider
          key={`agent-record:${activeSessionId ?? 'none'}:${refreshNonce}`}
          gatewayBaseUrl={gatewayBaseUrl ?? ''}
          sessionId={null}
          initialMessages={initialMessages}
        >
          <AgentThread
            readOnly
            pendingSlot={
              <InRecordApprovalPanel
                sessionId={activeSessionId}
                runState={runState}
                agentName={agentName}
                onDecided={onDecided}
              />
            }
          />
        </AiSdkRuntimeProvider>
      )}
    </div>
  )
}
