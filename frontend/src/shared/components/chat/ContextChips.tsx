// Sprint 4 §6 — context chips header. Shows what's loaded into the current
// turn's prompt so the user has a one-glance answer to "what did the AI
// see?". Click to expand / toggle each scope (V1 just shows; toggle UI
// lands in V1.5 once we have per-scope `included: boolean` plumbing).
//
// V1 redesign (Sprint 10 polish): mirrors mockup-inbox.html lines 1144-1150.
// `Ctx` section label is an English mono caption — never CJK — so the
// chip area itself can adopt a tighter mono visual rhythm. Chip *content*
// can be CJK ("邮件全文" / "线程") so chips themselves run at text-aux
// (14px) to clear DESIGN.md §14 #2.

import { useTranslation } from 'react-i18next'
import { cn } from '@shared/lib/cn'
import { useCjkMonoSwap } from '@shared/i18n/cjk-mono'

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
  // chip labels can resolve to "邮件全文" / "线程 ×N" — CJK content must sit at
  // ≥14px (text-aux) per DESIGN.md §1.3 / §14 #2. Mono is fine for ASCII tail.
  const chipKlass = useCjkMonoSwap('text-meta font-mono')
  const noneKlass = useCjkMonoSwap('text-meta font-mono')

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
      // Mockup-style label: "Notion · N 项目" — English head + CJK tail
      label: `Notion · ${notionProjectCount} 项目`,
      active: notionProjectCount > 0,
      tone: 'ok'
    }
  ]

  return (
    <div
      className={cn(
        'px-3 py-2 flex items-center gap-1.5 flex-wrap',
        'border-b border-ink-border-soft'
      )}
    >
      {/* Section label — English mono caption (never goes through CJK swap) */}
      <span
        className={cn(
          'text-meta font-mono uppercase tracking-wider text-ink-fg-2 mr-0.5'
        )}
      >
        Ctx
      </span>

      {chips.every((c) => !c.active) ? (
        <span className={cn(noneKlass, 'text-ink-fg-3')}>{t('chat.context.noContext')}</span>
      ) : (
        chips
          .filter((c) => c.active)
          .map((c) =>
            c.tone === 'ok' ? (
              <span
                key={c.key}
                className={cn(
                  chipKlass,
                  'px-1.5 py-0.5 rounded',
                  'text-ok bg-ok/10 border border-ok/25'
                )}
              >
                {c.label}
              </span>
            ) : (
              <span
                key={c.key}
                className={cn(
                  chipKlass,
                  'px-1.5 py-0.5 rounded',
                  'text-ink-fg-1 bg-ink-3 border border-ink-border-soft'
                )}
              >
                {c.label}
              </span>
            )
          )
      )}
    </div>
  )
}
