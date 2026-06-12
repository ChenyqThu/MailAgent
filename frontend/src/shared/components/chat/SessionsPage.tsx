// Global "AI 会话历史" page — cross-email conversation history.
//
// Sibling entry point to the in-panel ChatSidebar (which is per-email). This
// page lists EVERY conversation across all emails, newest-first, and lets the
// user search/filter, delete, and jump back into any one of them. Clicking a
// row flips the active email + parks the target session in the panel store
// (openAIChatSession) then navigates to the inbox, where AIChatPanel selects
// that exact session so the user can continue the conversation.
//
// Data: mailApi.chat.listAllSessions() — a cross-DB join (ai_chat.db sessions
// + sync_store.db email subject/sender) done in the main process. Read-only.

import type { TFunction } from 'i18next'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Check, History, Mail, MessageSquare, Search, Sparkles, Trash2, X } from 'lucide-react'

import type { ChatSessionListItem } from '@shared/api/types'
import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useActiveEmail } from '@shared/state/active-email'
import { openAIChatSession } from '@shared/state/ai-chat-panel'
import { toastSuccess } from '@shared/state/toast'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { HoverTip } from '@shared/components/ui/HoverTip'
import { SegmentedControl } from '@shared/components/ui/segmented'

const SESSIONS_QUERY_KEY = ['chat', 'allSessions'] as const

type BackendFilter = 'all' | 'notion-agent' | 'custom-api'

