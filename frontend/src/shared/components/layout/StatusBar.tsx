// 24px bottom status bar · mockup-inbox.html footer. mono text-meta, ≥5
// segments separated by `text-ink-fg-3 ·` dividers. Sprint 2 wires what
// it can (active mailbox, theme, accent, version); the rest are static
// placeholders that Sprint 6 (admin stats live data) replaces.

import { Activity, Cpu, Database, Layers } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useAppearance } from '@shared/state/appearance'
import { useMailbox } from '@shared/state/mailbox'

function Sep(): React.ReactElement {
  return <span className="text-ink-fg-3 px-2">·</span>
}

function Segment({
  icon,
  children
}: {
  icon?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5">
      {icon}
      {children}
    </span>
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
        'flex items-center px-3',
        'text-meta font-mono text-ink-fg-2'
      )}
    >
      <Segment icon={<span className="w-1.5 h-1.5 rounded-full bg-ok" aria-hidden />}>
        <span>Synced</span>
        <span className="text-ink-fg-3">·</span>
        <span className="text-ink-fg-1">5s</span>
      </Segment>
      <Sep />

      <Segment icon={<Database size={11} strokeWidth={2} />}>
        <span className="text-ink-fg-3">mailbox</span>
        <span className="text-ink-fg-1">{active}</span>
      </Segment>
      <Sep />

      <Segment icon={<Cpu size={11} strokeWidth={2} />}>
        <span className="text-ink-fg-3">llm</span>
        <span className="text-ink-fg-1">IDLE</span>
      </Segment>
      <Sep />

      <Segment icon={<Activity size={11} strokeWidth={2} />}>
        <span className="text-ink-fg-3">theme</span>
        <span className="text-ink-fg-1 uppercase">{resolved}</span>
        <span className="text-ink-fg-3">·</span>
        <span className="text-ink-fg-1 capitalize">{accent}</span>
      </Segment>

      <span className="ml-auto flex items-center gap-1.5">
        <Layers size={11} strokeWidth={2} className="text-ink-fg-3" />
        <span className="text-ink-fg-3">v0.0.1 · sprint 2</span>
      </span>
    </footer>
  )
}
