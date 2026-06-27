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

import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import type { ReasoningMessagePartProps, TextMessagePartProps } from '@assistant-ui/react'

import { cn } from '@shared/lib/cn'
import { gsap, useGSAP, DUR } from '@shared/lib/gsap'
import { useReducedMotion } from '@shared/hooks/useReducedMotion'
import { ShimmerText } from '@shared/components/ShimmerText'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'

export function MarkdownText({ text, status }: TextMessagePartProps): React.JSX.Element {
  return <TranslatedBody text={text} streaming={status?.type === 'running'} />
}

export function ReasoningText({ text, status }: ReasoningMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const reduce = useReducedMotion()
  const active = status?.type === 'running'
  const [open, setOpen] = useState(active)
  const [prevActive, setPrevActive] = useState(active)
  // Adjust-on-prop-change (react.dev): active → expand; thinking done → collapse.
  if (prevActive !== active) {
    setPrevActive(active)
    setOpen(active)
  }
  const shown = open || active
  // GSAP 平滑折叠（用户反馈：思考/工具折叠张开/收起要动效，取代瞬时 hidden/block）。height auto↔0 +
  // opacity，§8 standard ease + base 时长；首挂载不播（gsap.set 直达终态），reduce 立即切。展开时设回
  // auto 让流式思考文本继续自然增高。
  const bodyRef = useRef<HTMLDivElement>(null)
  const didInitRef = useRef(false)
  useGSAP(
    () => {
      const el = bodyRef.current
      if (!el) return
      if (!didInitRef.current) {
        didInitRef.current = true
        gsap.set(el, { height: shown ? 'auto' : 0, opacity: shown ? 1 : 0 })
        return
      }
      if (reduce) {
        gsap.set(el, { height: shown ? 'auto' : 0, opacity: shown ? 1 : 0 })
        return
      }
      gsap.to(el, { height: shown ? 'auto' : 0, opacity: shown ? 1 : 0, duration: DUR.base })
    },
    { dependencies: [shown, reduce] }
  )
  // dogfood round-4 — render reasoning as a VISUALLY DISTINCT collapsible block (rounded card + hairline
  // border + tinted header), not a bare chevron+pre that reads as inline prose. The user saw the thinking
  // text but "没有进单独的折叠 reasoning 块" — the collapse logic was right, the block affordance was missing.
  return (
    <div className="my-1.5 min-w-0 overflow-hidden rounded-lg border border-[var(--hairline)] bg-ink-2">
      <button
        type="button"
        onClick={() => {
          if (!active) setOpen((o) => !o)
        }}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors duration-fast hover:bg-ink-3"
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
          <span className="text-aux text-ink-fg-2">{t('chat.thinking.label')}</span>
        )}
      </button>
      <div ref={bodyRef} className="overflow-hidden" aria-hidden={!shown}>
        <pre className="scrollbar-thin whitespace-pre-wrap break-words border-t border-[var(--hairline)] px-2.5 py-2 font-sans text-aux leading-relaxed text-ink-fg-1">
          {text}
          {active && <span className="think-caret" aria-hidden="true" />}
        </pre>
      </div>
    </div>
  )
}
