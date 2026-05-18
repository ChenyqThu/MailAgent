// Sprint 3 §2.1 — FTS5 full-text search page.
//
// Lives at /search (router-instance.tsx). Mirrors the visual language of
// EmailList (340px ink-2 column) but stretches to flex-1 because it owns
// the main column when /search is active.
//
// Query normalisation handles the FTS5 unicode61 quirk (CLAUDE.md "Phase 3"):
// bare CJK queries get a `*` suffix on the last whitespace-separated token so
// "产品" matches the token "本周产品评审" via prefix search. Queries that
// already contain wildcards (* "), FTS5 operators (AND/OR/NOT/NEAR), or no
// CJK chars at all pass through untouched.
//
// Snippet rendering: backend SQL emits FTS5 `snippet()` with literal
// <mark>...</mark> tags. DOMPurify's html profile keeps <mark> by default
// so we render directly via dangerouslySetInnerHTML on a sanitised string.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import DOMPurify from 'dompurify'
import { ArrowLeft, CalendarRange, Folder, Search as SearchIcon, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useActiveEmail } from '@shared/state/active-email'
import { formatRelativeTime } from '@shared/format'
import { EmptyState } from '@shared/components/feedback/EmptyState'
import { SkeletonRow } from '@shared/components/feedback/LoadingSkeleton'
import { parseSender } from '@shared/lib/mail_parse'
import { normalizeFtsQuery } from '@shared/lib/search_query'
import type { MailboxSummary, SearchHit } from '@shared/api/types'

// ---- since filter ----------------------------------------------------------

type SinceId = 'any' | '7d' | '30d'

function sinceToIso(s: SinceId): string | undefined {
  if (s === 'any') return undefined
  const days = s === '7d' ? 7 : 30
  const t = Date.now() - days * 24 * 60 * 60 * 1000
  // YYYY-MM-DD slice — backend FTS5 join compares against date_received
  // which is stored as ISO8601 with offset; lexical comparison works
  // for the date-only prefix.
  return new Date(t).toISOString().slice(0, 10)
}

// ---- debounce --------------------------------------------------------------

function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return debounced
}

// ---- sub-components --------------------------------------------------------

function FilterChip({
  active,
  icon,
  children,
  onClick
}: {
  active: boolean
  icon: React.ReactNode
  children: React.ReactNode
  onClick(): void
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded border text-aux transition-colors duration-fast',
        active
          ? 'text-coral bg-coral/15 border-coral/30 hover:bg-coral/20'
          : 'text-ink-fg-1 border-transparent hover:text-ink-fg hover:bg-ink-4'
      )}
    >
      <span className="shrink-0 grid place-items-center w-3 h-3">{icon}</span>
      <span>{children}</span>
    </button>
  )
}

function SnippetText({ html }: { html: string }): React.ReactElement {
  // FTS5 snippet emits literal <mark>…</mark>; DOMPurify default html profile
  // keeps <mark>. We strip everything else for safety — search snippets
  // are short text fragments, no need for links or block-level tags.
  const safe = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['mark', 'em', 'strong'],
        ALLOWED_ATTR: []
      }),
    [html]
  )
  return (
    <span
      className="text-aux text-ink-fg-2 line-clamp-2 [&_mark]:bg-coral/20 [&_mark]:text-coral [&_mark]:rounded-sm [&_mark]:px-0.5"
      dangerouslySetInnerHTML={{ __html: safe }}
    />
  )
}

function SearchHitRow({ hit, onSelect }: { hit: SearchHit; onSelect(): void }): React.ReactElement {
  const parsed = parseSender(hit.sender)
  const senderName = parsed.name || hit.sender
  const senderAddr = parsed.email
  const time = hit.date_received ? formatRelativeTime(hit.date_received) : ''

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'row px-4 py-3 border-b border-ink-border-soft cursor-pointer',
        'transition-colors duration-fast hover:bg-ink-4'
      )}
    >
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-aux truncate flex-1 text-ink-fg-1">
          <span className="font-medium text-ink-fg">{senderName}</span>
          {senderAddr && (
            <>
              <span className="text-ink-fg-3"> · </span>
              <span className="text-ink-fg-2">{senderAddr}</span>
            </>
          )}
        </span>
        {hit.mailbox && (
          <span className="text-meta font-mono text-ink-fg-2 shrink-0">{hit.mailbox}</span>
        )}
        <span className="text-meta font-mono text-ink-fg-2 shrink-0 tabular-nums">{time}</span>
      </div>
      <div className="text-body text-ink-fg font-semibold truncate">
        {hit.subject || '(no subject)'}
      </div>
      {hit.snippet && (
        <div className="mt-1">
          <SnippetText html={hit.snippet} />
        </div>
      )}
    </article>
  )
}

// ---- main page -------------------------------------------------------------

