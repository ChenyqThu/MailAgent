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

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { ChatSessionListItem } from '@shared/api/types'
import { qk } from '@shared/lib/queryKeys'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { ChatPanelBoundary } from '@shared/components/chat/ChatPanelBoundary'
import { InspectorProvider } from '@shared/assistant/inspector/InspectorProvider'
import { InspectorTogglePill } from '@shared/assistant/inspector/InspectorTogglePill'
import { SessionInspectorPane } from '@shared/assistant/inspector/SessionInspectorPane'
import { useSessionInspector } from '@shared/assistant/inspector/inspectorContext'

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
  const modalVisible = useAIChatPanel((s) => s.visible)
  return (
    <InspectorProvider
      sessionKey={`team:${member.key}:${sessionId ?? 'new'}`}
      shortcutEnabled={!modalVisible}
      autoOpenWhenPopulated={true}
    >
      <TeamChatHostInner
        member={member}
        memberTitle={memberTitle}
        sessionId={sessionId}
        sessionRow={sessionRow}
      />
    </InspectorProvider>
  )
}

function TeamChatHostInner({
  member,
  memberTitle,
  sessionId,
  sessionRow
}: {
  member: TeamMember
  memberTitle: string
  sessionId: number | null
  sessionRow: ChatSessionListItem | null
}): React.ReactElement {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const chat = useGeneralChat()
  const inspector = useSessionInspector()
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440
  )
  useEffect(() => {
    const onResize = (): void => setWindowWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
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
        // 09-01 dogfood：头像嵌进句中——「和 [头像] 名字 开始新对话」。titlePre 是头像前
        // 的句首片段，title 是头像后的剩余句子（名字开头），两段拆开进 i18n。
        icon: (
          <AgentAvatar
            agentId={agentId}
            config={member.cfg?.avatar}
            size={36}
            title={memberTitle}
          />
        ),
        titlePre: t('team.record.newSessionTitlePre'),
        title: t('team.record.newSessionTitleRest', { name: memberTitle }),
        hint: memberScheduleHint(member.cfg, t, i18n.language)
      }
    }
  }, [agentId, member.cfg, memberTitle, t, i18n.language])

  const showHeaderPill = (inspector?.snapshot.totalItems ?? 0) > 0 || Boolean(inspector?.open)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-team-chat-host={member.key}>
      {showHeaderPill && (
        <div className="flex h-9 shrink-0 items-center justify-end border-b border-ink-border-soft px-3">
          <InspectorTogglePill />
        </div>
      )}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatPanelBoundary resetKeys={[chat.activeSessionId]}>
            <AgentConversation chat={chat} activeItem={sessionRow} agentIdentity={agentIdentity} />
          </ChatPanelBoundary>
        </div>
        <SessionInspectorPane presentation={windowWidth >= 1060 ? 'push' : 'overlay'} />
      </div>
    </div>
  )
}
