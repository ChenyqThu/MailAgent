// Search-module 1:1 mockup-search.html — ⌘K command palette + jump.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, BookmarkPlus, Search as SearchIcon, X } from 'lucide-react'
import { cn } from '@shared/lib/cn'
import { useExitAnimation } from '@shared/hooks/useExitAnimation'
import { useFocusTrap } from '@shared/hooks/useFocusTrap'
import { closeCommandPalette, useCommandPalette } from '@shared/state/command-palette'
import { useSearchHistory } from '@shared/state/search-history'
import type { SearchAgentPhase, SearchHit } from '@shared/api/types'
import type { PaletteScope } from './paletteMatters'
import { detectLang, IS_WEB, type ScopeItem } from './commandPaletteTypes'
import { useCommandPaletteSearch } from './useCommandPaletteSearch'
import { useCommandPaletteActions } from './useCommandPaletteActions'
import { CommandPaletteList } from './CommandPaletteList'

export function CommandPalette(): React.ReactElement | null {
  const { t } = useTranslation()
  const open = useCommandPalette((s) => s.open)

  const history = useSearchHistory((s) => s.history)
  const savedSearches = useSearchHistory((s) => s.saved)
  const removeHistory = useSearchHistory((s) => s.removeHistory)
  const clearHistory = useSearchHistory((s) => s.clearHistory)
  const removeSaved = useSearchHistory((s) => s.removeSaved)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<PaletteScope>('all')
  const [highlight, setHighlight] = useState(0)
  const [lastLatencyMs, setLastLatencyMs] = useState<number | null>(null)
  const [actionRunning, setActionRunning] = useState<string | null>(null)

  const [aiSearching, setAiSearching] = useState(false)
  const [aiHits, setAiHits] = useState<SearchHit[]>([])
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiCompleted, setAiCompleted] = useState(false)
  const [aiPhase, setAiPhase] = useState<SearchAgentPhase>('searching')
  const [aiPhaseDetail, setAiPhaseDetail] = useState<string | null>(null)
  const aiAbortRef = useRef<AbortController | null>(null)

  // Adjust-on-prop-change: always start from an empty query on closed→open.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    setScope('all')
    if (open) {
      setQuery('')
      setHighlight(0)
      setLastLatencyMs(null)
      setActionRunning(null)
      setAiSearching(false)
      setAiHits([])
      setAiSummary(null)
      setAiError(null)
      setAiCompleted(false)
      setAiPhase('searching')
      setAiPhaseDetail(null)
    }
  }

  useEffect(() => {
    if (open) return
    if (aiAbortRef.current) {
      aiAbortRef.current.abort()
      aiAbortRef.current = null
    }
  }, [open])

  const inputRef = useRef<HTMLInputElement>(null)
  const veilRef = useRef<HTMLDivElement>(null)
  const { dialogRef, handleTab } = useFocusTrap({ open })
  const { shouldRender, scopeRef } = useExitAnimation<HTMLDivElement>(open, {
    card: '.palette-pane',
    backdrop: '.palette-veil',
    from: { autoAlpha: 0, xPercent: -50, y: 8, scale: 0.97 }
  })

  useEffect(() => {
    if (!open) return
    const tid = window.setTimeout(() => inputRef.current?.focus(), 0)
    return (): void => window.clearTimeout(tid)
  }, [open])

  const focusInput = useCallback((): void => {
    inputRef.current?.focus()
  }, [])

  const search = useCommandPaletteSearch({
    open,
    query,
    scope,
    aiHits,
    onMeasuredLatency: setLastLatencyMs
  })

  const actions = useCommandPaletteActions({
    open,
    query,
    setQuery,
    debouncedRaw: search.debouncedRaw,
    highlight,
    setHighlight,
    setActionRunning,
    focusInput,
    dialogRef,
    handleTab,
    mailboxes: search.mailboxes,
    hits: search.hits,
    dedupedHits: search.dedupedHits,
    visibleMatterHits: search.visibleMatterHits,
    visibleContactHits: search.visibleContactHits,
    libraryHits: search.libraryHits,
    scopeVisibility: search.scopeVisibility,
    ai: {
      aiSearching,
      setAiSearching,
      aiHits,
      setAiHits,
      aiSummary,
      setAiSummary,
      aiError,
      setAiError,
      aiCompleted,
      setAiCompleted,
      aiPhase,
      setAiPhase,
      aiPhaseDetail,
      setAiPhaseDetail,
      aiAbortRef
    }
  })

  // Clamp highlight in render (no extra paint cycle).
  if (actions.flat.length > 0 && highlight >= actions.flat.length) {
    setHighlight(Math.max(0, actions.flat.length - 1))
  } else if (actions.flat.length === 0 && highlight !== 0) {
    setHighlight(0)
  }

  useEffect(() => {
    if (!open) return
    const root = dialogRef.current
    if (!root) return
    const opt = root.querySelector<HTMLElement>(`[data-flat-idx="${highlight}"]`)
    opt?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight, dialogRef])

  if (!shouldRender) return null

  const lang = detectLang(query)
  const langLabel = lang === 'zh' ? t('palette.lang.zh') : t('palette.lang.en')
  const hasHits = search.dedupedHits.length > 0
  const showEmailGroup =
    search.scopeVisibility.showEmail &&
    search.hasQuery &&
    (search.dedupedHits.length > 0 || aiHits.length === 0)
  const showAiEmpty = aiCompleted && !aiSearching && aiHits.length === 0
  const countLabel =
    search.totalIndexed === null
      ? `${search.dedupedHits.length}`
      : t('palette.email.countLabel', { n: search.dedupedHits.length, total: search.totalIndexed })

  const scopeItems: ReadonlyArray<ScopeItem> = [
    {
      id: 'all',
      count:
        search.emailProviderCount +
        search.visibleMatterHits.length +
        search.visibleContactHits.length +
        search.libraryHits.length
    },
    { id: 'email', count: search.emailProviderCount },
    ...(search.mattersEnabled
      ? [{ id: 'matter', count: search.visibleMatterHits.length } as const]
      : []),
    ...(search.contactsEnabled
      ? [{ id: 'contact', count: search.visibleContactHits.length } as const]
      : []),
    ...(IS_WEB ? [] : [{ id: 'library', count: search.libraryHits.length } as const])
  ]

  return createPortal(
    <div ref={scopeRef} style={{ display: 'contents' }}>
      <div
        ref={veilRef}
        className="palette-veil"
        role="presentation"
        onClick={closeCommandPalette}
      />

      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.aria.label')}
        tabIndex={-1}
        onKeyDown={actions.onKeyDown}
        className="palette-pane glass-pop"
      >
        <div className="px-4 h-12 flex items-center gap-3 border-b border-ink-border-soft shrink-0">
          <SearchIcon size={15} strokeWidth={2} className="text-ink-fg-2 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              if (aiAbortRef.current) {
                aiAbortRef.current.abort()
                aiAbortRef.current = null
              }
              if (aiSearching) setAiSearching(false)
              if (aiHits.length > 0) setAiHits([])
              if (aiSummary !== null) setAiSummary(null)
              if (aiError) setAiError(null)
              if (aiCompleted) setAiCompleted(false)
              setAiPhase('searching')
              setAiPhaseDetail(null)
            }}
            placeholder={t('palette.placeholder')}
            autoComplete="off"
            spellCheck={false}
            aria-autocomplete="list"
            aria-controls="palette-listbox"
            aria-expanded={true}
            aria-activedescendant={actions.flat.length > 0 ? `palette-opt-${highlight}` : undefined}
            className="palette-input flex-1"
          />
          <span
            className="lang-pip shrink-0"
            title={t('palette.lang.detected')}
            aria-label={t('palette.lang.detected')}
          >
            {langLabel}
          </span>
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                actions.switchToPlainSearch()
              }}
              title="Clear"
              aria-label="Clear search"
              className="text-ink-fg-2 hover:text-ink-fg p-1 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
            >
              <X size={14} strokeWidth={2} />
            </button>
          )}
        </div>

        {actions.facetChips.length > 0 && (
          <div className="px-4 py-1.5 flex items-center gap-1.5 flex-wrap border-b border-ink-border-soft shrink-0">
            {actions.facetChips.map((c) => (
              <button
                key={c.token}
                type="button"
                onClick={() => actions.toggleFacet(c.token)}
                aria-pressed={c.active}
                className={cn(
                  'text-micro px-2 py-0.5 rounded-full border transition shrink-0',
                  c.active
                    ? 'bg-coral/[0.14] border-coral/40 text-coral'
                    : 'bg-ink-fg/[0.04] border-ink-border-soft text-ink-fg-2 hover:text-ink-fg hover:bg-ink-fg/[0.08]'
                )}
              >
                {c.label}
              </button>
            ))}
            {search.hasQuery && (
              <button
                type="button"
                onClick={actions.saveCurrentSearch}
                title={t('palette.saved.save')}
                aria-label={t('palette.saved.save')}
                className="ml-auto inline-flex items-center gap-1 text-micro text-ink-fg-2 hover:text-ink-fg transition shrink-0"
              >
                <BookmarkPlus size={12} strokeWidth={2} className="shrink-0" aria-hidden />
                <span>{t('palette.saved.save')}</span>
              </button>
            )}
          </div>
        )}

        {search.hasQuery &&
          !search.searchQ.isPlaceholderData &&
          search.searchQ.data?.coverage?.scope === 'metadata_candidates' &&
          !search.searchQ.data.coverage.complete && (
            <div
              role="status"
              className="px-4 py-1.5 border-b border-ink-border-soft text-micro text-ink-fg-2"
            >
              {t('palette.coverage.candidates', {
                count:
                  search.searchQ.data.coverage.body_missing +
                  search.searchQ.data.coverage.body_unsearchable
              })}
            </div>
          )}

        {search.hasQuery && search.parseWarnings.length > 0 && (
          <div className="px-4 py-1.5 flex items-start gap-1.5 border-b border-ink-border-soft text-micro text-ink-fg-2 shrink-0">
            <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0 text-warn" />
            <span className="leading-snug">
              {search.parseWarnings.map((w) => search.formatWarning(w)).join('；')}
            </span>
          </div>
        )}

        {aiError && (
          <div className="px-4 py-1.5 flex items-start gap-1.5 border-b border-ink-border-soft text-micro text-ink-fg-2 shrink-0">
            <AlertTriangle size={12} strokeWidth={2} className="mt-px shrink-0 text-warn" />
            <span className="leading-snug flex-1 min-w-0">{aiError}</span>
            <button
              type="button"
              onClick={() => setAiError(null)}
              title={t('palette.ai.dismiss')}
              aria-label={t('palette.ai.dismiss')}
              className="text-ink-fg-2 hover:text-ink-fg p-0.5 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
            >
              <X size={12} strokeWidth={2} />
            </button>
          </div>
        )}

        {(search.mattersEnabled || search.contactsEnabled || !IS_WEB) && search.hasQuery ? (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-border-soft px-4 py-1.5">
            {scopeItems.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={scope === item.id}
                onClick={() => setScope(item.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-micro transition',
                  scope === item.id
                    ? 'border-coral/40 bg-coral/[0.14] text-coral'
                    : 'border-ink-border-soft bg-ink-fg/[0.04] text-ink-fg-2 hover:bg-ink-fg/[0.08] hover:text-ink-fg'
                )}
              >
                <span>{t(`palette.matters.scope.${item.id}`)}</span>
                <span className="font-mono text-[10px] opacity-70">{item.count}</span>
              </button>
            ))}
          </div>
        ) : null}

        <CommandPaletteList
          hasQuery={search.hasQuery}
          scope={scope}
          scopeVisibility={search.scopeVisibility}
          highlight={highlight}
          setHighlight={setHighlight}
          queryTerms={search.queryTerms}
          jumpItems={actions.jumpItems}
          mattersEnabled={search.mattersEnabled}
          visibleMatterHits={search.visibleMatterHits}
          isSearchingMatters={search.isSearchingMatters}
          contactsEnabled={search.contactsEnabled}
          visibleContactHits={search.visibleContactHits}
          contactOverflow={search.contactOverflow}
          isSearchingContacts={search.isSearchingContacts}
          libraryHits={search.libraryHits}
          libraryWarnings={search.libraryWarnings}
          isSearchingLibrary={search.isSearchingLibrary}
          history={history}
          savedSearches={savedSearches}
          clearHistory={clearHistory}
          removeHistory={removeHistory}
          removeSaved={removeSaved}
          runStoredQuery={actions.runStoredQuery}
          aiSearching={aiSearching}
          aiPhase={aiPhase}
          aiPhaseDetail={aiPhaseDetail}
          aiSummary={aiSummary}
          aiHits={aiHits}
          showAiEmpty={showAiEmpty}
          switchToPlainSearch={actions.switchToPlainSearch}
          onRunAiSearch={() => void actions.runAiSearch()}
          showEmailGroup={showEmailGroup}
          countLabel={countLabel}
          isSearching={search.isSearching}
          lastLatencyMs={lastLatencyMs}
          hasHits={hasHits}
          dedupedHits={search.dedupedHits}
          hitsLength={search.hits.length}
          totalIndexed={search.totalIndexed}
          lookupMattersData={search.matterLookupData}
          actionItems={actions.actionItems}
          actionRunning={actionRunning}
          activateMatter={actions.activateMatter}
          activateContact={actions.activateContact}
          activateLibraryFile={actions.activateLibraryFile}
          activateHit={actions.activateHit}
        />
      </section>
    </div>,
    document.body
  )
}
