// task 06-08-chat §3.1 — per-agent session history POPOVER.
//
// Replaces the old ChatSidebar 140px left rail (mockup `.hist-pop`): a
// 262px floating card anchored under the panel header's "History" button.
// The two agents (Notion Agent / Custom AI) do NOT share history — the
// parent (AIChatPanel) already scopes `sessions` to the active backend
// kind, so flipping the agent (BackendSelector) re-renders the list in
// place while the popover stays open.
//
// Anchoring contract: the parent must render this inside a `relative`
// container (the panel header) so the popover positions `absolute` to it.
// Outside-click closes the popover but is intentionally NOT triggered by
// clicks inside the BackendSelector (`[data-chat-agent-switch]`) — so the
// user can switch agents with the list open and watch it re-scope. Esc
// also closes. reduced-motion drops the entrance fade.
//
// Item rendering (title preview / backend-label fallback / relative time /
// inline delete confirm) mirrors the old ChatSidebar SessionItem so the
// data model + behaviour carry over unchanged.

import type { TFunction } from 'i18next'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Plus, Trash2, X } from 'lucide-react'

import type { ChatBackendKind, ChatSession } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'

interface ChatHistoryPopoverProps {
  /** Which agent the panel is currently on — drives the header label so the
   *  popover reads "Custom AI · Recent" vs "Notion Agent · Recent". */
  backendKind: ChatBackendKind
  /** Already scoped to `backendKind` by AIChatPanel (useEmailChat). */
  sessions: ReadonlyArray<ChatSession>
  activeSessionId: number | null
  /** First user-message preview per session, lazy-loaded by AIChatPanel.
   *  Missing key = still loading (show backend label); explicit null =
   *  no user message (assistant-only seeded session). */
  previews?: Record<number, string | null>
  onSelectSession: (sessionId: number) => void
  onNewSession: () => void
  onClose: () => void
  onDeleteSession?: (sessionId: number) => void
}

export function ChatHistoryPopover({
  backendKind,
  sessions,
  activeSessionId,
  previews,
  onSelectSession,
  onNewSession,
  onClose,
  onDeleteSession
}: ChatHistoryPopoverProps): React.ReactElement {
  const { t } = useTranslation()
  const reduceMotion = useReducedMotion()
  const popRef = useRef<HTMLDivElement>(null)

  // Outside-click close. Clicks inside the popover itself, the History
  // toggle button ([data-chat-history-toggle]), or the agent switcher
  // ([data-chat-agent-switch]) are excluded — the toggle owns open/close,
  // and the agent switch must NOT close the popover (so the list visibly
  // re-scopes between Notion Agent / Custom AI). Esc closes.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (popRef.current?.contains(target)) return
      if (target.closest('[data-chat-history-toggle]')) return
      if (target.closest('[data-chat-agent-switch]')) return
      onClose()
    }
    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', escHandler)
    return (): void => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', escHandler)
    }
  }, [onClose])

  const agentLabel =
    backendKind === 'notion-agent' ? t('chat.backend.notionAgent') : t('chat.backend.customApi')

  return (
    <div
      ref={popRef}
      role="dialog"
      aria-label={t('chat.sidebar.title')}
      className={cn(
        'absolute top-full right-1 mt-1 z-30 w-[262px] max-h-[360px] overflow-y-auto',
        'rounded-xl glass-pop p-1.5',
        // tailwindcss-animate entrance; reduced-motion drops it (and the
        // plugin already gates its utilities behind motion-safe).
        !reduceMotion && 'animate-in fade-in-0 zoom-in-95 duration-fast origin-top-right'
      )}
    >
      {/* Header — "{Agent} · Recent" + a New-session shortcut. */}
      <div className="flex items-center gap-1 px-2 pt-1.5 pb-2">
        {/* §14 fix (codex r4) — recentTitle is "{agent} · 最近会话": the localized
            half is CJK, so this label is SANS, NOT font-mono/uppercase. mono+CJK
            renders muddy at any size, and text-micro/-meta are English-only
            tokens — so a plain sans 10px label is the §14-correct treatment. */}
        <span className="flex-1 text-[10px] text-ink-fg-2 truncate">
          {t('chat.sidebar.recentTitle', { agent: agentLabel })}
        </span>
        <HoverTip text={t('chat.sidebar.newSession')} side="bottom">
          <button
            type="button"
            aria-label={t('chat.sidebar.newSession')}
            onClick={() => {
              onNewSession()
              onClose()
            }}
            className={cn(
              'text-ink-fg-2 hover:text-ink-fg p-1 rounded',
              'transition-colors duration-fast hover:bg-ink-4'
            )}
          >
            <Plus size={13} strokeWidth={2} />
          </button>
        </HoverTip>
      </div>

      {sessions.length === 0 ? (
        <div className="px-3 py-6 text-[10px] text-ink-fg-3 text-center">
          {t('chat.sidebar.empty')}
        </div>
      ) : (
        <ul role="listbox" aria-label={t('chat.sidebar.title')} className="space-y-0.5">
          {sessions.map((session) => (
            <HistoryItem
              key={session.id}
              session={session}
              active={session.id === activeSessionId}
              preview={previews?.[session.id]}
              onSelect={() => {
                onSelectSession(session.id)
                onClose()
              }}
              onDelete={onDeleteSession ? () => onDeleteSession(session.id) : undefined}
            />
          ))}
        </ul>
      )}

      {/* Footer — the two agents keep separate threads. */}
      <div className="px-2.5 pt-2 pb-1 mt-1 text-[10px] text-ink-fg-3 border-t border-ink-border-soft">
        {t('chat.sidebar.notShared')}
      </div>
    </div>
  )
}

