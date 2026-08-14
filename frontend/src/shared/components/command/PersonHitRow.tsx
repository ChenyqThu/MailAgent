// ⌘K「人」组的一行（通讯录 WP4，镜像 MatterHitRow 的形状）：Monogram 22 +
// 姓名（命中词高亮）+ org / primary_email 副文案。激活 = 关面板 →
// useContactNavigation.open(id) → navigate('/contacts')（接线在 CommandPalette）。

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'

import type { ContactRowDto } from '@shared/api/types/contact'
import { Monogram } from '@shared/components/contacts/Monogram'
import { cn } from '@shared/lib/cn'
import { highlightTerms } from '@shared/lib/highlight_terms'

const HIGHLIGHT_PURIFY: DOMPurifyConfig = { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] }

interface PersonHitRowProps {
  contact: ContactRowDto
  flatIdx: number
  selected: boolean
  setHighlight(idx: number): void
  queryTerms: ReadonlyArray<string>
  onActivate(): void
}

export function PersonHitRow({
  contact,
  flatIdx,
  selected,
  setHighlight,
  queryTerms,
  onActivate
}: PersonHitRowProps): React.ReactElement {
  const { t } = useTranslation()
  const name = contact.display_name || contact.name_en || contact.primary_email || '?'
  const nameHtml = useMemo(
    () => DOMPurify.sanitize(highlightTerms(name, queryTerms), HIGHLIGHT_PURIFY),
    [name, queryTerms]
  )
  // 副文案 = 组织 · 主邮箱（有啥给啥；姓名兜底用过 primary_email 时不再重复画）。
  const subParts: string[] = []
  if (contact.organization) subParts.push(contact.organization)
  if (contact.primary_email && contact.primary_email !== name) {
    subParts.push(contact.primary_email)
  }

  return (
    <li
      role="option"
      id={`palette-opt-${flatIdx}`}
      data-flat-idx={flatIdx}
      aria-selected={selected}
      onMouseEnter={() => setHighlight(flatIdx)}
      onClick={onActivate}
      className={cn('pal-row', selected && 'is-selected')}
    >
      <Monogram
        displayName={contact.display_name}
        primaryEmail={contact.primary_email}
        kind={contact.kind}
        size={22}
        className="shrink-0"
      />
      <div className="min-w-0 flex-1">
        <span
          className="block min-w-0 truncate text-body font-medium text-ink-fg [&_mark]:rounded [&_mark]:bg-coral/25 [&_mark]:px-0.5 [&_mark]:text-ink-fg"
          dangerouslySetInnerHTML={{ __html: nameHtml || name }}
        />
        {subParts.length > 0 ? (
          <span className="mt-0.5 block min-w-0 truncate text-meta text-ink-fg-2">
            {subParts.join(' · ')}
          </span>
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
