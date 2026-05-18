// DESIGN.md §5 — 36px title bar. macOS hiddenInset renders real traffic
// lights on the left, so we reserve 72px of `-webkit-app-region: drag`
// space without drawing our own dots. Mockup §header has:
//   - left:    MailAgent label (text-aux, font-medium)
//   - center:  ⌘K search/jump button (Sprint 7 wires the palette)
//   - right:   Island indicator · Accent dot · Synced status
//
// Sprint 2 also exposes theme + accent click-cycle on the right cluster so
// reviewers can verify light/dark without diving into Settings (Sprint 6).

import { useEffect } from 'react'
import { Monitor, Moon, Search, Sun } from 'lucide-react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import type { IslandConnectionState } from '@shared/api/types'
import { useMailApi } from '@shared/hooks/useMailApi'
import { cn } from '@shared/lib/cn'
import { useAppearance, type AccentId, type ThemeMode } from '@shared/state/appearance'
import { islandStateI18nKey, setIslandStatus, useIslandStore } from '@shared/state/island'

const ACCENT_LABEL: Record<AccentId, string> = {
  coral: 'Coral',
  cobalt: 'Cobalt',
  teal: 'Teal',
  rose: 'Rose',
  slate: 'Slate',
  olive: 'Olive'
}
const ACCENT_ORDER: AccentId[] = ['coral', 'cobalt', 'teal', 'rose', 'slate', 'olive']
const THEME_ORDER: ThemeMode[] = ['system', 'dark', 'light']

function nextOf<T>(arr: ReadonlyArray<T>, current: T): T {
  return arr[(arr.indexOf(current) + 1) % arr.length]
}

function ThemeIcon({ mode }: { mode: ThemeMode }): React.ReactElement {
  if (mode === 'light') return <Sun size={11} strokeWidth={2} />
  if (mode === 'dark') return <Moon size={11} strokeWidth={2} />
  return <Monitor size={11} strokeWidth={2} />
}

// Sprint 9 §2.3 — TitleBar Island indicator color mapping. The right-cluster
// pill carries one visual cue (the dot color) + a hover title. Connected =
// ok-green; degraded = warn-amber; disconnected/idle/disabled = neutral grey
// so a sleeping ping-island doesn't paint the chrome as "error".
function islandDotClass(state: IslandConnectionState): string {
  switch (state) {
    case 'connected':
      return 'bg-ok'
    case 'degraded':
      return 'bg-warn'
    case 'idle':
    case 'disconnected':
    case 'dev-disabled':
    case 'disabled':
    default:
      return 'bg-ink-fg-3'
  }
}

export function TitleBar(): React.ReactElement {
  const accent = useAppearance((s) => s.accent)
  const themeMode = useAppearance((s) => s.themeMode)
  const resolved = useAppearance((s) => s.resolvedTheme)
  const setAccent = useAppearance((s) => s.setAccent)
  const setThemeMode = useAppearance((s) => s.setThemeMode)
  const navigate = useNavigate()
  const { t } = useTranslation()
  const mailApi = useMailApi()
  const islandStatus = useIslandStore((s) => s.status)

  // Sprint 9 §2.3 — hydrate the island store on mount + subscribe to live
  // probe broadcasts. Mirrors the UpdateSection pattern (SettingsPage). If
  // we're running in the HttpApi V2 stub the hydrate throws; we swallow it
  // so the renderer still renders the (idle) initial state.
  useEffect(() => {
    let cancelled = false
    void mailApi.island
      .status()
      .then((s) => {
        if (!cancelled) setIslandStatus(s)
      })
      .catch(() => {
        /* HttpApi V2 stub — keep initial state */
      })
    const unsubscribe = mailApi.island.onEvent((next) => setIslandStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [mailApi])
  // Sprint 3 enables this for /search; Sprint 7 swaps it for the CommandPalette.
  const currentPath = useRouterState({ select: (s) => s.location.pathname })
  const searchTarget = currentPath === '/search' ? '/' : '/search'
  const searchLabel = currentPath === '/search' ? t('search.back') : t('search.title')

  return (
    <header
      className={cn(
        'h-titlebar shrink-0 bg-ink-1 border-b border-ink-border',
        'flex items-center px-3 select-none'
      )}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* 72px reservation for real macOS traffic lights (hiddenInset). */}
      <div className="w-[72px] shrink-0" aria-hidden />

      {/* Brand label — refined, dim; the inbox is the headline, not us. */}
      <div className="text-aux text-ink-fg-1 font-medium tracking-tight">MailAgent</div>

      {/* Center · ⌘K search/jump — Sprint 3 navigates to /search; Sprint 7
          swaps this for the CommandPalette overlay. */}
      <div className="flex-1 flex justify-center">
        <button
          type="button"
          onClick={() => navigate({ to: searchTarget })}
          title={searchLabel}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className={cn(
            'group flex items-center gap-2 px-3 py-1 rounded-md text-aux text-ink-fg-2',
            'hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast'
          )}
        >
          <Search size={13} strokeWidth={2} />
          <span>{searchLabel}</span>
          <kbd className="group-hover:bg-ink-4">⌘K</kbd>
        </button>
      </div>

      {/* Right cluster · Island · Theme · Accent · Sync */}
      <div
        className="flex items-center gap-3 text-meta font-mono text-ink-fg-2"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <span
          className="flex items-center gap-1.5"
          title={t(`titleBar.island.${islandStateI18nKey(islandStatus.state)}`, {
            defaultValue: islandStatus.state
          })}
        >
          <span
            className={cn('w-1.5 h-1.5 rounded-full', islandDotClass(islandStatus.state))}
            aria-hidden
          />
          <span>{t('titleBar.island.label')}</span>
        </span>
        <span className="text-ink-fg-3">·</span>

        <button
          type="button"
          onClick={() => setThemeMode(nextOf(THEME_ORDER, themeMode))}
          title={`Theme: ${themeMode}${themeMode === 'system' ? ` → ${resolved}` : ''} · click to cycle`}
          className={cn(
            'flex items-center gap-1.5 px-1.5 py-0.5 rounded',
            'hover:bg-ink-3 hover:text-ink-fg-1 transition-colors duration-fast'
          )}
        >
          <ThemeIcon mode={themeMode} />
          <span className="capitalize">{themeMode}</span>
        </button>
        <span className="text-ink-fg-3">·</span>

        <button
          type="button"
          onClick={() => setAccent(nextOf(ACCENT_ORDER, accent))}
          title={`Accent: ${ACCENT_LABEL[accent]} · click to cycle (Sprint 6 = picker)`}
          className={cn(
            'group flex items-center gap-1.5 px-1.5 py-0.5 rounded',
            'hover:bg-ink-3 hover:text-ink-fg-1 transition-colors duration-fast'
          )}
        >
          <span
            className="inline-block w-2.5 h-2.5 rounded-full bg-coral/100 shadow-[0_0_0_1px_rgb(var(--ink-0)/0.6)]"
            aria-hidden
          />
          <span className="group-hover:text-ink-fg">{ACCENT_LABEL[accent]}</span>
        </button>
        <span className="text-ink-fg-3">·</span>

        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden />
          <span>Synced</span>
        </span>
      </div>
    </header>
  )
}
