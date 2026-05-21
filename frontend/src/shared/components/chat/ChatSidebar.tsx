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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Trash2, X } from 'lucide-react'

import type { ChatSession } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'

interface ChatSidebarProps {
  sessions: ReadonlyArray<ChatSession>
  activeSessionId: number | null
  /** Sprint 14 PR G polish — first user-message preview per session,
   *  lazy-loaded by AIChatPanel when the sidebar opens. Missing key
   *  means "not loaded yet"; explicit null means "no user message in
   *  this session" (e.g. seeded by automation, never user-driven). */
  previews?: Record<number, string | null>
  onSelectSession: (sessionId: number) => void
  onNewSession: () => void
  onClose: () => void
  /** Sprint 14 PR J — delete a session. SessionItem surfaces an inline
   *  confirm step before invoking, so the parent only gets called when
   *  the user actually committed to dropping the conversation. */
  onDeleteSession?: (sessionId: number) => void
}

export function ChatSidebar({
  sessions,
  activeSessionId,
  previews,
  onSelectSession,
  onNewSession,
  onClose,
  onDeleteSession
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
              preview={previews?.[session.id]}
              onSelect={() => onSelectSession(session.id)}
              onDelete={onDeleteSession ? () => onDeleteSession(session.id) : undefined}
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
  /** Sprint 14 PR G polish — undefined = lazy fetch in-flight (show
   *  backend label as fallback); null = explicitly empty (no user msg
   *  in this session); string = the preview to display. */
  preview?: string | null
  onSelect: () => void
  /** Sprint 14 PR J — delete affordance. Undefined hides the trash
   *  icon (read-only sidebar callers). Click → enters inline confirm
   *  mode; second click on the checkmark commits. */
  onDelete?: () => void
}

function SessionItem({
  session,
  active,
  preview,
  onSelect,
  onDelete
}: SessionItemProps): React.ReactElement {
  const { t } = useTranslation()
  const backendLabel = formatBackendLabel(session, t)
  const time = formatRelativeTime(session.updated_at, t)
  // Sprint 14 PR G polish — line 1 prefers the first user-message
  // preview (more informative than "Custom API · sonnet-4-6" repeated
  // across every row); fall back to backend label when the preview is
  // either still loading (undefined) or explicitly empty (null).
  const hasPreview = typeof preview === 'string' && preview.length > 0
  const primary = hasPreview ? preview : backendLabel
  // Sprint 14 PR J — inline delete confirm. The trash icon's first
  // click flips into "confirm" mode (icon morphs to a check + an X);
  // the check commits the delete, the X (or Escape) reverts. Keeps
  // accidental clicks safe without a heavyweight modal.
  const [confirming, setConfirming] = useState(false)
  return (
    <li role="option" aria-selected={active}>
      <div className="relative group">
        <button
          type="button"
          onClick={onSelect}
          aria-label={active ? t('chat.sidebar.itemAriaActive') : t('chat.sidebar.itemAriaSwitch')}
          aria-current={active ? 'true' : undefined}
          className={cn(
            'w-full text-left px-2 py-1.5 rounded transition-colors duration-fast',
            'flex flex-col gap-0.5',
            // Right-pad to leave room for the trash icon overlay so a
            // long preview never collides with the icon's hit-area.
            onDelete && 'pr-8',
            active ? 'bg-ink-4 text-ink-fg ring-1 ring-c-accent/30' : 'text-ink-fg-1 hover:bg-ink-3'
          )}
        >
          <span className="text-meta truncate" title={primary}>
            {primary}
          </span>
          <span
            className={cn(
              'text-micro font-mono truncate',
              active ? 'text-ink-fg-2' : 'text-ink-fg-3'
            )}
          >
            {hasPreview ? `${backendLabel} · ${time}` : time}
          </span>
        </button>
        {onDelete &&
          (confirming ? (
            <span className="absolute top-1 right-1 flex items-center gap-0.5">
              <HoverTip text={t('chat.sidebar.deleteConfirm')} side="left">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete()
                  }}
                  aria-label={t('chat.sidebar.deleteConfirm')}
                  className="p-1 rounded bg-fail/15 text-fail hover:bg-fail/25 transition-colors duration-fast"
                >
                  <Check size={11} strokeWidth={2.5} />
                </button>
              </HoverTip>
              <HoverTip text={t('chat.sidebar.deleteCancel')} side="left">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirming(false)
                  }}
                  aria-label={t('chat.sidebar.deleteCancel')}
                  className="p-1 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
                >
                  <X size={11} strokeWidth={2.5} />
                </button>
              </HoverTip>
            </span>
          ) : (
            <HoverTip text={t('chat.sidebar.delete')} side="left">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setConfirming(true)
                }}
                aria-label={t('chat.sidebar.delete')}
                className={cn(
                  'absolute top-1 right-1 p-1 rounded',
                  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                  'transition-opacity duration-fast',
                  'text-ink-fg-3 hover:text-fail hover:bg-fail/10'
                )}
              >
                <Trash2 size={11} strokeWidth={2} />
              </button>
            </HoverTip>
          ))}
      </div>
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
