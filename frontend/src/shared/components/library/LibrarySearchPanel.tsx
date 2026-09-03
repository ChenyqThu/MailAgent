// 资料库页内的全库搜索（design §9.1；mockup B3 / E1）：页头一个宽输入框 + 结果面。
//
// 与文件夹工具条上那个窄的「在当前文件夹中过滤」是**两件事，刻意不合成一个框**：
// 过滤是当前这一个文件夹的行筛选（服务端 `q`，不跨文件夹、无相关度）；这里是走
// `GET /library/search` 的全库检索（FTS 双表 + 语义腿 RRF 混合），结果带路径 / snippet / lane。
//
// 三条服务端语义决定了这一面的形态，改之前先读它们：
//   ① 🔴 **中文 1 字 = 出提示、不出结果**：`warnings` 带 `cjk_too_short:<字>` 且零命中。
//      渲染成「没有匹配的文件」就是把「这次根本没查」说成「查了没有」——只有 warnings 为空
//      的零命中才是真的没有。
//   ② 🔴 snippet 的命中标记是**字面 `[` / `]`**（`src/library/repository.py::search` 的
//      `snippet(…, '[', ']', …)`），不是 `<mark>` ⇒ 走 `parseLibrarySnippet` 切段、按 React
//      节点渲染，**正文一个字符都不进 innerHTML**（与 ⌘K 那条 lane 同一份切法）。
//   ③ 语义腿在不在**不进 `warnings`**（服务端有意为之：能力缺席是常态，塞进去 UI 只能整条
//      忽略）⇒「当前只按关键词匹配」这句必须由这里按 `semantic.available` 自己渲。
//
// 文案与 placeholder **不许暗示有字段语法**：资料库检索是纯关键词，抄邮件的 `from:` 说明会
// 让模型 / 用户往里塞字段，被当字面文本召回归零且没有任何 warning。

