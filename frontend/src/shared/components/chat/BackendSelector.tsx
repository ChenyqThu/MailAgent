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
import { SegmentedControl } from '@shared/components/ui/segmented'
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

  // Label = ok dot + text（dot 的 active/inactive 色跟随当前 kind）。文字用
  // text-aux(14px)：从 micro(11px) 提到 aux（跳过 meta 12px），用户反馈切换
  // 按钮文字偏小。whitespace-nowrap 防止字号变大后短标签在窄侧栏里折行。
  const kindLabel = (kind: ChatBackendKind): React.ReactNode => (
    <>
      <span
        className={cn(
          'w-1.5 h-1.5 rounded-full transition-colors duration-fast',
          value.kind === kind ? 'bg-ok' : 'bg-ink-fg-3'
        )}
      />
      <span className="text-aux whitespace-nowrap">
        {kind === 'notion-agent' ? t('chat.backend.notionAgent') : t('chat.backend.customApi')}
      </span>
    </>
  )

  return (
    <div className="px-3 py-2.5 border-b border-ink-border-soft">
      {/* v0.7.2 — 统一 SegmentedControl（ui/segmented.tsx，authored `.seg` 视觉
          基准 + 测量式滑动指示器）取代旧 sliding-thumb。Click 仍 toggle backend
          KIND（⌥⇧B parity）；reduced-motion / 初帧由组件内部处理。

          task 06-08-chat §3.1 — data-chat-agent-switch marks the agent switcher
          so the History popover's outside-click handler can EXCLUDE it:
          switching agents with the popover open must keep it open (the list
          re-scopes in place between Notion Agent / Custom AI). */}
      <div data-chat-agent-switch>
        <SegmentedControl<ChatBackendKind>
          value={value.kind}
          onChange={switchKind}
          ariaLabel={t('chat.backend.selectorLabel')}
          fluid
          size="md"
          className="w-full"
          options={[
            {
              value: 'notion-agent',
              ariaLabel: t('chat.backend.notionAgent'),
              label: kindLabel('notion-agent')
            },
            {
              value: 'custom-api',
              ariaLabel: t('chat.backend.customApi'),
              label: kindLabel('custom-api')
            }
          ]}
        />
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
