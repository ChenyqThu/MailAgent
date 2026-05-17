// DESIGN.md §5 — title bar 36px tall, hiddenInset window style so macOS
// traffic-light controls render natively on the left. We leave 72px of empty
// `-webkit-app-region: drag` space for them, then place app chrome on the
// right (accent dot per §2.7, island indicator, future quick toggles).
//
// Sprint 1 ships the shell; Sprint 6 SettingsPage wires the accent popover
// onClick — for now the dot is decorative + reflects the live accent token
// so a theme switch visibly updates here too.

import { useAppearance } from '@shared/state/appearance'
import { cn } from '@shared/lib/cn'

const ACCENT_LABEL: Record<string, string> = {
  coral: 'Coral',
  cobalt: 'Cobalt',
  teal: 'Teal',
  rose: 'Rose',
  slate: 'Slate',
  olive: 'Olive'
}

export function TitleBar(): React.ReactElement {
  const accent = useAppearance((s) => s.accent)
  return (
    <header
      className={cn('h-titlebar shrink-0 bg-ink-0 border-b border-ink-border', 'flex items-center')}
      // hiddenInset shows the system traffic lights — leaving the full bar
      // draggable lets the user grab anywhere outside our right-side buttons.
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Reserve room for traffic lights (left). 72px matches macOS spacing. */}
      <div className="w-[72px]" aria-hidden="true" />

      {/* App label sits centered-left, dim text — the headline is the inbox,
          not the app brand. */}
      <div className="text-meta font-mono uppercase tracking-widest text-ink-fg-3">MailAgent</div>

      <div className="ml-auto flex items-center gap-3 pr-3">
        {/* IslandIndicator placeholder — Island plugin sprint wires the live
            state (recent envelope, mascot avatar). 12×12 dot keeps the slot. */}
        <span aria-label="island-indicator" className="w-2 h-2 rounded-full bg-ink-fg-3" />

        {/* Accent dot + label. Re-skins on accent swap because the dot reads
            `--c-accent` via `bg-coral`. Click target waits for Sprint 6. */}
        <button
          type="button"
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