import { useMemo, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'

import type { LibrarySearchHit } from '@shared/api/types/library'
import { LibrarySearchWarnings } from '@shared/components/command/LibraryHitRow'
import {
  libraryAddressableHits,
  parseLibrarySnippet
} from '@shared/components/command/paletteLibrary'
import { Skeleton } from '@shared/components/feedback/LoadingSkeleton'
import { formatFileSize } from '@shared/format'
import { cn } from '@shared/lib/cn'
import { errorMessage } from '@shared/lib/ipcErrors'
import type { LibrarySearchLane } from '@shared/libraryConstants'

import { displayName, fileTimeLabel, libraryIconTone } from './fileMeta'
import { useLibrarySearchQuery } from './hooks'
import { Notice, Pill } from './parts'

/** lane 徽标的词表。🔴 与 `hit.match`（filename / text）是**两个独立词表**，别混用。 */
const LANE_LABEL_KEY: Record<LibrarySearchLane, string> = {
  fts: 'library.search.matchFts',
  vec: 'library.search.matchVec',
  both: 'library.search.matchBoth'
}

export function LibrarySearchBar({
  value,
  onChange
}: {
  value: string
  onChange(next: string): void
}): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="border-b border-ink-border-soft px-4 py-2">
      <label className="flex h-9 items-center gap-2 rounded-[var(--r-ctl)] border border-ink-border bg-ink-2 px-3 focus-within:border-coral/60">
        <Search size={14} strokeWidth={2} aria-hidden className="shrink-0 text-ink-fg-3" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          data-testid="library-search-input"
          placeholder={t('library.search.placeholder')}
          aria-label={t('library.folder.searchLibraryPlaceholder')}
          className="min-w-0 flex-1 bg-transparent text-body text-ink-fg outline-none placeholder:text-ink-fg-3"
        />
        {value !== '' ? (
          <button
            type="button"
            data-testid="library-search-clear"
            aria-label={t('library.search.clear')}
            onClick={() => onChange('')}
            className="grid size-5 shrink-0 place-items-center rounded text-ink-fg-3 hover:bg-ink-3 hover:text-ink-fg"
          >
            <X size={12} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </label>
    </div>
  )
}

function HitRow({
  hit,
  onSelect
}: {
  hit: LibrarySearchHit
  onSelect(): void
}): ReactElement {
  const { t } = useTranslation()
  const tone = libraryIconTone(hit)
  const Icon = tone.Icon
  // 切段一次，渲染时只映射节点 —— 正文不进 innerHTML（见文件头 ②）。
  const segments = useMemo(() => parseLibrarySnippet(hit.snippet), [hit.snippet])
  return (
    <button
      type="button"
      data-testid="library-search-row"
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 border-b border-ink-border-soft px-4 py-2 text-left transition-colors duration-fast hover:bg-ink-3/60"
    >
      <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded', tone.bg)}>
        <Icon size={12} strokeWidth={2} className={tone.text} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-aux text-ink-fg">{displayName(hit)}</span>
          <Pill tone={hit.lane === 'vec' ? 'ai' : hit.lane === 'both' ? 'accent' : 'info'}>
            {t(LANE_LABEL_KEY[hit.lane])}
          </Pill>
          <span className="ml-auto shrink-0 font-mono text-micro tabular-nums text-ink-fg-3">
            {fileTimeLabel(hit)}
            {hit.size_bytes != null ? ` · ${formatFileSize(hit.size_bytes)}` : ''}
          </span>
        </span>
        <span className="mt-0.5 block truncate font-mono text-micro text-ink-fg-3">{hit.path}</span>
        {segments.length > 0 ? (
          <span
            data-testid="library-search-snippet"
            className="mt-0.5 block line-clamp-2 text-meta leading-5 text-ink-fg-2"
          >
            {segments.map((segment, index) =>
              segment.hit ? (
                <mark key={index} className="rounded-[2px] bg-coral/25 px-0.5 text-ink-fg">
                  {segment.text}
                </mark>
              ) : (
                <span key={index}>{segment.text}</span>
              )
            )}
          </span>
        ) : null}
      </span>
    </button>
  )
}

export function LibrarySearchResults({
  query,
  onSelectFile
}: {
  query: string
  /** 命中恒有 library id（服务端不返投影行），调用方按 id 去打开。 */
  onSelectFile(hit: LibrarySearchHit & { id: number }): void
}): ReactElement {
  const { t } = useTranslation()
  // 恒发 `hybrid`：没下载语义模型时服务端自己退化成纯 FTS，形状不变（`search_mode` 会说实话）。
  const search = useLibrarySearchQuery(query, 'hybrid')

  if (search.isPending) {
    return <Skeleton rows={5} className="px-4 py-3" width="2/3" />
  }
  if (search.isError) {
    return (
      <div className="px-4 py-3">
        <Notice tone="fail">
          {t('library.folder.loadFailed')}
          <span className="ml-1.5 text-ink-fg-3">{errorMessage(search.error)}</span>
        </Notice>
      </div>
    )
  }

  const { hits, warnings, semantic } = search.data
  const addressable = libraryAddressableHits(hits)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      {semantic.available ? null : (
        <div className="border-b border-ink-border-soft px-4 py-1.5 text-meta text-ink-fg-2">
          {t('library.search.noSemantic')}
        </div>
      )}
      <LibrarySearchWarnings warnings={warnings} className="px-4 py-2" />
      {addressable.map((hit) => (
        <HitRow key={hit.id} hit={hit} onSelect={() => onSelectFile(hit)} />
      ))}
      {addressable.length === 0 && warnings.length === 0 ? (
        <div
          data-testid="library-search-empty"
          className="grid place-items-center gap-1 px-6 py-16 text-center"
        >
          <div className="text-aux text-ink-fg-1">{t('library.search.empty')}</div>
          <div className="text-meta text-ink-fg-3">{t('library.search.emptyHint')}</div>
        </div>
      ) : null}
    </div>
  )
}
