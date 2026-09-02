// Inbox 内容区: EmailList + EmailDetail (master-detail) + AI dock。
//
// task 08-20-perf-shell-prefetch-sidebar §② — TitleBar/Sidebar/StatusBar 已提升为
// RootLayout 的 AppShell 单例, 本组件退化为内容区: 顶层节点直接是 AppShell 中间
// flex 行的 flex item (master-detail 容器 + AssistantChatDock 兄弟位)。
//
// task 08-27 P1 Lane B — 邮件域的二级栏**就是这一列列表**（registry `second: 'page'`,
// 同事项/通讯录）。
// task 09-01-sidebar-fluid-optimization — 列宽读 `--app-second-w`（邮件域自己的记忆：
// 默认 336、可拖 280–420、折叠 0），外壳 `.nav-second-col` 裁切、内层按记忆值定宽
// （过渡期间虚拟列表不重排）；折叠态整列 visibility hidden **不卸载**（EmailList 是
// 虚拟列表，卸载会丢滚动位置与已翻的页）。
//
// S3 W2 — the legacy right-rail AIChatPanel drawer (squeeze column + width
// tween + resize handle + drawer overlay) is deleted with the legacy runtime;
// the AI chat surface in the main window is the AssistantChatModal dock
// (floating / sidebar modes) + its FAB, mounted unconditionally below.

import { useEffect } from 'react'
import { useSearch } from '@tanstack/react-router'

import { cn } from '@shared/lib/cn'
import { useIsBelowLg } from '@shared/hooks/useMediaQuery'
import { useActiveEmail } from '@shared/state/active-email'
import { useEmailFilter } from '@shared/state/email-filter'
import { useDomainCollapsed, useDomainWidth } from '@shared/state/nav-shell'

import { EmailList } from '../email/EmailList'
import { EmailDetail } from '../email/EmailDetail'
import { AssistantChatDock } from '@shared/assistant/modal/AssistantChatDock'
import { ChatModalFab } from '@shared/assistant/modal/ChatModalFab'

export function InboxLayout(): React.ReactElement {
  const activeId = useActiveEmail((s) => s.activeInternalId)
  // RESPONSIVE-XCUT-01 — <lg(1024) 列表/详情单栏切换：选中邮件 → 详情 absolute
  // 覆盖列表；未选中 → 详情 hidden, 列表占满。≥lg 维持桌面三栏并排（零回归）。
  const belowLg = useIsBelowLg()
  // 邮件域二级栏的折叠态与记忆宽（nav-shell store，按域一份）。<lg 单栏时列表是内容，
  // 不受折叠影响。
  const listCollapsed = useDomainCollapsed('mail')
  const listWidth = useDomainWidth('mail')
  // Sprint 11 V1.4 — URL ↔ store sync. The route's `validateSearch` clamps
  // unknown values to 'inbox', so `urlView` is always a real EmailView
  // (the optional type just lets `navigate({to:'/'})` skip the search arg).
  // 列表头的文件夹选择器写 view → URL；这个 effect 管反向路径，让深链
  // (`/?view=flagged`) 能把 store 灌起来。
  const urlView = useSearch({ from: '/', select: (s) => s.view ?? 'inbox' })
  const storeView = useEmailFilter((s) => s.view)
  const setView = useEmailFilter((s) => s.setView)
  useEffect(() => {
    if (urlView !== storeView) setView(urlView)
  }, [urlView, storeView, setView])

  // Sprint 7 review (opus Nit) — removed local `useShortcut('cmd+k', goSearch)`
  // because `GlobalShortcuts` (mounted in App.tsx) now owns ⌘K → command
  // palette. The palette includes a "Go · Search" navigation entry, so the
  // user can still reach /search from the same keystroke — without
  // double-firing two handlers (LIFO + non-consuming open() would have
  // navigated AND opened the palette on the same press).
  return (
    <>
      {/* master-detail 容器 — AppShell 中间 flex 行的直接 flex item。relative 给
          <lg 时 EmailDetail 的 absolute 覆盖提供定位上下文（只盖 list, 不盖
          Sidebar）。≥lg 内部 list(--app-second-w) + detail(flex-1) 并排；<lg list 占满,
          detail 覆盖(选中) / hidden(未选中)。 */}
      <div className="relative flex flex-1 min-h-0 min-w-0">
        <div
          className={cn('relative flex min-h-0', belowLg ? 'w-full' : 'nav-second-col')}
          data-nav-second
          data-collapsed={!belowLg && listCollapsed ? 'true' : 'false'}
        >
          <div
            className={belowLg ? 'flex min-h-0 w-full' : 'nav-second-col-inner'}
            style={belowLg ? undefined : { width: listWidth }}
          >
            <EmailList />
          </div>
        </div>
        <div
          className={cn(
            'flex min-h-0',
            belowLg ? (activeId !== null ? 'absolute inset-0 z-30' : 'hidden') : 'flex-1 min-w-0'
          )}
        >
          <EmailDetail internalId={activeId} />
        </div>
      </div>
      {/* assistant-modal — dock 内嵌在 master-detail 行内（AppShell 中行的兄弟位）：
          sidebar 模式 = 可调宽 flex 列（挤压正文）；floating 模式 = 自身
          position:fixed 脱流（0 flow 占位，不挤压）；最小化 = hidden。渲染在行内
          （非 portal）正是为了让 sidebar 能真正挤压正文 —— 也是它不能提到
          RootLayout 做全局单例的原因（见 AssistantChatDock 头注释）。 */}
      <AssistantChatDock />
      {/* Sprint 17 — 旧 Sprint 5 fixed BatchActionBar 移除. floating bar
          (Sprint 12 设计, components/email/BatchActionBar.tsx) 由 EmailList
          portal 到 document.body, 不再需要在 chrome 这层 mount. */}
      {/* assistant-modal — 正文右下 FAB 入口（最小化态，portal 到 body）。⚠️ dock 本体只在 master-detail
          行内渲染（见上），sidebar 才能挤压正文；这里**不再**第二次挂 AssistantChatModal——之前
          重复挂载导致两个 dock + 两个 useGeneralChat，底部那个挂在 flex-col 根上撑满宽度把列表/正文顶没。 */}
      <ChatModalFab />
    </>
  )
}
