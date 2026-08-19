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
  /** 这一行在 IMAP 上对应什么。null = 它压根不是 IMAP 文件夹，是本地视图。
   *  🔴 folder_pref 若以 imap_name 作 PK，这两行没有天然主键（见页面底部说明）。 */
  imapName: string | null
}

export const BUILTIN_ROWS: readonly BuiltinRow[] = [
  { id: 'inbox', label: '收件箱', icon: 'folder-input', count: 12, imapName: 'INBOX' },
  { id: 'outbox', label: '发件箱', icon: 'send', imapName: 'Sent Items' },
  { id: 'drafts', label: '草稿箱', icon: 'feather', count: 3, imapName: 'Drafts' },
  { id: 'flagged', label: '已标旗', icon: 'zap', count: 7, imapName: null },
  { id: 'all', label: '所有邮件', icon: 'folders', count: 13148, imapName: null }
]

/** SYNC_FOLDERS 白名单里的自定义文件夹 —— 本次可排序、可换图标、可逐个配开关的就是这些。 */
export interface SyncedFolder {
  imapName: string
  displayName: string
  count: number
  /** null = 没设过，用兜底 Folder。 */
  icon: FolderIconKey | null
  /**
   * 新邮件是否推飞书。对应 FOLDER_NOTIFY_ENABLED —— **白名单**语义：
   * 自定义文件夹默认 **不** 通知，只有进了名单的才通知。所以这里默认 false。
   * 落 folder_pref 时列名 notify_enabled，取值与本字段同向。
   */
  notify: boolean
  /**
   * 是否跑 LLM 分类。对应 FOLDER_LLM_DISABLED —— **黑名单**语义：
   * 自定义文件夹默认 **跑** LLM，进了名单的才跳过。所以这里默认 true。
   * 🔴 落 folder_pref 时列名 llm_disabled，取值与本字段 **反向**（llm_disabled = !ai）。
   */
  ai: boolean
}

export const SYNCED_FOLDERS: readonly SyncedFolder[] = [
  {
    imapName: '&X1JoYw-',
    displayName: '归档',
    count: 2841,
    icon: 'folder-archive',
    notify: false,
    ai: true
  },
  {
    imapName: 'DMS&VvpO9lPRXgM-',
    displayName: 'DMS固件发布',
    count: 109,
    icon: 'folder-sync',
    notify: true,
    ai: true
  },
  {
    imapName: 'Teams',
    displayName: 'Teams',
    count: 33,
    icon: 'folder-kanban',
    notify: false,
    ai: false
  },
  {
    imapName: '&mHl27lRoYqU-',
    displayName: '项目周报',
    count: 246,
    icon: 'folder-clock',
    notify: false,
    ai: true
  },
  {
    imapName: '&XfJSnn7T-',
    displayName: '已办结',
    count: 512,
    icon: 'folder-check',
    notify: false,
    ai: false
  },
  {
    imapName: 'Newsletters',
    displayName: 'Newsletters',
    count: 1893,
    icon: null,
    notify: false,
    ai: false
  }
]

/** 新加入 SYNC_FOLDERS 的文件夹会长成什么样 —— 与后端 gate 的缺省行为逐字对齐。 */
export const PREF_DEFAULTS = { icon: null, notify: false, ai: true } as const
