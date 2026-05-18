// Sprint 4 §6.7 — quick action chips above the composer. Each chip
// injects a pre-built user message and (in Sprint 5) auto-submits. For
// Sprint 4 we only inject — the user still hits ⌘↩ to send so they can
// edit the prefab before committing.

import { useTranslation } from 'react-i18next'
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
}

const ACTIONS: ActionDef[] = [
  {
    key: 'summarize',
    labelKey: 'chat.quickActions.summarize',
    promptKey: 'chat.quickActions.summarizePrompt'
  },
  {
    key: 'draft',
    labelKey: 'chat.quickActions.draft',
    promptKey: 'chat.quickActions.draftPrompt'
  },
  {
    key: 'translate',
    labelKey: 'chat.quickActions.translate',
    promptKey: 'chat.quickActions.translatePrompt'
  },
  {
    key: 'extract',
    labelKey: 'chat.quickActions.extract',
    promptKey: 'chat.quickActions.extractPrompt'
  },
  {
    key: 'linkNotion',
    labelKey: 'chat.quickActions.linkNotion',
    promptKey: 'chat.quickActions.linkNotionPrompt'
  }
]

export function QuickActions({ onPick, disabled = false }: Props): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div className="px-3 pt-2 flex flex-wrap gap-1.5">
      {ACTIONS.map((a) => (
        <button
          key={a.key}
          type="button"
          disabled={disabled}
          onClick={() => onPick(t(a.promptKey))}
          className={cn(
            'rounded-full px-2.5 py-1 text-aux',
            'text-ink-fg-1 border border-ink-border bg-ink-3',
            'hover:bg-ink-4 hover:border-ink-fg-3 transition-colors duration-fast',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {t(a.labelKey)}
        </button>
      ))}
    </div>
  )
}
