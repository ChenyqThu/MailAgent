import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckSquare,
  Download,
  Globe,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Square,
  Trash2,
  X
} from 'lucide-react'

import type {
  ChromeCookieDomainSummary,
  ChromeProfileSummary,
  ManagedCookieDomainSummary
} from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import { toastError, toastSuccess } from '@shared/state/toast'

export interface BrowserCookieManagerPanelProps {
  readonly initialTab?: 'stored' | 'import'
  readonly compact?: boolean
  readonly onClose?: () => void
  readonly onImported?: () => void
}

export function BrowserCookieManagerPanel({
  initialTab = 'stored',
  compact = false,
  onClose,
  onImported
}: BrowserCookieManagerPanelProps): React.ReactElement {
  const { t } = useTranslation()
  const mailApi = useMailApi()

  const [activeTab, setActiveTab] = useState<'stored' | 'import'>(initialTab)
  const [storedDomains, setStoredDomains] = useState<ManagedCookieDomainSummary[]>([])
  const [storedLoading, setStoredLoading] = useState(
    () => initialTab === 'stored' && typeof mailApi.connector.managedCookieDomains === 'function'
  )
  const [storedError, setStoredError] = useState<string | null>(null)
  const [storedSearch, setStoredSearch] = useState('')
  const [clearingDomain, setClearingDomain] = useState<string | null>(null)
  const [confirmClearAll, setConfirmClearAll] = useState(false)

  const [profiles, setProfiles] = useState<ChromeProfileSummary[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState('Default')
  const [chromeDomains, setChromeDomains] = useState<ChromeCookieDomainSummary[]>([])
  const [chromeLoading, setChromeLoading] = useState(
    () => initialTab === 'import' && typeof mailApi.connector.chromeCookieDomains === 'function'
  )
  const [chromeError, setChromeError] = useState<string | null>(null)
  const [importSearch, setImportSearch] = useState('')
  const [selectedDomains, setSelectedDomains] = useState<Set<string>>(() => new Set())
  const [importing, setImporting] = useState(false)

  const touchedProfileRef = useRef<string | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadStoredDomains = useCallback(async (): Promise<void> => {
    const fn = mailApi.connector.managedCookieDomains
    if (!fn) return
    setStoredLoading(true)
    setStoredError(null)
    try {
      const res = await fn()
      if (!mountedRef.current) return
      setStoredDomains(res.domains ?? [])
    } catch (err) {
      if (!mountedRef.current) return
      setStoredError(errorMessage(err))
    } finally {
      if (mountedRef.current) setStoredLoading(false)
    }
  }, [mailApi.connector.managedCookieDomains])

  const loadChromeDomains = useCallback(
    async (profileId: string): Promise<void> => {
      const fn = mailApi.connector.chromeCookieDomains
      if (!fn) return
      setChromeLoading(true)
      setChromeError(null)
      try {
        const res = await fn(profileId)
        if (!mountedRef.current) return
        const nextDomains = res.domains ?? []
        setChromeDomains(nextDomains)
        if (touchedProfileRef.current !== profileId) {
          setSelectedDomains(
            new Set(nextDomains.filter((d) => !d.sensitive).map((d) => d.domain))
          )
        }
      } catch (err) {
        if (!mountedRef.current) return
        setChromeError(errorMessage(err))
        setChromeDomains([])
      } finally {
        if (mountedRef.current) setChromeLoading(false)
      }
    },
    [mailApi.connector.chromeCookieDomains]
  )

  useEffect(() => {
    let active = true
    if (activeTab === 'stored') {
      const fn = mailApi.connector.managedCookieDomains
      if (!fn) return undefined
      void fn()
        .then((res) => {
          if (active && mountedRef.current) setStoredDomains(res.domains ?? [])
        })
        .catch((err) => {
          if (active && mountedRef.current) setStoredError(errorMessage(err))
        })
        .finally(() => {
          if (active && mountedRef.current) setStoredLoading(false)
        })
      return () => {
        active = false
      }
    }
    const profilesFn = mailApi.connector.chromeProfiles
    if (profilesFn) {
      void profilesFn()
        .then((res) => {
          if (!active || !mountedRef.current) return
          const list = res.profiles ?? []
          setProfiles(list)
          if (list.length > 0 && !list.some((p) => p.profile_id === selectedProfileId)) {
            setSelectedProfileId(list[0].profile_id)
          }
        })
        .catch(() => {
          /* ignore profile discovery failure; falls back to Default */
        })
    }
    const domainsFn = mailApi.connector.chromeCookieDomains
    if (domainsFn) {
      void domainsFn(selectedProfileId)
        .then((res) => {
          if (!active || !mountedRef.current) return
          const nextDomains = res.domains ?? []
          setChromeDomains(nextDomains)
          if (touchedProfileRef.current !== selectedProfileId) {
            setSelectedDomains(
              new Set(nextDomains.filter((d) => !d.sensitive).map((d) => d.domain))
            )
          }
        })
        .catch((err) => {
          if (!active || !mountedRef.current) return
          setChromeError(errorMessage(err))
          setChromeDomains([])
        })
        .finally(() => {
          if (active && mountedRef.current) setChromeLoading(false)
        })
    }
    return () => {
      active = false
    }
  }, [
    activeTab,
    mailApi.connector.chromeCookieDomains,
    mailApi.connector.chromeProfiles,
    mailApi.connector.managedCookieDomains,
    selectedProfileId
  ])

  const filteredStored = useMemo(() => {
    const q = storedSearch.trim().toLowerCase()
    if (!q) return storedDomains
    return storedDomains.filter((d) => d.domain.toLowerCase().includes(q))
  }, [storedDomains, storedSearch])

  const filteredChrome = useMemo(() => {
    const q = importSearch.trim().toLowerCase()
    if (!q) return chromeDomains
    return chromeDomains.filter((d) => d.domain.toLowerCase().includes(q))
  }, [chromeDomains, importSearch])

  const handleToggleDomain = (domain: string): void => {
    touchedProfileRef.current = selectedProfileId
    setSelectedDomains((prev) => {
      const next = new Set(prev)
      if (next.has(domain)) next.delete(domain)
      else next.add(domain)
      return next
    })
  }

  const handleSelectNonSensitive = (): void => {
    touchedProfileRef.current = selectedProfileId
    setSelectedDomains(new Set(chromeDomains.filter((d) => !d.sensitive).map((d) => d.domain)))
  }

  const handleSelectAll = (): void => {
    touchedProfileRef.current = selectedProfileId
    setSelectedDomains(new Set(chromeDomains.map((d) => d.domain)))
  }

  const handleClearSelection = (): void => {
    touchedProfileRef.current = selectedProfileId
    setSelectedDomains(new Set())
  }

  const handleImportSelected = async (): Promise<void> => {
    const fn = mailApi.connector.importChromeCookies
    if (!fn || importing || selectedDomains.size === 0) return
    setImporting(true)
    try {
      const res = await fn({
        profile_id: selectedProfileId,
        domain_filters: Array.from(selectedDomains)
      })
      toastSuccess(
        t('settings.connectors.managed.importChromeDone', {
          count: res.imported,
          profile: res.profile_id
        })
      )
      onImported?.()
      setActiveTab('stored')
      await loadStoredDomains()
    } catch (err) {
      toastError(t('settings.connectors.managed.importChromeFailed'), errorMessage(err))
    } finally {
      if (mountedRef.current) setImporting(false)
    }
  }

  const handleClearDomain = async (domain: string): Promise<void> => {
    const fn = mailApi.connector.clearManagedCookies
    if (!fn || clearingDomain !== null) return
    setClearingDomain(domain)
    try {
      const res = await fn({ domain })
      toastSuccess(
        t('browserPane.cookieManager.clearedDomain', {
          domain,
          count: res.cleared
        })
      )
      onImported?.()
      await loadStoredDomains()
    } catch (err) {
      toastError(t('browserPane.cookieManager.title'), errorMessage(err))
    } finally {
      if (mountedRef.current) setClearingDomain(null)
    }
  }

  const handleClearAll = async (): Promise<void> => {
    const fn = mailApi.connector.clearManagedCookies
    if (!fn || clearingDomain !== null) return
    setClearingDomain('__all__')
    try {
      const res = await fn({})
      setConfirmClearAll(false)
      toastSuccess(t('browserPane.cookieManager.clearedAll', { count: res.cleared }))
      onImported?.()
      await loadStoredDomains()
    } catch (err) {
      toastError(t('browserPane.cookieManager.title'), errorMessage(err))
    } finally {
      if (mountedRef.current) setClearingDomain(null)
    }
  }

  const canImportSelected =
    selectedDomains.size > 0 && !importing && typeof mailApi.connector.importChromeCookies === 'function'

  return (
    <div
      data-testid="browser-cookie-manager"
      className={cn(
        'flex min-h-0 flex-col bg-ink-1 text-ink-fg',
        compact ? 'rounded-[var(--r-ctl)] border border-ink-border-soft' : 'h-full'
      )}
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-ink-border-soft bg-ink-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <KeyRound size={15} className="shrink-0 text-coral" aria-hidden="true" />
          <span className="truncate text-aux font-medium text-ink-fg">
            {t('browserPane.cookieManager.title')}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex items-center rounded-md border border-ink-border-soft bg-ink-1 p-0.5">
            <button
              type="button"
              onClick={() => {
                if (mailApi.connector.managedCookieDomains) setStoredLoading(true)
                setStoredError(null)
                setActiveTab('stored')
              }}
              className={cn(
                'rounded px-2 py-1 text-aux transition-colors duration-fast',
                activeTab === 'stored'
                  ? 'bg-ink-4 font-medium text-ink-fg'
                  : 'text-ink-fg-2 hover:text-ink-fg'
              )}
            >
              {t('browserPane.cookieManager.storedTab')}
            </button>
            <button
              type="button"
              onClick={() => {
                if (mailApi.connector.chromeCookieDomains) setChromeLoading(true)
                setChromeError(null)
                setActiveTab('import')
              }}
              className={cn(
                'rounded px-2 py-1 text-aux transition-colors duration-fast',
                activeTab === 'import'
                  ? 'bg-ink-4 font-medium text-ink-fg'
                  : 'text-ink-fg-2 hover:text-ink-fg'
              )}
            >
              {t('browserPane.cookieManager.importTab')}
            </button>
          </div>
          {onClose && (
            <button
              type="button"
              aria-label={t('browserPane.cookieManager.close')}
              title={t('browserPane.cookieManager.close')}
              onClick={onClose}
              className="grid size-7 place-items-center rounded-md text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg"
            >
              <X size={15} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>

      {/* Stored logins tab */}
      {activeTab === 'stored' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-ink-border-soft px-3 py-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-1.5">
              <Search size={14} className="shrink-0 text-ink-fg-3" aria-hidden="true" />
              <input
                type="text"
                value={storedSearch}
                onChange={(e) => setStoredSearch(e.target.value)}
                placeholder={t('browserPane.cookieManager.searchStoredPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg outline-none placeholder:text-ink-fg-3"
              />
            </label>
            <button
              type="button"
              aria-label={t('browserPane.cookieManager.refresh')}
              title={t('browserPane.cookieManager.refresh')}
              disabled={storedLoading}
              onClick={() => void loadStoredDomains()}
              className="grid size-8 shrink-0 place-items-center rounded-md border border-ink-border-soft bg-ink-2 text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(storedLoading && 'animate-spin')} />
            </button>
          </div>

          <div
            className={cn(
              'scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-2',
              compact && 'max-h-[260px]'
            )}
          >
            {storedLoading && storedDomains.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-aux text-ink-fg-2">
                <Loader2 size={15} className="animate-spin text-coral" />
                <span>{t('browserPane.cookieManager.refresh')}</span>
              </div>
            ) : storedError ? (
              <div className="py-6 text-center text-aux text-fail">{storedError}</div>
            ) : filteredStored.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                <Globe size={24} strokeWidth={1.5} className="text-ink-fg-3" />
                <p className="text-aux text-ink-fg-2">
                  {t('browserPane.cookieManager.emptyStored')}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (mailApi.connector.chromeCookieDomains) setChromeLoading(true)
                    setChromeError(null)
                    setActiveTab('import')
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-opacity hover:opacity-90"
                >
                  <Download size={14} />
                  <span>{t('browserPane.cookieManager.goImport')}</span>
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                {filteredStored.map((item) => (
                  <div
                    key={item.domain}
                    className="flex items-center justify-between gap-2 rounded-md border border-ink-border-soft bg-ink-2/60 px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-meta text-ink-fg">{item.domain}</div>
                      <div className="text-aux text-ink-fg-3">
                        {t('browserPane.cookieManager.cookieCount', { count: item.count })}
                      </div>
                    </div>
                    {typeof mailApi.connector.clearManagedCookies === 'function' && (
                      <button
                        type="button"
                        aria-label={`${t('browserPane.cookieManager.clearDomain')} ${item.domain}`}
                        title={t('browserPane.cookieManager.clearDomain')}
                        disabled={clearingDomain !== null}
                        onClick={() => void handleClearDomain(item.domain)}
                        className="grid size-7 shrink-0 place-items-center rounded-md text-ink-fg-3 transition-colors duration-fast hover:bg-ink-3 hover:text-fail disabled:opacity-50"
                      >
                        {clearingDomain === item.domain ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-ink-border-soft bg-ink-2/70 px-3 py-2">
            <button
              type="button"
              onClick={() => {
                if (mailApi.connector.chromeCookieDomains) setChromeLoading(true)
                setChromeError(null)
                setActiveTab('import')
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-ink-border bg-ink-1 px-2.5 py-1.5 text-aux font-medium text-ink-fg transition-colors hover:bg-ink-3"
            >
              <Download size={14} />
              <span>{t('browserPane.cookieManager.goImport')}</span>
            </button>

            {storedDomains.length > 0 &&
              typeof mailApi.connector.clearManagedCookies === 'function' &&
              (confirmClearAll ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={clearingDomain !== null}
                    onClick={() => void handleClearAll()}
                    className="rounded-md bg-fail px-2.5 py-1.5 text-aux font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {t('browserPane.cookieManager.confirmClearAll', {
                      count: storedDomains.length
                    })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearAll(false)}
                    className="rounded-md border border-ink-border bg-ink-1 px-2.5 py-1.5 text-aux text-ink-fg-2 hover:bg-ink-3"
                  >
                    {t('browserPane.cookieManager.cancel')}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={clearingDomain !== null}
                  onClick={() => setConfirmClearAll(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-ink-border-soft bg-ink-1 px-2.5 py-1.5 text-aux text-fail transition-colors hover:bg-fail/10 disabled:opacity-50"
                >
                  <Trash2 size={14} />
                  <span>{t('browserPane.cookieManager.clearAll')}</span>
                </button>
              ))}
          </div>
        </div>
      ) : (
        /* Chrome domain-scoped import tab */
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ink-border-soft px-3 py-2">
            <select
              aria-label={t('settings.connectors.managed.chromeProfileLabel')}
              value={selectedProfileId}
              disabled={importing}
              onChange={(e) => {
                touchedProfileRef.current = null
                if (mailApi.connector.chromeCookieDomains) setChromeLoading(true)
                setChromeError(null)
                setSelectedProfileId(e.target.value)
              }}
              className="h-8 rounded-md border border-ink-border bg-ink-2 px-2 text-aux text-ink-fg"
            >
              {profiles.length > 0 ? (
                profiles.map((prof) => (
                  <option key={prof.profile_id} value={prof.profile_id}>
                    {prof.user_name
                      ? `${prof.name} (${prof.user_name})`
                      : `${prof.name} (${prof.profile_id})`}
                  </option>
                ))
              ) : (
                <option value="Default">Default</option>
              )}
            </select>

            <label className="flex min-w-[140px] flex-1 items-center gap-2 rounded-md border border-ink-border-soft bg-ink-2 px-2.5 py-1">
              <Search size={14} className="shrink-0 text-ink-fg-3" aria-hidden="true" />
              <input
                type="text"
                value={importSearch}
                onChange={(e) => setImportSearch(e.target.value)}
                placeholder={t('browserPane.cookieManager.searchImportPlaceholder')}
                className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg outline-none placeholder:text-ink-fg-3"
              />
            </label>

            <button
              type="button"
              aria-label={t('browserPane.cookieManager.refresh')}
              title={t('browserPane.cookieManager.refresh')}
              disabled={chromeLoading}
              onClick={() => void loadChromeDomains(selectedProfileId)}
              className="grid size-8 shrink-0 place-items-center rounded-md border border-ink-border-soft bg-ink-2 text-ink-fg-2 transition-colors duration-fast hover:bg-ink-3 hover:text-ink-fg disabled:opacity-50"
            >
              <RefreshCw size={14} className={cn(chromeLoading && 'animate-spin')} />
            </button>
          </div>

          {chromeDomains.length > 0 && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-ink-border-soft bg-ink-2/40 px-3 py-1.5">
              <span className="text-aux text-ink-fg-2">
                {t('browserPane.cookieManager.selectedCount', {
                  selected: selectedDomains.size,
                  total: chromeDomains.length
                })}
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleSelectNonSensitive}
                  className="rounded px-2 py-0.5 text-aux text-ink-fg-2 transition-colors hover:bg-ink-3 hover:text-ink-fg"
                >
                  {t('browserPane.cookieManager.selectNonSensitive')}
                </button>
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="rounded px-2 py-0.5 text-aux text-ink-fg-2 transition-colors hover:bg-ink-3 hover:text-ink-fg"
                >
                  {t('browserPane.cookieManager.selectAll')}
                </button>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="rounded px-2 py-0.5 text-aux text-ink-fg-2 transition-colors hover:bg-ink-3 hover:text-ink-fg"
                >
                  {t('browserPane.cookieManager.clearSelection')}
                </button>
              </div>
            </div>
          )}

          <div
            className={cn(
              'scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-2',
              compact && 'max-h-[260px]'
            )}
          >
            {chromeLoading && chromeDomains.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-aux text-ink-fg-2">
                <Loader2 size={15} className="animate-spin text-coral" />
                <span>{t('browserPane.cookieManager.refresh')}</span>
              </div>
            ) : chromeError ? (
              <div className="py-6 text-center text-aux text-fail">{chromeError}</div>
            ) : filteredChrome.length === 0 ? (
              <div className="py-8 text-center text-aux text-ink-fg-2">
                {t('browserPane.cookieManager.emptyChromeDomains')}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredChrome.map((item) => {
                  const checked = selectedDomains.has(item.domain)
                  return (
                    <button
                      key={item.domain}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => handleToggleDomain(item.domain)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors duration-fast',
                        checked
                          ? 'border-coral/40 bg-coral/[0.06] text-ink-fg'
                          : 'border-ink-border-soft bg-ink-2/50 text-ink-fg-1 hover:bg-ink-3'
                      )}
                    >
                      {checked ? (
                        <CheckSquare size={16} className="shrink-0 text-coral" />
                      ) : (
                        <Square size={16} className="shrink-0 text-ink-fg-3" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-meta">
                        {item.domain}
                      </span>
                      {item.sensitive && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn/30 bg-warn/15 px-2 py-0.5 text-aux text-warn">
                          <ShieldAlert size={12} aria-hidden="true" />
                          <span>{t('browserPane.cookieManager.sensitiveBadge')}</span>
                        </span>
                      )}
                      <span className="shrink-0 font-mono text-meta tabular-nums text-ink-fg-3">
                        {item.count}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-border-soft bg-ink-2/70 px-3 py-2">
            <button
              type="button"
              disabled={!canImportSelected}
              onClick={() => void handleImportSelected()}
              className="inline-flex items-center gap-1.5 rounded-md bg-coral/100 px-3 py-1.5 text-aux font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {importing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              <span>
                {importing
                  ? t('browserPane.cookieManager.importing')
                  : t('browserPane.cookieManager.importSelected', { count: selectedDomains.size })}
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
