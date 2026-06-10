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
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
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
  const reduceMotion = useReducedMotion()

  const isNotionAgent = value.kind === 'notion-agent'
  const activeModel = value.model ?? DEFAULT_CUSTOM_MODEL

  // Segmented control 选中态的 detail 行: 当前 backend 的"标识 + meta".
  // truncate + min-w-0 flex-1 防止长 agent name (Jarvis / 中文名 / 长 model id)
  // 撑破侧栏边界.
  const activeName = isNotionAgent ? (agentName ?? 'Jarvis') : activeModel
  const activeMeta = isNotionAgent
    ? 'notion-agent-cli · token_v2'
    : `openai-compat · ${activeModel}`

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
      {/* 交付文档 §3 — sliding-thumb segmented control (mockup `.seg`/`.seg-thumb`/
          `.sdot`). A single track holds a white thumb that slides between the two
          halves (transform translateX) — more refined than two independent
          buttons. Active item: solid text + leading GREEN dot (--c-ok); inactive:
          a grey dot (--ink-fg-3). Click still toggles backend KIND (⌥⇧B parity).
          reduced-motion drops the slide (snaps via no transition). */}
      <div
        role="tablist"
        // task 06-08-chat §3.1 — marks the agent switcher so the History
        // popover's outside-click handler can EXCLUDE it: switching agents
        // with the popover open must keep it open (the list re-scopes in
        // place between Notion Agent / Custom AI).
        data-chat-agent-switch
        aria-label={t('chat.backend.selectorLabel')}
        className="relative flex rounded-[10px] bg-ink-2 border border-ink-border p-[3px]"
      >
        {/* Sliding white thumb — half the track width minus the 3px padding gutter,
            translated to the right half for custom-api. */}
        <span
          aria-hidden
          className={cn(
            'absolute top-[3px] bottom-[3px] left-[3px] rounded-[7px] bg-white',
            'shadow-[0_1px_2px_rgba(28,34,48,0.10),0_0_0_0.5px_rgba(28,34,48,0.04)]',
            !reduceMotion && 'transition-transform duration-fast ease-out'
          )}
          style={{
            width: 'calc(50% - 3px)',
            transform: isNotionAgent ? 'translateX(0)' : 'translateX(100%)'
          }}
        />
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
                'relative z-[1] flex-1 inline-flex items-center justify-center gap-1.5',
                // task 06-08-chat dogfood r3→r4 — "字体再小一号". seg tab
                // labels ("Notion Agent" / "Custom AI", ASCII in both locales)
                // r3 dropped text-meta(12)→text-micro(11); r4 drops to 10px;
                // r5 user feedback "大一号" — back to text-micro(11px).
                'h-8 rounded-[7px] text-micro',
                'transition-colors duration-fast',
                active ? 'text-ink-fg font-semibold' : 'text-ink-fg-2 hover:text-ink-fg-1'
              )}
            >
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full transition-colors duration-fast',
                  active ? 'bg-ok' : 'bg-ink-fg-3'
                )}
              />
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
            {/* "字体再小一号": active name r3 body(14)→meta(12), r4 meta(12)→
                micro(11). Name may be a CJK agent name — 11px is the CJK floor
                (DESIGN.md §14), so it holds there, not below. */}
            <span className="text-micro text-ink-fg font-medium truncate min-w-0">
              {activeName}
            </span>
            <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" aria-label="ok" />
          </div>
          {/* mono ascii sub-line r3 meta(12)→micro(11); r4 →10px (ASCII). */}
          <div className="text-[10px] font-mono text-ink-fg-2 truncate">{activeMeta}</div>
        </div>
      </div>
    </div>
  )
}
