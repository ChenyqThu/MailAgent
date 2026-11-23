import type React from 'react'
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { Check, Folder, Loader2, RotateCcw, Sparkle, Sparkles } from 'lucide-react'
import { errorMessage } from '@shared/lib/ipcErrors'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useMailbox } from '@shared/state/mailbox'
import { useActiveEmail } from '@shared/state/active-email'
import { ARCHIVE_LABEL, viewForMailbox } from '@shared/lib/mailboxSemantics'
import { useEmailFilter } from '@shared/state/email-filter'
import { runGatewaySearchAgent } from '@shared/assistant/searchAgentClient'
import { closeCommandPalette } from '@shared/state/command-palette'
import { useSearchHistory } from '@shared/state/search-history'
import { toastError, toastSuccess } from '@shared/state/toast'
import { hasDslToken, toggleDslToken } from '@shared/lib/dsl_token'
import type {
  MailboxSummary,
  SearchAgentPhase,
  SearchHit
} from '@shared/api/types'
import type { Matter } from '@shared/api/types/matter'
import type { ContactRowDto } from '@shared/api/types/contact'
import { useMatterNavigation } from '@shared/components/matters/navigation'
import { useContactNavigation } from '@shared/components/contacts/navigation'
import { navigateToLibraryFile } from '@shared/components/library/deeplink'
import type { LibrarySearchHit } from '@shared/api/types/library'
import {
  navigateToNavEntry,
  navPaletteEntries,
  navPaletteLabel,
  type NavEntry
} from '@shared/navigation/registry'
import { useVisibleNavEntries } from '@shared/navigation/useNavGates'
import type { PaletteScopeVisibility } from './paletteMatters'
import {
  type ActionRow,
  FIXED_FACETS,
  type FlatEntry,
  type Group,
  IS_WEB,
  type JumpRow,
  MAX_JUMP_MAILBOXES
} from './commandPaletteTypes'

export interface PaletteAiState {
  aiSearching: boolean
  setAiSearching: React.Dispatch<React.SetStateAction<boolean>>
  aiHits: SearchHit[]
  setAiHits: React.Dispatch<React.SetStateAction<SearchHit[]>>
  aiSummary: string | null
  setAiSummary: React.Dispatch<React.SetStateAction<string | null>>
  aiError: string | null
  setAiError: React.Dispatch<React.SetStateAction<string | null>>
  aiCompleted: boolean
  setAiCompleted: React.Dispatch<React.SetStateAction<boolean>>
  aiPhase: SearchAgentPhase
  setAiPhase: React.Dispatch<React.SetStateAction<SearchAgentPhase>>
  aiPhaseDetail: string | null
  setAiPhaseDetail: React.Dispatch<React.SetStateAction<string | null>>
  aiAbortRef: React.RefObject<AbortController | null>
}

export interface UseCommandPaletteActionsOptions {
  open: boolean
  query: string
  setQuery: React.Dispatch<React.SetStateAction<string>>
  debouncedRaw: string
  highlight: number
  setHighlight: React.Dispatch<React.SetStateAction<number>>
  setActionRunning: React.Dispatch<React.SetStateAction<string | null>>
  focusInput: () => void
  dialogRef: React.RefObject<HTMLDivElement | null>
  handleTab: (e: React.KeyboardEvent<HTMLDivElement>) => void
  mailboxes: MailboxSummary[]
  hits: SearchHit[]
  dedupedHits: SearchHit[]
  visibleMatterHits: Matter[]
  visibleContactHits: ContactRowDto[]
  libraryHits: Array<LibrarySearchHit & { id: number }>
  scopeVisibility: PaletteScopeVisibility
  ai: PaletteAiState
}

export interface UseCommandPaletteActionsResult {
  activateHit: (hit: SearchHit) => void
  activateMatter: (matter: Matter) => void
  activateContact: (contact: ContactRowDto) => void
  activateLibraryFile: (fileId: number) => void
  runAiSearch: () => Promise<void>
  switchToPlainSearch: () => void
  toggleFacet: (token: string) => void
  saveCurrentSearch: () => void
  runStoredQuery: (q: string) => void
  jumpItems: JumpRow[]
  facetChips: ReadonlyArray<{ token: string; label: string; active: boolean }>
  actionItems: ActionRow[]
  flat: FlatEntry[]
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void
}

