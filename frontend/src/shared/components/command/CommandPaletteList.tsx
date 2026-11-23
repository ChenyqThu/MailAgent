import type React from 'react'
import { useTranslation } from 'react-i18next'
import { Bookmark, Clock, Loader2, Search as SearchIcon, Sparkles, Trash2, X } from 'lucide-react'
import { cn } from '@shared/lib/cn'
import type { SearchAgentPhase, SearchHit } from '@shared/api/types'
import type { Matter } from '@shared/api/types/matter'
import type { ContactRowDto } from '@shared/api/types/contact'
import type { SavedSearch } from '@shared/state/search-history'
import type { LibrarySearchHit } from '@shared/api/types/library'
import { EmailHitRow } from './EmailHitRow'
import { LibraryHitRow, LibrarySearchWarnings } from './LibraryHitRow'
import { MatterHitRow } from './MatterHitRow'
import { PersonHitRow } from './PersonHitRow'
import { PaletteThinkingPhrases } from './PaletteThinkingPhrases'
import {
  lookupMattersForEmail,
  type PaletteScope,
  type PaletteScopeVisibility
} from './paletteMatters'
import {
  type ActionRow,
  IS_WEB,
  type JumpRow,
  SEARCH_SYNTAX_HINTS
} from './commandPaletteTypes'

interface GroupHeaderProps {
  title: string
  countLabel?: string
  subtitle?: string
  aside?: React.ReactNode
}

function GroupHeader({ title, countLabel, subtitle, aside }: GroupHeaderProps): React.ReactElement {
  return (
    <h2 className="text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-2 px-5 py-1.5 flex items-center gap-2">
      <span>{title}</span>
      {countLabel !== undefined && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="text-ink-fg-3 tabular-nums">{countLabel}</span>
        </>
      )}
      {subtitle && (
        <>
          <span className="text-ink-fg-3">·</span>
          <span className="text-ink-fg-3 normal-case tracking-normal">{subtitle}</span>
        </>
      )}
      {aside && (
        <span className="ml-auto flex items-center gap-1.5 text-ink-fg-3 normal-case tracking-normal">
          {aside}
        </span>
      )}
    </h2>
  )
}

function KbdHint({ keys, label }: { keys: string; label: string }): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
        {keys}
      </kbd>
      <span className="normal-case">{label}</span>
    </span>
  )
}

function FooterDot(): React.ReactElement {
  return <span className="text-ink-fg-3">·</span>
}

export interface CommandPaletteListProps {
  hasQuery: boolean
  scope: PaletteScope
  scopeVisibility: PaletteScopeVisibility
  highlight: number
  setHighlight: React.Dispatch<React.SetStateAction<number>>
  queryTerms: string[]
  jumpItems: JumpRow[]
  mattersEnabled: boolean
  visibleMatterHits: Matter[]
  isSearchingMatters: boolean
  contactsEnabled: boolean
  visibleContactHits: ContactRowDto[]
  contactOverflow: number
  isSearchingContacts: boolean
  libraryHits: Array<LibrarySearchHit & { id: number }>
  libraryWarnings: string[]
  isSearchingLibrary: boolean
  history: string[]
  savedSearches: SavedSearch[]
  clearHistory: () => void
  removeHistory: (q: string) => void
  removeSaved: (id: string) => void
  runStoredQuery: (q: string) => void
  aiSearching: boolean
  aiPhase: SearchAgentPhase
  aiPhaseDetail: string | null
  aiSummary: string | null
  aiHits: SearchHit[]
  showAiEmpty: boolean
  switchToPlainSearch: () => void
  onRunAiSearch: () => void
  showEmailGroup: boolean
  countLabel: string
  isSearching: boolean
  lastLatencyMs: number | null
  hasHits: boolean
  dedupedHits: SearchHit[]
  hitsLength: number
  totalIndexed: number | null
  lookupMattersData?: Parameters<typeof lookupMattersForEmail>[0]
  actionItems: ActionRow[]
  actionRunning: string | null
  activateMatter: (matter: Matter) => void
  activateContact: (contact: ContactRowDto) => void
  activateLibraryFile: (fileId: number) => void
  activateHit: (hit: SearchHit) => void
}

