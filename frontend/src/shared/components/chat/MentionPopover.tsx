// Sprint 14 PR D — @-mention popover.
//
// Click Composer's AtSign button (left footer) to surface a search
// field anchored above the textarea; type to fuzzy-find emails via
// `mailApi.email.search` (Phase 3 FTS5 backend already shipped). Click
// a hit → AIChatPanel's `mentions` state grows by one, the textarea
// gets the `@subject` placeholder appended, and `handleSend` later
// prepends a "Referenced email: …" header to the user message so the
// LLM sees the email's subject + a snippet alongside the prompt.
//
// No new IPC / no backend changes — Composer-level UX layer + send-
// time prepend keeps the wire shape stable.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Search } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { normalizeFtsQuery } from '@shared/lib/search_query'
import type { SearchHit, SearchResult } from '@shared/api/types'

interface MentionPopoverProps {
  open: boolean
  onClose(): void
  onSelect(hit: SearchHit): void
}

// 200ms debounce — same value CommandPalette ('@shared/components/command/
// CommandPalette.tsx') uses. Long enough that fast typists don't fire a
// query per keystroke; short enough that the hit list feels live.
const SEARCH_DEBOUNCE_MS = 200

export function MentionPopover({
  open,
  onClose,
  onSelect
}: MentionPopoverProps): React.ReactElement | null {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  // "Adjusting state on prop change" — react.dev pattern. When `open`
  // flips to false, blank query + debounced inside render rather than
  // via useEffect so the next render already shows the empty state
  // (avoids no-set-state-in-effect lint per Sprint 18 review).
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (!open) {
      setQuery('')
      setDebounced('')
    }
  }
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Debounce — set a timer on every `query` change and clear on the
  // next change (cleanup). The trailing value lands in `debounced`
  // after the user pauses for SEARCH_DEBOUNCE_MS.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query), SEARCH_DEBOUNCE_MS)
    return (): void => clearTimeout(id)
  }, [query])

  // Auto-focus the input each time the popover opens. Reset of query
  // already happens in the render-time block above.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // Outside click + Escape close. Mirrors Composer's modelPicker
  // pattern (model dropdown above) for muscle-memory consistency.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return (): void => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const normalised = normalizeFtsQuery(debounced)
  const searchQ = useQuery<SearchResult>({
    queryKey: ['mention', 'search', normalised],
    queryFn: () => mailApi.email.search({ query: normalised, limit: 10 }),
    enabled: open && normalised.length > 0,
    staleTime: 30_000
  })
  const hits: SearchHit[] = searchQ.data?.items ?? []
  const isSearching = searchQ.isFetching && normalised.length > 0

  if (!open) return null
  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={t('chat.mention.title')}
      className={cn(
        'absolute bottom-full left-2 mb-2 w-[280px] z-50',
        // Tier-2 surface — light depth shadow per DESIGN.md §4 (no
        // heavy `shadow-lg`, which the lint rule prohibits for floating
        // chrome). Border + ink-2 surface already differentiates from
        // the Composer underneath; shadow-md is purely depth cueing.
        'rounded-lg border border-ink-border bg-ink-2 shadow-md',
        'flex flex-col overflow-hidden'
      )}
    >
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-ink-border-soft">
        <Search size={11} strokeWidth={2} className="text-ink-fg-3 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('chat.mention.placeholder')}
          aria-label={t('chat.mention.searchAria')}
          className={cn(
            'flex-1 bg-transparent text-aux text-ink-fg',
            'placeholder:text-ink-fg-3 outline-none border-0'
          )}
        />
        {isSearching && (
          <Loader2 size={11} strokeWidth={2} className="text-ink-fg-3 animate-spin shrink-0" />
        )}
      </div>
      {normalised.length === 0 ? (
        <div className="px-3 py-4 text-micro text-ink-fg-3 text-center">
          {t('chat.mention.hint')}
        </div>
      ) : hits.length === 0 && !isSearching ? (
        <div className="px-3 py-4 text-micro text-ink-fg-3 text-center">
          {t('chat.mention.noResults', { query: debounced })}
        </div>
      ) : (
        <ul
          role="listbox"
          aria-label={t('chat.mention.title')}
          className="flex-1 max-h-[240px] overflow-y-auto py-1"
        >
          {hits.map((hit) => (
            <MentionItem key={hit.internal_id} hit={hit} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </div>
  )
}

interface MentionItemProps {
  hit: SearchHit
  onSelect(hit: SearchHit): void
}

function MentionItem({ hit, onSelect }: MentionItemProps): React.ReactElement {
  // SearchHit only exposes a bare `sender` (email address); the friendlier
  // `sender_name` lives on EmailDetail but isn't included in FTS5 search
  // hits. Display the address as-is — agents reading the popup can match
  // it to their mental model.
  const senderLabel = hit.sender || '—'
  return (
    <li role="option">
      <button
        type="button"
        onClick={() => onSelect(hit)}
        className={cn(
          'w-full text-left px-2.5 py-1.5',
          'hover:bg-ink-3 transition-colors duration-fast',
          'flex flex-col gap-0.5'
        )}
      >
        <span className="text-meta text-ink-fg truncate">{hit.subject || '(无主题)'}</span>
        <span className="text-micro font-mono text-ink-fg-3 truncate">
          {senderLabel} · #{hit.internal_id}
        </span>
      </button>
    </li>
  )
}
