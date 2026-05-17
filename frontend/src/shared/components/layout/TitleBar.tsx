// DESIGN.md §5 — title bar 36px tall, hiddenInset window style so macOS
// traffic-light controls render natively on the left. We leave 72px of empty
// `-webkit-app-region: drag` space for them, then place app chrome on the
// right (accent dot per §2.7, island indicator, theme/accent quick toggles).
//
// Sprint 2 adds a click-cycle on both the theme indicator (system → dark →
// light → system) and the accent dot (6-tier ring). Sprint 6 SettingsPage
// will replace these with a proper segmented control + popover; for now the
// cycle buttons exist so developers and reviewers can verify both modes
// without diving into localStorage.

import { Monitor, Moon, Sun } from 'lucide-react'

import { useAppearance, type AccentId, type ThemeMode } from '@shared/state/appearance'
import { cn } from '@shared/lib/cn'

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
  const idx = arr.indexOf(current)
  return arr[(idx + 1) % arr.length]
}

function ThemeIcon({ mode }: { mode: ThemeMode }): React.ReactElement {
  if (mode === 'light') return <Sun size={12} />
  if (mode === 'dark') return <Moon size={12} />
  return <Monitor size={12} />
}

const THEME_LABEL: Record<ThemeMode, string> = {
  system: 'System',
  dark: 'Dark',
  light: 'Light'
}

export function TitleBar(): React.ReactElement {
  const accent = useAppearance((s) => s.accent)
  const themeMode = useAppearance((s) => s.themeMode)
  const resolved = useAppearance((s) => s.resolvedTheme)
  const setAccent = useAppearance((s) => s.setAccent)
  const setThemeMode = useAppearance((s) => s.setThemeMode)

  return (
    <header
      className={cn('h-titlebar shrink-0 bg-ink-0 border-b border-ink-border', 'flex items-center')}
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div className="w-[72px]" aria-hidden="true" />

      <div className="text-meta font-mono uppercase tracking-widest text-ink-fg-3">MailAgent</div>

      <div className="ml-auto flex items-center gap-2 pr-3">
        <span aria-label="island-indicator" className="w-2 h-2 rounded-full bg-ink-fg-3" />

        {/* Theme cycle: System → Dark → Light → System.
            Title shows the resolved theme so System mode tells you what
            you're actually looking at. */}
        <button
          type="button"
          onClick={() => setThemeMode(nextOf(THEME_ORDER, themeMode))}
          title={`Theme: ${THEME_LABEL[themeMode]}${themeMode === 'system' ? ` (resolved: ${resolved})` : ''}`}
          className={cn(
            'flex items-center gap-1.5 px-1.5 py-0.5 rounded',
            'text-meta font-mono text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3'
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <ThemeIcon mode={themeMode} />
          {THEME_LABEL[themeMode]}
        </button>

        {/* Accent cycle: Coral → Cobalt → Teal → Rose → Slate → Olive → Coral. */}
        <button
          type="button"
          onClick={() => setAccent(nextOf(ACCENT_ORDER, accent))}
          title={`Accent: ${ACCENT_LABEL[accent]}`}
          className={cn(
            'flex items-center gap-1.5 px-1.5 py-0.5 rounded',
            'text-meta font-mono text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3'
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-coral/100" aria-hidden="true" />
          {ACCENT_LABEL[accent] ?? accent}
        </button>
      </div>
    </header>
  )
}
