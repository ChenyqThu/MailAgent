// redesign — MailAgent general-agent VIEW shell (renders at /sessions when MAILAGENT_AGENT_VIEW is on;
// flag-off keeps the read-only ChatsTab). Two-pane: LEFT = AgentThreadList (general session history,
// collapsible), RIGHT = AgentConversation (the live general-agent thread; ai-sdk gateway with a legacy
// degrade fallback). Owns the SHARED session state via useGeneralChat — the same hook the Cmd+O dialog
// uses: the general sessions list + select/new/delete + the legacy engine — so the left list and the
// conversation stay in lock-step. A lazy first-user-message preview cache supplies row titles (general
// sessions carry no subject), mirroring GeneralAgentDialog / the email panel's sessionPreviews.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'
import { useAIChatPanel } from '@shared/state/ai-chat-panel'

import { AgentThreadList } from './AgentThreadList'
import { AgentConversation } from './AgentConversation'
import { useNarrow } from './hooks'

const ALL_SESSIONS_KEY = ['chat', 'allSessions'] as const

export function AgentViewLayout(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const narrow = useNarrow()
  const chat = useGeneralChat()
  const [collapsed, setCollapsed] = useState(false)
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
    queryFn: () => mailApi.chat.listAllSessions(true),
    staleTime: 10_000
  })
  const items = sessionsQ.data ?? []
  const invalidateSessions = (): void => {
    void qc.invalidateQueries({ queryKey: ALL_SESSIONS_KEY })
  }
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

  // The active session's unified item (anchor_type / email_id / backend_kind) drives the conversation's
  // runtime + context routing (email vs general). null for a brand-new chat → general default.
  const activeItem = items.find((s) => s.id === chat.activeSessionId) ?? null

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
          .catch(() => undefined)
      }}
      onArchive={(id) => {
        // dogfood-2: 归档 = 软删(从日期分组移到底部「归档」组；行/消息保留)。serve-api → ai_chat.db，刷新。
        void mailApi.chat
          .updateSessionArchived(id, true)
          .then(invalidateSessions)
          .catch(() => undefined)
      }}
      onRestore={(id) => {
        // dogfood-3: 恢复 = 取消归档(archived=false)，从「归档」组移回日期分组。
        void mailApi.chat
          .updateSessionArchived(id, false)
          .then(invalidateSessions)
          .catch(() => undefined)
      }}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      fluid={narrow}
    />
  )

  // The welcome heading + quick-action chips now live INSIDE AgentThread (demo layout: heading at the
  // viewport top, chips below the centered composer), so AgentConversation owns the empty state.
  const conversation = <AgentConversation chat={chat} activeItem={activeItem} />

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
