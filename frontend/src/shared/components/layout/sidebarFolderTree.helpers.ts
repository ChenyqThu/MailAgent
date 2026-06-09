// 多文件夹同步 (P3) — SidebarFolderTree 的纯函数 helper (从组件文件拆出, 避免
// react-refresh/only-export-components: 组件文件只能导出组件)。
//
// 把 discover 的 flat folders 按 whitelist 过滤 + parent 链还原成树, 供 Sidebar
// 渲染。父不在 whitelist 但子在 → 子挂到最近的 synced 祖先 (无则升顶层, 不丢)。

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
  whitelist: ReadonlySet<string>
): SidebarFolderNode[] {
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
  return roots
}
