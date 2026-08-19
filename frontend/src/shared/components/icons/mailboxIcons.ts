// 内建邮箱（收件箱 / 发件箱 / 草稿箱 / 已标旗 / 所有邮件）的图标单源。
//
// 🔴 为什么是独立叶子模块而不是留在 Sidebar.tsx：这份对应关系有**两个**消费点 ——
// 侧边栏 MAILBOXES 段（`layout/Sidebar.tsx`）与设置页「已同步文件夹配置」里那段只读的
// 内建邮箱行（`settings/parts/FolderPrefRows.tsx`）。第二处照抄一份就是同一个事实存两处，
// 换图标必漏一边。这里只 import 图标组件与一个类型，不拉 store / IPC，两边都能直接吃。
//
// 内建 5 行的图标**不开放自定义**（与自定义文件夹的 `folder_pref.icon` 相反）：
// 换这 5 个只能改本文件。

import type { EmailView } from '@shared/state/email-filter'

import type { AnimatedIconProps } from './AnimatedIcon'
import { FeatherIcon } from './animated/feather'
import { FolderInputIcon } from './animated/folder-input'
import { FoldersIcon } from './animated/folders'
import { SendIcon } from './animated/send'
import { ZapIcon } from './animated/zap'

export type MailboxIconComponent = (props: AnimatedIconProps) => React.ReactElement

export const MAILBOX_ICON_COMPONENT: Record<EmailView, MailboxIconComponent> = {
  inbox: FolderInputIcon,
  outbox: SendIcon,
  drafts: FeatherIcon,
  flagged: ZapIcon,
  all: FoldersIcon
}
