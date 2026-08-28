// /search 空态的「最近打开」小节（原型 .ssech + .rrow），从 SearchTabPage 拆出。
//
// 数据 = 标签工作区自己的（开着的标签按 lastActiveAt 序 + 最近关闭栈，零新增持久化）；
// 搜索标签自身与空标题条目不进列表。点行 = 开/激活对象标签（openTab 去重），路由由
// useTabRouteSync 的 store→route 腿跟上 —— 搜索标签保留在原位（原型 recents pick 语义）。

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase, Mail } from 'lucide-react'

import { useTabWorkspace, type TabKind } from '@shared/state/tab-workspace'
import { openObjectTab } from '@shared/state/tab-workspace-bridge'

const RECENTS_LIMIT = 6

interface RecentEntry {
  readonly kind: Exclude<TabKind, 'search'>
  readonly targetId: number
  readonly title: string
}

export function SearchRecentOpens(): React.ReactElement | null {
  const { t } = useTranslation()
  const tabs = useTabWorkspace((s) => s.tabs)
  const closedStack = useTabWorkspace((s) => s.closedStack)

  const recents: RecentEntry[] = useMemo(() => {
    const out: RecentEntry[] = []
    const seen = new Set<string>()
    const push = (kind: TabKind, targetId: number, title: string): void => {
      if (kind === 'search' || title === '') return
      const key = `${kind}:${targetId}`
      if (seen.has(key)) return
      seen.add(key)
      out.push({ kind, targetId, title })
    }
    for (const tab of [...tabs].sort((a, b) => b.lastActiveAt - a.lastActiveAt)) {
      push(tab.kind, tab.targetId, tab.title)
    }
    // 栈末 = 最近关掉的，先进列表。
    for (let i = closedStack.length - 1; i >= 0; i--) {
      push(closedStack[i].kind, closedStack[i].targetId, closedStack[i].title)
    }
    return out.slice(0, RECENTS_LIMIT)
  }, [tabs, closedStack])

  const openRecent = useCallback((entry: RecentEntry): void => {
    openObjectTab(entry.kind, entry.targetId, entry.title)
  }, [])

  if (recents.length === 0) return null

  return (
    <>
      <div className="text-micro font-mono uppercase tracking-[0.08em] text-ink-fg-3 mx-1 mt-[30px] mb-1.5">
        {t('searchTab.recents')}
      </div>
      <div className="space-y-px">
        {recents.map((entry) => (
          <div
            key={`${entry.kind}:${entry.targetId}`}
            className="flex h-[42px] cursor-pointer items-center gap-3 rounded-[9px] px-3 hover:bg-ink-fg/[0.05]"
            onClick={() => openRecent(entry)}
          >
            <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-ink-fg/[0.06] text-ink-fg-2">
              {entry.kind === 'email' ? (
                <Mail size={14} strokeWidth={1.8} aria-hidden />
              ) : (
                <Briefcase size={14} strokeWidth={1.8} aria-hidden />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-body text-ink-fg">{entry.title}</span>
            <span className="shrink-0 font-mono text-meta text-ink-fg-3">
              {entry.kind === 'email' ? t('searchTab.metaEmail') : t('searchTab.metaMatter')}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