export function CommandPaletteList(props: CommandPaletteListProps): React.ReactElement {
  const { t } = useTranslation()
  const {
    hasQuery,
    scope,
    scopeVisibility,
    highlight,
    setHighlight,
    queryTerms,
    jumpItems,
    mattersEnabled,
    visibleMatterHits,
    isSearchingMatters,
    contactsEnabled,
    visibleContactHits,
    contactOverflow,
    isSearchingContacts,
    libraryHits,
    libraryWarnings,
    isSearchingLibrary,
    history,
    savedSearches,
    clearHistory,
    removeHistory,
    removeSaved,
    runStoredQuery,
    aiSearching,
    aiPhase,
    aiPhaseDetail,
    aiSummary,
    aiHits,
    showAiEmpty,
    switchToPlainSearch,
    onRunAiSearch,
    showEmailGroup,
    countLabel,
    isSearching,
    lastLatencyMs,
    hasHits,
    dedupedHits,
    hitsLength,
    totalIndexed,
    lookupMattersData,
    actionItems,
    actionRunning,
    activateMatter,
    activateContact,
    activateLibraryFile,
    activateHit
  } = props

  let cursor = 0
  const jumpStartIdx = cursor
  cursor += scopeVisibility.showNonProviderGroups ? jumpItems.length : 0
  const matterStartIdx = cursor
  cursor += scopeVisibility.showMatter ? visibleMatterHits.length : 0
  const contactStartIdx = cursor
  cursor += scopeVisibility.showContact ? visibleContactHits.length : 0
  const libraryStartIdx = cursor
  cursor += scopeVisibility.showLibrary ? libraryHits.length : 0
  const aiStartIdx = cursor
  cursor += scopeVisibility.showEmail ? aiHits.length : 0
  const emailStartIdx = cursor
  cursor += scopeVisibility.showEmail ? dedupedHits.length : 0
  const actionStartIdx = cursor

  return (
    <>
      <ul
        id="palette-listbox"
        role="listbox"
        aria-label={t('palette.aria.list')}
        className="flex-1 overflow-y-auto scrollbar-thin py-2"
      >
        {scopeVisibility.showNonProviderGroups && jumpItems.length > 0 && (
          <>
            <GroupHeader title="Jump" countLabel={String(jumpItems.length)} />
            <div className="px-3 space-y-px">
              {jumpItems.map((j, i) => {
                const idx = jumpStartIdx + i
                const selected = idx === highlight
                return (
                  <li
                    key={j.id}
                    role="option"
                    id={`palette-opt-${idx}`}
                    data-flat-idx={idx}
                    aria-selected={selected}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={j.isAiEntry ? onRunAiSearch : j.run}
                    className={cn('pal-row', selected && 'is-selected')}
                  >
                    <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
                      {j.icon}
                    </span>
                    {j.label}
                    {j.aside && <span className="shrink-0 mr-2">{j.aside}</span>}
                    <span className="pal-hint items-center gap-1.5 text-micro font-mono text-ink-fg-2 shrink-0">
                      <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
                        {j.isAiEntry ? '⌘⏎' : '⏎'}
                      </kbd>
                      <span>{j.isAiEntry ? t('palette.kbd.aiSearch') : t('palette.kbd.open')}</span>
                    </span>
                  </li>
                )
              })}
            </div>
          </>
        )}

        {mattersEnabled &&
        scopeVisibility.showMatter &&
        hasQuery &&
        (visibleMatterHits.length > 0 || scope === 'matter') ? (
          <>
            <GroupHeader
              title={t('palette.matters.title')}
              countLabel={String(visibleMatterHits.length)}
              aside={
                isSearchingMatters ? (
                  <>
                    <Loader2
                      size={12}
                      strokeWidth={2}
                      className="animate-spin text-ink-fg-2 motion-reduce:animate-none"
                      aria-hidden
                    />
                    <span>{t('palette.searching')}</span>
                  </>
                ) : undefined
              }
            />
            {visibleMatterHits.length > 0 ? (
              <div className="space-y-px px-3">
                {visibleMatterHits.map((matter, index) => {
                  const idx = matterStartIdx + index
                  return (
                    <MatterHitRow
                      key={matter.public_id}
                      matter={matter}
                      flatIdx={idx}
                      selected={idx === highlight}
                      setHighlight={setHighlight}
                      queryTerms={queryTerms}
                      onActivate={() => activateMatter(matter)}
                    />
                  )
                })}
              </div>
            ) : (
              <div className="px-5">
                <div className="empty-tile">
                  {isSearchingMatters ? (
                    <Loader2
                      size={18}
                      strokeWidth={1.75}
                      className="animate-spin text-ink-fg-3 motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : (
                    <SearchIcon
                      size={18}
                      strokeWidth={1.75}
                      className="text-ink-fg-3"
                      aria-hidden
                    />
                  )}
                  <div className="text-aux text-ink-fg-1">
                    {isSearchingMatters ? t('palette.searching') : t('palette.matters.emptyTitle')}
                  </div>
                  {!isSearchingMatters ? (
                    <div className="text-center text-meta text-ink-fg-3">
                      {t('palette.matters.emptyHint')}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </>
        ) : null}

        {contactsEnabled &&
        scopeVisibility.showContact &&
        hasQuery &&
        (visibleContactHits.length > 0 || scope === 'contact') ? (
          <>
            <GroupHeader
              title={t('palette.contacts.title')}
              countLabel={String(visibleContactHits.length)}
              aside={
                isSearchingContacts ? (
                  <>
                    <Loader2
                      size={12}
                      strokeWidth={2}
                      className="animate-spin text-ink-fg-2 motion-reduce:animate-none"
                      aria-hidden
                    />
                    <span>{t('palette.searching')}</span>
                  </>
                ) : undefined
              }
            />
            {visibleContactHits.length > 0 ? (
              <>
                <div className="space-y-px px-3">
                  {visibleContactHits.map((contact, index) => {
                    const idx = contactStartIdx + index
                    return (
                      <PersonHitRow
                        key={contact.id}
                        contact={contact}
                        flatIdx={idx}
                        selected={idx === highlight}
                        setHighlight={setHighlight}
                        queryTerms={queryTerms}
                        onActivate={() => activateContact(contact)}
                      />
                    )
                  })}
                </div>
                {contactOverflow > 0 ? (
                  <div className="px-5 pb-1 pt-0.5 text-[10px] text-ink-fg-3">
                    {t('palette.contacts.moreMatches', { n: contactOverflow })}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="px-5">
                <div className="empty-tile">
                  {isSearchingContacts ? (
                    <Loader2
                      size={18}
                      strokeWidth={1.75}
                      className="animate-spin text-ink-fg-3 motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : (
                    <SearchIcon
                      size={18}
                      strokeWidth={1.75}
                      className="text-ink-fg-3"
                      aria-hidden
                    />
                  )}
                  <div className="text-aux text-ink-fg-1">
                    {isSearchingContacts ? t('palette.searching') : t('palette.contacts.emptyTitle')}
                  </div>
                  {!isSearchingContacts ? (
                    <div className="text-center text-meta text-ink-fg-3">
                      {t('palette.contacts.emptyHint')}
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </>
        ) : null}

        {!IS_WEB &&
        scopeVisibility.showLibrary &&
        hasQuery &&
        (libraryHits.length > 0 || libraryWarnings.length > 0 || scope === 'library') ? (
          <>
            <GroupHeader
              title={t('library.search.groupTitle')}
              countLabel={String(libraryHits.length)}
              aside={
                isSearchingLibrary ? (
                  <>
                    <Loader2
                      size={12}
                      strokeWidth={2}
                      className="animate-spin text-ink-fg-2 motion-reduce:animate-none"
                      aria-hidden
                    />
                    <span>{t('palette.searching')}</span>
                  </>
                ) : undefined
              }
            />
            <LibrarySearchWarnings warnings={libraryWarnings} className="px-5 pb-1 pt-0.5" />
            {libraryHits.length > 0 ? (
              <div className="space-y-px px-3">
                {libraryHits.map((file, index) => {
                  const idx = libraryStartIdx + index
                  return (
                    <LibraryHitRow
                      key={file.id}
                      hit={file}
                      flatIdx={idx}
                      selected={idx === highlight}
                      setHighlight={setHighlight}
                      queryTerms={queryTerms}
                      onActivate={() => activateLibraryFile(file.id)}
                    />
                  )
                })}
              </div>
            ) : libraryWarnings.length === 0 ? (
              <div className="px-5">
                <div className="empty-tile">
                  {isSearchingLibrary ? (
                    <Loader2
                      size={18}
                      strokeWidth={1.75}
                      className="animate-spin text-ink-fg-3 motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : (
                    <SearchIcon
                      size={18}
                      strokeWidth={1.75}
                      className="text-ink-fg-3"
                      aria-hidden
                    />
                  )}
                  <div className="text-aux text-ink-fg-1">
                    {isSearchingLibrary ? t('palette.searching') : t('library.search.empty')}
                  </div>
                  {!isSearchingLibrary ? (
                    <div className="text-center text-meta text-ink-fg-3">
                      {t('library.search.emptyHint')}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {!hasQuery && (history.length > 0 || savedSearches.length > 0) && (
          <>
            {history.length > 0 && (
              <>
                <GroupHeader
                  title="Recent"
                  countLabel={String(history.length)}
                  aside={
                    <button
                      type="button"
                      onClick={clearHistory}
                      className="text-micro text-ink-fg-3 hover:text-ink-fg transition normal-case tracking-normal"
                    >
                      {t('palette.history.clear')}
                    </button>
                  }
                />
                <div className="px-3 space-y-px">
                  {history.map((h) => (
                    <div
                      key={`hist-${h}`}
                      className="pal-row group"
                      onClick={() => runStoredQuery(h)}
                    >
                      <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
                        <Clock size={14} strokeWidth={1.75} />
                      </span>
                      <span className="text-body flex-1 truncate text-ink-fg-1">{h}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeHistory(h)
                        }}
                        title={t('palette.history.remove')}
                        aria-label={t('palette.history.remove')}
                        className="opacity-0 group-hover:opacity-100 text-ink-fg-3 hover:text-ink-fg p-1 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {savedSearches.length > 0 && (
              <>
                <GroupHeader title="Saved" countLabel={String(savedSearches.length)} />
                <div className="px-3 space-y-px">
                  {savedSearches.map((s) => (
                    <div
                      key={`saved-${s.id}`}
                      className="pal-row group"
                      onClick={() => runStoredQuery(s.query)}
                    >
                      <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
                        <Bookmark size={14} strokeWidth={1.75} />
                      </span>
                      <span className="text-body flex-1 truncate text-ink-fg-1">{s.name}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          removeSaved(s.id)
                        }}
                        title={t('palette.saved.remove')}
                        aria-label={t('palette.saved.remove')}
                        className="opacity-0 group-hover:opacity-100 text-ink-fg-3 hover:text-ink-fg p-1 rounded hover:bg-ink-fg/[0.08] transition shrink-0"
                      >
                        <Trash2 size={12} strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {scopeVisibility.showEmail && (aiSearching || aiHits.length > 0 || showAiEmpty) && (
          <>
            <GroupHeader
              title="AI Search"
              countLabel={aiHits.length > 0 ? String(aiHits.length) : undefined}
            />
            {aiSearching && (
              <div className="px-5 py-1.5 flex items-center gap-2 text-aux text-ink-fg-2">
                <Sparkles size={14} strokeWidth={1.75} className="shrink-0 text-coral" aria-hidden />
                <PaletteThinkingPhrases phase={aiPhase} detail={aiPhaseDetail} />
              </div>
            )}
            {!aiSearching && aiSummary && (
              <div className="px-5 py-1.5 flex items-start gap-2 text-aux text-ink-fg-1">
                <Sparkles
                  size={14}
                  strokeWidth={1.75}
                  className="mt-px shrink-0 text-coral"
                  aria-hidden
                />
                <span className="leading-snug min-w-0 break-words">
                  {t('palette.ai.summary', { text: aiSummary })}
                </span>
              </div>
            )}
            {aiHits.length > 0 && (
              <div className="px-3 space-y-px">
                {aiHits.map((h, i) => {
                  const idx = aiStartIdx + i
                  const selected = idx === highlight
                  return (
                    <EmailHitRow
                      key={`ai-${h.internal_id}`}
                      hit={h}
                      flatIdx={idx}
                      selected={selected}
                      setHighlight={setHighlight}
                      queryTerms={queryTerms}
                      onActivate={() => activateHit(h)}
                      matterLinks={
                        mattersEnabled && lookupMattersData
                          ? lookupMattersForEmail(lookupMattersData, h.internal_id)
                          : undefined
                      }
                    />
                  )
                })}
              </div>
            )}
            {showAiEmpty && (
              <div className="px-5 pb-1">
                <div className="empty-tile">
                  <Sparkles size={18} strokeWidth={1.75} className="text-ink-fg-3" aria-hidden />
                  <div className="text-aux text-ink-fg-1">{t('palette.ai.emptyTitle')}</div>
                  <div className="text-meta text-ink-fg-3">{t('palette.ai.emptyHint')}</div>
                </div>
              </div>
            )}
            {(aiHits.length > 0 || showAiEmpty) && (
              <div className="px-5 pt-0.5 pb-1">
                <button
                  type="button"
                  onClick={switchToPlainSearch}
                  className="text-micro text-ink-fg-2 hover:text-ink-fg inline-flex items-center gap-1 transition"
                >
                  <SearchIcon size={11} strokeWidth={2} className="shrink-0" aria-hidden />
                  <span>{t('palette.ai.viewInPlain')}</span>
                </button>
              </div>
            )}
          </>
        )}

        {showEmailGroup && (
          <>
            <GroupHeader
              title="Email"
              countLabel={countLabel}
              aside={
                isSearching ? (
                  <>
                    <Loader2
                      size={12}
                      strokeWidth={2}
                      className="animate-spin motion-reduce:animate-none text-ink-fg-2"
                      aria-hidden
                    />
                    <span>{t('palette.searching')}</span>
                  </>
                ) : (
                  <>
                    <span className="w-1 h-1 rounded-full bg-ok" aria-hidden />
                    <span>{t('palette.footer.fts5Healthy')}</span>
                    {lastLatencyMs !== null && (
                      <>
                        <FooterDot />
                        <span className="tabular-nums">{lastLatencyMs}ms</span>
                      </>
                    )}
                  </>
                )
              }
            />
            {hasHits ? (
              <div className="px-3 space-y-px">
                {dedupedHits.map((h, i) => {
                  const idx = emailStartIdx + i
                  const selected = idx === highlight
                  return (
                    <EmailHitRow
                      key={h.internal_id}
                      hit={h}
                      flatIdx={idx}
                      selected={selected}
                      setHighlight={setHighlight}
                      queryTerms={queryTerms}
                      onActivate={() => activateHit(h)}
                      matterLinks={
                        mattersEnabled && lookupMattersData
                          ? lookupMattersForEmail(lookupMattersData, h.internal_id)
                          : undefined
                      }
                    />
                  )
                })}
              </div>
            ) : (
              <div className="px-5">
                <div className="empty-tile">
                  {isSearching ? (
                    <Loader2
                      size={18}
                      strokeWidth={1.75}
                      className="animate-spin motion-reduce:animate-none text-ink-fg-3"
                      aria-hidden
                    />
                  ) : (
                    <SearchIcon
                      size={18}
                      strokeWidth={1.75}
                      className="text-ink-fg-3"
                      aria-hidden
                    />
                  )}
                  <div className="text-aux text-ink-fg-1">
                    {isSearching ? t('palette.searching') : t('palette.email.emptyTitle')}
                  </div>
                  {!isSearching && (
                    <>
                      <div className="text-meta text-ink-fg-3">{t('palette.email.emptyHint')}</div>
                      <div className="mt-1.5 flex flex-col items-center gap-1">
                        <div className="text-micro uppercase tracking-wide text-ink-fg-3">
                          {t('palette.email.syntaxLabel')}
                        </div>
                        <div className="flex flex-wrap justify-center gap-x-2.5 gap-y-1">
                          {SEARCH_SYNTAX_HINTS.map((h) => (
                            <span key={h.token} className="text-micro inline-flex items-center gap-1">
                              <code className="font-mono text-ink-fg-1 bg-ink-fg/[0.06] px-1 py-px rounded">
                                {h.token}
                              </code>
                              <span className="text-ink-fg-3">{t(h.labelKey)}</span>
                            </span>
                          ))}
                        </div>
                        <div className="text-micro text-ink-fg-3">
                          {t('palette.email.syntaxHint')}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {scopeVisibility.showNonProviderGroups && actionItems.length > 0 && (
          <>
            <GroupHeader
              title="AI Actions"
              subtitle={t('palette.actions.subtitle', { n: hitsLength })}
              aside={
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden />
                  <span>{t('palette.actions.aside')}</span>
                </>
              }
            />
            <div className="px-3 space-y-px pb-1">
              {actionItems.map((a, i) => {
                const idx = actionStartIdx + i
                const selected = idx === highlight
                const isRunning = actionRunning === a.id
                const disabled = a.disabled || isRunning
                return (
                  <li
                    key={a.id}
                    role="option"
                    id={`palette-opt-${idx}`}
                    data-flat-idx={idx}
                    aria-selected={selected}
                    aria-disabled={disabled || undefined}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={disabled ? undefined : () => void a.run()}
                    className={cn('pal-row', selected && 'is-selected')}
                  >
                    <span
                      className={cn(
                        'w-5 h-5 grid place-items-center shrink-0',
                        a.iconTone === 'ok' && 'text-ok',
                        a.iconTone === 'info' && 'text-info',
                        a.iconTone === 'coral' && 'text-coral'
                      )}
                    >
                      {a.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-body text-ink-fg flex items-center gap-2">
                        <span className="truncate">{a.label}</span>
                        {a.soon && (
                          <span className="text-micro font-mono uppercase tracking-wide px-1.5 py-0.5 rounded text-ink-fg-2 bg-ink-fg/[0.06] border border-ink-border-soft shrink-0">
                            {t('palette.actions.soon')}
                          </span>
                        )}
                        {isRunning && (
                          <span className="text-meta font-mono text-ink-fg-3 animate-pulse motion-reduce:animate-none">
                            {t('palette.actions.running')}
                          </span>
                        )}
                      </div>
                      <div className="text-meta text-ink-fg-2 truncate mt-0.5">{a.meta}</div>
                    </div>
                    <span className="pal-hint items-center gap-1.5 text-micro font-mono text-ink-fg-2 shrink-0">
                      <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
                        ⏎
                      </kbd>
                      <span>{t('palette.kbd.run')}</span>
                    </span>
                  </li>
                )
              })}
            </div>
          </>
        )}
      </ul>

      <footer className="px-3 h-8 border-t border-ink-border-soft flex items-center gap-3 text-micro font-mono text-ink-fg-2 shrink-0">
        <KbdHint keys="↑↓" label={t('palette.kbd.navigate')} />
        <FooterDot />
        <KbdHint keys="⇥" label={t('palette.kbd.selectGroup')} />
        <FooterDot />
        <KbdHint keys="⏎" label={t('palette.kbd.open')} />
        <FooterDot />
        <KbdHint
          keys="⌘⏎"
          label={IS_WEB ? t('palette.kbd.newWindow') : t('palette.kbd.aiSearch')}
        />
        <FooterDot />
        <KbdHint keys="esc" label={t('palette.kbd.dismiss')} />

        <span className="ml-auto flex items-center gap-2">
          <span className="w-1 h-1 rounded-full bg-ok" aria-hidden />
          <span>{t('palette.footer.fts5Healthy')}</span>
          {lastLatencyMs !== null && (
            <>
              <FooterDot />
              <span className="tabular-nums">{lastLatencyMs}ms</span>
            </>
          )}
          {totalIndexed !== null && (
            <>
              <FooterDot />
              <span className="tabular-nums">
                {t('palette.email.countLabel', { n: hitsLength, total: totalIndexed })}
              </span>
            </>
          )}
        </span>
      </footer>
    </>
  )
}
