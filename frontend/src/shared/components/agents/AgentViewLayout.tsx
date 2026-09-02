// redesign — MailAgent general-agent VIEW shell (renders at /sessions when MAILAGENT_AGENT_VIEW is on;
// flag-off keeps the read-only ChatsTab). Two-pane: LEFT = AgentThreadList (general session history,
// collapsible), RIGHT = AgentConversation (the live general-agent thread; ai-sdk gateway with a legacy
// degrade fallback). Owns the SHARED session state via useGeneralChat — the same hook the Cmd+O dialog
// uses: the general sessions list + select/new/delete + the legacy engine — so the left list and the
// conversation stay in lock-step. A lazy first-user-message preview cache supplies row titles (general
// sessions carry no subject), mirroring GeneralAgentDialog / the email panel's sessionPreviews.
//
// L4 群聊 — the二级栏 now carries a top segment (「AI」｜「群聊」). The 'groups' segment forks the
// WHOLE surface to GroupChatWorkspace (its own list + view); everything described above is the 'ai'
// segment. The fork sits after every hook so hook order stays fixed.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { toastError } from '@shared/state/toast'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'
import { useMainBreadcrumb } from '@shared/state/main-breadcrumb'
import { useDomainCollapsed } from '@shared/state/nav-shell'
import { useSessionsSegment, type SessionsSegment } from '@shared/state/sessions-segment'
import { ChatPanelBoundary } from '@shared/components/chat/ChatPanelBoundary'
import { SegmentedControl } from '@shared/components/ui/segmented'

import { AgentThreadList } from './AgentThreadList'
import { titleOf } from './sessionTitle'
import { AgentConversation } from './AgentConversation'
import { GroupChatWorkspace } from './groups/GroupChatWorkspace'
import { useNarrow } from './hooks'

const ALL_SESSIONS_KEY = [...qk.chat.allSessions(), 'interactive'] as const

