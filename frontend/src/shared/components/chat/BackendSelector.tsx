// Sprint 4 §6.1 — backend selector at the top of the AI panel.
//
// Sprint 13 user-feedback rewrite: mockup-inbox.html L2307-2321 is a SINGLE
// hero-card button (icon + title + meta + ok dot + chevron). The "Alt" row
// (model chips) we added in Sprint 10 was a Sprint-decision that the mockup
// doesn't authorise — model switching belongs to the Composer footer Cpu
// button (mockup L2530 `title="切换模型 · claude-3.5"`).
//
// Click behaviour: still toggles backend KIND (Notion Agent ⇄ Custom API).
// A full popover dropdown surface ("pick from N agents / N custom keys") is
// scoped to Sprint 14 alongside Settings polish — for now the toggle
// matches the ⌥⇧B shortcut and is enough for the V1 ship.

import { useTranslation } from 'react-i18next'
import { ChevronDown, Sparkles } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import type { ChatBackendKind } from '@shared/api/types'

export interface BackendChoice {
  kind: ChatBackendKind
  model: string | null
  agentPageId: string | null
}

interface Props {
  value: BackendChoice
  onChange(next: BackendChoice): void
  agentName?: string | null
}

const DEFAULT_CUSTOM_MODEL = 'claude-sonnet-4-6'

export function BackendSelector({ value, onChange, agentName }: Props): React.ReactElement {
  const { t } = useTranslation()

  const isNotionAgent = value.kind === 'notion-agent'
  const activeModel = value.model ?? DEFAULT_CUSTOM_MODEL

  // Hero card title — Notion Agent surfaces the user-provided agent name
  // (English or CJK) so it has to clear the 14px floor; Custom API uses a
  // mono model id which is always ASCII.
  const heroTitle = isNotionAgent
    ? `${t('chat.backend.notionAgent')} · ${agentName ?? 'Jarvis'}`
    : `${t('chat.backend.customApi')} · ${activeModel}`
  // Meta line — ASCII mono short summary of how this backend talks. Stays
  // English at text-meta 12px (the 14px floor only applies to CJK).
  const heroMeta = isNotionAgent
    ? 'notion-agent-cli · token_v2 · persona_overlay'
    : `openai-compat · ${activeModel}`

  const toggleBackend = (): void => {
    if (isNotionAgent) {
      onChange({ kind: 'custom-api', model: activeModel, agentPageId: null })
    } else {
      onChange({
        kind: 'notion-agent',
        model: value.model,
        agentPageId: value.agentPageId
      })
    }
  }

  return (
    <div className="px-3 py-2.5 border-b border-ink-border-soft">
      <button
        type="button"
        onClick={toggleBackend}
        className={cn(
          'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md',
          'bg-ink-3 border border-ink-border hover:border-ink-fg-3',
          'transition-colors duration-fast group text-left'
        )}
        aria-label={t('chat.backend.selectorLabel')}
      >
        <span
          className={cn(
            'w-7 h-7 rounded-md grid place-items-center shrink-0',
            'bg-coral/15 border border-coral/30'
          )}
        >
          <Sparkles size={13} strokeWidth={0} className="fill-coral text-coral" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-body text-ink-fg font-medium truncate">{heroTitle}</span>
            <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" />
          </span>
          <span className="block text-meta font-mono text-ink-fg-2 truncate">{heroMeta}</span>
        </span>
        <ChevronDown
          size={13}
          strokeWidth={2}
          className="text-ink-fg-2 group-hover:text-ink-fg shrink-0 transition-colors duration-fast"
        />
      </button>
    </div>
  )
}