export function SessionsPage(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const setActiveEmail = useActiveEmail((s) => s.setActive)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<BackendFilter>('all')

  const sessionsQ = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => mailApi.chat.listAllSessions(),
    staleTime: 10_000
  })

  // useMemo so the `?? []` fallback is a stable reference across renders —
  // otherwise the `filtered` memo below would recompute every render.
  const all = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return all.filter((s) => {
      if (filter !== 'all' && s.backend_kind !== filter) return false
      if (q === '') return true
      const haystack = [s.email_subject, s.email_sender, s.first_user_message, s.backend_model]
        .filter((v): v is string => typeof v === 'string')
        .join(' ')
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [all, query, filter])

  const openSession = (item: ChatSessionListItem): void => {
    // navTarget: the email may live in any mailbox / not be paged into the
    // current list — exempt it from EmailList's active-reset (same as the
    // CommandPalette search-jump path).
    setActiveEmail(item.email_id, { navTarget: true })
    // 交付文档 §3.1 — pass the session's own backend kind so AIChatPanel switches
    // the panel onto that agent before selecting (per-kind session scoping).
    openAIChatSession(item.email_id, item.id, item.backend_kind)
    void navigate({ to: '/' })
  }

  const deleteSession = (id: number): void => {
    mailApi.chat.deleteSession(id)
    // Fire-and-forget IPC — optimistically drop the row, then invalidate so a
    // background refetch reconciles (e.g. if the delete raced a new message).
    qc.setQueryData<ChatSessionListItem[]>(SESSIONS_QUERY_KEY, (cur) =>
      (cur ?? []).filter((s) => s.id !== id)
    )
    void qc.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY })
    toastSuccess(t('sessions.deleted'))
  }

  const isLoading = sessionsQ.isLoading
  const isEmpty = !isLoading && all.length === 0
  const noMatch = !isLoading && all.length > 0 && filtered.length === 0

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header — title + count + search + backend filter */}
      <header className="shrink-0 px-6 pt-5 pb-3 border-b border-ink-border-soft">
        <div className="flex items-center gap-2.5 mb-3">
          <span className="w-7 h-7 rounded-md grid place-items-center bg-coral/15 border border-coral/30 shrink-0">
            <History size={15} strokeWidth={1.75} className="text-coral" />
          </span>
          <h1 className="text-h2 font-semibold text-ink-fg">{t('sessions.title')}</h1>
          {!isLoading && (
            <span className="text-meta font-mono text-ink-fg-3">
              {t('sessions.count', { n: all.length })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="relative flex-1 min-w-[220px] max-w-md">
            <Search
              size={14}
              strokeWidth={1.75}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-fg-3 pointer-events-none"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('sessions.searchPlaceholder')}
              aria-label={t('sessions.searchPlaceholder')}
              className={cn(
                'w-full h-8 pl-8 pr-3 rounded-md text-body',
                'input-surface border border-ink-border-soft text-ink-fg',
                'placeholder:text-ink-fg-3 focus:outline-none focus:ring-1 focus:ring-c-accent/40'
              )}
            />
          </label>
          {/* v0.7.2 — 统一 SegmentedControl（自适应宽：fluid=false 默认）。 */}
          <SegmentedControl<BackendFilter>
            value={filter}
            onChange={setFilter}
            ariaLabel={t('sessions.filterLabel')}
            options={[
              { value: 'all', label: t('sessions.filterAll') },
              { value: 'notion-agent', label: t('chat.backend.notionAgent') },
              { value: 'custom-api', label: t('chat.backend.customApi') }
            ]}
          />
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0 scrollbar-thin px-4 py-3">
        {isLoading ? (
          <ul className="space-y-1.5" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <li
                key={i}
                className="px-3 py-3 rounded-lg bg-ink-1 border border-ink-border-soft animate-pulse motion-reduce:animate-none"
              >
                <div className="h-3.5 w-2/3 rounded bg-ink-3 mb-2" />
                <div className="h-3 w-1/3 rounded bg-ink-3" />
              </li>
            ))}
          </ul>
        ) : isEmpty ? (
          <EmptyState
            fill
            icon={<Sparkles size={28} strokeWidth={1.5} />}
            title={t('sessions.emptyTitle')}
            hint={t('sessions.emptyHint')}
          />
        ) : noMatch ? (
          <EmptyState
            fill
            icon={<Search size={28} strokeWidth={1.5} />}
            title={t('sessions.noMatchTitle')}
            hint={t('sessions.noMatchHint')}
          />
        ) : (
          <ul className="space-y-1.5" aria-label={t('sessions.title')}>
            {filtered.map((item) => (
              <SessionRow
                key={item.id}
                item={item}
                t={t}
                onOpen={() => openSession(item)}
                onDelete={() => deleteSession(item.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface SessionRowProps {
  item: ChatSessionListItem
  t: TFunction
  onOpen: () => void
  onDelete: () => void
}

function SessionRow({ item, t, onOpen, onDelete }: SessionRowProps): React.ReactElement {
  const [confirming, setConfirming] = useState(false)

  const backendLabel =
    item.backend_kind === 'notion-agent'
      ? t('chat.backend.notionAgent')
      : (item.backend_model ?? t('chat.backend.customApi'))

  // Title prefers the owning email's subject; falls back to the first user
  // message, then an "untitled" placeholder. The preview line then shows the
  // first user message UNLESS it's already serving as the title (avoid echo).
  const subject = item.email_subject?.trim() || null
  const firstMsg = item.first_user_message?.trim() || null
  const title = subject ?? firstMsg ?? t('sessions.untitled')
  const preview = subject ? firstMsg : null

  const time = formatRelativeTime(item.updated_at, t)

  return (
    <li>
      <div className="relative group">
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            'w-full text-left px-3 py-2.5 rounded-lg pr-10',
            'bg-ink-1 border border-ink-border-soft',
            'hover:bg-ink-2 hover:border-ink-border transition-colors duration-fast',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-c-accent/40'
          )}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Mail size={13} strokeWidth={1.75} className="text-ink-fg-3 shrink-0" />
            <span className="text-body font-medium text-ink-fg truncate min-w-0" title={title}>
              {title}
            </span>
          </div>
          {preview && (
            <p className="mt-1 text-meta text-ink-fg-2 line-clamp-1" title={preview}>
              {preview}
            </p>
          )}
          <div className="mt-1.5 flex items-center gap-2 text-micro font-mono text-ink-fg-3">
            <span className="inline-flex items-center gap-1">
              <Sparkles size={10} strokeWidth={2} className="text-coral" />
              {backendLabel}
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <MessageSquare size={10} strokeWidth={2} />
              {t('chat.sidebar.messageCount', { n: item.message_count })}
            </span>
            <span aria-hidden>·</span>
            <span>{time}</span>
            {item.email_sender && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate max-w-[180px]" title={item.email_sender}>
                  {item.email_sender}
                </span>
              </>
            )}
          </div>
        </button>
        {confirming ? (
          <span className="absolute top-2 right-2 flex items-center gap-0.5">
            <HoverTip text={t('chat.sidebar.deleteConfirm')} side="left">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete()
                }}
                aria-label={t('chat.sidebar.deleteConfirm')}
                className="p-1.5 rounded bg-fail/15 text-fail hover:bg-fail/25 transition-colors duration-fast"
              >
                <Check size={13} strokeWidth={2.5} />
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
                className="p-1.5 rounded text-ink-fg-2 hover:text-ink-fg hover:bg-ink-4 transition-colors duration-fast"
              >
                <X size={13} strokeWidth={2.5} />
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
                'absolute top-2 right-2 p-1.5 rounded',
                'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                'transition-opacity duration-fast',
                'text-ink-fg-3 hover:text-fail hover:bg-fail/10'
              )}
            >
              <Trash2 size={13} strokeWidth={2} />
            </button>
          </HoverTip>
        )}
      </div>
    </li>
  )
}

/** Mirror of ChatSidebar's five-bucket formatter (kept local so the page
 *  doesn't depend on a sidebar internal). */
function formatRelativeTime(epochMs: number, t: TFunction): string {
  const diff = Date.now() - epochMs
  if (diff < 60_000) return t('chat.sidebar.justNow')
  if (diff < 3_600_000) return t('chat.sidebar.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('chat.sidebar.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('chat.sidebar.daysAgo', { n: Math.floor(diff / 86_400_000) })
}
