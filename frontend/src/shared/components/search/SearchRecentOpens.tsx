// /search 空态的「最近打开」小节（原型 .ssech + .rrow），从 SearchTabPage 拆出。
//
// 数据 = 标签工作区自己的（开着的标签按 lastActiveAt 序 + 最近关闭栈，零新增持久化）；
// 搜索标签自身与空标题条目不进列表。点行 = 开/激活对象标签（openTab 去重），路由由
// useTabRouteSync 的 store→route 腿跟上 —— 搜索标签保留在原位（原型 recents pick 语义）。

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Briefcase, Mail, MessagesSquare } from 'lucide-react'

import { useTabWorkspace, type DomainTabKind, type TabKind } from '@shared/state/tab-workspace'
import { openObjectTab } from '@shared/state/tab-workspace-bridge'

const RECENTS_LIMIT = 6

/** 行的图标与右侧类别字，按种类查表。写成 `satisfies Record<DomainTabKind, …>` 而不是
 *  两臂三元：再加一种对象标签时这里缺键当场红（09-02 加 `chat` 前是三元式的，新种类
 *  会被静默画成事项图标 + 写着「事项」）。chat 复用域名（AI Chat），不另起一套说法。 */
const KIND_ICON = {
  email: Mail,
  matter: Briefcase,
  chat: MessagesSquare
} as const satisfies Record<DomainTabKind, typeof Mail>

const KIND_META_KEY = {
  email: 'searchTab.metaEmail',
  matter: 'searchTab.metaMatter',
  chat: 'nav.domain.chats'
} as const satisfies Record<DomainTabKind, string>

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
        {recents.map((entry) => {
          const Icon = KIND_ICON[entry.kind]
          return (
            <div
              key={`${entry.kind}:${entry.targetId}`}
              className="flex h-[42px] cursor-pointer items-center gap-3 rounded-[9px] px-3 hover:bg-ink-fg/[0.05]"
              onClick={() => openRecent(entry)}
            >
              <span className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-lg bg-ink-fg/[0.06] text-ink-fg-2">
                <Icon size={14} strokeWidth={1.8} aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate text-body text-ink-fg">{entry.title}</span>
              <span className="shrink-0 font-mono text-meta text-ink-fg-3">
                {t(KIND_META_KEY[entry.kind])}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