export function useCommandPaletteActions({
  query,
  setQuery,
  debouncedRaw,
  highlight,
  setHighlight,
  setActionRunning,
  focusInput,
  handleTab,
  mailboxes,
  hits,
  dedupedHits,
  visibleMatterHits,
  visibleContactHits,
  libraryHits,
  scopeVisibility,
  ai
}: UseCommandPaletteActionsOptions): UseCommandPaletteActionsResult {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const navigate = useNavigate()
  const router = useRouter()
  const queryClient = useQueryClient()
  const openMatter = useMatterNavigation((state) => state.open)
  const openContact = useContactNavigation((state) => state.open)
  const activeMailbox = useMailbox((s) => s.active)
  const setActiveMailbox = useMailbox((s) => s.setActive)
  const setActiveEmail = useActiveEmail((s) => s.setActive)
  const setView = useEmailFilter((s) => s.setView)
  const addSaved = useSearchHistory((s) => s.addSaved)

  const visibleNavEntries = useVisibleNavEntries()
  const paletteNavEntries: readonly NavEntry[] = useMemo(
    () => navPaletteEntries(visibleNavEntries),
    [visibleNavEntries]
  )

  const activateHit = useCallback(
    (hit: SearchHit): void => {
      const targetView = viewForMailbox(hit.mailbox)
      closeCommandPalette()
      setView(targetView)
      if (hit.mailbox) setActiveMailbox(hit.mailbox)
      setActiveEmail(hit.internal_id, { navTarget: true })
      void navigate({ to: '/', search: { view: targetView } })
    },
    [setView, setActiveMailbox, setActiveEmail, navigate]
  )

  const activateMatter = useCallback(
    (matter: Matter): void => {
      closeCommandPalette()
      openMatter(matter.public_id)
      void navigate({ to: '/matters' })
    },
    [navigate, openMatter]
  )

  const activateContact = useCallback(
    (contact: ContactRowDto): void => {
      closeCommandPalette()
      openContact(contact.id)
      void navigate({ to: '/contacts' })
    },
    [navigate, openContact]
  )

  const activateLibraryFile = useCallback(
    (fileId: number): void => {
      closeCommandPalette()
      navigateToLibraryFile(router, fileId)
    },
    [router]
  )

  const formatAiError = useCallback(
    (code: string): string => {
      switch (code) {
        case 'E_NO_LLM_KEY':
          return t('palette.ai.errNoKey')
        case 'E_EMPTY':
        case 'E_NO_OUTPUT':
          return t('palette.ai.errEmpty')
        case 'E_UNSUPPORTED':
          return t('palette.ai.errUnsupported')
        case 'E_TIMEOUT':
          return t('palette.ai.errTimeout')
        case 'E_QUOTA':
          return t('palette.ai.errQuota')
        case 'E_AGENT':
        case 'E_BACKEND_CRASH':
        case 'E_UPSTREAM':
        case 'E_COST_BUDGET':
        case 'E_MAX_ITER':
          return t('palette.ai.errAgent')
        default:
          return t('palette.ai.errGeneric')
      }
    },
    [t]
  )

  const {
    aiSearching,
    setAiSearching,
    aiHits,
    setAiHits,
    setAiSummary,
    setAiError,
    setAiCompleted,
    setAiPhase,
    setAiPhaseDetail,
    aiAbortRef
  } = ai

  const runAiSearch = useCallback(async (): Promise<void> => {
    const nl = query.trim()
    if (nl.length === 0 || aiSearching) return
    const ac = new AbortController()
    aiAbortRef.current = ac
    setAiSearching(true)
    setAiHits([])
    setAiSummary(null)
    setAiError(null)
    setAiCompleted(false)
    setAiPhase('searching')
    setAiPhaseDetail(null)
    setHighlight(0)
    try {
      const res = await runGatewaySearchAgent(mailApi, {
        query: nl,
        mailbox: activeMailbox || undefined,
        signal: ac.signal,
        onPhase: (p, detail) => {
          if (!ac.signal.aborted) {
            setAiPhase(p)
            setAiPhaseDetail((prev) => (detail !== undefined ? detail : prev))
          }
        }
      })
      if (ac.signal.aborted) return
      if (res.ok) {
        setAiHits(res.hits)
        setAiSummary(res.summary)
        setAiCompleted(true)
        return
      }
      if (res.fallbackDsl) {
        setQuery(res.fallbackDsl)
        toastSuccess(t('palette.ai.fellBack'))
        return
      }
      const code = res.error?.code ?? ''
      if (code === 'E_ABORTED') return
      setAiError(formatAiError(code))
    } catch (err) {
      if (ac.signal.aborted) return
      setAiError(
        formatAiError(err instanceof Error ? ((err as Error & { code?: string }).code ?? '') : '')
      )
    } finally {
      if (!ac.signal.aborted) setAiSearching(false)
    }
  }, [
    query,
    aiSearching,
    aiAbortRef,
    setAiSearching,
    setAiHits,
    setAiSummary,
    setAiError,
    setAiCompleted,
    setAiPhase,
    setAiPhaseDetail,
    setHighlight,
    mailApi,
    activeMailbox,
    setQuery,
    t,
    formatAiError
  ])

  const switchToPlainSearch = useCallback((): void => {
    if (aiAbortRef.current) {
      aiAbortRef.current.abort()
      aiAbortRef.current = null
    }
    setAiSearching(false)
    setAiHits([])
    setAiSummary(null)
    setAiError(null)
    setAiCompleted(false)
    setAiPhase('searching')
    setAiPhaseDetail(null)
    setHighlight(0)
    focusInput()
  }, [
    aiAbortRef,
    setAiSearching,
    setAiHits,
    setAiSummary,
    setAiError,
    setAiCompleted,
    setAiPhase,
    setAiPhaseDetail,
    setHighlight,
    focusInput
  ])

  const toggleFacet = useCallback(
    (token: string): void => {
      setQuery((q) => toggleDslToken(q, token))
      focusInput()
    },
    [setQuery, focusInput]
  )

  const saveCurrentSearch = useCallback((): void => {
    const q = query.trim()
    if (q.length === 0) return
    addSaved(q, q)
    toastSuccess(t('palette.saved.savedToast'))
  }, [query, addSaved, t])

  const runStoredQuery = useCallback(
    (q: string): void => {
      switchToPlainSearch()
      setQuery(q)
    },
    [switchToPlainSearch, setQuery]
  )

  // Note: AI entry click uses `runAiSearch` directly in JSX rather than capturing
  // `aiAbortRef`-touching callbacks inside this render-time `useMemo`.
  const jumpItems: JumpRow[] = useMemo(() => {
    const out: JumpRow[] = []
    const q = debouncedRaw.trim()
    const liveQuery = query.trim()

    if (liveQuery.length > 0 && !IS_WEB) {
      out.push({
        id: 'ai:understand',
        isAiEntry: true,
        icon: aiSearching ? (
          <Loader2
            size={14}
            strokeWidth={1.75}
            className="animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        ) : (
          <Sparkles size={14} strokeWidth={1.75} />
        ),
        label: (
          <span className="text-body flex-1 truncate">
            <span className="text-ink-fg font-medium">
              {t('palette.ai.understand', { query: liveQuery })}
            </span>
            {!aiSearching && (
              <>
                <span className="text-ink-fg-3 mx-1">·</span>
                <span className="text-ink-fg-2">{t('palette.ai.understandHint')}</span>
              </>
            )}
          </span>
        ),
        run: () => {}
      })
    }

    const builtinMailboxes = mailboxes.filter(
      (m) => viewForMailbox(m.mailbox) !== 'all' || m.mailbox === ARCHIVE_LABEL
    )
    const baseList =
      q.length === 0
        ? builtinMailboxes.slice(0, MAX_JUMP_MAILBOXES)
        : builtinMailboxes
            .filter((m) => m.mailbox.toLowerCase().includes(q.toLowerCase()))
            .slice(0, MAX_JUMP_MAILBOXES)

    for (const mb of baseList) {
      const matchedCount = hits.filter((h) => h.mailbox === mb.mailbox).length
      const showMatch = q.length > 0 && matchedCount > 0
      const trailing = showMatch
        ? t('palette.mailbox.matchedSuffix', { query: q, n: matchedCount })
        : t('palette.mailbox.hint', { unread: mb.unread, total: mb.total })
      out.push({
        id: `mailbox:${mb.mailbox}`,
        icon: <Folder size={14} strokeWidth={1.75} />,
        label: (
          <span className="text-body flex-1 truncate">
            <span className="text-ink-fg font-medium">{mb.mailbox}</span>
            <span className="text-ink-fg-3 mx-1">·</span>
            <span className="text-ink-fg-2">{trailing}</span>
          </span>
        ),
        aside:
          mb.unread > 0 ? (
            <span className="text-meta font-mono text-ink-fg-2 tabular-nums">
              {mb.unread} unread
            </span>
          ) : null,
        run: () => {
          closeCommandPalette()
          setActiveMailbox(mb.mailbox)
          void navigate({ to: '/' })
        }
      })
    }

    const needle = q.toLowerCase()
    for (const entry of paletteNavEntries) {
      const label = navPaletteLabel(entry, t)
      const hidden =
        needle === '' ? entry.palette?.searchOnly === true : !label.toLowerCase().includes(needle)
      if (hidden) continue
      out.push({
        id: `jump:${entry.id}`,
        icon: entry.icon(),
        label: (
          <span className="text-body flex-1 truncate">
            <span className="text-ink-fg font-medium">{label}</span>
            <span className="text-ink-fg-3 mx-1">·</span>
            <span className="text-ink-fg-2">{t(entry.palette?.metaI18nKey ?? '', { n: 0 })}</span>
          </span>
        ),
        run: () => {
          closeCommandPalette()
          navigateToNavEntry(navigate, entry)
        }
      })
    }
    return out
  }, [
    debouncedRaw,
    query,
    aiSearching,
    hits,
    mailboxes,
    navigate,
    setActiveMailbox,
    paletteNavEntries,
    t
  ])

  const facetChips: ReadonlyArray<{ token: string; label: string; active: boolean }> = useMemo(
    () =>
      FIXED_FACETS.map((f) => ({
        token: f.token,
        label: t(f.labelKey),
        active: hasDslToken(query, f.token)
      })),
    [query, t]
  )

  const actionItems: ActionRow[] = useMemo(() => {
    if (dedupedHits.length === 0) return []
    const ids = dedupedHits.map((h) => h.internal_id)
    return [
      {
        id: 'action:markAllRead',
        iconTone: 'ok',
        icon: <Check size={14} strokeWidth={1.75} />,
        label: t('palette.actions.markAllRead'),
        meta: t('palette.actions.markAllReadMeta', { n: dedupedHits.length }),
        async run() {
          setActionRunning('action:markAllRead')
          try {
            await mailApi.email.flag(null, {
              ids,
              isRead: true,
              allowConcurrent: true
            })
            toastSuccess(t('palette.actions.doneToast', { n: dedupedHits.length }))
            await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
            closeCommandPalette()
          } catch (err) {
            toastError(t('palette.actions.errToast'), errorMessage(err))
          } finally {
            setActionRunning(null)
          }
        }
      },
      {
        id: 'action:reRunAi',
        iconTone: 'info',
        icon: <RotateCcw size={14} strokeWidth={1.75} />,
        label: t('palette.actions.reRunAi'),
        meta: t('palette.actions.reRunAiMeta', { n: dedupedHits.length }),
        async run() {
          setActionRunning('action:reRunAi')
          try {
            const settled = await Promise.allSettled(
              dedupedHits.map((h) => mailApi.llm.run(h.internal_id, { force: true }))
            )
            const ok = settled.filter((r) => r.status === 'fulfilled').length
            if (ok < dedupedHits.length) {
              const firstErr = settled.find((r) => r.status === 'rejected') as
                | PromiseRejectedResult
                | undefined
              const msg = firstErr ? String(firstErr.reason) : ''
              toastError(t('palette.actions.errToast'), `${ok}/${dedupedHits.length} · ${msg}`)
            } else {
              toastSuccess(t('palette.actions.doneToast', { n: ok }))
            }
            await queryClient.invalidateQueries({ queryKey: qk.emails.all() })
            closeCommandPalette()
          } catch (err) {
            toastError(t('palette.actions.errToast'), errorMessage(err))
          } finally {
            setActionRunning(null)
          }
        }
      },
      {
        id: 'action:summarize',
        iconTone: 'coral',
        icon: <Sparkle size={14} strokeWidth={1.75} />,
        label: t('palette.actions.summarize'),
        meta: t('palette.actions.summarizeMeta', { n: dedupedHits.length }),
        disabled: true,
        soon: true,
        async run() {
          /* disabled — wired in a future sprint when AIChatPanel accepts batch context */
        }
      }
    ]
  }, [dedupedHits, mailApi, queryClient, setActionRunning, t])

  const flat: FlatEntry[] = useMemo(() => {
    const out: FlatEntry[] = []
    if (scopeVisibility.showNonProviderGroups) {
      jumpItems.forEach((j, i) =>
        out.push({ group: 'jump', indexInGroup: i, isAiEntry: j.isAiEntry, run: j.run })
      )
    }
    if (scopeVisibility.showMatter) {
      visibleMatterHits.forEach((matter, i) =>
        out.push({ group: 'matter', indexInGroup: i, run: () => activateMatter(matter) })
      )
    }
    if (scopeVisibility.showContact) {
      visibleContactHits.forEach((contact, i) =>
        out.push({ group: 'contact', indexInGroup: i, run: () => activateContact(contact) })
      )
    }
    if (scopeVisibility.showLibrary) {
      libraryHits.forEach((file, i) =>
        out.push({ group: 'library', indexInGroup: i, run: () => activateLibraryFile(file.id) })
      )
    }
    if (scopeVisibility.showEmail) {
      aiHits.forEach((h, i) =>
        out.push({ group: 'ai', indexInGroup: i, run: () => activateHit(h) })
      )
    }
    if (scopeVisibility.showEmail) {
      dedupedHits.forEach((h, i) =>
        out.push({ group: 'email', indexInGroup: i, run: () => activateHit(h) })
      )
    }
    if (scopeVisibility.showNonProviderGroups) {
      actionItems.forEach((a, i) =>
        out.push({
          group: 'actions',
          indexInGroup: i,
          disabled: a.disabled,
          run: () => a.run()
        })
      )
    }
    return out
  }, [
    jumpItems,
    visibleMatterHits,
    visibleContactHits,
    libraryHits,
    aiHits,
    dedupedHits,
    actionItems,
    scopeVisibility,
    activateMatter,
    activateContact,
    activateLibraryFile,
    activateHit
  ])

  const jumpToGroupBoundary = useCallback(
    (forward: boolean) => {
      if (flat.length === 0) return
      const order: Group[] = ['jump', 'matter', 'contact', 'library', 'ai', 'email', 'actions']
      const present = order.filter((g) => flat.some((f) => f.group === g))
      if (present.length <= 1) return
      const curGroup = flat[highlight]?.group ?? present[0]
      const idx = present.indexOf(curGroup)
      const nextGroup = forward
        ? present[(idx + 1) % present.length]
        : present[(idx - 1 + present.length) % present.length]
      const target = flat.findIndex((f) => f.group === nextGroup)
      if (target >= 0) setHighlight(target)
    },
    [flat, highlight, setHighlight]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCommandPalette()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (flat.length === 0) return
        setHighlight((h) => (h + 1) % flat.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (flat.length === 0) return
        setHighlight((h) => (h - 1 + flat.length) % flat.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.metaKey && !IS_WEB && query.trim().length > 0) {
          void runAiSearch()
          return
        }
        const entry = flat[highlight]
        if (!entry || entry.disabled) return
        if (entry.isAiEntry) {
          if (dedupedHits.length > 0) activateHit(dedupedHits[0])
          return
        }
        void entry.run()
        return
      }
      if (e.key === 'Tab') {
        if (flat.length === 0) {
          handleTab(e)
          return
        }
        e.preventDefault()
        jumpToGroupBoundary(!e.shiftKey)
      }
    },
    [
      flat,
      setHighlight,
      handleTab,
      highlight,
      jumpToGroupBoundary,
      query,
      runAiSearch,
      dedupedHits,
      activateHit
    ]
  )

  return {
    activateHit,
    activateMatter,
    activateContact,
    activateLibraryFile,
    runAiSearch,
    switchToPlainSearch,
    toggleFacet,
    saveCurrentSearch,
    runStoredQuery,
    jumpItems,
    facetChips,
    actionItems,
    flat,
    onKeyDown
  }
}
