// 资料库文件夹树的数据层（design §2.2 / §8.2）：服务端的扁平 `folders` + `mounts`
// → 多根嵌套树 → 摊平数组 + depth。呈现层是 `ui/FileTree`（收编自 beui），它吃的是
// 摊平结果，所以这里**不产 JSX**（图标 / 角标由渲染层按 kind 与 mount 自己配）。
//
// 范式抄 `lib/folderTree.ts`（build 嵌套 → flatten 带 depth），但**不复用它的函数** ——
// 那边是「IMAP 白名单序 + 最近 synced 祖先」，这边是「多根 + 挂载分组 + 只读/不可用
// 向下传染」，两套语义没有公共子集，强行合并只会让两边都要读对方的注释。
//
// 三条不变量（各有一条单测钉着，见 tests/shared/libraryTree.test.ts）：
//   · 内置四根恒在 —— 服务端还没建目录时也要能点进去（点了才会建）；
//   · 同层级保持**服务端顺序** —— 投影区按 `{YYYY-MM}` 是服务端排好的，读侧再 sort 一次
//     就把它打乱了（与 SYNC_FOLDERS「读侧不得 sorted()」同一条纪律）；
//   · 父行缺失的文件夹升到自己的根下、根也认不出就自成一根 —— 树是唯一导航面，
//     丢一行等于那一批文件在 UI 上不可达。

import type { LibraryFolderNode, LibraryMountSummary } from '@shared/api/types/library'
import { PROJECTION_SLUG, TOP_LEVEL_SLUGS, TRASH_SLUG } from '@shared/libraryConstants'

/** 「挂载的文件夹」分组头的合成路径。🔴 服务端永不返回它，也不是任何文件的 parent。 */
export const MOUNTS_GROUP_PATH = '__mounts__'

/** 内置根 = `TOP_LEVEL_SLUGS` 去掉废纸篓（废纸篓单列在树尾，design §2.2）。 */
export const BUILT_IN_ROOT_SLUGS: readonly string[] = TOP_LEVEL_SLUGS.filter(
  (slug) => slug !== TRASH_SLUG
)

export type LibraryTreeNodeKind = 'root' | 'folder' | 'group' | 'trash'

export interface LibraryTreeNode {
  /** 虚拟路径；内置根 = slug，挂载根 = `@<label>`，分组头 = `MOUNTS_GROUP_PATH`。 */
  path: string
  /** 末段显示名。内置根恒为 slug —— 渲染层按 slug 取 i18n 文案，不吃服务端的名字。 */
  name: string
  kind: LibraryTreeNodeKind
  mountId: number
  /** 直接子文件数（角标）；分组头是挂载数。 */
  fileCount: number
  /** 投影根 / `ro` 挂载根，向下传染。 */
  readonly: boolean
  /** 卷拔了 / 目录移走的挂载，向下传染（行不删，灰显）。 */
  unavailable: boolean
  mount: LibraryMountSummary | null
  children: LibraryTreeNode[]
}

export type LibraryTreeRow = Omit<LibraryTreeNode, 'children'> & {
  depth: number
  /** 画不画 chevron 的唯一判据。 */
  hasChildren: boolean
}

export interface LibraryTreeInput {
  folders: readonly LibraryFolderNode[]
  /** `GET /library/tree` 内嵌的挂载投影（不带 `abs_path`，绝对路径只在设置页出现）。 */
  mounts: readonly LibraryMountSummary[]
}

function rootSegment(path: string): string {
  const slash = path.indexOf('/')
  return slash < 0 ? path : path.slice(0, slash)
}

function emptyNode(path: string, name: string, kind: LibraryTreeNodeKind): LibraryTreeNode {
  return {
    path,
    name,
    kind,
    mountId: 0,
    fileCount: 0,
    readonly: false,
    unavailable: false,
    mount: null,
    children: []
  }
}

/** 只读 / 不可用向下传染 —— 建完树再走一遍，省得建树时到处传两个布尔。 */
function inherit(node: LibraryTreeNode, readonlyFlag: boolean, unavailableFlag: boolean): void {
  node.readonly = node.readonly || readonlyFlag
  node.unavailable = node.unavailable || unavailableFlag
  for (const child of node.children) inherit(child, node.readonly, node.unavailable)
}

