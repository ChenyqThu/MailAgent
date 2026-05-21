// Sprint 14 PR A — AI Chat session history sidebar.
//
// Sits inside AIChatPanel as a 140 px left rail (collapsible from the
// tab bar's History button). Lists every session for the current email
// ordered by updated_at DESC, lets the user switch back into an older
// conversation. The actual "switch" wiring (chat.abort + listMessages +
// setActiveSessionId) lives in useEmailChat.selectSession; this
// component is purely presentational + click → onSelectSession.
//
// Width was chosen empirically: 140 px keeps the panel's main column
// at 220 px (still wider than mockup-inbox.html's narrow-list breakpoint
// at 196 px) while leaving room for a 1-line backend label + relative-
// time meta inside each item.

import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'

import type { ChatSession } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'

interface ChatSidebarProps {
  sessions: ReadonlyArray<ChatSession>
  activeSessionId: number | null
  onSelectSession: (sessionId: number) => void
  onNewSession: () => void
  onClose: () => void
}

export function ChatSidebar({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onClose
}: ChatSidebarProps): React.ReactElement {
  const { t } = useTranslation()
  return (
    <aside
      aria-label={t('chat.sidebar.title')}
      className={cn(
        'w-[140px] shrink-0 border-r border-ink-border flex flex-col min-h-0',
        'bg-ink-2'
      )}
    >
      <header className="h-9 px-2 flex items-center gap-1 border-b border-ink-border-soft shrink-0">
        <span className="text-aux text-ink-fg-1 flex-1 truncate">{t('chat.sidebar.title')}</span>
        <HoverTip text={t('chat.sidebar.newSession')} side="bottom">
          <button
            type="button"
            aria-label={t('chat.sidebar.newSession')}
            onClick={onNewSession}
            className={cn(
              'text-ink-fg-2 hover:text-ink-fg p-1 rounded',
              'transition-colors duration-fast hover:bg-ink-4'
            )}
          >
            <Plus size={12} strokeWidth={2} />
          </button>
        </HoverTip>
        <HoverTip text={t('chat.sidebar.close')} side="bottom">
          <button
            type="button"
            aria-label={t('chat.sidebar.close')}
            onClick={onClose}
            className={cn(
              'text-ink-fg-2 hover:text-ink-fg p-1 rounded',
              'transition-colors duration-fast hover:bg-ink-4'
            )}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </HoverTip>
      </header>
      {sessions.length === 0 ? (
        <div className="flex-1 flex items-center justify-center px-3 text-micro text-ink-fg-3 text-center">
          {t('chat.sidebar.empty')}
        </div>
      ) : (
        <ul
          role="listbox"
          aria-label={t('chat.sidebar.title')}
          className="flex-1 overflow-y-auto px-1 py-1 space-y-0.5"
        >
          {sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              onSelect={() => onSelectSession(session.id)}
            />
          ))}
        </ul>
      )}
    </aside>
  )
}

interface SessionItemProps {
  session: ChatSession
  active: boolean
  onSelect: () => void
}

function SessionItem({ session, active, onSelect }: SessionItemProps): React.ReactElement {
  const { t } = useTranslation()
  const backendLabel = formatBackendLabel(session, t)
  const time = formatRelativeTime(session.updated_at, t)
  return (
    <li role="option" aria-selected={active}>
      <button
        type="button"
        onClick={onSelect}
        aria-label={active ? t('chat.sidebar.itemAriaActive') : t('chat.sidebar.itemAriaSwitch')}
        aria-current={active ? 'true' : undefined}
        className={cn(
          'w-full text-left px-2 py-1.5 rounded transition-colors duration-fast',
          'flex flex-col gap-0.5 group',
          active ? 'bg-ink-4 text-ink-fg ring-1 ring-c-accent/30' : 'text-ink-fg-1 hover:bg-ink-3'
        )}
      >
        <span className="text-meta truncate">{backendLabel}</span>
        <span
          className={cn(
            'text-micro font-mono truncate',
            active ? 'text-ink-fg-2' : 'text-ink-fg-3'
          )}
        >
          {time}
        </span>
      </button>
    </li>
  )
}

/** Notion Agent → "Jarvis" / agent label suffix. Custom API → bare model id
 *  (`claude-sonnet-4-6`, `gpt-5.4`, …) so the sidebar reads as a list of
 *  conversations indexed by which model handled them. Fallback to the
 *  backend kind translation when neither name nor model is available. */
function formatBackendLabel(session: ChatSession, t: TFunction): string {
  if (session.backend_kind === 'notion-agent') {
    return t('chat.backend.notionAgent')
  }
  return session.backend_model ?? t('chat.backend.customApi')
}

/** Five-bucket relative formatter, matches the granularity the sidebar
 *  can actually distinguish at a glance. Anything older than 6 days
 *  rolls off into "Nd ago" up to "999d ago" — we don't promote to weeks
 *  because the list is already ordered, the suffix is just for tie-break.
 *  Future polish: ISO date when the sidebar gets wider. */
function formatRelativeTime(epochMs: number, t: TFunction): string {
  const diff = Date.now() - epochMs
  if (diff < 60_000) return t('chat.sidebar.justNow')
  if (diff < 3_600_000) return t('chat.sidebar.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('chat.sidebar.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('chat.sidebar.daysAgo', { n: Math.floor(diff / 86_400_000) })
}
