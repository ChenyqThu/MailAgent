// redesign Phase 3 — MailAgent welcome quick-actions: two horizontally-scrollable chip rows (a category
// row → an expanded sub-option row). Restyled from the assistant-ui base template with our coral/ink
// tokens. Rendered inside the AssistantThread empty state (so it sits in the runtime context); each
// sub-option is a ThreadPrimitive.Suggestion, so a click sends that prompt through whichever runtime is
// active (ai-sdk gateway OR the legacy degrade engine) — one uniform path. Content lives in i18n.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ThreadPrimitive } from '@assistant-ui/react'
import { FileText, ListChecks, PenLine, Reply, Search, type LucideIcon } from 'lucide-react'

import { cn } from '@shared/lib/cn'

interface Category {
  key: string
  icon: LucideIcon
  options: readonly string[]
}

// Category + sub-option keys mirror the agentView.quickActions.* i18n block (Phase 0). Icons are a code
// concern (not translated). The sub-option i18n VALUES are the prompts sent on click.
const CATEGORIES: readonly Category[] = [
  { key: 'summarize', icon: FileText, options: ['unread', 'weekly', 'sender'] },
  { key: 'draft', icon: Reply, options: ['followup', 'decline', 'thanks'] },
  { key: 'search', icon: Search, options: ['invoice', 'unanswered', 'attachments'] },
  { key: 'todo', icon: ListChecks, options: ['needReply', 'waiting', 'thisWeek'] },
  { key: 'write', icon: PenLine, options: ['meeting', 'report', 'intro'] }
]

const chipClass =
  'inline-flex h-auto items-center gap-1.5 whitespace-nowrap rounded-full border border-ink-border-soft px-3.5 py-1.5 text-aux text-ink-fg-1 transition-colors duration-fast hover:bg-ink-3'

export function AgentQuickActions(): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)
  const active = CATEGORIES.find((c) => c.key === expanded) ?? null

  return (
    <div className="flex w-full flex-col gap-2">
      {/* category chips */}
      <div className="scrollbar-none w-full overflow-x-auto">
        <div className="mx-auto flex w-max items-center gap-2">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon
            const isActive = cat.key === expanded
            return (
              <button
                key={cat.key}
                type="button"
                onClick={() => setExpanded(isActive ? null : cat.key)}
                aria-expanded={isActive}
                className={cn(chipClass, isActive && 'border-ink-border bg-ink-3 text-ink-fg')}
              >
                <Icon size={14} strokeWidth={1.75} className="text-coral" />
                {t(`agentView.quickActions.${cat.key}.label`)}
              </button>
            )
          })}
        </div>
      </div>

      {/* sub-option chips — keyed by category so a switch retriggers the slide-in (base template idiom) */}
      {active && (
        <div
          key={active.key}
          className="scrollbar-none w-full animate-in fade-in slide-in-from-top-1 overflow-x-auto duration-200 motion-reduce:animate-none"
        >
          <div className="mx-auto flex w-max items-center gap-2">
            {active.options.map((optKey) => {
              const text = t(`agentView.quickActions.${active.key}.options.${optKey}`)
              return (
                <ThreadPrimitive.Suggestion
                  key={optKey}
                  prompt={text}
                  autoSend
                  className={chipClass}
                >
                  {text}
                </ThreadPrimitive.Suggestion>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
