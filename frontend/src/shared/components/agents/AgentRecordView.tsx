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
import { useQueryClient } from '@tanstack/react-query'

import type { AgentRunState, ChatSession } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { qk } from '@shared/lib/queryKeys'
import type { UseGeneralChatReturn } from '@shared/hooks/useGeneralChat'
import { chatMessageToUIMessage } from '@shared/assistant/uiMessage'
import { AiSdkRuntimeProvider } from '@shared/assistant/runtime/AiSdkRuntimeProvider'
// harness-chat lane A B3 (task 07-15) — the decide card is now the SHARED PendingApprovalPanel
// (generalized from this file's S6 W2 InRecordApprovalPanel so the email panel + general
// conversation mount the same actionable card); ageLabel moved to shared/lib (single source).
import { PendingApprovalPanel } from '@shared/assistant/PendingApprovalPanel'
import { ageLabel } from '@shared/lib/ageLabel'

import { AgentThread } from './AgentThread'
import { RunStateBadge } from './CustomAgentDrawer'
import { ReportIcon } from './primitives'
import { useAgentRuns, useReportConfig } from './hooks'

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
 *  paused 态 → 诚实失效态；否则不渲染。决策走 /decide（approvalId 形状，token 不出 gateway）。
 *  B3（07-15）— 薄封装到共享 PendingApprovalPanel：run 读态只决定 miss 时是否渲染失效态，卡本体
 *  与 email/general 面板同源。 */
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
  return (
    <PendingApprovalPanel
      sessionId={sessionId}
      agentName={agentName}
      showExpiredState={runState === 'paused_pending' || runState === 'paused_expired'}
      onDecided={onDecided}
    />
  )
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
  activeItem: ChatSession
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
