// Phase 2 — 设置页全局搜索框（⌘F 聚焦，模糊检索 8+1 Tab / 节标题 / 环境变量，直达跳转并滚动定位）。

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
import { Search, X } from 'lucide-react'

import { scrollToAnchorWhenReady } from './aiTabAnchors'
import { searchSettingsItems, type SettingsSearchEntry } from './settingsSearchIndex'
import { settingsTabLabelKey } from './settingsTabMeta'

export interface SettingsSearchBarProps {
  includeMatters?: boolean
}

export function SettingsSearchBar({
  includeMatters = false
}: SettingsSearchBarProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  const [query, setQuery] = React.useState('')
  const [open, setOpen] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(0)

  const results = React.useMemo(
    () => searchSettingsItems(query, includeMatters).slice(0, 10),
    [query, includeMatters]
  )

  React.useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // ⌘F / Ctrl+F 劫持为设置页全局检索，避免原生页内查找遮挡结果面板。
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 点击外部收起下拉结果。
  React.useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const selectEntry = React.useCallback(
    (entry: SettingsSearchEntry) => {
      void navigate({
        to: '/settings',
        search: {
          tab: entry.tab,
          ...(entry.section ? { section: entry.section } : {}),
          ...(entry.anchorId ? { anchor: entry.anchorId } : {})
        }
      })
      if (entry.anchorId) {
        window.dispatchEvent(
          new CustomEvent('mailagent:focus-anchor', { detail: { id: entry.anchorId } })
        )
        scrollToAnchorWhenReady(entry.anchorId)
      }
      setOpen(false)
      setQuery('')
      inputRef.current?.blur()
    },
    [navigate]
  )

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (query) {
        setQuery('')
      } else {
        setOpen(false)
        inputRef.current?.blur()
      }
      return
    }
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true)
      return
    }
    if (results.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((idx) => (idx + 1) % results.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((idx) => (idx - 1 + results.length) % results.length)
    } else if (e.key === 'Enter' && open) {
      e.preventDefault()
      const target = results[activeIndex] ?? results[0]
      if (target) selectEntry(target)
    }
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        className="flex items-center gap-2 rounded-lg border border-ink-border-soft bg-ink-2/80 px-3 py-1.5 transition-colors focus-within:border-ink-border focus-within:bg-ink-2"
      >
        <Search className="h-3.5 w-3.5 shrink-0 text-ink-fg-2" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls="settings-global-search-results"
          aria-label={t('settings.search.aria')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleInputKeyDown}
          placeholder={t('settings.search.placeholder')}
          className="min-w-0 flex-1 bg-transparent text-aux text-ink-fg placeholder:text-ink-fg-3 focus:outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
            aria-label={t('common.clear', { defaultValue: 'Clear' })}
            className="rounded p-0.5 text-ink-fg-2 hover:bg-ink-3 hover:text-ink-fg"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          <kbd className="hidden sm:inline-flex shrink-0 items-center rounded border border-ink-border-soft bg-ink-2 px-1.5 py-0.5 font-mono text-meta text-ink-fg-2">
            {t('settings.search.shortcut')}
          </kbd>
        )}
      </div>

      {open && (
        <div
          id="settings-global-search-results"
          role="listbox"
          className="glass-pop absolute left-0 right-0 top-full z-40 mt-1.5 max-h-80 overflow-y-auto rounded-lg border border-ink-border p-1.5 scrollbar-thin"
        >
          {results.length === 0 ? (
            <div className="px-3 py-4 text-center text-aux text-ink-fg-2">
              {t('settings.search.empty')}
            </div>
          ) : (
            results.map((item, idx) => {
              const active = idx === activeIndex
              const label = item.titleKey
                ? t(item.titleKey, { defaultValue: item.title })
                : item.title
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onMouseDown={(e) => {
                    // 阻止 input blur 先于点击触发。
                    e.preventDefault()
                  }}
                  onClick={() => selectEntry(item)}
                  className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                    active ? 'bg-ink-3 text-ink-fg' : 'text-ink-fg hover:bg-ink-3/60'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-aux font-medium text-ink-fg">{label}</div>
                    {item.subtitle && (
                      <div className="truncate font-mono text-meta text-ink-fg-2">
                        {item.subtitle}
                      </div>
                    )}
                  </div>
                  <span className="shrink-0 rounded border border-ink-border-soft bg-ink-1 px-2 py-0.5 text-aux text-ink-fg-2">
                    {t(settingsTabLabelKey(item.tab), { defaultValue: item.tab })}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
