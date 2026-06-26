// redesign — MailAgent general-agent VIEW shell (renders at /sessions when MAILAGENT_AGENT_VIEW is on;
// flag-off keeps the read-only ChatsTab). Two-pane: LEFT = AgentThreadList (general session history,
// collapsible), RIGHT = AgentConversation (the live general-agent thread; ai-sdk gateway with a legacy
// degrade fallback). Owns the SHARED session state via useGeneralChat — the same hook the Cmd+O dialog
// uses: the general sessions list + select/new/delete + the legacy engine — so the left list and the
// conversation stay in lock-step. A lazy first-user-message preview cache supplies row titles (general
// sessions carry no subject), mirroring GeneralAgentDialog / the email panel's sessionPreviews.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronLeft } from 'lucide-react'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'

import { AgentThreadList } from './AgentThreadList'
import { AgentConversation } from './AgentConversation'
import { useNarrow } from './hooks'

export function AgentViewLayout(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const narrow = useNarrow()
  const chat = useGeneralChat()
  const [collapsed, setCollapsed] = useState(false)
  // Narrow single-pane back-stack: the list and the conversation alternate (a row tap / "New" pushes
  // the conversation; the back arrow returns to the list).
  const [mobileDetail, setMobileDetail] = useState(false)

  // Lazy first-user-message preview cache for row titles (general sessions have no subject) — mirror
  // of GeneralAgentDialog / the email panel's sessionPreviews. The `missing.length === 0` guard makes
  // the previews-in-deps loop converge (same proven shape).
  const [previews, setPreviews] = useState<Record<number, string | null>>({})
  const chatSessions = chat.sessions
  useEffect(() => {
    const missing = chatSessions.filter((s) => !(s.id in previews))
    if (missing.length === 0) return undefined
    let cancelled = false
    void Promise.all(
      missing.map(async (s) => {
        try {
          const msgs = await mailApi.chat.listMessages(s.id)
          const firstUser = msgs.find((m) => m.role === 'user')
          const preview = firstUser?.content?.trim() ?? null
          return [s.id, preview === null ? null : preview.slice(0, 80)] as const
        } catch {
          return [s.id, null] as const
        }
      })
    ).then((pairs) => {
      if (cancelled) return
      setPreviews((cur) => {
        const next = { ...cur }
        for (const [id, p] of pairs) next[id] = p
        return next
      })
    })
    return (): void => {
      cancelled = true
    }
  }, [chatSessions, previews, mailApi])

  const list = (
    <AgentThreadList
      sessions={chat.sessions}
      previews={previews}
      activeSessionId={chat.activeSessionId}
      onSelect={(id) => {
        void chat.selectSession(id)
        if (narrow) setMobileDetail(true)
      }}
      onNew={() => {
        chat.newSession()
        if (narrow) setMobileDetail(true)
      }}
      onDelete={chat.deleteSession}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      fluid={narrow}
    />
  )

  // Empty-thread welcome (Phase 3 swaps in the welcome heading + quick-actions chips).
  const welcome = (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-2xl font-semibold text-ink-fg">{t('agentView.welcome')}</h1>
      <p className="max-w-md text-aux text-ink-fg-2">{t('agentView.emptyHint')}</p>
    </div>
  )

  const conversation = <AgentConversation chat={chat} emptyState={welcome} />

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
