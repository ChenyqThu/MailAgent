// mockup 数据 —— 用真实邮箱里的文件夹，不用 Foo/Bar。
//
// 收件箱 / 发件箱 是本机 email_metadata.mailbox 里真实存在的两个（11544 / 1462
// 封）；DMS固件发布、Teams 也是真实自定义文件夹（109 / 33 封）。归档、项目周报、
// 已办结、Newsletters 是同一邮箱风格的补充样本，让顺序/图标演示有足够行数。
// imap_name 是 modified UTF-7 原始名（.env.example 里 SYNC_FOLDERS 的样例
// `DMS&VvpO9lPRXgM-` 与这里逐字一致）。

import type { FolderIconKey } from './icons'

/** 内建邮箱行 —— 不在 SYNC_FOLDERS 里，位置与图标当前都写死在 Sidebar.tsx。 */
export interface BuiltinRow {
  id: string
  label: string
  /** lucide 名（Sidebar 用的是 @shared/components/icons 的动效版同名图标）。 */
  icon: 'folder-input' | 'send' | 'feather' | 'zap' | 'folders'
  count?: number
}

export const BUILTIN_ROWS: readonly BuiltinRow[] = [
  { id: 'inbox', label: '收件箱', icon: 'folder-input', count: 12 },
  { id: 'outbox', label: '发件箱', icon: 'send' },
  { id: 'drafts', label: '草稿箱', icon: 'feather', count: 3 },
  { id: 'flagged', label: '已标旗', icon: 'zap', count: 7 },
  { id: 'all', label: '所有邮件', icon: 'folders', count: 13148 }
]

/** SYNC_FOLDERS 白名单里的自定义文件夹 —— 本次可排序、可换图标的就是这些。 */
export interface SyncedFolder {
  imapName: string
  displayName: string
  count: number
  /** null = 没设过，用兜底 Folder。 */
  icon: FolderIconKey | null
}

export const SYNCED_FOLDERS: readonly SyncedFolder[] = [
  { imapName: '&X1JoYw-', displayName: '归档', count: 2841, icon: 'folder-archive' },
  { imapName: 'DMS&VvpO9lPRXgM-', displayName: 'DMS固件发布', count: 109, icon: 'folder-sync' },
  { imapName: 'Teams', displayName: 'Teams', count: 33, icon: 'folder-kanban' },
  { imapName: '&mHl27lRoYqU-', displayName: '项目周报', count: 246, icon: 'folder-clock' },
  { imapName: '&XfJSnn7T-', displayName: '已办结', count: 512, icon: 'folder-check' },
  { imapName: 'Newsletters', displayName: 'Newsletters', count: 1893, icon: null }
]
