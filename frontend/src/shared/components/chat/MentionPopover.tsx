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
import { qk } from '@shared/lib/queryKeys'
import { Loader2, Search } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { DUR } from '@shared/lib/gsap'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useMailApi } from '@shared/hooks/useMailApi'
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
  // Sprint 14 PR H — keyboard nav. ↑/↓ moves highlight; Enter selects.
  // Reset to 0 every time `hits` changes (new query → fresh list).
  const [highlightedIndex, setHighlightedIndex] = useState(0)
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
  // 出入场：popover 锚在 Composer 上方 (bottom-full 向上展开)，故 transformOrigin
  // bottom left。无 backdrop，退场反向延迟卸载。scopeRef 兼作原 containerRef
  // (outside-click 命中判定的容器)。
  const { shouldRender, scopeRef: containerRef } = useExitAnimation<HTMLDivElement>(open, {
    backdrop: false,
    from: { autoAlpha: 0, y: 4, scale: 0.98, transformOrigin: 'bottom left' },
    enterDuration: DUR.fast
  })

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
  }, [open, onClose, containerRef])

  // T3: CJK transform 统一到后端 smart 模式，前端只 trim。
  const normalised = debounced.trim()
  const searchQ = useQuery<SearchResult>({
    queryKey: qk.mention.search(normalised),
    queryFn: () => mailApi.email.search({ query: normalised, limit: 10 }),
    enabled: open && normalised.length > 0,
    staleTime: 30_000
  })
  const hits: SearchHit[] = searchQ.data?.items ?? []
  const isSearching = searchQ.isFetching && normalised.length > 0

  // Adjust highlight index when the hit list shrinks under us (e.g.
  // user kept typing and the new query returns fewer results). Render-
  // time setState ("Adjusting on prop change" pattern) instead of a
  // post-render useEffect so the first paint already shows a valid
  // highlight.
  const maxIndex = Math.max(0, hits.length - 1)
  if (highlightedIndex > maxIndex) {
    setHighlightedIndex(maxIndex)
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (hits.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((cur) => Math.min(cur + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((cur) => Math.max(cur - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[highlightedIndex]
      if (hit) onSelect(hit)
    }
  }

  if (!shouldRender) return null
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
          onKeyDown={onInputKeyDown}
          placeholder={t('chat.mention.placeholder')}
          aria-label={t('chat.mention.searchAria')}
          aria-activedescendant={
            hits[highlightedIndex] ? `mention-hit-${hits[highlightedIndex].internal_id}` : undefined
          }
          aria-controls="mention-results"
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
          id="mention-results"
          role="listbox"
          aria-label={t('chat.mention.title')}
          className="flex-1 max-h-[240px] overflow-y-auto py-1"
        >
          {hits.map((hit, idx) => (
            <MentionItem
              key={hit.internal_id}
              hit={hit}
              highlighted={idx === highlightedIndex}
              onSelect={onSelect}
              onHover={() => setHighlightedIndex(idx)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface MentionItemProps {
  hit: SearchHit
  highlighted: boolean
  onSelect(hit: SearchHit): void
  onHover(): void
}

function MentionItem({
  hit,
  highlighted,
  onSelect,
  onHover
}: MentionItemProps): React.ReactElement {
  // SearchHit only exposes a bare `sender` (email address); the friendlier
  // `sender_name` lives on EmailDetail but isn't included in FTS5 search
  // hits. Display the address as-is — agents reading the popup can match
  // it to their mental model.
  const senderLabel = hit.sender || '—'
  return (
    <li role="option" id={`mention-hit-${hit.internal_id}`} aria-selected={highlighted}>
      <button
        type="button"
        onClick={() => onSelect(hit)}
        onMouseEnter={onHover}
        className={cn(
          'w-full text-left px-2.5 py-1.5',
          'transition-colors duration-fast',
          'flex flex-col gap-0.5',
          highlighted ? 'bg-ink-3' : 'hover:bg-ink-3'
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
