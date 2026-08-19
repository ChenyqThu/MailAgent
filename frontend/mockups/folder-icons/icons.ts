// 文件夹图标候选表 —— 24 个 lucide folder 家族图标，全部为动效版。
//
// 已核对 lucide-react@1.16.0（本仓 node_modules 实际版本）：24 个 PascalCase
// 导出名全部存在，没有缺项，不需要降级替换。核对方式：
//   ls node_modules/lucide-react/dist/esm/icons | grep '^folder'
//   + 在 dist/lucide-react.d.ts 里逐个 grep 导出名。
// 动效实现见 ./animated.tsx（path 数据也是从上面那批 .mjs 里读出来的）。
//
// key 用 lucide 官方 kebab 名（= 落库存的值，与组件解耦：将来 lucide 改名或
// 我们换动效实现时只动本表一行，DB 里的历史值不用迁移）。

import {
  FolderArchiveIcon,
  FolderCheckIcon,
  FolderClockIcon,
  FolderCodeIcon,
  FolderCogIcon,
  FolderDotIcon,
  FolderDownIcon,
  FolderGit2Icon,
  FolderGitIcon,
  FolderHeartIcon,
  FolderIcon24,
  FolderInputIcon24,
  FolderKanbanIcon,
  FolderKeyIcon,
  FolderLockIcon,
  FolderMinusIcon,
  FolderOpenIcon,
  FolderOutputIcon,
  FolderPlusIcon24,
  FolderRootIcon,
  FolderSyncIcon,
  FolderTreeIcon,
  FolderUpIcon,
  FolderXIcon,
  FoldersIcon24,
  type FolderIconComponent
} from './animated'

/** 候选图标 key —— 存储值就是它。顺序 = 选择器网格的排列顺序。 */
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
  'folder-input': FolderInputIcon24,
  'folder-kanban': FolderKanbanIcon,
  'folder-key': FolderKeyIcon,
  'folder-lock': FolderLockIcon,
  'folder-minus': FolderMinusIcon,
  'folder-open': FolderOpenIcon,
  'folder-output': FolderOutputIcon,
  'folder-plus': FolderPlusIcon24,
  'folder-root': FolderRootIcon,
  'folder-sync': FolderSyncIcon,
  'folder-tree': FolderTreeIcon,
  'folder-up': FolderUpIcon,
  'folder-x': FolderXIcon,
  folders: FoldersIcon24
}

/** 每个图标一句话动效说明 —— 选择器里 hover 时给 owner 看，也当验收清单。 */
export const FOLDER_ICON_MOTION: Record<FolderIconKey, string> = {
  'folder-archive': '归档件下沉入库',
  'folder-check': '勾描线画出',
  'folder-clock': '分针走一圈',
  'folder-code': '尖括号左右让开',
  'folder-cog': '齿轮转 90°',
  'folder-dot': '圆点脉冲',
  'folder-down': '箭头下探',
  'folder-git': '节点亮起，两侧连线外画',
  'folder-git-2': '分支画出，末端节点后弹',
  'folder-heart': '心跳（双拍）',
  'folder-input': '箭头滑进来',
  'folder-kanban': '三列依次长高',
  'folder-key': '钥匙拧一下',
  'folder-lock': '锁扣抬起再合上',
  'folder-minus': '横杠描线',
  'folder-open': '前盖沿轮廓扫开',
  'folder-output': '箭头往外走',
  'folder-plus': '加号两笔错开描出',
  'folder-root': '节点亮起，根须向下长',
  'folder-sync': '双向环箭头转半圈',
  'folder-tree': '主干先画，子节点依次浮现',
  'folder-up': '箭头上抬',
  'folder-x': '两笔交叉错开划掉',
  folders: '前层错开滑出，后层退让'
}

/** 兜底图标 —— 没设过 / 存的 key 不认识（lucide 改名、手改 DB）都落这里，不炸。 */
export const DEFAULT_FOLDER_ICON: FolderIconComponent = FolderIcon24

export function folderIcon(key: string | null | undefined): FolderIconComponent {
  if (!key) return DEFAULT_FOLDER_ICON
  return REGISTRY[key as FolderIconKey] ?? DEFAULT_FOLDER_ICON
}
