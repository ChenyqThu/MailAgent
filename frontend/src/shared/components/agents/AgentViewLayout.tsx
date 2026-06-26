// redesign Phase 1 — MailAgent general-agent VIEW shell (renders at /sessions when
// MAILAGENT_AGENT_VIEW is on; flag-off keeps the read-only ChatsTab). Two-pane: LEFT =
// AgentThreadList (general session history, collapsible), RIGHT = the live conversation. Phase 1
// ships a welcome placeholder in the right pane; Phase 2 swaps in <AgentConversation chat={chat} />.
//
// Owns the SHARED session state via useGeneralChat — the same hook the Cmd+O dialog uses: the
// general sessions list + select/new/delete, and (Phase 2) the legacy degrade engine. A lazy
// first-user-message preview cache supplies row titles (general sessions carry no subject), mirroring
// GeneralAgentDialog / the email panel's sessionPreviews.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useMailApi } from '@shared/hooks/useMailApi'
import { useGeneralChat } from '@shared/hooks/useGeneralChat'

import { AgentThreadList } from './AgentThreadList'
import { useNarrow } from './hooks'

export function AgentViewLayout(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const narrow = useNarrow()
  const chat = useGeneralChat()
  const [collapsed, setCollapsed] = useState(false)

  // Lazy first-user-message preview cache for row titles (general sessions have no subject) — mirror
  // of GeneralAgentDialog (183-212) / the email panel's sessionPreviews. The `missing.length === 0`
  // guard makes the previews-in-deps loop converge (same proven shape).
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
      onSelect={(id) => void chat.selectSession(id)}
      onNew={chat.newSession}
      onDelete={chat.deleteSession}
      collapsed={collapsed}
      onToggleCollapse={() => setCollapsed((c) => !c)}
      fluid={narrow}
    />
  )

  // Phase 1 placeholder — Phase 2 replaces with the live <AgentConversation chat={chat} />.
  const conversation = (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-2xl font-semibold text-ink-fg">{t('agentView.welcome')}</h1>
      <p className="max-w-md text-aux text-ink-fg-2">{t('agentView.emptyHint')}</p>
    </div>
  )

  // Narrow: single pane (Phase 1 shows the list; Phase 2 wires the list↔conversation back-stack).
  if (narrow) return <div className="h-full w-full">{list}</div>

  return (
    <div className="flex h-full min-h-0">
      {list}
      <div className="flex min-w-0 flex-1 flex-col">{conversation}</div>
    </div>
  )
}
