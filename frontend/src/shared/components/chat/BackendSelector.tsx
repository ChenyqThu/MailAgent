// Sprint 4 §6.1 — backend selector at the top of the AI panel.
//
// Two rows:
//   1. Backend kind: Notion Agent / Custom API (active = coral underline)
//   2. Model chips (alternates), only shown for Custom API since the
//      Notion Agent runtime is locked to whatever Notion AI is using.
//
// Selection writes back to the panel-level state via `onChange`; the panel
// passes the values through to `useEmailChat.send()` on the next turn.

import { useTranslation } from 'react-i18next'

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

const CUSTOM_API_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5.4'] as const

export function BackendSelector({ value, onChange, agentName }: Props): React.ReactElement {
  const { t } = useTranslation()

  const isNotionAgent = value.kind === 'notion-agent'

  return (
    <div className="px-3 pt-3 pb-2 border-b border-ink-border-soft">
      <div className="flex items-center gap-2 text-meta font-mono text-ink-fg-3 mb-2 uppercase tracking-wider">
        {t('chat.backend.selectorLabel')}
      </div>
      <div className="flex items-center gap-1.5 text-aux">
        <button
          type="button"
          aria-pressed={isNotionAgent}
          onClick={() =>
            onChange({
              kind: 'notion-agent',
              model: value.model,
              agentPageId: value.agentPageId
            })
          }
          className={cn(
            'px-2.5 py-1 rounded-md transition-colors duration-fast',
            isNotionAgent
              ? 'bg-coral/10 text-coral border border-coral/30'
              : 'text-ink-fg-1 hover:bg-ink-4 border border-transparent'
          )}
        >
          {t('chat.backend.notionAgent')}
          {agentName && (
            <span className="ml-1 text-meta font-mono text-ink-fg-2">· {agentName}</span>
          )}
        </button>
        <button
          type="button"
          aria-pressed={!isNotionAgent}
          onClick={() =>
            onChange({
              kind: 'custom-api',
              model: value.model ?? CUSTOM_API_MODELS[0],
              agentPageId: null
            })
          }
          className={cn(
            'px-2.5 py-1 rounded-md transition-colors duration-fast',
            !isNotionAgent
              ? 'bg-coral/10 text-coral border border-coral/30'
              : 'text-ink-fg-1 hover:bg-ink-4 border border-transparent'
          )}
        >
          {t('chat.backend.customApi')}
        </button>
      </div>
      {!isNotionAgent && (
        <div className="flex flex-wrap gap-1 mt-2">
          {CUSTOM_API_MODELS.map((m) => {
            const active = (value.model ?? CUSTOM_API_MODELS[0]) === m
            return (
              <button
                key={m}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ ...value, model: m })}
                className={cn(
                  'px-2 py-0.5 rounded text-micro font-mono uppercase tracking-wide',
                  active
                    ? 'text-coral bg-coral/10 border border-coral/30'
                    : 'text-ink-fg-2 hover:text-ink-fg-1 border border-ink-border'
                )}
              >
                {m}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
