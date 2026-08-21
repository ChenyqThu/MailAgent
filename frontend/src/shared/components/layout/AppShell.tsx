// 应用外壳单例 (task 08-20-perf-shell-prefetch-sidebar §②)。
//
// TitleBar + Sidebar + StatusBar 由 RootLayout 渲染**一次**, <Outlet/> 只换中间
// 内容区。此前 InboxLayout / PageFrame 各渲染一份同样的壳 ⇒ 每次路由切换整个
// Sidebar 树 remount: 文件夹树 / mailboxes / settings / flags 等 query 反复
// mount/unmount, 滚动位置与展开态全丢 (lane-c P0-2)。单例化后这些 query 常驻
// active、永不被 GC, Sidebar 内 useEffect 注册的全局监听也恒为单份。
//
// children 渲染进中间 flex 行 —— 路由组件返回的顶层节点就是该行的**直接 flex
// item** (InboxLayout 的 master-detail 容器 / PageFrame 的 <main> + rightDock)。
// 🔴 这个兄弟位是 AssistantChatDock sidebar 模式挤压正文的前提 (dock 头注释),
// 别在 children 外再包一层 div。
//
// 外层 div 的 class 逐字沿用两个旧壳的公共结构: `flex flex-col h-full
// text-ink-fg` (只写 text 不写 bg —— 把 body::before 的 wallpaper 透出来,
// Sprint 18 review 的既有结论) + 中行 `flex flex-1 min-h-0`。

import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex flex-col h-full text-ink-fg">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        {children}
      </div>
      <StatusBar />
    </div>
  )
}