interface HistoryItemProps {
  session: ChatSession
  active: boolean
  /** undefined = lazy fetch in-flight (show backend label); null = no user
   *  message; string = the preview to display. */
  preview?: string | null
  onSelect: () => void
  onDelete?: () => void
}

function HistoryItem({
  session,
  active,
  preview,
  onSelect,
  onDelete
}: HistoryItemProps): React.ReactElement {
  const { t } = useTranslation()
  const backendLabel = formatBackendLabel(session, t)
  const time = formatRelativeTime(session.updated_at, t)
  const hasPreview = typeof preview === 'string' && preview.length > 0
  const primary = hasPreview ? preview : backendLabel
  // Inline delete confirm — first trash click flips into a check + X pair;
  // the check commits, the X (or Escape) reverts. Same safety as the old
  // ChatSidebar without a heavyweight modal.
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
            'w-full text-left px-2 py-2 rounded-lg transition-colors duration-fast',
            'flex flex-col gap-0.5',
            onDelete && 'pr-8',
            active ? 'bg-coral/[0.09]' : 'text-ink-fg-1 hover:bg-ink-1'
          )}
        >
          {/* task 06-08-chat dogfood r3→r4 — "字体再小一号". Item title (a CJK
              user-message preview / model label) is SANS at text-micro(11px):
              r3 dropped body(14)→meta(12), r4 →micro(11). It is NOT font-mono,
              so CJK stays legible (§14 only forbids CJK in *mono* small text).
              The header + item-meta carry CJK too (agent label "… · 最近会话",
              relative time 刚刚/{n}分钟前), so the r4 fix dropped font-mono on
              those spans as well (see their §14 notes); footer/empty are
              already sans 10px CJK captions.
              r5 user feedback — "再小一号" to 10px. This is below the DESIGN.md
              §14 11px CJK floor; user explicitly approved the deviation (title
              may be a CJK user-message preview). */}
          <span
            className={cn('text-[10px] truncate', active && 'text-coral font-semibold')}
            title={primary}
          >
            {primary}
          </span>
          {/* §14 fix (codex r4) — `time` is localized (刚刚 / {n} 分钟前 …) = CJK,
              so the whole meta line is SANS, not font-mono. */}
          <span className="text-[10px] text-ink-fg-3 truncate">
            {hasPreview ? `${backendLabel} · ${time}` : time}
          </span>
        </button>
        {onDelete &&
          (confirming ? (
            <span className="absolute top-1.5 right-1 flex items-center gap-0.5">
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
                  'absolute top-1.5 right-1 p-1 rounded',
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

/** Notion Agent → its label / Custom API → bare model id (`claude-sonnet-4-6`,
 *  `gpt-5.4`, …), falling back to the Custom API translation when no model is
 *  on file. Ported verbatim from the old ChatSidebar. */
function formatBackendLabel(session: ChatSession, t: TFunction): string {
  if (session.backend_kind === 'notion-agent') {
    return t('chat.backend.notionAgent')
  }
  return session.backend_model ?? t('chat.backend.customApi')
}

/** Five-bucket relative formatter (justNow / minutesAgo / hoursAgo / daysAgo),
 *  ported verbatim from the old ChatSidebar. */
function formatRelativeTime(epochMs: number, t: TFunction): string {
  const diff = Date.now() - epochMs
  if (diff < 60_000) return t('chat.sidebar.justNow')
  if (diff < 3_600_000) return t('chat.sidebar.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('chat.sidebar.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('chat.sidebar.daysAgo', { n: Math.floor(diff / 86_400_000) })
}
