// 同步文件夹树的纯函数 —— 把 `folder.discover` 的 flat folders 按 whitelist 过滤 +
// parent 链还原成树。父不在 whitelist 但子在 → 子挂到最近的 synced 祖先（无则升顶层，
// 不丢）。
//
// 原址 `components/layout/sidebarFolderTree.helpers.ts`（多文件夹同步 P3）。task
// 08-27 P1 Lane B 把常驻文件夹树换成列表头的文件夹选择器后，这份逻辑与「侧边栏」
// 不再有关系，故搬到 lib 并去掉名字里的 Sidebar。行为逐字不变。
//
// 🔴 whitelist 参数是**有序数组**（SYNC_FOLDERS 数组序 = 用户自定义显示顺序），同层级内
// （roots 与每个节点的 children）按其下标排序；层级挂载不受影响。读侧不得 sorted()。

import type { FolderInfo } from '@shared/api/types'
import { decodeImapUtf7 } from '@shared/lib/imapUtf7'

/** 树节点 — FolderInfo 子集 + children + 层级 display_name 路径。 */
export interface FolderNode {
  imapName: string
  /** 叶子段 display_name（已按 delimiter 切末段）；过滤 key 用 fullDisplayName。 */
  displayName: string
  /** 完整 display_name（原始值，未切割），用于 customMailbox 过滤 key（后端
   *  `email_metadata.mailbox` 存完整解码路径）。 */
  fullDisplayName: string
  count: number | null
  /** 根→本节点的 display_name 段（末段 = displayName），面包屑用。 */
  path: string[]
  children: FolderNode[]
}

/** discover 未就绪时的本地 seed（task 08-20-perf-shell-prefetch-sidebar §③）——
 *  从 whitelist（imap 原始名，SYNC_FOLDERS 数组序）合成 FolderInfo 子集，喂给
 *  buildFolderTree 走与正式树**完全相同**的建树 + orderIndex 排序路径
 *  (🔴 顺序红线: 数组序 = 用户自定义显示顺序, 两棵树同源同序, 切换零跳变)。
 *
 *  display_name = decodeImapUtf7(imap_name) —— 与后端两处同源同值:
 *  ① discover 的 display_name (imap_client.py `decode_imap_utf7(imap_name)`);
 *  ② `email_metadata.mailbox` (davmail 落库同一函数)。所以 seed 行**可点**:
 *  fullDisplayName 过滤 key 与正式树逐字一致, discover 回来只换引用不换语义。
 *
 *  delimiter 按 davmail 实况假定 '/' (真 delimiter 只在 LIST 响应里有; 假定错时
 *  parent 推导不出 → 全平铺顶层 + label 显完整路径, 优雅降级不误挂)。parent 取
 *  「'/' 前缀里最长的 whitelist 成员」= discover 树 nearestSyncedParent 在 '/'
 *  delimiter 下的结果, 避免 discover 回来后层级跳变。编码段内不含字面 '/'
 *  (modified-BASE64 用 ',' 代 '/'), 按 '/' 切 imap_name 不会切进编码段。 */
export function buildSeedFolderInfos(whitelistOrder: readonly string[]): FolderInfo[] {
  const members = new Set(whitelistOrder)
  const nearestParent = (imapName: string): string | null => {
    let idx = imapName.lastIndexOf('/')
    while (idx > 0) {
      const prefix = imapName.slice(0, idx)
      if (members.has(prefix)) return prefix
      idx = prefix.lastIndexOf('/')
    }
    return null
  }
  return whitelistOrder.map((imapName) => ({
    imap_name: imapName,
    display_name: decodeImapUtf7(imapName),
    delimiter: '/',
    special_use: null,
    is_system: false,
    has_children: false,
    parent: nearestParent(imapName),
    message_count: null
  }))
}

export function buildFolderTree(
  folders: FolderInfo[],
  whitelistOrder: readonly string[]
): FolderNode[] {
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

  const nodes = new Map<string, FolderNode>()
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

  const roots: FolderNode[] = []
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
  const rank = (n: FolderNode): number => orderIndex.get(n.imapName) ?? 0
  const sortLevel = (level: FolderNode[]): void => {
    level.sort((a, b) => rank(a) - rank(b))
    for (const n of level) sortLevel(n.children)
  }
  sortLevel(roots)
  return roots
}

/** 树按深度优先摊平（父在前，子紧随），供不做展开/收起的平铺列表消费。
 *  🔴 顺序仍是 buildFolderTree 定的 whitelist 序，这里只负责摊平。 */
export function flattenFolderTree(
  nodes: readonly FolderNode[],
  depth = 0
): Array<{ node: FolderNode; depth: number }> {
  const out: Array<{ node: FolderNode; depth: number }> = []
  for (const node of nodes) {
    out.push({ node, depth })
    out.push(...flattenFolderTree(node.children, depth + 1))
  }
  return out
}
