// 资料库域的树状态（design §2.2「展开态 / 选中态 zustand，按域缺省」+ §2.3 视图与排序）。
//
// 「按域缺省」= 这些是资料库这一个域自己的偏好，与邮件 / 事项的列表视图互不相干，
// 因此单独一把 localStorage key、单独一份缺省值，不去挤别的域的 store。
//
// 持久化：展开态 / 当前文件夹 / 视图 / 排序（回到这个域时还在原地）。
// **不**持久化 `selectedFileId` —— 文件可能已被删/移走，冷启第一帧就撞 missing 态没意义；
// 重新打开某个文件是深链（`/library?file={id}`）的事。
//
// 🔴 本文件不 import registry / router，也不 import api 的**运行时**（仓内既有纪律：
// 状态叶子保持可单测）。排序两个类型是 `import type`（编译期擦除，不引入任何运行时依赖），
// 因为它们的值要原样发给服务端，权威在 wire 那一侧。

import { create } from 'zustand'

import type { LibraryFolderSort, LibrarySortDirection } from '@shared/api/library'

import { MOUNTS_GROUP_PATH, ancestorPaths, BUILT_IN_ROOT_SLUGS } from '@shared/components/library/tree'

const KEY = 'mailagent.library.tree.v1'

/** 文件夹内容区的两种视图（design §2.3，`ui/segmented` 切）。 */
export type LibraryFolderView = 'grid' | 'list'
/** 排序维度（design §2.3）。🔴 **不在这里第二次声明值域** —— 它们要原样进
 *  `GET /library/folder` 的 query，权威是 `api/library.ts`；这里只给域内惯用的别名。 */
export type LibrarySortKey = LibraryFolderSort
export type LibrarySortDir = LibrarySortDirection

const VIEWS: readonly LibraryFolderView[] = ['grid', 'list']
const SORT_KEYS: readonly LibrarySortKey[] = ['name', 'size', 'type', 'date']
const SORT_DIRS: readonly LibrarySortDir[] = ['asc', 'desc']

/** 缺省展开内置四根 + 挂载分组头：树一打开就能看见「有哪些地方可以去」，
 *  而不是四行全折叠、要点四下才知道里面有什么。 */
const DEFAULT_EXPANDED: readonly string[] = [...BUILT_IN_ROOT_SLUGS, MOUNTS_GROUP_PATH]
/** 缺省落在「我的文档」—— 唯一一个既不是只读投影、也不是 agent 自留地的根。 */
const DEFAULT_SELECTED_PATH = 'my-docs'

interface Persisted {
  expanded: string[]
  selectedPath: string | null
  view: LibraryFolderView
  sortKey: LibrarySortKey
  sortDir: LibrarySortDir
}

function fallback(): Persisted {
  return {
    expanded: [...DEFAULT_EXPANDED],
    selectedPath: DEFAULT_SELECTED_PATH,
    view: 'grid',
    sortKey: 'date',
    sortDir: 'desc'
  }
}

function pick<T extends string>(raw: unknown, allowed: readonly T[], dflt: T): T {
  return typeof raw === 'string' && (allowed as readonly string[]).includes(raw) ? (raw as T) : dflt
}

function readPersisted(): Persisted {
  const dflt = fallback()
  if (typeof window === 'undefined') return dflt
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return dflt
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return dflt
    const rec = parsed as Record<string, unknown>
    return {
      expanded: Array.isArray(rec.expanded)
        ? rec.expanded.filter((v): v is string => typeof v === 'string')
        : dflt.expanded,
      selectedPath: typeof rec.selectedPath === 'string' ? rec.selectedPath : null,
      view: pick(rec.view, VIEWS, dflt.view),
      sortKey: pick(rec.sortKey, SORT_KEYS, dflt.sortKey),
      sortDir: pick(rec.sortDir, SORT_DIRS, dflt.sortDir)
    }
  } catch {
    return dflt
  }
}

function writePersisted(state: LibraryTreeState): void {
  if (typeof window === 'undefined') return
  try {
    const payload: Persisted = {
      expanded: [...state.expanded],
      selectedPath: state.selectedPath,
      view: state.view,
      sortKey: state.sortKey,
      sortDir: state.sortDir
    }
    window.localStorage.setItem(KEY, JSON.stringify(payload))
  } catch {
    /* 配额 / 隐私模式 —— 状态留在内存里，功能不受影响。 */
  }
}

interface LibraryTreeState {
  expanded: ReadonlySet<string>
  /** 当前文件夹（内容区网格读它）。 */
  selectedPath: string | null
  /** 当前文件（内容区预览面读它）；选文件夹会清掉它。 */
  selectedFileId: number | null
  view: LibraryFolderView
  sortKey: LibrarySortKey
  sortDir: LibrarySortDir
}

interface LibraryTreeStore extends LibraryTreeState {
  toggleExpanded(path: string): void
  setExpanded(path: string, next: boolean): void
  selectFolder(path: string): void
  selectFile(fileId: number | null): void
  /** 深链 / 「在树中显示」：展开到目标的每一层祖先并选中它。 */
  revealPath(path: string): void
  setView(view: LibraryFolderView): void
  setSort(key: LibrarySortKey, dir?: LibrarySortDir): void
}

function initialState(): LibraryTreeState {
  const persisted = readPersisted()
  return {
    expanded: new Set(persisted.expanded),
    selectedPath: persisted.selectedPath,
    selectedFileId: null,
    view: persisted.view,
    sortKey: persisted.sortKey,
    sortDir: persisted.sortDir
  }
}

export const useLibraryTree = create<LibraryTreeStore>((set, get) => ({
  ...initialState(),

  toggleExpanded(path) {
    get().setExpanded(path, !get().expanded.has(path))
  },

  setExpanded(path, next) {
    const expanded = new Set(get().expanded)
    if (next) expanded.add(path)
    else expanded.delete(path)
    set({ expanded })
    writePersisted(get())
  },

  selectFolder(path) {
    set({ selectedPath: path, selectedFileId: null })
    writePersisted(get())
  },

  selectFile(fileId) {
    set({ selectedFileId: fileId })
  },

  revealPath(path) {
    const expanded = new Set(get().expanded)
    for (const ancestor of ancestorPaths(path)) expanded.add(ancestor)
    set({ expanded, selectedPath: path, selectedFileId: null })
    writePersisted(get())
  },

  setView(view) {
    set({ view })
    writePersisted(get())
  },

  setSort(key, dir) {
    // 不传方向 = 点同一列切正反、换列回到该列的自然序（时间/大小新→旧、名称/类型 A→Z）。
    const state = get()
    const next =
      dir ??
      (state.sortKey === key
        ? state.sortDir === 'asc'
          ? 'desc'
          : 'asc'
        : key === 'name' || key === 'type'
          ? 'asc'
          : 'desc')
    set({ sortKey: key, sortDir: next })
    writePersisted(get())
  }
}))

/** 按持久化值重新初始化（测试隔离用；将来设置页要加「重置资料库视图」也走它）。 */
export function resetLibraryTreeState(): void {
  useLibraryTree.setState(initialState())
}
