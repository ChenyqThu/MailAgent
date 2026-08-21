// Sprint 6 §2.2 — shared content wrapper for the secondary routes (/admin ·
// /llm · /calendar · /settings · /sessions · /agents · /matters · /contacts).
//
// task 08-20-perf-shell-prefetch-sidebar §② — TitleBar/Sidebar/StatusBar 已提升为
// RootLayout 的 AppShell 单例, 本组件退化为内容容器: <main> (自管滚动, dashboards
// 纵向增长不 flex 兄弟) + 可选 rightDock, 两者都是 AppShell 中间 flex 行的直接
// flex item。保留组件本身 (9 个路由 Layout 消费 ariaLabel / mainClassName /
// rightDock 语义), 只是不再渲染壳。

import { cn } from '@shared/lib/cn'

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
  /** 0812 dogfood — <main> 右侧的行内槽位, 目前只有 AI chat dock 用它 (MattersLayout).
   *  必须是 <main> 的**兄弟**而非子节点: dock 的 sidebar 模式靠这个 flex 位置吃宽度 /
   *  挤压正文 (见 AssistantChatDock 头注释). 不传 = 该路由没有 dock, 字节级同现状. */
  rightDock?: React.ReactNode
}

const DEFAULT_MAIN = 'flex-1 overflow-y-auto min-w-0 scrollbar-thin'

export function PageFrame({
  children,
  ariaLabel,
  mainClassName,
  rightDock
}: PageFrameProps): React.ReactElement {
  return (
    // <main> 与 rightDock 是 AppShell 中间 flex 行的直接 flex item —— dock 的
    // sidebar 模式靠这个兄弟位吃宽度 / 挤压正文 (见 AssistantChatDock 头注释)。
    <>
      <main aria-label={ariaLabel} className={cn(mainClassName ?? DEFAULT_MAIN)}>
        {children}
      </main>
      {rightDock}
    </>
  )
}
