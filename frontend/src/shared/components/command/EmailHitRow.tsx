// ─── EmailHitRow — extracted because the JSX is dense + heavy ────────
//
// Shared search-result row for the ⌘K command palette EMAIL group. Extracted
// from CommandPalette.tsx so the agentic search flow can reuse the exact same
// row rendering. Pure move — no behaviour change.

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'
import { BriefcaseBusiness, Mail, Paperclip, Plus } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { highlightTerms } from '@shared/lib/highlight_terms'
import { parseSender } from '@shared/lib/mail_parse'
import { formatRelativeTime } from '@shared/format'
import type { AIPriority, SearchHit } from '@shared/api/types'
import type { MatterResourceLinkHit } from '@shared/api/types/matter'
import { MatterLinkPopover } from '@shared/components/matters/MatterLinkPopover'

// DOMPurify Config uses mutable arrays — keep the literals plain so the
// types match without an `as const` cast (which would mark them readonly).
const SNIPPET_PURIFY: DOMPurifyConfig = { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] }

const PRIORITY_LABEL: Record<AIPriority, string> = {
  critical: 'CRITICAL',
  urgent: 'URGENT',
  important: 'IMPORTANT',
  normal: 'NORMAL',
  low: 'LOW'
}
const PRIORITY_CLASS: Record<AIPriority, string> = {
  critical: 'text-crit bg-crit/15 border-crit/30',
  urgent: 'text-urg bg-urg/15 border-urg/30',
  important: 'text-impt bg-impt/15 border-impt/30',
  normal: 'text-norm bg-norm/15 border-norm/30',
  low: 'text-low bg-low/15 border-low/30'
}

function shortTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return formatRelativeTime(iso)
  } catch {
    return ''
  }
}

export interface EmailHitRowProps {
  hit: SearchHit
  flatIdx: number
  selected: boolean
  setHighlight(idx: number): void
  queryTerms: ReadonlyArray<string>
  onActivate(): void
  matterLinks?: MatterResourceLinkHit[]
}

