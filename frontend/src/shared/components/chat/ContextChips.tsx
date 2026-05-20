// Sprint 4 §6 — context chips header. Shows what's loaded into the current
// turn's prompt so the user has a one-glance answer to "what did the AI see?".
//
// Sprint 13 user-feedback rewrite — mockup-inbox.html L2323-2331 keeps every
// chip at `text-meta font-mono` (12px) regardless of locale, including the
// Chinese-bearing ones ("邮件全文" / "Notion · 2 项目"). DESIGN.md §14 #2's
// 14px CJK floor would normally upgrade these to text-aux, but the mockup is
// explicit that this chip strip is the **section-header floor** (English-mono
// "Ctx" caption + CJK content rendered in a tight 12px row to keep visual
// density tight). Sprint 12 added a CJK-mono swap that scaled chip content to
// text-aux — that's what the user flagged as "ctx 样式也没遵循". Removed.

import { useTranslation } from 'react-i18next'
import { cn } from '@shared/lib/cn'

interface Props {
  hasEmailBody: boolean
  aiFieldsCount: number
  threadCount: number
  /** Sprint 4 V1: chat panel doesn't yet have a notion-agent project resolver,
   *  so callers pass 0 and the chip is hidden. V1.5 plumbs the real count. */
  notionProjectCount?: number
}

export function ContextChips({
  hasEmailBody,
  aiFieldsCount,
  threadCount,
  notionProjectCount = 0
}: Props): React.ReactElement {
  const { t } = useTranslation()

  interface Chip {
    key: string
    label: string
    active: boolean
    tone?: 'default' | 'ok'
  }

  const chips: Chip[] = [
    { key: 'email', label: t('chat.context.emailBody'), active: hasEmailBody },
    {
      key: 'ai',
      label: t('chat.context.aiFields', { n: aiFieldsCount }),
      active: aiFieldsCount > 0
    },
    {
      key: 'thread',
      label: t('chat.context.thread', { n: threadCount }),
      active: threadCount > 0
    },
    {
      key: 'notion',
      label: `Notion · ${notionProjectCount} 项目`,
      active: notionProjectCount > 0,
      tone: 'ok'
    }
  ]

  return (
    // mockup L2324: `px-3 py-2 border-b border-ink-border-soft flex
    // items-center gap-1.5 flex-wrap text-meta`. text-meta on the wrapper
    // sets the size for the inner chips at the same time as the "Ctx" label.
    <div
      className={cn(
        'px-3 py-2 flex items-center gap-1.5 flex-wrap text-meta',
        'border-b border-ink-border-soft'
      )}
    >
      {/* Ctx caption — English mono per DESIGN.md §3.3 section-header rule */}
      <span className="font-mono uppercase tracking-wider text-ink-fg-2 mr-0.5">Ctx</span>

      {chips.every((c) => !c.active) ? (
        <span className="font-mono text-ink-fg-3">{t('chat.context.noContext')}</span>
      ) : (
        chips
          .filter((c) => c.active)
          .map((c) =>
            c.tone === 'ok' ? (
              // Notion chip — green-tinted to call out "the AI can read your
              // Notion workspace". mockup L2330.
              <span
                key={c.key}
                className="font-mono px-1.5 py-0.5 rounded text-ok bg-ok/10 border border-ok/25"
              >
                {c.label}
              </span>
            ) : (
              // Default chip — ink-3 surface, soft border (mockup L2327-2329).
              <span
                key={c.key}
                className="font-mono px-1.5 py-0.5 rounded text-ink-fg-1 bg-ink-3 border border-ink-border-soft"
              >
                {c.label}
              </span>
            )
          )
      )}
    </div>
  )
}
