// 多文件夹同步 (P3) — SidebarFolderTree 的纯函数 helper (从组件文件拆出, 避免
// react-refresh/only-export-components: 组件文件只能导出组件)。
//
// 把 discover 的 flat folders 按 whitelist 过滤 + parent 链还原成树, 供 Sidebar
// 渲染。父不在 whitelist 但子在 → 子挂到最近的 synced 祖先 (无则升顶层, 不丢)。
// 排序 task: whitelist 参数是**有序数组** (SYNC_FOLDERS 数组序 = 用户自定义显示
// 顺序), 同层级内 (roots 与每个节点的 children) 按其下标排序; 层级挂载不受影响。

import type { FolderInfo } from '@shared/api/types'

/** sidebar 内部树节点 — FolderInfo 子集 + children + 层级 display_name 路径。 */
export interface SidebarFolderNode {
  imapName: string
  /** 叶子段 display_name (已按 delimiter 切末段), 行 label + 过滤 key 用完整路径用 fullDisplayName。 */
  displayName: string
  /** 完整 display_name (原始值, 未切割), 用于 customMailbox 过滤 key (后端 mailbox 字段存完整解码路径)。 */
  fullDisplayName: string
  count: number | null
  /** 根→本节点的 display_name 段 (末段 = displayName), 列表面包屑用。 */
  path: string[]
  children: SidebarFolderNode[]
  /** discover 未就绪/失败时退化平铺的节点, display_name 未解码 → 禁用点击。 */
  isDisabled?: boolean
}

export function buildSidebarFolderTree(
  folders: FolderInfo[],
  whitelistOrder: readonly string[]
): SidebarFolderNode[] {
  const whitelist = new Set(whitelistOrder)
  const orderIndex = new Map<string, number>()
  whitelistOrder.forEach((n, i) => orderIndex.set(n, i))
  const byName = new Map<string, FolderInfo>()
  for (const f of folders) byName.set(f.imap_name, f)

  // 最近的 synced 祖先 (不含自身) — 父未勾时把子挂到更上层的 synced 祖先。
  const nearestSyncedParent = (f: FolderInfo): string | null => {
    let cur = f.parent
    while (cur) {
      if (whitelist.has(cur)) return cur
      const parentInfo = byName.get(cur)
      cur = parentInfo?.parent ?? null
    }
    return null
  }

  // 叶子段: 按 delimiter 切 display_name 取末段 (如 "项目/2026 Q2" → "2026 Q2")。
  // 过滤 key 仍用完整 display_name (后端 email_metadata.mailbox = 完整解码路径)。
  const leafName = (f: FolderInfo): string => {
    const delim = f.delimiter || '/'
    const parts = f.display_name.split(delim)
    return parts[parts.length - 1] || f.display_name
  }

  // display_name 路径 (从根 synced 链推导; 末段用叶子名, 祖先段也用叶子名)。
  const pathFor = (f: FolderInfo): string[] => {
    const segs: string[] = [leafName(f)]
    let cur = f.parent
    while (cur) {
      if (!whitelist.has(cur)) break
      const info = byName.get(cur)
      if (!info) break
      segs.unshift(leafName(info))
      cur = info.parent
    }
    return segs
  }

  const nodes = new Map<string, SidebarFolderNode>()
  const synced = folders.filter((f) => whitelist.has(f.imap_name))
  for (const f of synced) {
    nodes.set(f.imap_name, {
      imapName: f.imap_name,
      displayName: leafName(f),
      fullDisplayName: f.display_name,
      count: f.message_count,
      path: pathFor(f),
      children: []
    })
  }

  const roots: SidebarFolderNode[] = []
  for (const f of synced) {
    const node = nodes.get(f.imap_name)
    if (!node) continue
    const parentName = nearestSyncedParent(f)
    const parentNode = parentName ? nodes.get(parentName) : null
    if (parentNode) parentNode.children.push(node)
    else roots.push(node)
  }

  // 同层级内按 whitelist 下标排序 (数组序 = 自定义显示顺序)。节点 ⊆ whitelist
  // (synced 过滤保证), 下标必存在; ?? 0 仅安抚类型。
  const rank = (n: SidebarFolderNode): number => orderIndex.get(n.imapName) ?? 0
  const sortLevel = (level: SidebarFolderNode[]): void => {
    level.sort((a, b) => rank(a) - rank(b))
    for (const n of level) sortLevel(n.children)
  }
  sortLevel(roots)
  return roots
}
