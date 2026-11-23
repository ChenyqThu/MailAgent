import { useCallback, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { qk } from '@shared/lib/queryKeys'
import { useMailApi } from '@shared/hooks/useMailApi'
import { useDebouncedValue } from '@shared/hooks/useDebouncedValue'
import { extractTerms } from '@shared/lib/highlight_terms'
import type { MailboxSummary, SearchHit } from '@shared/api/types'
import type { Matter, MatterResourceLookupResponse } from '@shared/api/types/matter'
import type { ContactRowDto } from '@shared/api/types/contact'
import type { LibrarySearchHit } from '@shared/api/types/library'
import { useMattersApi, useMattersEnabled } from '@shared/components/matters/hooks'
import { useContactsApi, useContactsEnabled } from '@shared/components/contacts/hooks'
import { useLibraryApi } from '@shared/components/library/hooks'
import { useProgressiveLibrarySearch } from '@shared/components/library/useProgressiveLibrarySearch'
import {
  type ProgressiveEmailSearchResult,
  useProgressiveEmailSearch
} from '@shared/hooks/useProgressiveEmailSearch'
import { useSearchHistory } from '@shared/state/search-history'
import { LIBRARY_MAX_HITS, libraryAddressableHits } from './paletteLibrary'
import {
  buildPaletteMatterLookupKeys,
  paletteScopeVisibility,
  type PaletteScope,
  type PaletteScopeVisibility
} from './paletteMatters'
import {
  CONTACT_FETCH_LIMIT,
  DEBOUNCE_MS,
  IS_WEB,
  MAX_CONTACT_HITS,
  MAX_EMAIL_HITS
} from './commandPaletteTypes'

export interface UseCommandPaletteSearchOptions {
  open: boolean
  query: string
  scope: PaletteScope
  aiHits: SearchHit[]
  onMeasuredLatency: (latencyMs: number) => void
}

export interface UseCommandPaletteSearchResult {
  mattersEnabled: boolean
  contactsEnabled: boolean
  debouncedRaw: string
  normalised: string
  queryTerms: string[]
  hasQuery: boolean
  scopeVisibility: PaletteScopeVisibility
  mailboxes: MailboxSummary[]
  searchQ: ProgressiveEmailSearchResult
  hits: SearchHit[]
  dedupedHits: SearchHit[]
  emailProviderCount: number
  totalIndexed: number | null
  parseWarnings: string[]
  formatWarning: (code: string) => string
  isSearching: boolean
  visibleMatterHits: Matter[]
  isSearchingMatters: boolean
  visibleContactHits: ContactRowDto[]
  contactOverflow: number
  isSearchingContacts: boolean
  libraryHits: Array<LibrarySearchHit & { id: number }>
  libraryWarnings: string[]
  isSearchingLibrary: boolean
  matterLookupData: MatterResourceLookupResponse | undefined
}

export function useCommandPaletteSearch({
  open,
  query,
  scope,
  aiHits,
  onMeasuredLatency
}: UseCommandPaletteSearchOptions): UseCommandPaletteSearchResult {
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const mattersApi = useMattersApi()
  const mattersEnabled = useMattersEnabled()
  const contactsApi = useContactsApi()
  const { enabled: contactsEnabled } = useContactsEnabled()
  const libraryApi = useLibraryApi()
  const pushHistory = useSearchHistory((s) => s.pushHistory)

  const debouncedRaw = useDebouncedValue(query, DEBOUNCE_MS)
  // T3: CJK transform 统一到后端 smart 模式，前端只 trim。
  const normalised = useMemo(() => debouncedRaw.trim(), [debouncedRaw])
  const queryTerms = useMemo(() => extractTerms(debouncedRaw), [debouncedRaw])
  const hasQuery = normalised.length > 0
  const scopeVisibility = useMemo(() => paletteScopeVisibility(scope), [scope])

  const mailboxesQ = useQuery({
    queryKey: qk.mailboxes(),
    queryFn: () => mailApi.email.listMailboxes(),
    staleTime: 30_000,
    enabled: open
  })
  const mailboxes: MailboxSummary[] = useMemo(() => mailboxesQ.data ?? [], [mailboxesQ.data])

  const searchQ = useProgressiveEmailSearch({
    mailApi,
    query: normalised,
    limit: MAX_EMAIL_HITS,
    enabled: open,
    allowEmpty: true,
    onMeasuredLatency
  })

  const hits: SearchHit[] = useMemo(() => searchQ.data?.items ?? [], [searchQ.data?.items])
  const totalIndexed = searchQ.data?.total_indexed ?? null
  const parseWarnings: string[] = searchQ.isPlaceholderData
    ? []
    : (searchQ.data?.parse_warnings ?? [])

  const formatWarning = useCallback(
    (code: string): string => {
      const [head, a, b] = code.split(':')
      switch (head) {
        case 'empty_value':
          return t('palette.warn.emptyValue', { field: a ?? '' })
        case 'unknown_value':
          return t('palette.warn.unknownValue', { field: a ?? '', value: b ?? '' })
        case 'invalid_date':
        case 'invalid_relative_date':
          return t('palette.warn.invalidDate', { field: a ?? '', value: b ?? '' })
        case 'unsupported_or':
          return a === 'negated' ? t('palette.warn.negatedOr') : t('palette.warn.crossClassOr')
        case 'unclosed_quote':
          return t('palette.warn.unclosedQuote')
        case 'dangling_or':
          return t('palette.warn.danglingOr')
        case 'empty_text':
          return t('palette.warn.emptyText')
        case 'parse_error':
          return t('palette.warn.parseError')
        default:
          return t('palette.warn.generic')
      }
    },
    [t]
  )
  const isSearching = (searchQ.isFetching || searchQ.isEnhancing) && normalised.length > 0

  const mattersQ = useQuery({
    queryKey: qk.matters.paletteSearch(normalised),
    queryFn: () => mattersApi.list({ q: normalised, limit: 8 }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled: open && mattersEnabled && hasQuery
  })
  const matterHits: Matter[] = useMemo(() => mattersQ.data?.items ?? [], [mattersQ.data?.items])
  const visibleMatterHits = useMemo(
    () => (mattersEnabled ? matterHits : []),
    [mattersEnabled, matterHits]
  )
  const isSearchingMatters = mattersQ.isFetching && hasQuery

  const contactsQ = useQuery({
    queryKey: qk.contacts.paletteSearch(normalised),
    queryFn: () =>
      contactsApi.list({
        view: 'all',
        q: normalised,
        sort: 'density',
        limit: CONTACT_FETCH_LIMIT
      }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    enabled: open && contactsEnabled && hasQuery
  })
  const contactHits: ContactRowDto[] = useMemo(
    () =>
      (contactsQ.data?.items ?? [])
        .filter((row) => row.hidden_at === null)
        .slice(0, MAX_CONTACT_HITS),
    [contactsQ.data?.items]
  )
  const visibleContactHits = useMemo(
    () => (contactsEnabled ? contactHits : []),
    [contactsEnabled, contactHits]
  )
  const contactOverflow = Math.max(0, (contactsQ.data?.total ?? 0) - visibleContactHits.length)
  const isSearchingContacts = contactsQ.isFetching && hasQuery

  const libraryQ = useProgressiveLibrarySearch({
    api: libraryApi,
    query: normalised,
    limit: LIBRARY_MAX_HITS,
    enabled: open && !IS_WEB && hasQuery,
    staleTime: 30_000,
    queryKeyPrefix: ['library', 'palette-search']
  })
  const libraryHits = useMemo(
    () => libraryAddressableHits(libraryQ.data?.hits ?? []),
    [libraryQ.data?.hits]
  )
  const libraryWarnings: string[] =
    libraryQ.isPlaceholderData || IS_WEB ? [] : (libraryQ.data?.warnings ?? [])
  const isSearchingLibrary = (libraryQ.isFetching || libraryQ.isEnhancing) && hasQuery

  // G-B3 — record history on a settled successful search.
  useEffect(() => {
    if (!open) return
    if (normalised.length === 0) return
    if (!searchQ.isSuccess || searchQ.isPlaceholderData) return
    pushHistory(normalised)
  }, [open, normalised, searchQ.isSuccess, searchQ.isPlaceholderData, pushHistory])

  // G-A7 ⑤ — AI/FTS 双组去重
  const dedupedHits: SearchHit[] = useMemo(() => {
    if (aiHits.length === 0) return hits
    const aiIds = new Set(aiHits.map((h) => h.internal_id))
    return hits.filter((h) => !aiIds.has(h.internal_id))
  }, [hits, aiHits])

  const emailProviderHits = useMemo(() => [...aiHits, ...dedupedHits], [aiHits, dedupedHits])
  const emailProviderCount = useMemo(
    () => new Set(emailProviderHits.map((hit) => hit.internal_id)).size,
    [emailProviderHits]
  )
  const lookupKeys = useMemo(
    () =>
      buildPaletteMatterLookupKeys(
        scopeVisibility.showEmail ? emailProviderHits : [],
        open && mattersEnabled && hasQuery
      ),
    [emailProviderHits, hasQuery, mattersEnabled, open, scopeVisibility.showEmail]
  )
  const matterLookupQ = useQuery({
    queryKey: qk.matters.resourceLookup('mailagent', lookupKeys),
    queryFn: () => mattersApi.lookupResourceLinks('mailagent', lookupKeys),
    enabled: open && mattersEnabled && hasQuery && lookupKeys.length > 0,
    staleTime: 10_000
  })

  return {
    mattersEnabled,
    contactsEnabled,
    debouncedRaw,
    normalised,
    queryTerms,
    hasQuery,
    scopeVisibility,
    mailboxes,
    searchQ,
    hits,
    dedupedHits,
    emailProviderCount,
    totalIndexed,
    parseWarnings,
    formatWarning,
    isSearching,
    visibleMatterHits,
    isSearchingMatters,
    visibleContactHits,
    contactOverflow,
    isSearchingContacts,
    libraryHits,
    libraryWarnings,
    isSearchingLibrary,
    matterLookupData: matterLookupQ.data
  }
}
