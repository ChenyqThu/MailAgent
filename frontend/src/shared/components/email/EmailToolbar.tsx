// DESIGN.md §5 Toolbar — Sprint 2 ships the UI shell only. Actions
// (`✦ 起草回复` opens composer, Translate, Resync, Re-run LLM) wire in
// Sprint 5 once cli_runner.ts is online; for now each button is a `disabled`
// affordance with the right hover/focus shape so the visual is the final
// answer when the IPCs land.

import { Reply, Languages, RefreshCcw, Sparkles } from 'lucide-react'

import { cn } from '@shared/lib/cn'

function GhostButton({
  icon,
  children,
  disabled
}: {
  icon: React.ReactNode
  children: React.ReactNode
  disabled?: boolean
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-1 rounded',
        'text-meta font-mono uppercase tracking-wide',
        'text-ink-fg-1 border border-transparent',
        'hover:bg-ink-3 hover:text-ink-fg hover:border-ink-border',
        'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:border-transparent'
      )}
    >
      {icon}
      <span>{children}</span>
    </button>
  )
}

export function EmailToolbar(): React.ReactElement {
  return (
    <div className="h-12 shrink-0 border-b border-ink-border bg-ink-1 flex items-center gap-2 px-4">
      {/* Primary action — DESIGN.md §2.2 reserves solid bg-coral/100 for the
          single headline action per surface. */}
      <button
        type="button"
        disabled
        className={cn(
          'inline-flex items-center gap-1.5 px-3 py-1.5 rounded',
          'text-aux font-medium bg-coral/100 text-white',
          'hover:bg-coral-hover',
          'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-coral/100'
        )}
        title="Sprint 5"
      >
        <Sparkles size={13} className="fill-current" />
        <span>起草回复</span>
      </button>

      <span className="w-px h-5 bg-ink-border-soft mx-1" aria-hidden />

      <GhostButton icon={<Languages size={13} />} disabled>
        Translate
      </GhostButton>
      <GhostButton icon={<RefreshCcw size={13} />} disabled>
        Resync
      </GhostButton>
      <GhostButton icon={<Reply size={13} />} disabled>
        Re-run AI
      </GhostButton>
    </div>
  )
}
