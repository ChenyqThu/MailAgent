// DESIGN.md §5 — bottom status bar 24px, mono text-meta, ≥5 segments. Sprint
// 1 ships static placeholders sourced from local state (active mailbox,
// resolved theme + accent). The remaining segments get wired in Sprint 6
// (sync clock from /admin stats) and Sprint 4 (LLM idle/busy from
// llm_processing live query).

import { useAppearance } from '@shared/state/appearance'
import { useMailbox } from '@shared/state/mailbox'
import { cn } from '@shared/lib/cn'

function Segment({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5 px-2 border-r border-ink-border-soft last:border-r-0">
      {children}
    </div>
  )
}

export function StatusBar(): React.ReactElement {
  const resolved = useAppearance((s) => s.resolvedTheme)
  const accent = useAppearance((s) => s.accent)
  const active = useMailbox((s) => s.active)

  return (
    <footer
      className={cn(
        'h-statusbar shrink-0 bg-ink-1 border-t border-ink-border',
        'flex items-stretch text-meta font-mono text-ink-fg-2'
      )}
    >
      <Segment>
        <span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden="true" />
        SYNCED
      </Segment>
      <Segment>
        <span className="text-ink-fg-3">mailbox</span>
        <span className="text-ink-fg-1">{active}</span>
      </Segment>
      <Segment>
        <span className="text-ink-fg-3">llm</span>
        <span className="text-ink-fg-1">IDLE</span>
      </Segment>
      <Segment>
        <span className="text-ink-fg-3">theme</span>
        <span className="text-ink-fg-1 uppercase">{resolved}</span>
        <span className="text-ink-fg-3">·</span>
        <span className="text-ink-fg-1 uppercase">{accent}</span>
      </Segment>
      <div className="ml-auto flex items-center px-2 text-ink-fg-3">v0.0.1 · sprint 1</div>
    </footer>
  )
}