export function AgentViewLayout(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const narrow = useNarrow()
  const chat = useGeneralChat()
  const [collapsed, setCollapsed] = useState(false)
  // 会话列 = 对话域的「二级栏」（registry second:'page'）：折叠读 nav-shell store（09-01 侧栏批，
  // 按域一份）。窄窗（<780）单栏由 useNarrow 自治，列是整页，不藏。
  const navHidden = useDomainCollapsed('chats')
  // Narrow single-pane back-stack: the list and the conversation alternate (a row tap / "New" pushes
  // the conversation; the back arrow returns to the list).
  const [mobileDetail, setMobileDetail] = useState(false)

  // Phase 9 — UNIFIED history (email + general) for the left list, from listAllSessions (same query key
  // as ChatsTab → shared cache). useGeneralChat stays the ENGINE (activeSessionId + select/new/delete +
  // general send); each row carries its own title (email subject / first user message), so the lazy
  // preview cache is gone.
  const sessionsQ = useQuery({
    queryKey: ALL_SESSIONS_KEY,
    // dogfood-3 — include archived sessions so the left list can render the bottom "归档" group
    // (active vs archived are split client-side in AgentThreadList).
    queryFn: () => mailApi.chat.listAllSessions({ includeArchived: true, origin: 'interactive' }),
    staleTime: 10_000
  })
  const items = sessionsQ.data ?? []
  const invalidateSessions = (): void => {
    void qc.invalidateQueries({ queryKey: ALL_SESSIONS_KEY })
  }

  // L4 群聊 — 二级栏顶部分段（「AI」｜「群聊」）。选择进模块级 store（HMR/remount 不丢态）；
  // 群列表查询只在群聊分段激活时拉。
  const segment = useSessionsSegment((s) => s.segment)
  const setSegment = useSessionsSegment((s) => s.setSegment)
  const activeGroupSessionId = useSessionsSegment((s) => s.activeGroupSessionId)
  const groupsQ = useQuery({
    queryKey: qk.chat.groupOriginSessions(),
    queryFn: () => mailApi.chat.listAllSessions({ origin: 'group' }),
    enabled: segment === 'groups',
    staleTime: 10_000
  })
  const groupItems = groupsQ.data ?? []
  const invalidateGroups = (): void => {
    void qc.invalidateQueries({ queryKey: qk.chat.groupOriginSessions() })
  }
  const segmentControl = (
    <SegmentedControl<SessionsSegment>
      value={segment}
      onChange={setSegment}
      options={[
        { value: 'ai', label: t('groupChat.segmentAi') },
        { value: 'groups', label: t('groupChat.segmentGroups') }
      ]}
      ariaLabel={t('groupChat.segmentAria')}
      fluid
      // .seg 是 inline-flex 收缩包裹；fluid 只让按钮 flex-1，容器不撑满时会缩到
      // min-content 让「群聊」两字换行——这里显式撑满列宽让两段等分。
      className="flex w-full"
    />
  )
  // A new general session created via send / adoptSession grows useGeneralChat.sessions — mirror it
  // into the unified list so the fresh chat shows up promptly (message_count freshness rides staleTime).
  useEffect(() => {
    invalidateSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.sessions])

  // assistant-modal P6 — consume a fullscreen-jump request: the floating modal parked the active session
  // id (requestOpenAgentSession) then navigated here; select it so the agent view opens that exact chat
  // (an email-anchored session continues correctly via AgentConversation's per-item routing). A brand-new
  // modal chat parks nothing → no-op (fresh empty agent view). flag-off → pendingAgentSessionId stays null.
  const pendingAgentSessionId = useAIChatPanel((s) => s.pendingAgentSessionId)
  const consumeOpenAgentSession = useAIChatPanel((s) => s.consumeOpenAgentSession)
  useEffect(() => {
    if (pendingAgentSessionId == null) return
    void chat.selectSession(pendingAgentSessionId)
    consumeOpenAgentSession()
    // selectSession is stable (useCallback); only re-run when a new id is parked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAgentSessionId])

  // 08-27 标签工作区 P2 — ⌘O 的第二半：GlobalShortcuts 导航到这里后排了一次「新建会话」
  // 请求（会话引擎是本组件实例内的 state，模块级 handler 够不着）。nonce 变化即消费一次，
  // 所以已经在对话页时连按 ⌘O 也是一次一个新会话。
  const pendingNewAgentSession = useAIChatPanel((s) => s.pendingNewAgentSession)
  const consumeNewAgentSession = useAIChatPanel((s) => s.consumeNewAgentSession)
  useEffect(() => {
    if (pendingNewAgentSession === 0) return
    chat.newSession()
    consumeNewAgentSession(pendingNewAgentSession)
    if (narrow) setMobileDetail(true)
    // newSession is stable (useCallback); only re-run when a new request is parked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNewAgentSession])

  // The active session's unified item (anchor_type / email_id / backend_kind) drives the conversation's
  // runtime + context routing (email vs general). null for a brand-new chat → general default.
  const listedActiveItem = items.find((s) => s.id === chat.activeSessionId) ?? null
  const directSessionQ = useQuery({
    queryKey: ['chat', 'session', chat.activeSessionId],
    queryFn: () => mailApi.chat.getSession(chat.activeSessionId as number),
    enabled: chat.activeSessionId != null && listedActiveItem == null,
    staleTime: 10_000
  })
  // Agent-run records are intentionally absent from the interactive sidebar, but a run-history jump
  // still needs the exact row metadata so AgentConversation enters locked record mode.
  const activeItem = listedActiveItem ?? directSessionQ.data ?? null

  // 主标签第二段 = 当前会话名或群聊名（design §三）。标题取列表行的同一份 titleOf；全新
  // 会话/未选中群聊不占第二段，主标签就显单段「对话」。
  const activeGroupItem =
    segment === 'groups' && activeGroupSessionId != null
      ? (groupItems.find((s) => s.id === activeGroupSessionId) ?? null)
      : null
  useMainBreadcrumb(
    'chats',
    segment === 'groups'
      ? activeGroupItem === null
        ? null
        : titleOf(activeGroupItem, t)
      : activeItem === null
        ? null
        : titleOf(activeItem, t)
  )

  // L4 群聊 — 分段分叉在全部 hooks 之后（hooks 恒序）；AI 分段字节级走原路径。
  if (segment === 'groups') {
    return (
      <GroupChatWorkspace
        headerSlot={segmentControl}
        items={groupItems}
        invalidate={invalidateGroups}
        narrow={narrow}
      />
    )
  }

  const list = (
    <AgentThreadList
      items={items}
      activeSessionId={chat.activeSessionId}
      onSelect={(id) => {
        void chat.selectSession(id)
        if (narrow) setMobileDetail(true)
      }}
      onNew={() => {
        chat.newSession()
        if (narrow) setMobileDetail(true)
      }}
      onDelete={(id) => {
        chat.deleteSession(id)
        invalidateSessions()
      }}
      onRename={(id, title) => {
        // Persist the rename (serve-api → ai_chat.db) then refresh the list so the new title shows.
        void mailApi.chat
          .updateSessionTitle(id, title)
          .then(invalidateSessions)
          .catch((err) => toastError(t('agentView.actionFail', { error: errorMessage(err) })))
      }}
      onArchive={(id) => {
        // dogfood-2: 归档 = 软删(从日期分组移到底部「归档」组；行/消息保留)。serve-api → ai_chat.db，刷新。
        void mailApi.chat
          .updateSessionArchived(id, true)
          .then(invalidateSessions)
          .catch((err) => toastError(t('agentView.actionFail', { error: errorMessage(err) })))
      }}
      onRestore={(id) => {
        // dogfood-3: 恢复 = 取消归档(archived=false)，从「归档」组移回日期分组。
        void mailApi.chat
          .updateSessionArchived(id, false)
          .then(invalidateSessions)
          .catch((err) => toastError(t('agentView.actionFail', { error: errorMessage(err) })))
      }}
      onPin={(id, pinned) => {
        void mailApi.chat
          .updateSessionPinned(id, pinned)
          .then(invalidateSessions)
          .catch((err) => toastError(t('agentView.actionFail', { error: errorMessage(err) })))
      }}
      onStar={(id, starred) => {
        void mailApi.chat
          .updateSessionStarred(id, starred)
          .then(invalidateSessions)
          .catch((err) => toastError(t('agentView.actionFail', { error: errorMessage(err) })))
      }}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      fluid={narrow}
      headerSlot={segmentControl}
      navHidden={navHidden}
    />
  )

  // The welcome heading + quick-action chips now live INSIDE AgentThread (demo layout: heading at the
  // viewport top, chips below the centered composer), so AgentConversation owns the empty state.
  // P2-9 — local boundary: the list stays interactive when the conversation crashes, and picking
  // another session auto-clears the held error via resetKeys.
  const conversation = (
    <ChatPanelBoundary resetKeys={[chat.activeSessionId]}>
      <AgentConversation chat={chat} activeItem={activeItem} />
    </ChatPanelBoundary>
  )

  if (narrow) {
    return mobileDetail ? (
      <div className="flex h-full w-full flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-ink-border px-2">
          <button
            type="button"
            onClick={() => setMobileDetail(false)}
            aria-label={t('agents.reports.backToList')}
            className="grid size-8 place-items-center rounded-md text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
          >
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <span className="truncate text-body font-medium text-ink-fg">{t('nav.agentView')}</span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{conversation}</div>
      </div>
    ) : (
      <div className="h-full w-full">{list}</div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {list}
      <div className="flex min-w-0 flex-1 flex-col">{conversation}</div>
    </div>
  )
}
