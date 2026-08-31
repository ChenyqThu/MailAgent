// task 08-27 P4b — 团队对话宿主：以指定 agent 身份的**真 composer**（与主 agent 同一套
// 运行时 / 工具面 / 审批面，owner 拍板「完全同构」——身份差异只有 agent_id / 欢迎屏 /
// model 初始值，全部经 AgentConversation 的 agentIdentity prop 声明）。
//
// 会话归宿：懒建（首次发送）经 onEnsureSession 带 agentId → serve-api 落
// origin='team' + agent_id；gateway 按 sessionId 反查装配身份（S2 W0：不从 body 读）。
// 记录列点中的既有 team 会话由本组件 selectSession 打开（宿主按 `sessionId ?? 'new'`
// keyed 重挂，见 TeamRecordPane）。
//
// 欢迎屏的「它什么时候会自己动」复用排程句子生成器（sentenceText/coerceRule —— 语义单源
// schedule-rule-contract.md，这里只取句子不重算 occurrence）。

import { useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { ChatSessionListItem } from '@shared/api/types'
import { qk } from '@shared/lib/queryKeys'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'
import { ChatPanelBoundary } from '@shared/components/chat/ChatPanelBoundary'

import { AgentAvatar } from '../AgentAvatar'
import { AgentConversation, type AgentConversationAgentIdentity } from '../AgentConversation'
import { memberScheduleHint } from './teamScheduleHint'
import type { TeamMember } from './teamMembers'

export function TeamChatHost({
  member,
  memberTitle,
  sessionId,
  sessionRow
}: {
  member: TeamMember
  memberTitle: string
  /** null = 新对话（默认落点）；数字 = 记录列点中的既有 team 会话。 */
  sessionId: number | null
  /** 既有会话的列表行（backend_kind / origin 路由用）；新对话传 null。 */
  sessionRow: ChatSessionListItem | null
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const chat = useGeneralChat()
  const agentId = member.ref.kind === 'agent' ? member.ref.agentId : null

  // 打开记录列点中的既有会话（宿主按 sessionId keyed，重挂即一次性 select；
  // selectSession 对同 id no-op，effect 幂等）。
  const selectSession = chat.selectSession
  useEffect(() => {
    if (sessionId != null) void selectSession(sessionId)
  }, [sessionId, selectSession])

  // 首次发送落下新 team 会话后，让记录列（origin='team' 查询）看到它。
  const sessionsLen = chat.sessions.length
  const seenLenRef = useRef(sessionsLen)
  useEffect(() => {
    if (sessionsLen === seenLenRef.current) return
    seenLenRef.current = sessionsLen
    void qc.invalidateQueries({ queryKey: qk.chat.teamOriginSessions() })
  }, [sessionsLen, qc])

  const agentIdentity = useMemo<AgentConversationAgentIdentity | undefined>(() => {
    if (agentId == null) return undefined
    return {
      agentId,
      model: member.cfg?.model ?? null,
      welcome: {
        icon: (
          <AgentAvatar
            agentId={agentId}
            config={member.cfg?.avatar}
            size={44}
            title={memberTitle}
          />
        ),
        title: t('team.record.newSessionTitle', { name: memberTitle }),
        hint: memberScheduleHint(member.cfg, t, i18n.language)
      }
    }
  }, [agentId, member.cfg, memberTitle, t, i18n.language])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-team-chat-host={member.key}>
      <ChatPanelBoundary resetKeys={[chat.activeSessionId]}>
        <AgentConversation chat={chat} activeItem={sessionRow} agentIdentity={agentIdentity} />
      </ChatPanelBoundary>
    </div>
  )
}
