import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'
import { BriefcaseBusiness } from 'lucide-react'

import type { Matter } from '@shared/api/types/matter'
import { cn } from '@shared/lib/cn'
import { highlightTerms } from '@shared/lib/highlight_terms'

import { getMatterMatchDetails } from './paletteMatters'

const HIGHLIGHT_PURIFY: DOMPurifyConfig = { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] }

interface MatterHitRowProps {
  matter: Matter
  flatIdx: number
  selected: boolean
  setHighlight(idx: number): void
  queryTerms: ReadonlyArray<string>
  onActivate(): void
}

export function MatterHitRow({
  matter,
  flatIdx,
  selected,
  setHighlight,
  queryTerms,
  onActivate
}: MatterHitRowProps): React.ReactElement {
  const { t } = useTranslation()
  const titleHtml = useMemo(
    () => DOMPurify.sanitize(highlightTerms(matter.title, queryTerms), HIGHLIGHT_PURIFY),
    [matter.title, queryTerms]
  )
  const { details, overflow } = getMatterMatchDetails(matter)

  return (
    <li
      role="option"
      id={`palette-opt-${flatIdx}`}
      data-flat-idx={flatIdx}
      aria-selected={selected}
      onMouseEnter={() => setHighlight(flatIdx)}
      onClick={onActivate}
      className={cn('pal-row items-start', selected && 'is-selected')}
    >
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-info">
        <BriefcaseBusiness size={14} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="min-w-0 truncate text-body font-medium text-ink-fg [&_mark]:rounded [&_mark]:bg-coral/25 [&_mark]:px-0.5 [&_mark]:text-ink-fg"
            dangerouslySetInnerHTML={{ __html: titleHtml || matter.title }}
          />
          <span className="shrink-0 font-mono text-[10px] text-ink-fg-3">{matter.public_id}</span>
          <span className="shrink-0 rounded-[var(--r-pill)] bg-ink-4 px-1.5 py-0.5 text-[10px] text-ink-fg-2">
            {t(`matters.status.${matter.status}`)}
          </span>
        </div>
        {details.length > 0 ? (
          <div className="mt-1.5 space-y-1">
            {details.map(({ field, labelKey, snippet }) => (
              <div key={field} className="flex min-w-0 items-start gap-1.5 text-meta text-ink-fg-2">
                <span className="shrink-0 rounded-[3px] border border-ink-border-soft bg-ink-fg/[0.04] px-1 py-px font-mono text-[10px] text-ink-fg-3">
                  {t(labelKey)}
                </span>
                <span className="line-clamp-1 min-w-0">{snippet}</span>
              </div>
            ))}
            {overflow > 0 ? (
              <div className="text-[10px] text-ink-fg-3">
                {t('palette.matters.moreMatches', { n: overflow })}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <span className="pal-hint shrink-0 items-center gap-1.5 font-mono text-micro text-ink-fg-2">
        <kbd className="rounded border border-ink-border bg-ink-fg/[0.06] px-1 py-px font-mono text-micro leading-none text-ink-fg-1">
          ⏎
        </kbd>
        <span>{t('palette.kbd.open')}</span>
      </span>
    </li>
  )
}
