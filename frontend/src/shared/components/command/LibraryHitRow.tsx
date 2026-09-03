// 资料库命中行（P2-L7）—— ⌘K 第五 lane 与 `/search` 页组共用，形状照 MatterHitRow。
//
// 两处与既有命中行不同，都是被服务端形状逼出来的：
//   1. snippet 的命中标记是**字面 `[` / `]`**（`src/library/repository.py::search` 的
//      `snippet(…, '[', ']', …)`），不是 `<mark>` ⇒ 不走 dangerouslySetInnerHTML，
//      切成段按 React 节点渲染（正文一个字符都不进 innerHTML）。
//   2. `rank` 允许为 null —— 2 字 query 走 LIKE，没有 bm25，服务端按 mtime 排。行上
//      不显示相关度，所以这条对渲染是「什么都不用做」，写在这里免得下一个人去补一个
//      永远为 null 的字段。
//
// `hit.match`（'filename' | 'text'）不单独渲染徽标：两种来源已经分别由「文件名高亮」
// 与「snippet 高亮」表达出来了。i18n 里的 `library.search.match{Fts,Vec,Both}` 是 P3
// 混合检索（关键词 / 语义 / 两者）的词表，与 P2 的这两个值不是一回事。

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify'
import { AlertTriangle, FileText } from 'lucide-react'

import type { LibrarySearchHit } from '@shared/api/types/library'
import { cn } from '@shared/lib/cn'
import { highlightTerms } from '@shared/lib/highlight_terms'

import { libraryWarningLabelKey, parseLibrarySnippet } from './paletteLibrary'

const HIGHLIGHT_PURIFY: DOMPurifyConfig = { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] }

/** 「查了但没查成」的说明行。🔴 `warnings` 是数组，逐条渲染 —— 不 join、不取 `[0]`：
 *  服务端 P2 只发一种码，但形状是复数，UI 就按复数做（漏在这里 = 以后加码时静默吞掉）。
 *  中文 1 个字的 query 走的就是这条腿：**出提示，不出结果**。 */
export function LibrarySearchWarnings({
  warnings,
  className
}: {
  warnings: readonly string[]
  className?: string
}): React.ReactElement | null {
  const { t } = useTranslation()
  if (warnings.length === 0) return null
  return (
    <div className={cn('space-y-1', className)}>
      {warnings.map((code) => (
        <div key={code} className="flex items-start gap-1.5 text-micro text-ink-fg-2">
          <AlertTriangle
            size={12}
            strokeWidth={2}
            className="mt-px shrink-0 text-warn"
            aria-hidden
          />
          <span className="min-w-0 leading-snug">{t(libraryWarningLabelKey(code))}</span>
        </div>
      ))}
    </div>
  )
}

export interface LibraryHitRowProps {
  hit: LibrarySearchHit
  flatIdx: number
  selected: boolean
  setHighlight(idx: number): void
  queryTerms: ReadonlyArray<string>
  onActivate(): void
}

export function LibraryHitRow({
  hit,
  flatIdx,
  selected,
  setHighlight,
  queryTerms,
  onActivate
}: LibraryHitRowProps): React.ReactElement {
  const { t } = useTranslation()
  const filenameHtml = useMemo(
    () => DOMPurify.sanitize(highlightTerms(hit.filename, queryTerms), HIGHLIGHT_PURIFY),
    [hit.filename, queryTerms]
  )
  const segments = useMemo(() => parseLibrarySnippet(hit.snippet), [hit.snippet])

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
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-ink-fg-2">
        <FileText size={14} strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <span
          className="block min-w-0 truncate text-body font-medium text-ink-fg [&_mark]:rounded [&_mark]:bg-coral/25 [&_mark]:px-0.5 [&_mark]:text-ink-fg"
          dangerouslySetInnerHTML={{ __html: filenameHtml || hit.filename }}
        />
        {/* 虚拟路径（`<根 slug>/<相对路径>`）—— 同名文件在库里很常见，没有它没法分辨。 */}
        <div className="mt-0.5 truncate font-mono text-[10px] text-ink-fg-3">{hit.path}</div>
        {segments.length > 0 && (
          <div className="mt-1 line-clamp-2 text-meta text-ink-fg-2">
            {segments.map((segment, index) =>
              segment.hit ? (
                <mark key={index} className="rounded bg-coral/15 px-0.5 text-ink-fg-1">
                  {segment.text}
                </mark>
              ) : (
                <span key={index}>{segment.text}</span>
              )
            )}
          </div>
        )}
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
