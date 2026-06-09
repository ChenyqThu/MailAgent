// Sprint 4 §6.7 — quick action chips above the composer. Each chip
// injects a pre-built user message and (in V1.5) auto-submits. For V1
// we only inject — the user still hits ⌘↩ to send so they can edit the
// prefab before committing.
//
// V1 redesign (Sprint 10 polish): mirrors mockup-inbox.html lines 1310-1329.
// Each chip pairs an 11px Lucide icon with its label so the row reads as
// a toolbar, not a forgettable text-only pill bar.

import { useTranslation } from 'react-i18next'
import { AlignLeft, ListChecks, Send } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@shared/lib/cn'

interface Props {
  onPick(prompt: string): void
  disabled?: boolean
}

interface ActionDef {
  key: string
  labelKey: string
  /** Sprint 10 (d) V1.5 polish — both label AND prompt go through i18n so an
   *  en-US user gets an English prompt body (not just an English chip label
   *  followed by a Chinese instruction the LLM will reply in Chinese to). */
  promptKey: string
  icon: LucideIcon
}

const ACTIONS: ActionDef[] = [
  {
    key: 'summarize',
    labelKey: 'chat.quickActions.summarize',
    promptKey: 'chat.quickActions.summarizePrompt',
    icon: AlignLeft
  },
  {
    key: 'extract',
    labelKey: 'chat.quickActions.extract',
    promptKey: 'chat.quickActions.extractPrompt',
    icon: ListChecks
  },
  {
    key: 'draft',
    labelKey: 'chat.quickActions.draft',
    promptKey: 'chat.quickActions.draftPrompt',
    icon: Send
  }
]

export function QuickActions({ onPick, disabled = false }: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="px-3 py-2 flex flex-wrap gap-1.5 border-t border-ink-border-soft">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <button
            key={a.key}
            type="button"
            disabled={disabled}
            onClick={() => onPick(t(a.promptKey))}
            className={cn('qchip', disabled && 'opacity-50 cursor-not-allowed')}
          >
            <Icon size={11} strokeWidth={2} />
            {t(a.labelKey)}
          </button>
        )
      })}
    </div>
  )
}
