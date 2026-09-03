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
import { CollapsibleRegion } from '@shared/components/ui/collapsible'
import { ShimmerText } from '@shared/components/ShimmerText'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'
import { formatToolDuration, useToolElapsed } from '@shared/assistant/tools/generic/useToolElapsed'
import { assistantMarkdownUrlTransform } from '@shared/assistant/tools/image/imageGenCard.lib'

export function MarkdownText({ text, status }: TextMessagePartProps): React.JSX.Element {
  return (
    <TranslatedBody
      text={text}
      streaming={status?.type === 'running'}
      urlTransform={assistantMarkdownUrlTransform}
    />
  )
}

export function ReasoningText({ text, status }: ReasoningMessagePartProps): React.JSX.Element {
  const { t } = useTranslation()
  const active = status?.type === 'running'
  // W3-① 折叠头耗时 —— 复用工具卡那口渲染器时钟（useToolElapsed）的三条契约，其中第一条最要紧：
  // 🔴 历史回放的 reasoning part 第一眼就是 settled，start 从未落过 → 返回 null → 折叠头保持静态
  // 「思考过程」，绝不显示编造的「思考了 0.0 秒」。运行中仍是 shimmer 的「思考中…」。
  const elapsed = useToolElapsed(active)
  const [open, setOpen] = useState(active)
  const [prevActive, setPrevActive] = useState(active)
  // Adjust-on-prop-change (react.dev): active → expand; thinking done → collapse.
  if (prevActive !== active) {
    setPrevActive(active)
    setOpen(active)
  }
  const shown = open || active
  // 平滑折叠（用户反馈：思考/工具折叠张开/收起要动效，取代瞬时 hidden/block）走全仓统一原语
  // CollapsibleRegion —— grid-rows 0fr↔1fr 纯 CSS 高度过渡 + opacity，§8 standard 曲线 + base
  // 时长，reduced-motion 由它自带的 motion-reduce: 立即切。DESIGN §4.1「能 grid-rows 解决不上
  // GSAP」：无需测量高度/首挂载抑制，1fr 让流式思考文本继续自然增高，另白得 inert（折叠态子树
  // 退出 tab 序）。
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
          <span className="text-aux text-ink-fg-2">
            {elapsed === null
              ? t('chat.thinking.label')
              : t('chat.thinking.duration', { duration: formatToolDuration(elapsed) })}
          </span>
        )}
      </button>
      <CollapsibleRegion expanded={shown}>
        <pre className="scrollbar-thin whitespace-pre-wrap break-words border-t border-[var(--hairline)] px-2.5 py-2 font-sans text-aux leading-relaxed text-ink-fg-1">
          {text}
          {active && <span className="think-caret" aria-hidden="true" />}
        </pre>
      </CollapsibleRegion>
    </div>
  )
}
