// 「切邮箱」的写路径单源（task 09-01-sidebar-fluid-optimization dogfood 轮 1）。
//
// 原址是 `components/email/EmailListHeader.tsx` 里的两个 useCallback（列表头文件夹选择器
// 的点行语义）。折叠态 peek 的邮箱列表（`layout/peek/MailPeekList`）要的是**同一套动作**，
// 复制一份就会漂，故抽成 hook —— 行为逐字不变，两处共用。
//
// 两个 handler 的分工：
//   · selectView   内建视图行：setView + mailbox 联动 + `?view=` 同步（navigateToNavEntry）
//   · selectFolder 自定义文件夹行：只写过滤 key，**不导航**（列表头本就在邮件域；peek 在
//     别的域浮出，由调用方自己补 navigateToDomain(navigate, 'mail')）

import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'

import type { FolderNode } from '@shared/lib/folderTree'
import { mailboxForView } from '@shared/lib/mailboxSemantics'
import { NAV_ENTRIES, navDomainPanelEntries, navigateToNavEntry } from '@shared/navigation/registry'
import { useEmailFilter, type EmailView } from '@shared/state/email-filter'
import { useMailbox } from '@shared/state/mailbox'

/** 五个内建邮箱视图行 —— registry 投影（标签 / 图标 / 落点的单源仍在那里）。
 *  registry 是零副作用的叶子模块，模块级取一次即可，不必每 render 过一遍。 */
export const MAIL_VIEW_ENTRIES = navDomainPanelEntries(NAV_ENTRIES, 'mail').filter(
  (e) => e.view !== undefined
)

export interface SelectMailbox {
  selectView(next: EmailView): void
  selectFolder(node: FolderNode): void
}

export function useSelectMailbox(): SelectMailbox {
  const navigate = useNavigate()
  const setView = useEmailFilter((s) => s.setView)
  const setCustomMailbox = useEmailFilter((s) => s.setCustomMailbox)
  const setActiveMailbox = useMailbox((s) => s.setActive)

  /** 内建视图切换 —— setView + StatusBar mailbox 联动 + `?view=` 同步，与侧栏行
   *  （Sidebar.handleViewClick）同一套动作；路径字面量仍只在 registry 里。 */
  const selectView = useCallback(
    (next: EmailView): void => {
      setView(next)
      const nextMailbox = mailboxForView(next)
      // flagged / all 是跨邮箱虚拟视图，没有具体 mailbox —— 保持 StatusBar 原值。
      if (nextMailbox) setActiveMailbox(nextMailbox)
      const entry = MAIL_VIEW_ENTRIES.find((e) => e.view === next)
      if (entry) navigateToNavEntry(navigate, entry)
    },
    [navigate, setActiveMailbox, setView]
  )

  /** 自定义文件夹切换 —— 过滤 key 必须是完整 display_name（后端
   *  `email_metadata.mailbox` 存完整解码路径）；path 供列表头显示叶子名。 */
  const selectFolder = useCallback(
    (node: FolderNode): void => {
      setCustomMailbox(node.fullDisplayName, node.path)
      setActiveMailbox(node.fullDisplayName)
    },
    [setActiveMailbox, setCustomMailbox]
  )

  return { selectView, selectFolder }
}
