// Sprint 4 §6.1 — backend header at the top of the AI panel.
//
// task 06-18-custom-ai-harness cleanup — notion-agent is retired as a
// *selectable* backend. New email-mode chats are always custom-api, so the old
// Notion Agent ⇄ Custom API toggle (SegmentedControl) is gone and this is now a
// static header:
//   - custom-api: shows the active model + "online" dot,
//   - notion-agent: an old `backend_kind='notion-agent'` session loaded
//     read-only — show a "migrated to a tool" notice (the session itself renders
//     read-only; see AIChatPanel's retired branch).
// Switching backends is no longer a user action; selectBackend is only driven by
// session restore (loading an old notion-agent history) and the model picker.

import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'

import type { ChatBackendKind } from '@shared/api/types'

export interface BackendChoice {
  kind: ChatBackendKind
  model: string | null
  agentPageId: string | null
}

interface Props {
  value: BackendChoice
  agentName?: string | null
}

const DEFAULT_CUSTOM_MODEL = 'claude-sonnet-4-6'

export function BackendSelector({ value, agentName }: Props): React.ReactElement {
  const { t } = useTranslation()

  // Retired notion-agent session (loaded read-only) — static "migrated" notice
  // instead of the active-backend meta row. Grey-toned so it reads as inert.
  if (value.kind === 'notion-agent') {
    return (
      <div className="px-3 py-2.5 border-b border-ink-border-soft">
        <div className="flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-md grid place-items-center shrink-0 bg-ink-4 border border-ink-border-soft">
            <Sparkles size={13} strokeWidth={0} className="fill-ink-fg-3 text-ink-fg-3" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-micro text-ink-fg font-medium truncate">
              {agentName ?? t('chat.backend.notionAgent')}
            </div>
            <div className="text-[10px] text-ink-fg-2 truncate">
              {t('chat.backend.retiredNotice')}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Active custom-api backend — icon + model + ok dot + mono meta sub-line.
  const activeModel = value.model ?? DEFAULT_CUSTOM_MODEL
  return (
    <div className="px-3 py-2.5 border-b border-ink-border-soft">
      <div className="flex items-center gap-2.5">
        <span className="w-7 h-7 rounded-md grid place-items-center shrink-0 bg-coral/15 border border-coral/30">
          <Sparkles size={13} strokeWidth={0} className="fill-coral text-coral" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-micro text-ink-fg font-medium truncate min-w-0">
              {activeModel}
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" aria-label="ok" />
          </div>
          <div className="text-[10px] font-mono text-ink-fg-2 truncate">
            openai-compat · {activeModel}
          </div>
        </div>
      </div>
    </div>
  )
}
