// Sprint 4 §6.1 — backend selector at the top of the AI panel.
// V1 redesign (Sprint 10 polish): mirrors mockup-inbox.html lines 1118-1141.
// Single hero card showing the active backend + 1-line meta + chevron;
// below it an "Alt" row of 3 model chips for one-tap swap to Custom API,
// plus a "+ add" affordance routing to Settings for new endpoints.

import { useTranslation } from 'react-i18next'
import { useNavigate } from '@tanstack/react-router'
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

const CUSTOM_API_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5.4'] as const

// Short alias for the Alt-row chips so 360px panel doesn't wrap. The full
// model id stays in the underlying BackendChoice (so the dispatcher still
// gets `claude-sonnet-4-6`), just the chip label is trimmed for fit. Title
// attribute carries the full id on hover for discoverability.
const MODEL_ALIAS: Record<string, string> = {
  'claude-sonnet-4-6': 'sonnet-4-6',
  'claude-opus-4-7': 'opus-4-7',
  'gpt-5.4': 'gpt-5.4'
}

export function BackendSelector({ value, onChange, agentName }: Props): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const isNotionAgent = value.kind === 'notion-agent'
  const activeModel = value.model ?? CUSTOM_API_MODELS[0]

  // Hero card title — Notion Agent surfaces the user-provided agent name
  // (English or CJK) so it has to clear the 14px floor; Custom API uses a
  // mono model id which is always ASCII.
  const heroTitle = isNotionAgent
    ? `${t('chat.backend.notionAgent')} · ${agentName ?? 'Jarvis'}`
    : `${t('chat.backend.customApi')} · ${activeModel}`
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

      {/* Alt row — quick-pick model chips. English-only labels (mono model ids
          + "Alt" / "+ add") so text-meta 12px is on-spec. flex-wrap so 360px
          panel never clips the "+ add" affordance — mockup model aliases are
          shorter (claude-3.5 / gpt-5 / deepseek-v3) so it fits single-row
          there; we degrade to 2 rows on narrow viewports rather than clip. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1 px-0.5">
        <span className="text-micro font-mono uppercase tracking-wider text-ink-fg-2 pr-1">
          Alt
        </span>
        {CUSTOM_API_MODELS.map((m) => {
          const active = !isNotionAgent && activeModel === m
          return (
            <button
              key={m}
              type="button"
              aria-pressed={active}
              onClick={() => onChange({ kind: 'custom-api', model: m, agentPageId: null })}
              title={m}
              className={cn(
                'text-meta font-mono px-1.5 py-0.5 rounded whitespace-nowrap',
                'transition-colors duration-fast',
                active
                  ? 'text-coral bg-coral/10 border border-coral/30'
                  : 'text-ink-fg-1 bg-ink-3 border border-ink-border hover:border-ink-fg-3'
              )}
            >
              {MODEL_ALIAS[m] ?? m}
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => void navigate({ to: '/settings' })}
          className={cn(
            'text-meta font-mono px-1.5 py-0.5 rounded',
            'text-ink-fg-2 hover:text-ink-fg hover:bg-ink-3 transition-colors duration-fast'
          )}
        >
          + add
        </button>
      </div>
    </div>
  )
}
