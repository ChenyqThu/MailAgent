// 文件夹图标候选表 —— 24 个 lucide folder 家族动效图标，per-folder 图标配置的词汇表。
//
// key 用 lucide 官方 kebab 名，**它就是 `folder_pref.icon` 落库的值**：后端把这一列
// 当不透明短串存、不做枚举校验（可选集是纯前端词汇），认不出的值由这里的 `folderIcon()`
// 兜底回默认 —— 所以将来 lucide 改名 / 我们换动效实现时，只动本表一行，DB 里的历史值
// 不用迁移。
//
// 每个图标一句动效说明在 i18n：`settings.folder.picker.icon.motion.<key>`（选择器
// hover 时显示）。这里不留中文副本，避免同一句话两处。

import type { AnimatedIconProps } from './AnimatedIcon'
import { FolderIcon } from './animated/folder'
import { FolderArchiveIcon } from './animated/folder-archive'
import { FolderCheckIcon } from './animated/folder-check'
import { FolderClockIcon } from './animated/folder-clock'
import { FolderCodeIcon } from './animated/folder-code'
import { FolderCogIcon } from './animated/folder-cog'
import { FolderDotIcon } from './animated/folder-dot'
import { FolderDownIcon } from './animated/folder-down'
import { FolderGitIcon } from './animated/folder-git'
import { FolderGit2Icon } from './animated/folder-git-2'
import { FolderHeartIcon } from './animated/folder-heart'
import { FolderInputIcon } from './animated/folder-input'
import { FolderKanbanIcon } from './animated/folder-kanban'
import { FolderKeyIcon } from './animated/folder-key'
import { FolderLockIcon } from './animated/folder-lock'
import { FolderMinusIcon } from './animated/folder-minus'
import { FolderOpenIcon } from './animated/folder-open'
import { FolderOutputIcon } from './animated/folder-output'
import { FolderPlusIcon } from './animated/folder-plus'
import { FolderRootIcon } from './animated/folder-root'
import { FolderSyncIcon } from './animated/folder-sync'
import { FolderTreeIcon } from './animated/folder-tree'
import { FolderUpIcon } from './animated/folder-up'
import { FolderXIcon } from './animated/folder-x'
import { FoldersIcon } from './animated/folders'

export type FolderIconComponent = (props: AnimatedIconProps) => React.ReactElement

/** 候选图标 key —— 存储值就是它。**数组序 = 选择器网格的排列顺序**（字母序）。 */
export const FOLDER_ICON_KEYS = [
  'folder-archive',
  'folder-check',
  'folder-clock',
  'folder-code',
  'folder-cog',
  'folder-dot',
  'folder-down',
  'folder-git',
  'folder-git-2',
  'folder-heart',
  'folder-input',
  'folder-kanban',
  'folder-key',
  'folder-lock',
  'folder-minus',
  'folder-open',
  'folder-output',
  'folder-plus',
  'folder-root',
  'folder-sync',
  'folder-tree',
  'folder-up',
  'folder-x',
  'folders'
] as const

export type FolderIconKey = (typeof FOLDER_ICON_KEYS)[number]

const REGISTRY: Record<FolderIconKey, FolderIconComponent> = {
  'folder-archive': FolderArchiveIcon,
  'folder-check': FolderCheckIcon,
  'folder-clock': FolderClockIcon,
  'folder-code': FolderCodeIcon,
  'folder-cog': FolderCogIcon,
  'folder-dot': FolderDotIcon,
  'folder-down': FolderDownIcon,
  'folder-git': FolderGitIcon,
  'folder-git-2': FolderGit2Icon,
  'folder-heart': FolderHeartIcon,
  'folder-input': FolderInputIcon,
  'folder-kanban': FolderKanbanIcon,
  'folder-key': FolderKeyIcon,
  'folder-lock': FolderLockIcon,
  'folder-minus': FolderMinusIcon,
  'folder-open': FolderOpenIcon,
  'folder-output': FolderOutputIcon,
  'folder-plus': FolderPlusIcon,
  'folder-root': FolderRootIcon,
  'folder-sync': FolderSyncIcon,
  'folder-tree': FolderTreeIcon,
  'folder-up': FolderUpIcon,
  'folder-x': FolderXIcon,
  folders: FoldersIcon
}

/** 兜底图标 —— 没设过 / 存的 key 不认识（lucide 改名、手改 DB）都落这里，不炸。 */
export const DEFAULT_FOLDER_ICON: FolderIconComponent = FolderIcon

/** `folder_pref.icon` → 组件。null / 未知 key → 兜底 folder。
 *
 *  🔴 必须用 `Object.hasOwn` 而不是 `REGISTRY[key] ?? DEFAULT`：DB 里存的是**不透明串**
 *  （后端不做枚举校验），`'toString'` / `'constructor'` 这类原型链上的名字用 `??` 取不到
 *  undefined，会取到 `Object.prototype` 上的函数并被当成组件渲染 —— 当场炸整棵侧边栏。 */
export function folderIcon(key: string | null | undefined): FolderIconComponent {
  if (!key || !Object.hasOwn(REGISTRY, key)) return DEFAULT_FOLDER_ICON
  return REGISTRY[key as FolderIconKey]
}