export function buildLibraryTree(input: LibraryTreeInput): LibraryTreeNode[] {
  const nodes = new Map<string, LibraryTreeNode>()

  for (const row of input.folders) {
    nodes.set(row.path, {
      path: row.path,
      name: row.name,
      kind: 'folder',
      mountId: row.mount_id,
      fileCount: row.file_count,
      readonly: false,
      unavailable: false,
      mount: null,
      children: []
    })
  }

  // 内置根：服务端返了就升级成 root，没返就补一个空的（目录尚未建 ≠ 不能点）。
  const builtInRoots = BUILT_IN_ROOT_SLUGS.map((slug) => {
    const existing = nodes.get(slug)
    const node = existing ?? emptyNode(slug, slug, 'root')
    node.kind = 'root'
    node.name = slug
    node.readonly = slug === PROJECTION_SLUG
    nodes.set(slug, node)
    return node
  })

  // 挂载根：身份来自 `library_mount` 行，不来自 folders（卸载 / 不可用时 folders 可能没这一支）。
  const mountRoots = input.mounts.map((mount) => {
    // 🔴 用服务端给的 `path`，别自己拼 `@${label}` —— label 可能含斜杠等特殊字符。
    const path = mount.path
    const node = nodes.get(path) ?? emptyNode(path, path, 'root')
    node.kind = 'root'
    node.name = path
    node.mountId = mount.id
    node.mount = mount
    node.readonly = mount.mode === 'ro'
    node.unavailable = mount.status !== 'ok'
    nodes.set(path, node)
    return node
  })

  const trashRoot = nodes.get(TRASH_SLUG) ?? emptyNode(TRASH_SLUG, TRASH_SLUG, 'trash')
  trashRoot.kind = 'trash'
  trashRoot.name = TRASH_SLUG
  nodes.set(TRASH_SLUG, trashRoot)

  const rootPaths = new Set<string>([
    ...builtInRoots.map((n) => n.path),
    ...mountRoots.map((n) => n.path),
    TRASH_SLUG
  ])

  const orphanRoots: LibraryTreeNode[] = []
  for (const row of input.folders) {
    if (rootPaths.has(row.path)) continue
    const node = nodes.get(row.path)
    if (!node) continue
    // `parent_path` 是**空串**表示根行（不是 null）。
    const parent =
      (row.parent_path !== '' ? nodes.get(row.parent_path) : undefined) ??
      nodes.get(rootSegment(row.path))
    if (!parent || parent === node) {
      orphanRoots.push(node)
      continue
    }
    parent.children.push(node)
  }

  const mountsGroup = emptyNode(MOUNTS_GROUP_PATH, MOUNTS_GROUP_PATH, 'group')
  mountsGroup.fileCount = mountRoots.length
  mountsGroup.children = mountRoots

  const roots = [...builtInRoots, ...orphanRoots, mountsGroup, trashRoot]
  for (const root of roots) inherit(root, root.readonly, root.unavailable)
  return roots
}

/** 深度优先摊平，只展开 `expanded` 里的分支。父在前、子紧随（照 `flattenFolderTree`）。 */
export function flattenLibraryTree(
  nodes: readonly LibraryTreeNode[],
  expanded: ReadonlySet<string>,
  depth = 0
): LibraryTreeRow[] {
  const out: LibraryTreeRow[] = []
  for (const node of nodes) {
    const { children, ...rest } = node
    out.push({ ...rest, depth, hasChildren: children.length > 0 })
    if (expanded.has(node.path)) out.push(...flattenLibraryTree(children, expanded, depth + 1))
  }
  return out
}

/** 目标路径的每一层祖先（不含自身），深链 / 「在树中显示」要逐层展开。
 *  挂载路径额外带上分组头 —— 不展开它，挂载根本身还在折叠的分组里。 */
export function ancestorPaths(path: string): string[] {
  const out: string[] = []
  if (path.startsWith('@')) out.push(MOUNTS_GROUP_PATH)
  const segments = path.split('/')
  for (let i = 1; i < segments.length; i += 1) out.push(segments.slice(0, i).join('/'))
  return out
}
