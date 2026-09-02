// L4 群聊 UX 批 — 单条气泡：正文（纯文本快路径 / TranslatedBody markdown）+ @ chip + hover meta chip。
//
// 🔴 DOM 契约（GroupChat.test.tsx V1 的选择器，design §2.6「组件不变式」(c)）：
//   • 本组件的根就是气泡 div —— 它必须是所在列里名字元素的**下一个兄弟**；
//   • 纯文本正文是气泡 div 的**直接文本子节点**（getByText 命中气泡本身）；
//   • hover meta chip 是气泡的子元素：绝对定位、常驻 DOM、只切 opacity，不进 getNodeText、
//     不占布局（红线 5：hover 不重排）。
// 正文两路：isPlainText → 直接文本 + whitespace-pre-wrap（也省一次 Streamdown 解析）；否则
// <TranslatedBody>（单聊同款）。owner 消息恒走纯文本路（无 markdown 渲染需求），恒套 @ chip；
// 成员回复只在纯文本行套 chip，markdown 交给 Streamdown（避免与解析冲突，design R3）。

import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@shared/lib/cn'
import { TranslatedBody } from '@shared/components/email/TranslatedBody'

import type { GroupMentionMember } from '../../../../ai-gateway/groupChat'
import type { GroupTurnUsage } from '../../../../ai-gateway/groupTurnEvent'
import { colorOfMember, isPlainText, mentionSegments } from './groupPresentation'

export interface GroupBubbleProps {
  text: string
  streaming: boolean
  variant: 'member' | 'user'
  /** 在写者名字：无正文时壳内显示「X 正在输入…」。 */
  typingName?: string
  members: readonly GroupMentionMember[]
  memberIds: readonly string[]
  /** assistant 气泡的 hover meta（model / tokens / cost）；null = 不画 chip。 */
  usage: GroupTurnUsage | null
  /** 绝对时间（hover）。 */
  title?: string
  className?: string
}

/** `rgb(var(--c-x))` → 同色 12% 底。 */
function tintOf(color: string): string {
  return color.replace(/\)$/, ' / 0.12)')
}

function shortModel(model: string): string {
  const idx = Math.max(model.lastIndexOf(':'), model.lastIndexOf('/'))
  return idx >= 0 ? model.slice(idx + 1) : model
}

function metaChipText(usage: GroupTurnUsage): string | null {
  const parts: string[] = []
  if (usage.model != null && usage.model.length > 0) parts.push(shortModel(usage.model))
  if (usage.tokensInput != null || usage.tokensOutput != null) {
    parts.push(`${usage.tokensInput ?? 0}/${usage.tokensOutput ?? 0} tok`)
    parts.push(usage.costUsd != null ? `$${usage.costUsd.toFixed(4)}` : '—')
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

export const GroupBubble = memo(function GroupBubble({
  text,
  streaming,
  variant,
  typingName,
  members,
  memberIds,
  usage,
  title,
  className
}: GroupBubbleProps): React.ReactElement {
  const { t } = useTranslation()
  const plain = variant === 'user' || isPlainText(text)
  const segments = useMemo(
    () => (plain && text.length > 0 ? mentionSegments(text, members) : null),
    [plain, text, members]
  )
  const chip = variant === 'member' && usage != null ? metaChipText(usage) : null

  let body: React.ReactNode
  if (text.length === 0) {
    body =
      streaming && typingName != null ? (
        <span className="text-ink-fg-3">{t('groupChat.typing', { name: typingName })}</span>
      ) : null
  } else if (segments != null) {
    body =
      segments.length === 1 && segments[0].kind === 'text'
        ? text
        : segments.map((seg, i) => {
            if (seg.kind === 'text') return seg.text
            const color =
              seg.kind === 'all' ? 'rgb(var(--c-accent))' : colorOfMember(memberIds, seg.agentId)
            return (
              <span
                key={i}
                data-mention={seg.kind === 'all' ? 'all' : seg.agentId}
                className="rounded-[var(--r-ctl)] px-1 py-px"
                style={{ color, backgroundColor: tintOf(color) }}
              >
                {seg.text}
              </span>
            )
          })
  } else {
    body = <TranslatedBody text={text} streaming={streaming} />
  }

  return (
    <div
      title={title}
      className={cn(
        'group/bubble relative px-3 py-2 text-body leading-relaxed text-ink-fg',
        plain && 'whitespace-pre-wrap',
        variant === 'member'
          ? 'rounded-[4px_12px_12px_12px] bg-ink-3'
          : 'max-w-full rounded-[12px_4px_12px_12px] [background-image:var(--sel-wash)]',
        className
      )}
    >
      {body}
      {streaming && text.length > 0 && plain && (
        <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse rounded-sm bg-ink-fg-3 align-middle" />
      )}
      {chip != null && (
        <span
          aria-hidden
          className="glass-pop pointer-events-none absolute -top-2.5 right-2 whitespace-nowrap rounded-[var(--r-ctl)] px-1.5 py-px font-mono text-micro text-ink-fg-3 opacity-0 transition-opacity duration-fast group-hover/bubble:opacity-100"
        >
          {chip}
        </span>
      )}
    </div>
  )
})
