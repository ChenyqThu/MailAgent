// chat-panel P4 Phase 01 — assistant-ui text + reasoning part renderers.
//
// `Text` slot: reuses the legacy TranslatedBody (Streamdown) so markdown — GFM,
// code highlight, streaming caret + per-token fade-in — is the exact same
// pipeline the legacy MessageList uses (goal: "markdown 渲染复用现有 streamdown").
// `Reasoning` slot: collapsible extended-thinking block mirroring the legacy
// ThinkingBlock (expanded + shimmer while streaming, auto-collapses when done,
// click to re-read). Both are typed via their part-props (not the ComponentType
// alias) so eslint react/prop-types reads the prop shape; they stay assignable
// to the MessagePrimitive.Parts `components` slots structurally.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import type { ReasoningMessagePartProps, TextMessagePartProps } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { ShimmerText } from '@shared/components/ShimmerText'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'

export function MarkdownText({ text, status }: TextMessagePartProps): React.JSX.Element {
  return <TranslatedBody text={text} streaming={status?.type === 'running'} />
}

export function ReasoningText({ text, status }: ReasoningMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const active = status?.type === 'running'
  const [open, setOpen] = useState(active)
  const [prevActive, setPrevActive] = useState(active)
  // Adjust-on-prop-change (react.dev): active → expand; thinking done → collapse.
  if (prevActive !== active) {
    setPrevActive(active)
    setOpen(active)
  }
  const shown = open || active
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => {
          if (!active) setOpen((o) => !o)
        }}
        className="inline-flex items-center gap-1.5 py-0.5 text-left text-ink-fg-2 transition-colors duration-fast hover:text-ink-fg-1"
        aria-expanded={shown}
      >
        <ChevronRight
          size={13}
          className={cn(
            'shrink-0 text-ink-fg-3 transition-transform duration-fast',
            shown && 'rotate-90'
          )}
        />
        {active ? (
          <ShimmerText text={t('chat.thinking.streaming')} className="text-aux" />
        ) : (
          <span className="text-aux">{t('chat.thinking.label')}</span>
        )}
      </button>
      <div className={cn('pl-[18px]', shown ? 'block' : 'hidden')} aria-hidden={!shown}>
        <pre className="scrollbar-thin whitespace-pre-wrap break-words pt-1 pb-0.5 font-sans text-aux leading-relaxed text-ink-fg-1">
          {text}
          {active && <span className="think-caret" aria-hidden="true" />}
        </pre>
      </div>
    </div>
  )
}