export function SearchPage(): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const setActive = useActiveEmail((s) => s.setActive)
  const navigate = useNavigate()

  const [rawQuery, setRawQuery] = useState('')
  const [mailbox, setMailbox] = useState<string | null>(null)
  const [since, setSince] = useState<SinceId>('any')

  const debouncedRaw = useDebouncedValue(rawQuery, 200)
  const normalised = useMemo(() => normalizeFtsQuery(debouncedRaw), [debouncedRaw])
  const sinceIso = useMemo(() => sinceToIso(since), [since])

  const mailboxesQ = useQuery({
    queryKey: ['mailboxes'],
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 60_000
  })
  const mailboxes: MailboxSummary[] = mailboxesQ.data ?? []

  const searchQ = useQuery({
    queryKey: ['search', normalised, mailbox, sinceIso],
    queryFn: () =>
      mailApi.email.search({
        query: normalised,
        mailbox: mailbox ?? undefined,
        since: sinceIso,
        limit: 50
      }),
    enabled: normalised.length > 0,
    staleTime: 30_000
  })

  const hits = searchQ.data ?? []

  function selectHit(h: SearchHit): void {
    setActive(h.internal_id)
    navigate({ to: '/' })
  }

  return (
    <main aria-label="search-page" className="flex-1 min-w-0 bg-ink-3 flex flex-col min-h-0">
      {/* Header — back button + title + filter chips */}
      <header className="px-4 pt-3 pb-2.5 border-b border-ink-border-soft shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={() => navigate({ to: '/' })}
            title={t('search.back')}
            className="p-1.5 rounded hover:bg-ink-4 text-ink-fg-2 hover:text-ink-fg transition-colors duration-fast"
          >
            <ArrowLeft size={14} strokeWidth={2} />
          </button>
          <h1 className="text-lead font-semibold text-ink-fg tracking-tight">
            {t('search.title')}
          </h1>
          <span className="ml-auto text-aux text-ink-fg-2">{t('search.subtitle')}</span>
        </div>

        {/* Search input */}
        <div className="flex items-center gap-2 px-3 py-2 bg-ink-4 rounded-md border border-ink-border">
          <SearchIcon size={14} strokeWidth={2} className="text-ink-fg-2 shrink-0" />
          <input
            type="search"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            autoFocus
            className="flex-1 bg-transparent outline-none text-body text-ink-fg placeholder:text-ink-fg-3"
          />
          {rawQuery.length > 0 && (
            <button
              type="button"
              onClick={() => setRawQuery('')}
              title="Clear"
              className="p-0.5 rounded text-ink-fg-3 hover:text-ink-fg hover:bg-ink-5 transition-colors duration-fast"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>

        {/* Filter chips */}
        <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
          <FilterChip
            active={mailbox === null}
            icon={<Folder size={11} strokeWidth={2} />}
            onClick={() => setMailbox(null)}
          >
            {t('search.filter.allMailboxes')}
          </FilterChip>
          {mailboxes.map((mb) => (
            <FilterChip
              key={mb.mailbox}
              active={mailbox === mb.mailbox}
              icon={<Folder size={11} strokeWidth={2} />}
              onClick={() => setMailbox(mailbox === mb.mailbox ? null : mb.mailbox)}
            >
              {mb.mailbox}
            </FilterChip>
          ))}

          <span className="w-px h-4 bg-ink-border mx-1" aria-hidden />

          <FilterChip
            active={since === 'any'}
            icon={<CalendarRange size={11} strokeWidth={2} />}
            onClick={() => setSince('any')}
          >
            {t('search.filter.any')}
          </FilterChip>
          <FilterChip
            active={since === '7d'}
            icon={<CalendarRange size={11} strokeWidth={2} />}
            onClick={() => setSince(since === '7d' ? 'any' : '7d')}
          >
            {t('search.filter.since7d')}
          </FilterChip>
          <FilterChip
            active={since === '30d'}
            icon={<CalendarRange size={11} strokeWidth={2} />}
            onClick={() => setSince(since === '30d' ? 'any' : '30d')}
          >
            {t('search.filter.since30d')}
          </FilterChip>
        </div>
      </header>

      {/* Result list */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {normalised.length === 0 && (
          <EmptyState
            icon={
              <SearchIcon size={32} strokeWidth={1.25} className="opacity-30" />
            }
            title={t('search.blankState')}
          />
        )}

        {normalised.length > 0 && searchQ.isLoading && (
          <div className="px-3 py-4 space-y-2">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        )}

        {normalised.length > 0 && searchQ.isError && (
          <EmptyState
            icon={<SearchIcon size={20} strokeWidth={1.75} className="text-fail" />}
            title={t('search.error')}
            action={
              <button
                type="button"
                onClick={() => void searchQ.refetch()}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-aux text-coral border border-coral/30 hover:bg-coral/10 transition-colors duration-fast"
              >
                {t('translate.retry')}
              </button>
            }
          />
        )}

        {normalised.length > 0 && !searchQ.isLoading && !searchQ.isError && hits.length === 0 && (
          <EmptyState
            icon={<SearchIcon size={20} strokeWidth={1.75} className="text-ink-fg-3" />}
            title={t('search.noResults')}
            hint={t('search.noResultsHint')}
          />
        )}

        {normalised.length > 0 && hits.length > 0 && (
          <>
            <div className="px-4 py-2 flex items-center gap-2 text-ink-fg-2 border-b border-ink-border-soft">
              <span className="text-meta font-mono tabular-nums text-ink-fg-1">{hits.length}</span>
              <span className="text-aux">{t('search.count', { n: hits.length })}</span>
              {searchQ.isFetching && (
                <span className="ml-auto text-meta font-mono text-ink-fg-3 animate-pulse">...</span>
              )}
            </div>
            {hits.map((h) => (
              <SearchHitRow key={h.internal_id} hit={h} onSelect={() => selectHit(h)} />
            ))}
          </>
        )}
      </div>
    </main>
  )
}
