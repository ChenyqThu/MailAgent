// /search 左列（宽读 `--app-second-w`，09-01 侧栏批起跟随邮件域的折叠 / 宽度记忆 ——
// Sidebar 在 /search 上同样回落 mail 域）—— palette 空查询态的召回面（最近搜索 +
// 已保存搜索），从 SearchTabPage 拆出（组件 300 行上限，spec css-design/quality）。
//
// 🔴 这一列不是装饰：/search 不属于任何 NavDomain（Sidebar 无 DomainPanel），没有它
// 左列边界会塌回导轨的 56（SearchTabPage 头注释）。数据 = useSearchHistory（与 ⌘K
// palette 同一份 localStorage 账本）；点行回放交给父级 onRunQuery（写 search-tab store）。

import { useTranslation } from 'react-i18next'
import { Bookmark, Clock, Trash2, X } from 'lucide-react'

import { cn } from '@shared/lib/cn'
import { useSearchHistory } from '@shared/state/search-history'

export interface SearchRecallColumnProps {
  onRunQuery(query: string): void
  /** 09-01 侧栏批：/search 不属于任何域，左列跟随邮件域的折叠记忆（Sidebar 同一回落）。 */
  hidden?: boolean
}

export function SearchRecallColumn({
  onRunQuery,
  hidden = false
}: SearchRecallColumnProps): React.ReactElement {
  const { t } = useTranslation()
  const history = useSearchHistory((s) => s.history)
  const savedSearches = useSearchHistory((s) => s.saved)
  const removeHistory = useSearchHistory((s) => s.removeHistory)
  const clearHistory = useSearchHistory((s) => s.clearHistory)
  const removeSaved = useSearchHistory((s) => s.removeSaved)

  return (
    <aside
      data-nav-second
      className={cn(
        // 宽读 `--app-second-w`（邮件域记忆，折叠 0）；过渡在 :root 变量上。
        'w-[var(--app-second-w,336px)] shrink-0 min-h-0 border-r border-ink-border overflow-x-hidden overflow-y-auto scrollbar-thin px-3 py-2',
        hidden && 'invisible border-r-0'
      )}
    >
      <div className="text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-3 px-1 pt-3 pb-1.5 flex items-center">
        <span>{t('searchTab.recentSearches')}</span>
        {history.length > 0 && (
          <button
            type="button"
            onClick={clearHistory}
            className="ml-auto text-micro text-ink-fg-3 hover:text-ink-fg transition normal-case tracking-normal"
          >
            {t('palette.history.clear')}
          </button>
        )}
      </div>
      {history.length === 0 ? (
        <div className="px-1 py-1 text-meta text-ink-fg-3">—</div>
      ) : (
        <div className="space-y-px">
          {history.map((h) => (
            <div
              key={`hist-${h}`}
              className="group flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-ink-fg-1 hover:bg-ink-fg/[0.05]"
              onClick={() => onRunQuery(h)}
            >
              <Clock size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
              <span className="min-w-0 flex-1 truncate text-aux">{h}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  removeHistory(h)
                }}
                title={t('palette.history.remove')}
                aria-label={t('palette.history.remove')}
                className="shrink-0 rounded p-0.5 text-ink-fg-3 opacity-0 transition hover:bg-ink-fg/[0.08] hover:text-ink-fg group-hover:opacity-100"
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      )}
      {savedSearches.length > 0 && (
        <>
          <div className="text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-3 px-1 pt-5 pb-1.5">
            {t('searchTab.savedSearches')}
          </div>
          <div className="space-y-px">
            {savedSearches.map((sv) => (
              <div
                key={`saved-${sv.id}`}
                className="group flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 text-ink-fg-1 hover:bg-ink-fg/[0.05]"
                onClick={() => onRunQuery(sv.query)}
              >
                <Bookmark size={13} strokeWidth={1.75} className="shrink-0 text-ink-fg-3" />
                <span className="min-w-0 flex-1 truncate text-aux">{sv.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeSaved(sv.id)
                  }}
                  title={t('palette.saved.remove')}
                  aria-label={t('palette.saved.remove')}
                  className="shrink-0 rounded p-0.5 text-ink-fg-3 opacity-0 transition hover:bg-ink-fg/[0.08] hover:text-ink-fg group-hover:opacity-100"
                >
                  <Trash2 size={12} strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
