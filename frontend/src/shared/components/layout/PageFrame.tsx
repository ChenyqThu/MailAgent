// Sprint 6 §2.2 — shared wrapper for the secondary routes (/admin · /llm
// · /calendar · /settings). Same chrome as InboxLayout / SearchLayout
// (TitleBar 36px + Sidebar 240px + StatusBar 24px) but the content slot
// owns its own scroll container so dashboards can grow vertically without
// flexing siblings.

import { cn } from '@shared/lib/cn'

import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'

interface PageFrameProps {
  children: React.ReactNode
  /** Optional accessible label for the <main> element. Falls back to the
   *  current route path; supplying it ensures VoiceOver reads the section
   *  name rather than a path. */
  ariaLabel?: string
  /** Sprint 18 review — override the default `flex-1 overflow-y-auto`
   *  on <main>. Settings needs the inner SettingsShell (rail + content)
   *  to own its own column-scoped scroll; piping `mainClassName="flex
   *  flex-col overflow-hidden"` 让 main 不创建外层滚动条,把高度链直接
   *  传给子节点. Other pages (admin / llm / calendar) 不传, 沿用默认. */
  mainClassName?: string
}

const DEFAULT_MAIN = 'flex-1 overflow-y-auto min-w-0 scrollbar-thin'

export function PageFrame({
  children,
  ariaLabel,
  mainClassName
}: PageFrameProps): React.ReactElement {
  return (
    // Sprint 18 review — 移除老 `bg-ink-0`. 旧 Sprint 6 代码在 PageFrame 顶层
    // 强制 opaque 背景, 把 body::before 的 wallpaper (--wallpaper aurora
    // gradient) 完全遮住, 导致主 Sidebar 的 `.glass` 半透 + backdrop-filter
    // 失去 wallpaper 这一层 source-of-truth → 看起来"没玻璃效果". 跟
    // InboxLayout 一致只写 `text-ink-fg`, 把 wallpaper 透出来.
    <div className="flex flex-col h-full text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <main aria-label={ariaLabel} className={cn(mainClassName ?? DEFAULT_MAIN)}>
          {children}
        </main>
      </div>
      <StatusBar />
    </div>
  )
}
