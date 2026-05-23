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
import { Sparkles } from 'lucide-react'

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

  // Segmented control 选中态的 detail 行: 当前 backend 的"标识 + meta".
  // truncate + min-w-0 flex-1 防止长 agent name (Jarvis / 中文名 / 长 model id)
  // 撑破侧栏边界.
  const activeName = isNotionAgent ? (agentName ?? 'Jarvis') : activeModel
  const activeMeta = isNotionAgent ? 'notion-agent-cli · token_v2' : `openai-compat · ${activeModel}`

  const switchKind = (next: ChatBackendKind): void => {
    if (next === value.kind) return
    if (next === 'custom-api') {
      onChange({ kind: 'custom-api', model: activeModel, agentPageId: null })
    } else {
      onChange({ kind: 'notion-agent', model: value.model, agentPageId: value.agentPageId })
    }
  }

  return (
    <div className="px-3 py-2.5 border-b border-ink-border-soft">
      {/* Segmented control — 两按钮并排, 当前 kind 高亮; 点哪个切到哪个.
          替代之前的"hero card + ChevronDown" 视觉, 后者看起来像下拉但实际
          只是 2 选项 toggle, 不符合切换型交互的直觉. */}
      <div
        role="tablist"
        aria-label={t('chat.backend.selectorLabel')}
        className="flex rounded-md bg-ink-2 p-0.5 gap-0.5"
      >
        {(['notion-agent', 'custom-api'] as const).map((kind) => {
          const active = value.kind === kind
          return (
            <button
              key={kind}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => switchKind(kind)}
              className={cn(
                'flex-1 px-2.5 py-1 rounded text-meta font-medium',
                'transition-colors duration-fast',
                active
                  ? 'bg-ink-3 text-ink-fg shadow-sm'
                  : 'text-ink-fg-2 hover:text-ink-fg'
              )}
            >
              {kind === 'notion-agent'
                ? t('chat.backend.notionAgent')
                : t('chat.backend.customApi')}
            </button>
          )
        })}
      </div>

      {/* Active backend meta — icon + name + ok dot + sub-line. */}
      <div className="mt-2 flex items-center gap-2.5">
        <span
          className={cn(
            'w-7 h-7 rounded-md grid place-items-center shrink-0',
            'bg-coral/15 border border-coral/30'
          )}
        >
          <Sparkles size={13} strokeWidth={0} className="fill-coral text-coral" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-body text-ink-fg font-medium truncate min-w-0">
              {activeName}
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" aria-label="ok" />
          </div>
          <div className="text-meta font-mono text-ink-fg-2 truncate">{activeMeta}</div>
        </div>
      </div>
    </div>
  )
}