export function EmailHitRow({
  hit,
  flatIdx,
  selected,
  setHighlight,
  queryTerms,
  onActivate,
  matterLinks
}: EmailHitRowProps): React.ReactElement {
  const { t } = useTranslation()
  const [matterPopoverOpen, setMatterPopoverOpen] = useState(false)
  const parsed = parseSender(hit.sender)
  const senderName = parsed.name || parsed.email.split('@')[0] || hit.sender
  const senderAddr = parsed.email
  const time = shortTime(hit.date_received)

  // Subject + snippet — both wrapped via DOMPurify before injecting because
  // user content reaches the DOM. highlightTerms entity-encodes everything
  // else; backend snippet() inserts literal <mark> only.
  const subjectHtml = useMemo(
    () => DOMPurify.sanitize(highlightTerms(hit.subject, queryTerms), SNIPPET_PURIFY),
    [hit.subject, queryTerms]
  )
  const snippetHtml = useMemo(
    () => (hit.snippet ? DOMPurify.sanitize(hit.snippet, SNIPPET_PURIFY) : ''),
    [hit.snippet]
  )

  return (
    <li
      role="option"
      id={`palette-opt-${flatIdx}`}
      data-flat-idx={flatIdx}
      aria-selected={selected}
      onMouseEnter={() => setHighlight(flatIdx)}
      onClick={onActivate}
      className={cn('pal-row', matterLinks !== undefined && 'group relative', selected && 'is-selected')}
    >
      <span className="w-5 h-5 grid place-items-center text-ink-fg-2 shrink-0">
        <Mail size={14} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-aux text-ink-fg font-medium truncate">
            {senderName}
            {senderAddr && (
              <>
                <span className="text-ink-fg-3"> · </span>
                <span className="text-ink-fg-2">{senderAddr}</span>
              </>
            )}
          </span>
          {hit.lang === 'en' && (
            <span className="lang-pip shrink-0" aria-label="English">
              EN
            </span>
          )}
          {hit.ai_priority && (
            <span
              className={cn(
                // badge 收紧 — 与 Sidebar count pill 同档 (px-1 py-px text-[10px]
                // rounded-[3px]); 旧 px-1.5 py-0.5 text-micro 视觉偏大 (用户反馈)。
                'text-[10px] leading-none font-mono uppercase tracking-wide px-1 py-px rounded-[3px] border shrink-0',
                PRIORITY_CLASS[hit.ai_priority]
              )}
            >
              {PRIORITY_LABEL[hit.ai_priority]}
            </span>
          )}
          {time && (
            <span className="text-meta font-mono text-ink-fg-2 shrink-0 tabular-nums">{time}</span>
          )}
        </div>
        <div
          className="text-body text-ink-fg mt-0.5 truncate [&_mark]:bg-coral/25 [&_mark]:text-ink-fg [&_mark]:rounded [&_mark]:px-0.5"
          dangerouslySetInnerHTML={{
            __html: subjectHtml || hit.subject || t('palette.email.untitled')
          }}
        />
        {hit.source === 'attachment' && (
          // 附件命中徽标 — snippet 此时来自附件正文 (P1b)。回形针图标 + 文件名,
          // 复刻 priority chip 的尺寸/圆角/边框, 用设计系统 token (禁 raw hex)。
          <span
            className="mt-1 inline-flex max-w-full items-center gap-1 rounded-[3px] border border-ink-border bg-ink-fg/[0.06] px-1 py-px text-[10px] leading-none text-ink-fg-2"
            title={hit.filename ?? undefined}
            aria-label={t('palette.email.fromAttachment', {
              filename: hit.filename || t('palette.email.unnamedAttachment'),
              defaultValue: '命中附件 {filename}'
            })}
          >
            <Paperclip size={10} strokeWidth={2} className="shrink-0" aria-hidden />
            <span className="truncate font-mono">
              {hit.filename || t('palette.email.unnamedAttachment')}
            </span>
          </span>
        )}
        {snippetHtml && (
          <div
            className="text-meta text-ink-fg-2 mt-1 line-clamp-2 [&_mark]:bg-coral/15 [&_mark]:text-ink-fg-1 [&_mark]:rounded [&_mark]:px-0.5"
            dangerouslySetInnerHTML={{ __html: snippetHtml }}
          />
        )}
      </div>
      {matterLinks !== undefined ? (
        <div
          className="relative flex shrink-0 items-center gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {matterLinks.length > 0 ? (
            <>
              {matterLinks.slice(0, 2).map((matter) => (
                <span
                  key={matter.public_id}
                  title={matter.title}
                  className="inline-flex max-w-24 items-center gap-1 rounded-[var(--r-pill)] border border-info/25 bg-info/10 px-1.5 py-0.5 font-mono text-[10px] text-info"
                >
                  <BriefcaseBusiness size={9} strokeWidth={2} className="shrink-0" aria-hidden />
                  <span className="truncate">{matter.public_id}</span>
                </span>
              ))}
              {matterLinks.length > 2 ? (
                <span className="font-mono text-[10px] text-ink-fg-3">+{matterLinks.length - 2}</span>
              ) : null}
            </>
          ) : (
            <button
              type="button"
              onClick={() => setMatterPopoverOpen(true)}
              className={cn(
                'inline-flex items-center gap-1 rounded-[var(--r-ctl)] px-1.5 py-1 text-[10px] text-ink-fg-2 transition hover:bg-ink-fg/[0.08] hover:text-ink-fg',
                selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
            >
              <Plus size={10} strokeWidth={2} aria-hidden />
              {t('palette.matters.add')}
            </button>
          )}
          <MatterLinkPopover
            open={matterPopoverOpen}
            source={{
              internalId: hit.internal_id,
              threadId: null,
              subject: hit.subject,
              sender: hit.sender,
              receivedAt: hit.date_received ?? null,
              threadCount: 1
            }}
            onClose={() => setMatterPopoverOpen(false)}
          />
        </div>
      ) : null}
      <span className="pal-hint items-center gap-1.5 text-micro font-mono text-ink-fg-2 shrink-0">
        <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
          ⏎
        </kbd>
        <span>{t('palette.kbd.open')}</span>
        <span className="text-ink-fg-3">·</span>
        <kbd className="text-micro font-mono px-1 py-px rounded bg-ink-fg/[0.06] border border-ink-border text-ink-fg-1 leading-none">
          ⌘⏎
        </kbd>
        <span>{t('palette.kbd.newWindow')}</span>
      </span>
    </li>
  )
}
